import { describe, expect, test } from "bun:test";
import {
  _resetHostMaintenanceState,
  getHostMaintenanceState,
  planHostMaintenance,
  runHostMaintenance,
  watermarkStatus,
  type HostMaintenanceDeps,
} from "./host-maintenance";
import { DEFAULT_HOST_MAINTENANCE_POLICY } from "./host-maintenance-policy";

const okDocker = (seen: string[]) => async (subcommand: string) => {
  seen.push(subcommand);
  if (subcommand.startsWith("ps ")) {
    return { stdout: "ai-engkit:latest\n", stderr: "", exitCode: 0 };
  }
  if (subcommand.startsWith("images ")) {
    return {
      stdout: [
        "ghcr.io/tryweb/ai-engkit  latest  abc123  2 days ago  500MB",
        "ghcr.io/tryweb/ai-engkit  v1.24.8  def456  3 weeks ago  499MB",
        "ghcr.io/tryweb/ai-engkit  v1.24.0  old999  2 months ago  490MB",
      ].join("\n"),
      stderr: "",
      exitCode: 0,
    };
  }
  return { stdout: "ok", stderr: "", exitCode: 0 };
};

describe("host maintenance lib", () => {
  test("watermark thresholds use bytes with crit < warn", () => {
    expect(watermarkStatus(null, DEFAULT_HOST_MAINTENANCE_POLICY)).toBe("unknown");
    expect(watermarkStatus(20 * 1024 ** 3, DEFAULT_HOST_MAINTENANCE_POLICY)).toBe("ok");
    expect(watermarkStatus(9 * 1024 ** 3, DEFAULT_HOST_MAINTENANCE_POLICY)).toBe("warn");
    expect(watermarkStatus(1 * 1024 ** 3, DEFAULT_HOST_MAINTENANCE_POLICY)).toBe("crit");
  });

  test("plan excludes running + kept versions, never deletes", async () => {
    const seen: string[] = [];
    const deps: HostMaintenanceDeps = {
      docker: okDocker(seen),
      collectDbHealth: async () => ({
        fileSizeBytes: 1,
        freeSpaceBytes: 1,
        freeSpacePath: "/data",
        inspectionCopyEstimate: { tempPath: "/tmp", freeBytes: 1 },
      }),
    };
    const plan = await planHostMaintenance(deps);
    expect(plan.tiers).toEqual(["dangling", "builder"]);
    // Regression: the --format template contains spaces, so it must be
    // single-quoted — otherwise parseSubcommand splits it into extra argv
    // tokens and `docker images` fails (real daemon returns zero rows).
    const imagesCall = seen.find((s) => s.startsWith("images "));
    expect(imagesCall).toContain("--format '{{.Repository}}");
    expect(plan.versionedCandidates.length).toBe(3);
    // abc123 is "running" (ps output) OR kept; old999 must be the only removable candidate
    const removable = plan.versionedCandidates.filter((c) => c.excludedReason === null);
    expect(removable.map((c) => c.imageId)).toEqual(["old999"]);
    expect(seen.some((s) => s.includes("prune"))).toBe(false);
  });

  test("run executes only P0 tiers via dockerCommand and blocks versioned", async () => {
    _resetHostMaintenanceState();
    const seen: string[] = [];
    const deps: HostMaintenanceDeps = {
      docker: okDocker(seen),
      getUpgradeState: () => "idle",
    };
    const result = await runHostMaintenance({ ...deps, tiers: ["dangling", "builder"] });
    expect(result.ok).toBe(true);
    expect(seen).toContain("image prune -f");
    expect(seen.some((s) => s.startsWith("builder prune"))).toBe(true);
    expect(seen.some((s) => s.includes("-a"))).toBe(false);
    expect(seen.some((s) => s.includes("system prune"))).toBe(false);
    expect(seen.some((s) => s.includes("volume prune"))).toBe(false);
    expect(getHostMaintenanceState()).toBe("done");
  });

  test("run rejects versioned tier without auto-execution", async () => {
    _resetHostMaintenanceState();
    const seen: string[] = [];
    await expect(
      runHostMaintenance({ docker: okDocker(seen), tiers: ["versioned"] }),
    ).rejects.toThrow();
    expect(seen.length).toBe(0);
  });

  test("run refuses while upgrade is running and makes no docker calls", async () => {
    _resetHostMaintenanceState();
    const seen: string[] = [];
    await expect(
      runHostMaintenance({ docker: okDocker(seen), getUpgradeState: () => "running" }),
    ).rejects.toThrow("upgrade_in_progress");
    expect(seen.length).toBe(0);
  });
});
