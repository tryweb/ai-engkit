import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getEventLog,
  getState,
  mergeEnvFromUpstream,
  pollAiDevHealth,
  parseReconcileOutput,
  pruneOldBackups,
  resolveBackupRetention,
  runUpgrade,
  type UpgradeDeps,
} from "./upgrade";
import type { ExecResult } from "./docker";

// These describes cover the V1 line contract (compose.yml, :latest image).
// The dev stack exports OMO_ENABLED=0, so pin the marker instead of
// inheriting the host env.
const PREV_OMO_ENABLED = process.env.OMO_ENABLED;
beforeAll(() => {
  process.env.OMO_ENABLED = "1";
});
afterAll(() => {
  if (PREV_OMO_ENABLED === undefined) delete process.env.OMO_ENABLED;
  else process.env.OMO_ENABLED = PREV_OMO_ENABLED;
});

describe("resolveBackupRetention", () => {
  test("defaults to 5 when BACKUP_RETENTION is missing", () => {
    expect(resolveBackupRetention({})).toBe(5);
  });

  test("parses a valid positive integer", () => {
    expect(resolveBackupRetention({ BACKUP_RETENTION: "3" })).toBe(3);
    expect(resolveBackupRetention({ BACKUP_RETENTION: "10" })).toBe(10);
  });

  test("falls back to 5 for invalid values", () => {
    expect(resolveBackupRetention({ BACKUP_RETENTION: "0" })).toBe(5);
    expect(resolveBackupRetention({ BACKUP_RETENTION: "-1" })).toBe(5);
    expect(resolveBackupRetention({ BACKUP_RETENTION: "abc" })).toBe(5);
    expect(resolveBackupRetention({ BACKUP_RETENTION: "3.5" })).toBe(5);
  });
});

describe("pruneOldBackups", () => {
  function rootWith(dirs: string[]): { root: string; cleanup: () => void } {
    const root = mkdtempSync(join(tmpdir(), "upgrade-prune-"));
    for (const d of dirs) {
      mkdirSync(join(root, d));
    }
    return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }

  test("removes oldest pre-* dirs beyond retention and returns their names", () => {
    const { root, cleanup } = rootWith(["pre-a", "pre-b", "pre-c", "pre-d"]);
    try {
      const removed = pruneOldBackups(root, 2);
      expect(removed).toEqual(["pre-a", "pre-b"]);
      expect(readdirSync(root).sort()).toEqual(["pre-c", "pre-d"]);
    } finally {
      cleanup();
    }
  });

  test("removes nothing when count is within retention", () => {
    const { root, cleanup } = rootWith(["pre-a", "pre-b"]);
    try {
      expect(pruneOldBackups(root, 5)).toEqual([]);
      expect(readdirSync(root).sort()).toEqual(["pre-a", "pre-b"]);
    } finally {
      cleanup();
    }
  });

  test("ignores retention below 1", () => {
    const { root, cleanup } = rootWith(["pre-a"]);
    try {
      expect(pruneOldBackups(root, 0)).toEqual([]);
      expect(readdirSync(root)).toEqual(["pre-a"]);
    } finally {
      cleanup();
    }
  });

  test("returns empty array for a missing backup root", () => {
    expect(pruneOldBackups(join(tmpdir(), "does-not-exist-xyz"), 2)).toEqual([]);
  });

  test("leaves non-pre-* entries untouched", () => {
    const { root, cleanup } = rootWith(["pre-a", "pre-b", "pre-c", "notes"]);
    try {
      pruneOldBackups(root, 2);
      expect(readdirSync(root).sort()).toEqual(["notes", "pre-b", "pre-c"]);
    } finally {
      cleanup();
    }
  });
});

describe("parseReconcileOutput", () => {
  test("parses a valid added count", () => {
    expect(parseReconcileOutput('{"added":2}')).toEqual({ added: 2 });
    expect(parseReconcileOutput('  {"added":0}  ')).toEqual({ added: 0 });
  });

  test("returns null for empty or non-JSON output", () => {
    expect(parseReconcileOutput("")).toBeNull();
    expect(parseReconcileOutput("   ")).toBeNull();
    expect(parseReconcileOutput("not json")).toBeNull();
  });

  test("returns null for wrong shapes", () => {
    expect(parseReconcileOutput("[1,2]")).toBeNull();
    expect(parseReconcileOutput("{}")).toBeNull();
    expect(parseReconcileOutput('{"added":"2"}')).toBeNull();
    expect(parseReconcileOutput('{"added":-1}')).toBeNull();
    expect(parseReconcileOutput('{"added":1.5}')).toBeNull();
  });
});

