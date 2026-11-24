import { describe, test, expect, beforeEach } from "bun:test";
import {
  _resetHostMaintenanceState,
  collectHostStorage,
  getHostMaintenanceEventLog,
  getHostMaintenanceStatus,
  parseDfOutput,
  parseDockerBytes,
  planHostMaintenance,
  runHostMaintenance,
  watermarkFor,
  type HostImageInfo,
  type HostStorage,
} from "./host-maintenance";
import type { ExecResult } from "./docker";
import { DEFAULT_HOST_MAINTENANCE_POLICY } from "./host-maintenance-policy";

const GB = 1024 * 1024 * 1024;

function ok(stdout: string): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function img(
  repository: string,
  tag: string,
  overrides: Partial<HostImageInfo> = {},
): HostImageInfo {
  return {
    repository,
    tag,
    id: `id-${repository}-${tag}`,
    createdAt: "2026-11-20T00:00:00.000Z",
    sizeBytesApprox: GB,
    sizeLabel: "1GB",
    inUse: false,
    ...overrides,
  };
}

function storageWith(images: HostImageInfo[]): HostStorage {
  return {
    root: { path: "/", totalBytes: 100 * GB, usedBytes: 90 * GB, availBytes: 10 * GB, usePercent: 90 },
    tmp: { path: "/tmp", totalBytes: 100 * GB, usedBytes: 90 * GB, availBytes: 10 * GB, usePercent: 90 },
    docker: {
      images: { total: images.length, active: 1, sizeBytesApprox: 5 * GB, reclaimableBytesApprox: 2 * GB },
      containers: { total: 2, active: 2, sizeBytesApprox: null, reclaimableBytesApprox: 0 },
      volumes: { total: 10, active: 4, sizeBytesApprox: null, reclaimableBytesApprox: null },
      buildCache: { total: 5, active: 0, sizeBytesApprox: 4 * GB, reclaimableBytesApprox: 3 * GB },
    },
    images,
    collectedAt: new Date().toISOString(),
  };
}

describe("parseDockerBytes", () => {
  test("parses common units", () => {
    expect(parseDockerBytes("22.88GB")).toBe(Math.round(22.88 * GB));
    expect(parseDockerBytes("575MB")).toBe(575 * 1024 * 1024);
    expect(parseDockerBytes("8.43MB")).toBe(Math.round(8.43 * 1024 * 1024));
    expect(parseDockerBytes("0B")).toBe(0);
  });

  test("returns null on garbage", () => {
    expect(parseDockerBytes("")).toBeNull();
    expect(parseDockerBytes("n/a")).toBeNull();
    expect(parseDockerBytes("12XB")).toBeNull();
  });
});

describe("parseDfOutput", () => {
  test("parses df -B1 output", () => {
    const out = "Filesystem     1B-blocks       Used  Available Use% Mounted on\n/dev/mapper/x 124000000000 108000000000 16000000000  88% /\n";
    expect(parseDfOutput(out, "/")).toEqual({
      path: "/",
      totalBytes: 124000000000,
      usedBytes: 108000000000,
      availBytes: 16000000000,
      usePercent: 88,
    });
  });

  test("returns null when nothing parses", () => {
    expect(parseDfOutput("garbage\n", "/")).toBeNull();
  });
});

describe("watermarkFor", () => {
  const policy = { ...DEFAULT_HOST_MAINTENANCE_POLICY, watermarkWarnGb: 10, watermarkCritGb: 8 };
  test("tiers", () => {
    expect(watermarkFor(null, policy)).toBe("unknown");
    expect(watermarkFor(20 * GB, policy)).toBe("ok");
    expect(watermarkFor(9 * GB, policy)).toBe("warn");
    expect(watermarkFor(7 * GB, policy)).toBe("crit");
  });
});

