import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHostMaintenanceScheduler,
  evaluateHostMaintenanceScheduler,
  getHostSchedulerStatus,
} from "./host-maintenance-scheduler";
import { DEFAULT_HOST_MAINTENANCE_POLICY } from "./host-maintenance-policy";

describe("evaluateHostMaintenanceScheduler", () => {
  let dir: string;
  let statePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hm-sched-"));
    statePath = join(dir, "sched.json");
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function baseDeps(overrides = {}) {
    return {
      readPolicy: () => ({ ...DEFAULT_HOST_MAINTENANCE_POLICY }),
      getState: () => "idle",
      getLastError: () => null as string | null,
      runCleanup: async () => ({ ok: true }),
      isUpgradeRunning: () => false,
      nowMs: () => new Date("2026-11-24T00:00:00Z").getTime(),
      statePath,
      intervalMs: 1000,
      ...overrides,
    };
  }

  test("skips when policy is disabled", async () => {
    let ran = 0;
    const result = await evaluateHostMaintenanceScheduler(
      baseDeps({
        readPolicy: () => ({ ...DEFAULT_HOST_MAINTENANCE_POLICY, enabled: false }),
        runCleanup: async () => {
          ran++;
          return { ok: true };
        },
      }),
    );
    expect(result.ran).toBe(false);
    expect(result.skipReason).toBe("policy disabled");
    expect(ran).toBe(0);
  });

  test("skips while an upgrade is running", async () => {
    let ran = 0;
    const result = await evaluateHostMaintenanceScheduler(
      baseDeps({
        isUpgradeRunning: () => true,
        runCleanup: async () => {
          ran++;
          return { ok: true };
        },
      }),
    );
    expect(result.ran).toBe(false);
    expect(result.skipReason).toBe("upgrade in progress");
    expect(ran).toBe(0);
  });

  test("skips while maintenance is already running", async () => {
    const result = await evaluateHostMaintenanceScheduler(baseDeps({ getState: () => "running" }));
    expect(result.ran).toBe(false);
    expect(result.skipReason).toBe("maintenance already in progress");
  });

  test("runs only safe tiers when enabled", async () => {
    const seen: string[][] = [];
    const result = await evaluateHostMaintenanceScheduler(
      baseDeps({
        runCleanup: async (tiers: string[]) => {
          seen.push(tiers);
          return { ok: true };
        },
      }),
    );
    expect(result.ran).toBe(true);
    expect(seen).toEqual([["dangling", "builder"]]);
    const status = getHostSchedulerStatus(baseDeps({}));
    expect(status.lastRunAt).toBe("2026-11-24T00:00:00.000Z");
  });
});

describe("createHostMaintenanceScheduler", () => {
  test("start/stop/reschedule lifecycle", async () => {
    const sched = createHostMaintenanceScheduler({
      readPolicy: () => ({ ...DEFAULT_HOST_MAINTENANCE_POLICY, enabled: false }),
      nowMs: () => Date.now(),
      intervalMs: 60_000,
      statePath: join(mkdtempSync(join(tmpdir(), "hm-life-")), "s.json"),
      readState: () => null,
      writeState: () => {},
    });
    expect(sched.isStarted()).toBe(false);
    sched.start();
    expect(sched.isStarted()).toBe(true);
    sched.reschedule();
    expect(sched.getStatus().isStarted).toBe(true);
    sched.stop();
    expect(sched.isStarted()).toBe(false);
  });
});
