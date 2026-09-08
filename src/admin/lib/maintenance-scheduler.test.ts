import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nextDailyOccurrence,
  evaluateMaintenanceScheduler,
  createMaintenanceScheduler,
  getSchedulerStatus,
  DEFAULT_EVALUATION_INTERVAL_MS,
} from "./maintenance-scheduler";

const FIXED_NOW = Date.parse("2026-09-08T04:00:00.000Z");

function tmpStatePath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "sched-test-"));
  const p = join(dir, "maintenance-scheduler.json");
  return { dir, path: p };
}

describe("guarded daily scheduler — policy evaluation (4.1)", () => {
  test("disabled policy takes no action, records skip reason, persists evaluation timestamp", async () => {
    const { dir, path } = tmpStatePath();
    let runCalled = false;
    const result = await evaluateMaintenanceScheduler({
      readRetentionPolicy: () => ({ enabled: false, cutoffDays: 30, dailyRunAt: "03:00" }),
      getLastSuccessAt: () => new Date(FIXED_NOW - 1000).toISOString(),
      getMaintenanceState: () => "idle",
      getLastError: () => null,
      runMaintenance: async () => {
        runCalled = true;
        return true;
      },
      nowMs: () => FIXED_NOW,
      statePath: path,
    });

    expect(result.ran).toBe(false);
    expect(result.skipReason).toBe("policy disabled");
    expect(result.evaluationAt).toBe(new Date(FIXED_NOW).toISOString());
    expect(runCalled).toBe(false);

    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    expect(raw["lastEvaluationAt"]).toBe(new Date(FIXED_NOW).toISOString());
    expect(raw["lastSkipReason"]).toBe("policy disabled");
    expect(raw["lastRunAt"]).toBeNull();

    const status = getSchedulerStatus({ statePath: path });
    expect(status.lastEvaluationAt).toBe(new Date(FIXED_NOW).toISOString());
    expect(status.lastSkipReason).toBe("policy disabled");

    rmSync(dir, { recursive: true, force: true });
  });

  test("enabled-but-never-manually-run takes no action (last_success_at null)", async () => {
    const { dir, path } = tmpStatePath();
    let runCalled = false;
    const result = await evaluateMaintenanceScheduler({
      readRetentionPolicy: () => ({ enabled: true, cutoffDays: 30, dailyRunAt: "03:00" }),
      getLastSuccessAt: () => null,
      getMaintenanceState: () => "idle",
      getLastError: () => null,
      runMaintenance: async () => {
        runCalled = true;
        return true;
      },
      nowMs: () => FIXED_NOW,
      statePath: path,
    });

    expect(result.ran).toBe(false);
    expect(result.skipReason).toBe("no prior successful manual run");
    expect(runCalled).toBe(false);
    const status = getSchedulerStatus({ statePath: path });
    expect(status.lastSkipReason).toBe("no prior successful manual run");
    expect(status.lastEvaluationAt).toBe(new Date(FIXED_NOW).toISOString());

    rmSync(dir, { recursive: true, force: true });
  });

  test("guard failure records skip reason with zero deletes", async () => {
    const { dir, path } = tmpStatePath();
    let runCalled = false;
    let deleteCalls = 0;
    const guardMsg = "Insufficient disk space: 512 bytes free, need 15728640 bytes headroom (db 10485760 bytes × 1.5)";
    const result = await evaluateMaintenanceScheduler({
      readRetentionPolicy: () => ({ enabled: true, cutoffDays: 30, dailyRunAt: "03:00" }),
      getLastSuccessAt: () => new Date(FIXED_NOW - 2000).toISOString(),
      getMaintenanceState: () => "idle",
      getLastError: () => guardMsg,
      runMaintenance: async () => {
        runCalled = true;
        // Simulate engine guard refusal: no deletes performed
        return false;
      },
      maintenanceDeps: {
        runSql: async (sql: string) => {
          if (sql.includes("DELETE FROM")) deleteCalls++;
          return { stdout: "0", stderr: "", exitCode: 0 };
        },
      },
      nowMs: () => FIXED_NOW,
      statePath: path,
    });

    expect(runCalled).toBe(true);
    expect(result.ran).toBe(false);
    expect(result.skipReason).toBe(guardMsg);
    expect(deleteCalls).toBe(0);

    const status = getSchedulerStatus({ statePath: path });
    expect(status.lastSkipReason).toBe(guardMsg);
    expect(status.lastEvaluationAt).toBe(new Date(FIXED_NOW).toISOString());
    expect(status.lastRunAt).toBeNull();

    rmSync(dir, { recursive: true, force: true });
  });

  test("successful guarded run when enabled, prior success, and guards pass", async () => {
    const { dir, path } = tmpStatePath();
    const result = await evaluateMaintenanceScheduler({
      readRetentionPolicy: () => ({ enabled: true, cutoffDays: 30, dailyRunAt: "03:00" }),
      getLastSuccessAt: () => new Date(FIXED_NOW - 5000).toISOString(),
      getMaintenanceState: () => "idle",
      getLastError: () => null,
      runMaintenance: async () => true,
      nowMs: () => FIXED_NOW,
      statePath: path,
    });

    expect(result.ran).toBe(true);
    expect(result.skipReason).toBeNull();

    const status = getSchedulerStatus({ statePath: path });
    expect(status.lastSkipReason).toBeNull();
    expect(status.lastRunAt).toBe(new Date(FIXED_NOW).toISOString());
    expect(status.lastEvaluationAt).toBe(new Date(FIXED_NOW).toISOString());

    rmSync(dir, { recursive: true, force: true });
  });

  test("maintenance already in progress skips without calling engine", async () => {
    const { dir, path } = tmpStatePath();
    let runCalled = false;
    const result = await evaluateMaintenanceScheduler({
      readRetentionPolicy: () => ({ enabled: true, cutoffDays: 30, dailyRunAt: "03:00" }),
      getLastSuccessAt: () => new Date().toISOString(),
      getMaintenanceState: () => "running",
      runMaintenance: async () => {
        runCalled = true;
        return true;
      },
      nowMs: () => FIXED_NOW,
      statePath: path,
    });
    expect(result.ran).toBe(false);
    expect(result.skipReason).toBe("maintenance already in progress");
    expect(runCalled).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("persisted last-evaluation timestamp survives read, missed day evaluates next cycle without backfill", async () => {
    const { dir, path } = tmpStatePath();
    // First evaluation at FIXED_NOW
    await evaluateMaintenanceScheduler({
      readRetentionPolicy: () => ({ enabled: true, cutoffDays: 30, dailyRunAt: "03:00" }),
      getLastSuccessAt: () => new Date(FIXED_NOW).toISOString(),
      getMaintenanceState: () => "idle",
      getLastError: () => null,
      runMaintenance: async () => true,
      nowMs: () => FIXED_NOW,
      statePath: path,
    });

    const afterFirst = getSchedulerStatus({ statePath: path });
    expect(afterFirst.lastEvaluationAt).toBe(new Date(FIXED_NOW).toISOString());

    // Simulate server down for 3 days: clock jumps 3 intervals ahead.
    // Scheduler is stateless; next evaluation should be a single call, not 3 backfilled calls.
    let callCount = 0;
    const threeDaysLater = FIXED_NOW + 3 * DEFAULT_EVALUATION_INTERVAL_MS + 1000;
    const result2 = await evaluateMaintenanceScheduler({
      readRetentionPolicy: () => ({ enabled: true, cutoffDays: 30, dailyRunAt: "03:00" }),
      getLastSuccessAt: () => new Date(FIXED_NOW).toISOString(),
      getMaintenanceState: () => "idle",
      getLastError: () => null,
      runMaintenance: async () => {
        callCount++;
        return true;
      },
      nowMs: () => threeDaysLater,
      statePath: path,
    });

    expect(callCount).toBe(1);
    expect(result2.ran).toBe(true);
    expect(result2.evaluationAt).toBe(new Date(threeDaysLater).toISOString());

    const afterSecond = getSchedulerStatus({ statePath: path });
    expect(afterSecond.lastEvaluationAt).toBe(new Date(threeDaysLater).toISOString());

    rmSync(dir, { recursive: true, force: true });
  });

  test("uses injected clock (no real timer waits) — evaluationAt matches injected nowMs", async () => {
    const { dir, path } = tmpStatePath();
    const customNow = Date.parse("2026-01-15T12:34:56.000Z");
    const result = await evaluateMaintenanceScheduler({
      readRetentionPolicy: () => ({ enabled: false, cutoffDays: 14, dailyRunAt: "03:00" }),
      getLastSuccessAt: () => null,
      nowMs: () => customNow,
      statePath: path,
    });
    expect(result.evaluationAt).toBe(new Date(customNow).toISOString());
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("scheduler lifecycle wired to admin server start/stop (4.2) — integration", () => {
  test("lifecycle: disabled policy via scheduler instance takes no destructive action", async () => {
    const { dir, path } = tmpStatePath();
    let runCalled = false;
    const sched = createMaintenanceScheduler({
      readRetentionPolicy: () => ({ enabled: false, cutoffDays: 30, dailyRunAt: "03:00" }),
      getLastSuccessAt: () => new Date(FIXED_NOW).toISOString(),
      getMaintenanceState: () => "idle",
      getLastError: () => null,
      runMaintenance: async () => {
        runCalled = true;
        return true;
      },
      nowMs: () => FIXED_NOW,
      statePath: path,
      intervalMs: 60 * 60 * 1000,
    });

    expect(sched.isStarted()).toBe(false);
    const result = await sched.evaluate();
    expect(result.ran).toBe(false);
    expect(result.skipReason).toBe("policy disabled");
    expect(runCalled).toBe(false);
    expect(sched.getStatus().lastSkipReason).toBe("policy disabled");

    sched.start();
    expect(sched.isStarted()).toBe(true);
    sched.stop();
    expect(sched.isStarted()).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  });

  test("lifecycle: enabled-but-never-manually-run via scheduler instance takes no destructive action", async () => {
    const { dir, path } = tmpStatePath();
    let runCalled = false;
    const sched = createMaintenanceScheduler({
      readRetentionPolicy: () => ({ enabled: true, cutoffDays: 7, dailyRunAt: "03:00" }),
      getLastSuccessAt: () => null,
      getMaintenanceState: () => "idle",
      getLastError: () => null,
      runMaintenance: async () => {
        runCalled = true;
        return true;
      },
      nowMs: () => FIXED_NOW,
      statePath: path,
      intervalMs: 60 * 60 * 1000,
    });

    const result = await sched.evaluate();
    expect(result.ran).toBe(false);
    expect(result.skipReason).toBe("no prior successful manual run");
    expect(runCalled).toBe(false);
    expect(sched.getStatus().lastSkipReason).toBe("no prior successful manual run");

    // start/stop lifecycle does not trigger extra destructive run
    sched.start();
    // give the immediate due evaluation a tick to settle (it will evaluate again but still skip)
    await new Promise((r) => setTimeout(r, 20));
    expect(runCalled).toBe(false);
    sched.stop();

    rmSync(dir, { recursive: true, force: true });
  });

  test("lifecycle: guard failure via scheduler instance records skip reason with zero deletes", async () => {
    const { dir, path } = tmpStatePath();
    let deleteCalls = 0;
    const guardMsg = "Unable to determine free disk space — refusing to start";
    const sched = createMaintenanceScheduler({
      readRetentionPolicy: () => ({ enabled: true, cutoffDays: 30, dailyRunAt: "03:00" }),
      getLastSuccessAt: () => new Date(FIXED_NOW).toISOString(),
      getMaintenanceState: () => "idle",
      getLastError: () => guardMsg,
      runMaintenance: async () => false,
      maintenanceDeps: {
        runSql: async (sql: string) => {
          if (sql.includes("DELETE FROM")) deleteCalls++;
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      },
      nowMs: () => FIXED_NOW,
      statePath: path,
      intervalMs: 60 * 60 * 1000,
    });

    const result = await sched.evaluate();
    expect(result.ran).toBe(false);
    expect(result.skipReason).toBe(guardMsg);
    expect(deleteCalls).toBe(0);
    expect(sched.getStatus().lastSkipReason).toBe(guardMsg);

    sched.start();
    expect(sched.isStarted()).toBe(true);
    // stop clears interval; start is idempotent
    sched.start();
    expect(sched.isStarted()).toBe(true);
    sched.stop();
    expect(sched.isStarted()).toBe(false);
    sched.stop(); // idempotent

    rmSync(dir, { recursive: true, force: true });
  });

  test("lifecycle: persisted last-evaluation timestamp visible after evaluate, start is idempotent, stop is idempotent", async () => {
    const { dir, path } = tmpStatePath();
    const sched = createMaintenanceScheduler({
      readRetentionPolicy: () => ({ enabled: false, cutoffDays: 30, dailyRunAt: "03:00" }),
      getLastSuccessAt: () => null,
      nowMs: () => FIXED_NOW,
      statePath: path,
      intervalMs: 24 * 60 * 60 * 1000,
    });

    expect(existsSync(path)).toBe(false);
    await sched.evaluate();
    expect(existsSync(path)).toBe(true);
    const persisted = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    expect(persisted["lastEvaluationAt"]).toBe(new Date(FIXED_NOW).toISOString());

    sched.start();
    sched.start();
    expect(sched.isStarted()).toBe(true);
    sched.stop();
    sched.stop();
    expect(sched.isStarted()).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("nextDailyOccurrence wall-clock", () => {
  test("morning before run time returns same day", () => {
    const nowMs = new Date(2026, 8, 8, 1, 0, 0, 0).getTime();
    const expected = new Date(2026, 8, 8, 3, 0, 0, 0).getTime();
    expect(nextDailyOccurrence("03:00", nowMs)).toBe(expected);
  });

  test("evening after run time wraps to next day", () => {
    const nowMs = new Date(2026, 8, 8, 4, 0, 0, 0).getTime();
    const expected = new Date(2026, 8, 9, 3, 0, 0, 0).getTime();
    expect(nextDailyOccurrence("03:00", nowMs)).toBe(expected);
  });

  test("exact-minute boundary is strictly greater than now", () => {
    const nowMs = new Date(2026, 8, 8, 3, 0, 0, 0).getTime();
    const expected = new Date(2026, 8, 9, 3, 0, 0, 0).getTime();
    expect(nextDailyOccurrence("03:00", nowMs)).toBe(expected);
  });

  test("one second before run time returns imminent same-day occurrence", () => {
    const nowMs = new Date(2026, 8, 8, 2, 59, 59, 0).getTime();
    const expected = new Date(2026, 8, 8, 3, 0, 0, 0).getTime();
    expect(nextDailyOccurrence("03:00", nowMs)).toBe(expected);
  });

  test("midnight wrap 23:59 from 00:00", () => {
    const nowMs = new Date(2026, 8, 8, 0, 0, 0, 0).getTime();
    const expectedSame = new Date(2026, 8, 8, 23, 59, 0, 0).getTime();
    expect(nextDailyOccurrence("23:59", nowMs)).toBe(expectedSame);
    const lateMs = new Date(2026, 8, 8, 23, 59, 0, 0).getTime();
    const expectedNext = new Date(2026, 8, 9, 23, 59, 0, 0).getTime();
    expect(nextDailyOccurrence("23:59", lateMs)).toBe(expectedNext);
  });

  test("00:00 wraps correctly", () => {
    const nowMs = new Date(2026, 8, 8, 0, 0, 0, 0).getTime();
    expect(nextDailyOccurrence("00:00", nowMs)).toBe(new Date(2026, 8, 9, 0, 0, 0, 0).getTime());
    const beforeMidnight = new Date(2026, 8, 8, 23, 59, 0, 0).getTime();
    expect(nextDailyOccurrence("00:00", beforeMidnight)).toBe(new Date(2026, 8, 9, 0, 0, 0, 0).getTime());
  });

  test("invalid inputs throw with dailyRunAt message", () => {
    const nowMs = Date.now();
    const bad = ["24:00", "3:00", "03:60", "ab:cd", "", "03:00:00", " 03:00", "03:0"];
    for (const v of bad) {
      expect(() => nextDailyOccurrence(v, nowMs)).toThrow();
      try {
        nextDailyOccurrence(v, nowMs);
      } catch (e) {
        expect(String(e)).toContain("dailyRunAt");
      }
    }
  });

  test("recomputed from wall clock each cycle has no drift", () => {
    const day1 = new Date(2026, 8, 8, 2, 0, 0, 0).getTime();
    const first = nextDailyOccurrence("03:00", day1);
    const day2 = first + 60 * 1000;
    const second = nextDailyOccurrence("03:00", day2);
    expect(second).toBe(new Date(2026, 8, 9, 3, 0, 0, 0).getTime());
    expect(second - first).toBe(24 * 60 * 60 * 1000);
  });
});