describe("planHostMaintenance", () => {
  const policy = { ...DEFAULT_HOST_MAINTENANCE_POLICY };

  test("proposes dangling, protects in-use dangling", () => {
    const storage = storageWith([
      img("<none>", "<none>", { id: "deadbeef" }),
      img("<none>", "<none>", { id: "abc123", inUse: true }),
    ]);
    const plan = planHostMaintenance(storage, policy);
    expect(plan.dangling.map((d) => d.ref)).toEqual(["deadbeef"]);
    expect(plan.skippedProtected.some((s) => s.reason.includes("in use"))).toBe(true);
  });

  test("keeps newest N family versions, protects in-use and tagged", () => {
    const storage = storageWith([
      img("ghcr.io/tryweb/ai-engkit", "v1.24.9", { createdAt: "2026-11-23T00:00:00Z", inUse: true }),
      img("ghcr.io/tryweb/ai-engkit", "v1.24.8", { createdAt: "2026-11-20T00:00:00Z" }),
      img("ghcr.io/tryweb/ai-engkit", "v1.24.7", { createdAt: "2026-11-10T00:00:00Z" }),
      img("postgres", "16-alpine", { createdAt: "2026-08-01T00:00:00Z" }),
    ]);
    const plan = planHostMaintenance(storage, { ...policy, keepAiEngkitVersions: 2, protectedTags: ["postgres:16-alpine"] });
    // v1.24.9 in use (protected), v1.24.8 kept (newest 2 among non-protected? no —
    // in-use images are excluded before ranking, so v1.24.8 + v1.24.7 are ranked, keep 2 → both kept.
    expect(plan.versioned).toHaveLength(0);
    expect(plan.skippedProtected.some((s) => s.ref === "postgres:16-alpine")).toBe(true);
  });

  test("oldest beyond keep count is proposed", () => {
    const storage = storageWith([
      img("ghcr.io/tryweb/ai-engkit", "v1.24.9", { createdAt: "2026-11-23T00:00:00Z" }),
      img("ghcr.io/tryweb/ai-engkit", "v1.24.8", { createdAt: "2026-11-20T00:00:00Z" }),
      img("ghcr.io/tryweb/ai-engkit", "v1.24.7", { createdAt: "2026-11-10T00:00:00Z" }),
    ]);
    const plan = planHostMaintenance(storage, { ...policy, keepAiEngkitVersions: 2 });
    expect(plan.versioned.map((d) => d.ref)).toEqual(["ghcr.io/tryweb/ai-engkit:v1.24.7"]);
    expect(plan.tiers).toContain("versioned");
  });

  test("non-family images are never proposed", () => {
    const storage = storageWith([img("marketing-lo-base", "20261007")]);
    const plan = planHostMaintenance(storage, policy);
    expect(plan.versioned).toHaveLength(0);
    expect(plan.dangling).toHaveLength(0);
  });
});

describe("collectHostStorage", () => {
  test("parses docker outputs and marks in-use images", async () => {
    const docker = async (subcommand: string): Promise<ExecResult> => {
      if (subcommand.startsWith("system df")) {
        return ok(
          `${JSON.stringify({ Type: "Images", TotalCount: 3, Active: 1, Size: "5GB", Reclaimable: "2GB" })}\n` +
            `${JSON.stringify({ Type: "Build Cache", TotalCount: 1, Active: 0, Size: "4GB", Reclaimable: "3GB" })}\n`,
        );
      }
      if (subcommand.startsWith("images")) {
        return ok(
          `${JSON.stringify({ Repository: "demo", Tag: "v1", ID: "aaa111", CreatedAt: "2026-11-01", Size: "1GB" })}\n` +
            `${JSON.stringify({ Repository: "<none>", Tag: "<none>", ID: "bbb222", CreatedAt: "2026-10-01", Size: "100MB" })}\n`,
        );
      }
      if (subcommand.startsWith("ps")) return ok("aaa111\n");
      throw new Error(`unexpected: ${subcommand}`);
    };
    const exec = async (): Promise<ExecResult> =>
      ok("Filesystem 1B-blocks Used Available Use% Mounted on\n/dev/x 100 80 20 80% /\n");
    const storage = await collectHostStorage({ docker, exec });
    expect(storage.root?.availBytes).toBe(20);
    expect(storage.docker?.images.total).toBe(3);
    expect(storage.images).toHaveLength(2);
    expect(storage.images[0].inUse).toBe(true);
    expect(storage.images[1].inUse).toBe(false);
  });

  test("degrades to nulls when docker is unreachable", async () => {
    const failing = async (): Promise<ExecResult> => {
      throw new Error("no docker");
    };
    const storage = await collectHostStorage({ docker: failing, exec: failing });
    expect(storage.root).toBeNull();
    expect(storage.docker).toBeNull();
    expect(storage.images).toEqual([]);
  });
});