function okResult(stdout = ""): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function failResult(message: string): ExecResult {
  return { stdout: "", stderr: message, exitCode: 1 };
}

function parseEnvText(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return vars;
}

interface FakeWorld {
  dir: string;
  envFile: string;
  composeFile: string;
  backupDir: string;
  originalEnvBytes: string;
  originalComposeBytes: string;
  dockerOps: string[];
  pruneOldCalls: number;
  composeUpCalls: number;
  enqueueComposeUp: (result: ExecResult) => void;
  deps: UpgradeDeps;
  cleanup: () => void;
}

function makeWorld(overrides: UpgradeDeps = {}): FakeWorld {
  const dir = mkdtempSync(join(tmpdir(), "upgrade-run-"));
  const envFile = join(dir, ".env");
  const composeFile = join(dir, "compose.yml");
  const backupDir = join(dir, "backups");
  const originalEnvBytes = "KEEP=custom\nSECRET=a=b=c\nQUOTED=\"spaced value\"\n";
  const originalComposeBytes = "services:\n  ai-dev:\n    image: old\n    container_name: ai-engkit\n";
  writeFileSync(envFile, originalEnvBytes);
  writeFileSync(composeFile, originalComposeBytes);
  const dockerOps: string[] = [];
  const state = { pruneOldCalls: 0, composeUpCalls: 0, composeUpResults: [] as ExecResult[] };
  const deps: UpgradeDeps = {
    backupDir,
    composeFile,
    envFile,
    keysFile: join(dir, "provider-keys.json"),
    versionFile: join(dir, "VERSION"),
    resolveImage: () => "ghcr.io/tryweb/ai-engkit:latest",
    readLocalVersion: () => "v1.2.0",
    ensureComposeFile: async () => {},
    pullImage: async () => {
      dockerOps.push("pull");
      return okResult("pulled");
    },
    getContainerRef: async () => "fake-container",
    snapshotSettings: async () => {
      dockerOps.push("snapshot");
      return okResult("{}");
    },
    fetchComposeText: async () => "services:\n  ai-dev:\n    image: new\n",
    getProject: async () => "ai-engkit",
    composeUp: async () => {
      state.composeUpCalls++;
      dockerOps.push("composeUp");
      const next = state.composeUpResults.shift();
      return next ?? okResult("up");
    },
    reconcile: async () => okResult('{"added":0}'),
    pruneOld: () => {
      state.pruneOldCalls++;
      dockerOps.push("pruneOld");
      return [];
    },
    pruneImages: async () => {
      dockerOps.push("pruneImages");
      return okResult("pruned");
    },
    readEnv: () => parseEnvText(readFileSync(envFile, "utf-8")),
    writeEnv: (vars) => {
      writeFileSync(envFile, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
    },
    fetchEnvExample: async () => null,
    isRunning: async () => true,
    sleepMs: async () => {},
    ...overrides,
  };
  return {
    dir,
    envFile,
    composeFile,
    backupDir,
    originalEnvBytes,
    originalComposeBytes,
    dockerOps,
    get pruneOldCalls(): number {
      return state.pruneOldCalls;
    },
    get composeUpCalls(): number {
      return state.composeUpCalls;
    },
    enqueueComposeUp: (result: ExecResult) => {
      state.composeUpResults.push(result);
    },
    deps,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("mergeEnvFromUpstream", () => {
  test("fills missing keys with upstream defaults and preserves custom values", async () => {
    const store: Record<string, string> = { KEEP: "custom" };
    let writes = 0;
    await mergeEnvFromUpstream({
      readEnv: () => ({ ...store }),
      writeEnv: (vars) => {
        writes++;
        Object.assign(store, vars);
      },
      fetchEnvExample: async () => "KEEP=override\nNEW_VAR=default=value\nEMPTY=\n# comment\nNOEQUALS\n",
    });
    expect(store["KEEP"]).toBe("custom");
    expect(store["NEW_VAR"]).toBe("default=value");
    expect(store["EMPTY"]).toBe("");
    expect("NOEQUALS" in store).toBe(false);
    expect(writes).toBe(1);
  });

  test("does not write when the upstream example is unavailable", async () => {
    let writes = 0;
    await mergeEnvFromUpstream({
      readEnv: () => ({ A: "1" }),
      writeEnv: () => {
        writes++;
      },
      fetchEnvExample: async () => null,
    });
    expect(writes).toBe(0);
  });
});

describe("pollAiDevHealth", () => {
  test("resolves true after false->true transitions", async () => {
    const sequence: boolean[] = [false, false, true];
    let checks = 0;
    const result = await pollAiDevHealth(5000, {
      isRunning: async () => {
        checks++;
        return sequence.shift() ?? false;
      },
      sleepMs: async () => {},
      intervalMs: 1,
    });
    expect(result).toBe(true);
    expect(checks).toBe(3);
  });

  test("resolves false on timeout", async () => {
    let checks = 0;
    const result = await pollAiDevHealth(40, {
      isRunning: async () => {
        checks++;
        return false;
      },
      sleepMs: async () => {},
      intervalMs: 5,
    });
    expect(result).toBe(false);
    expect(checks).toBeGreaterThan(0);
  });
});

describe("runUpgrade pull failure", () => {
  test("fails without backup, rollback, prune, or volume operations", async () => {
    const world = makeWorld({ pullImage: async () => failResult("denied") });
    try {
      const result = await runUpgrade(world.deps);
      expect(result).toBe(false);
      expect(getState()).toBe("failed");
      const failure = getEventLog().find((e) => e.status === "failure");
      expect(failure?.step).toBe("digest_compare");
      expect(failure?.message).toContain("Failed to pull image");
      expect(failure?.message).toContain("denied");
      expect(world.composeUpCalls).toBe(0);
      expect(world.dockerOps).not.toContain("pruneImages");
      expect(world.pruneOldCalls).toBe(0);
      expect(world.dockerOps.join(" ")).not.toContain("volume");
      expect(existsSync(world.backupDir)).toBe(false);
      expect(readFileSync(world.envFile, "utf-8")).toBe(world.originalEnvBytes);
      expect(readFileSync(world.composeFile, "utf-8")).toBe(world.originalComposeBytes);
    } finally {
      world.cleanup();
    }
  });
});

describe("runUpgrade compose fetch failure", () => {
  test("fails closed before recreating ai-dev or pruning backups", async () => {
    let composeWrites = 0;
    let projectLookups = 0;
    const world = makeWorld({
      fetchComposeText: async () => null,
      writeComposeText: () => {
        composeWrites++;
      },
      getProject: async () => {
        projectLookups++;
        return "ai-engkit";
      },
    });
    try {
      const result = await runUpgrade(world.deps);
      expect(result).toBe(false);
      expect(getState()).toBe("failed");
      const failure = getEventLog().find((e) => e.status === "failure");
      expect(failure?.step).toBe("recreate");
      expect(failure?.message).toContain("Failed to fetch latest docker-compose.v2.yml");
      // No forward progress: the fetched-null path throws before the compose
      // file is written, so the live compose content and .env stay
      // byte-identical and no cleanup runs. The single composeUp call (and its
      // project lookup) below is the recreate-step rollback re-running compose
      // from the backup, not an upgrade attempt.
      expect(composeWrites).toBe(0);
      expect(projectLookups).toBe(1);
      expect(world.composeUpCalls).toBe(1);
      expect(world.pruneOldCalls).toBe(0);
      expect(world.dockerOps).not.toContain("pruneImages");
      expect(readFileSync(world.composeFile, "utf-8")).toBe(world.originalComposeBytes);
      expect(readFileSync(world.envFile, "utf-8")).toBe(world.originalEnvBytes);
    } finally {
      world.cleanup();
    }
  });
});

describe("runUpgrade recreate failure", () => {
  test("restores backup byte-for-byte and re-runs compose up without pruning", async () => {
    const world = makeWorld();
    world.enqueueComposeUp(failResult("bad compose"));
    try {
      const result = await runUpgrade(world.deps);
      expect(result).toBe(false);
      expect(getState()).toBe("failed");
      const failure = getEventLog().find((e) => e.status === "failure");
      expect(failure?.step).toBe("recreate");
      expect(failure?.message).toContain("Failed to recreate ai-dev");
      expect(failure?.message).toContain("bad compose");
      expect(failure?.message).toContain("rollback:");
      expect(failure?.message).toContain("restored .env, compose.yml");
      expect(world.composeUpCalls).toBe(2);
      expect(readFileSync(world.envFile, "utf-8")).toBe(world.originalEnvBytes);
      expect(readFileSync(world.composeFile, "utf-8")).toBe(world.originalComposeBytes);
      expect(world.dockerOps).not.toContain("pruneImages");
      expect(world.pruneOldCalls).toBe(0);
      expect(world.dockerOps.join(" ")).not.toContain("volume");
    } finally {
      world.cleanup();
    }
  });
});

describe("runUpgrade health timeout", () => {
  test("rolls back after poll failure and re-runs compose up", async () => {
    const world = makeWorld({
      isRunning: async () => false,
      healthTimeoutMs: 40,
      intervalMs: 5,
    });
    try {
      const result = await runUpgrade(world.deps);
      expect(result).toBe(false);
      const failure = getEventLog().find((e) => e.status === "failure");
      expect(failure?.step).toBe("poll_health");
      expect(failure?.message).toContain("did not become healthy");
      expect(failure?.message).toContain("rollback:");
      expect(world.dockerOps.filter((op) => op === "composeUp").length).toBe(2);
      expect(readFileSync(world.envFile, "utf-8")).toBe(world.originalEnvBytes);
      expect(readFileSync(world.composeFile, "utf-8")).toBe(world.originalComposeBytes);
      expect(world.dockerOps).not.toContain("pruneImages");
      expect(world.pruneOldCalls).toBe(0);
    } finally {
      world.cleanup();
    }
  });
});

describe("runUpgrade compose fetch failure (V2 line)", () => {
  let savedOmo: string | undefined;
  beforeAll(() => {
    savedOmo = process.env.OMO_ENABLED;
    process.env.OMO_ENABLED = "0";
  });
  afterAll(() => {
    if (savedOmo === undefined) delete process.env.OMO_ENABLED;
    else process.env.OMO_ENABLED = savedOmo;
  });

  test("fails closed before recreating ai-dev or pruning backups", async () => {
    let composeWrites = 0;
    let projectLookups = 0;
    const world = makeWorld({
      fetchComposeText: async () => null,
      writeComposeText: () => {
        composeWrites++;
      },
      getProject: async () => {
        projectLookups++;
        return "ai-engkit";
      },
    });
    try {
      const result = await runUpgrade(world.deps);
      expect(result).toBe(false);
      expect(getState()).toBe("failed");
      const failure = getEventLog().find((e) => e.status === "failure");
      expect(failure?.step).toBe("recreate");
      expect(failure?.message).toContain("Failed to fetch latest docker-compose.v2.yml");
      expect(composeWrites).toBe(0);
      expect(projectLookups).toBe(1);
      expect(world.composeUpCalls).toBe(1);
      expect(world.pruneOldCalls).toBe(0);
      expect(world.dockerOps).not.toContain("pruneImages");
      expect(readFileSync(world.composeFile, "utf-8")).toBe(world.originalComposeBytes);
      expect(readFileSync(world.envFile, "utf-8")).toBe(world.originalEnvBytes);
    } finally {
      world.cleanup();
    }
  });
});

describe("runUpgrade reconcile", () => {
  test("stays successful when reconcile fails (soft-fail)", async () => {
    const world = makeWorld({ reconcile: async () => failResult("script blew up") });
    try {
      const result = await runUpgrade(world.deps);
      expect(result).toBe(true);
      expect(getState()).toBe("completed");
      const events = getEventLog();
      const reconcileSuccess = events.find((e) => e.step === "reconcile" && e.status === "success");
      expect(reconcileSuccess?.message).toContain("Reconcile skipped");
      expect(reconcileSuccess?.message).toContain("script blew up");
      expect(events.find((e) => e.status === "failure")).toBeUndefined();
      expect(events.find((e) => e.step === "cleanup" && e.status === "success")?.message).toContain(
        "Upgrade complete",
      );
      expect(world.dockerOps).toContain("pruneImages");
      expect(world.pruneOldCalls).toBe(1);
    } finally {
      world.cleanup();
    }
  });

  test("reports restored registrations on reconcile success", async () => {
    const world = makeWorld({ reconcile: async () => okResult('{"added":2}') });
    try {
      expect(await runUpgrade(world.deps)).toBe(true);
      const reconcileSuccess = getEventLog().find((e) => e.step === "reconcile" && e.status === "success");
      expect(reconcileSuccess?.message).toContain("2 project registrations restored");
    } finally {
      world.cleanup();
    }
  });
});