describe("runHostMaintenance", () => {
  beforeEach(() => {
    _resetHostMaintenanceState();
  });

  function fakeDocker(calls: string[]) {
    return async (subcommand: string): Promise<ExecResult> => {
      calls.push(subcommand);
      if (subcommand.startsWith("system df")) {
        return ok(
          `${JSON.stringify({ Type: "Images", TotalCount: 1, Active: 0, Size: "1GB", Reclaimable: "1GB" })}\n` +
            `${JSON.stringify({ Type: "Build Cache", TotalCount: 0, Active: 0, Size: "0B", Reclaimable: "0B" })}\n`,
        );
      }
      if (subcommand.startsWith("images")) {
        return ok(`${JSON.stringify({ Repository: "<none>", Tag: "<none>", ID: "deadbeef", CreatedAt: "x", Size: "10MB" })}\n`);
      }
      if (subcommand.startsWith("ps")) return ok("");
      if (subcommand.startsWith("image prune") || subcommand.startsWith("builder prune") || subcommand.startsWith("rmi ")) {
        return ok("done");
      }
      throw new Error(`unexpected: ${subcommand}`);
    };
  }

  const fakeExec = async (): Promise<ExecResult> =>
    ok("Filesystem 1B-blocks Used Available Use% Mounted on\n/dev/x 100 50 50 50% /\n");

  test("runs safe tiers and reports freed bytes", async () => {
    const calls: string[] = [];
    const result = await runHostMaintenance({
      docker: fakeDocker(calls),
      exec: fakeExec,
      policy: { ...DEFAULT_HOST_MAINTENANCE_POLICY },
      tiers: ["dangling", "builder"],
    });
    expect(result.ok).toBe(true);
    expect(calls.some((c) => c.startsWith("image prune -f"))).toBe(true);
    expect(calls.some((c) => c.startsWith("builder prune -f --keep-storage 5GB"))).toBe(true);
    expect(result.availBeforeBytes).toBe(50);
    expect(result.freedBytes).toBe(0);
    expect(getHostMaintenanceStatus().state).toBe("done");
    expect(getHostMaintenanceEventLog().length).toBeGreaterThan(0);
  });

  test("versioned tier requires confirmation", async () => {
    const calls: string[] = [];
    await expect(
      runHostMaintenance({ docker: fakeDocker(calls), exec: fakeExec, tiers: ["versioned"] }),
    ).rejects.toThrow("explicit confirmation");
    expect(calls.filter((c) => c.startsWith("rmi"))).toHaveLength(0);
  });

  test("rejects unknown tiers", async () => {
    await expect(
      runHostMaintenance({ tiers: ["nuke-everything" as never] }),
    ).rejects.toThrow("unknown cleanup tier");
  });

  test("refuses concurrent runs", async () => {
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blockingDocker = async (subcommand: string): Promise<ExecResult> => {
      if (subcommand.startsWith("image prune")) await gate;
      return fakeDocker(calls)(subcommand);
    };
    const first = runHostMaintenance({ docker: blockingDocker, exec: fakeExec, tiers: ["dangling"] });
    await expect(runHostMaintenance({ docker: fakeDocker([]), exec: fakeExec, tiers: ["dangling"] })).rejects.toThrow(
      "already running",
    );
    release();
    await first;
  });

  test("tier failure marks run failed but finishes", async () => {
    const badDocker = async (subcommand: string): Promise<ExecResult> => {
      if (subcommand.startsWith("image prune")) return { stdout: "", stderr: "boom", exitCode: 1 };
      return fakeDocker([])(subcommand);
    };
    const result = await runHostMaintenance({ docker: badDocker, exec: fakeExec, tiers: ["dangling"] });
    expect(result.ok).toBe(false);
    expect(getHostMaintenanceStatus().state).toBe("failed");
  });
});
