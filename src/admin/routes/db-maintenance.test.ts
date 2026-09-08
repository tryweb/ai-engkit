import { describe, test, expect } from "bun:test";
import { createDbMaintenanceRoutes } from "./db-maintenance";
import { nextDailyOccurrence } from "../lib/maintenance-scheduler";

describe("db-maintenance schedule route", () => {
  test("never evaluated → nextEvaluationAt is wall-clock occurrence", async () => {
    const nowMs = Date.parse("2026-09-08T02:00:00.000Z");
    const app = createDbMaintenanceRoutes({
      getSchedulerStatus: () => ({
        isStarted: false,
        lastEvaluationAt: null,
        lastSkipReason: null,
        lastRunAt: null,
      }),
      schedulerIntervalMs: 24 * 60 * 60 * 1000,
      readRetentionPolicy: () => ({ enabled: true, cutoffDays: 30, dailyRunAt: "03:00" }),
      nowMs: () => nowMs,
    });
    const res = await app.request("http://localhost/api/admin/db-maintenance/schedule");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      isStarted: boolean;
      lastEvaluationAt: string | null;
      lastSkipReason: string | null;
      lastRunAt: string | null;
      intervalMs: number;
      nextEvaluationAt: string | null;
    };
    expect(body.isStarted).toBe(false);
    expect(body.lastEvaluationAt).toBeNull();
    const expected = new Date(nextDailyOccurrence("03:00", nowMs)).toISOString();
    expect(body.nextEvaluationAt).toBe(expected);
    expect(body.intervalMs).toBe(24 * 60 * 60 * 1000);
  });

  test("wall-clock occurrence math: morning before run time", async () => {
    const nowMs = Date.parse("2026-09-08T01:00:00.000Z");
    const app = createDbMaintenanceRoutes({
      getSchedulerStatus: () => ({
        isStarted: true,
        lastEvaluationAt: "2026-09-07T03:00:00.000Z",
        lastSkipReason: null,
        lastRunAt: "2026-09-07T03:00:00.000Z",
      }),
      schedulerIntervalMs: 24 * 60 * 60 * 1000,
      readRetentionPolicy: () => ({ enabled: true, cutoffDays: 30, dailyRunAt: "03:00" }),
      nowMs: () => nowMs,
    });
    const res = await app.request("http://localhost/api/admin/db-maintenance/schedule");
    const body = (await res.json()) as { nextEvaluationAt: string | null };
    const expected = new Date(nextDailyOccurrence("03:00", nowMs)).toISOString();
    expect(body.nextEvaluationAt).toBe(expected);
  });

  test("wall-clock occurrence math: evening after run time wraps to next day", async () => {
    const nowMs = Date.parse("2026-09-08T04:00:00.000Z");
    const app = createDbMaintenanceRoutes({
      getSchedulerStatus: () => ({
        isStarted: true,
        lastEvaluationAt: "2026-09-08T03:00:00.000Z",
        lastSkipReason: null,
        lastRunAt: "2026-09-08T03:00:00.000Z",
      }),
      schedulerIntervalMs: 24 * 60 * 60 * 1000,
      readRetentionPolicy: () => ({ enabled: true, cutoffDays: 30, dailyRunAt: "03:00" }),
      nowMs: () => nowMs,
    });
    const res = await app.request("http://localhost/api/admin/db-maintenance/schedule");
    const body = (await res.json()) as { nextEvaluationAt: string | null };
    const expected = new Date(nextDailyOccurrence("03:00", nowMs)).toISOString();
    expect(body.nextEvaluationAt).toBe(expected);
  });

  test("bad stored dailyRunAt falls back to 03:00", async () => {
    const nowMs = Date.parse("2026-09-08T10:00:00.000Z");
    const app = createDbMaintenanceRoutes({
      getSchedulerStatus: () => ({
        isStarted: true,
        lastEvaluationAt: "2026-09-08T03:00:00.000Z",
        lastSkipReason: null,
        lastRunAt: "2026-09-08T03:00:00.000Z",
      }),
      schedulerIntervalMs: 24 * 60 * 60 * 1000,
      readRetentionPolicy: () => ({ enabled: true, cutoffDays: 30, dailyRunAt: "99:99" } as unknown as { enabled: boolean; cutoffDays: number; dailyRunAt: string }),
      nowMs: () => nowMs,
    });
    const res = await app.request("http://localhost/api/admin/db-maintenance/schedule");
    const body = (await res.json()) as { nextEvaluationAt: string | null };
    const expected = new Date(nextDailyOccurrence("03:00", nowMs)).toISOString();
    expect(body.nextEvaluationAt).toBe(expected);
  });

  test("skip reason passthrough and lastRunAt passthrough", async () => {
    const last = "2026-09-07T12:00:00.000Z";
    const reason = "policy disabled";
    const nowMs = Date.parse("2026-09-08T02:00:00.000Z");
    const app = createDbMaintenanceRoutes({
      getSchedulerStatus: () => ({
        isStarted: false,
        lastEvaluationAt: last,
        lastSkipReason: reason,
        lastRunAt: null,
      }),
      schedulerIntervalMs: 24 * 60 * 60 * 1000,
      readRetentionPolicy: () => ({ enabled: false, cutoffDays: 30, dailyRunAt: "03:00" }),
      nowMs: () => nowMs,
    });
    const res = await app.request("http://localhost/api/admin/db-maintenance/schedule");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lastSkipReason: string | null;
      lastEvaluationAt: string | null;
      lastRunAt: string | null;
      nextEvaluationAt: string | null;
    };
    expect(body.lastSkipReason).toBe(reason);
    expect(body.lastEvaluationAt).toBe(last);
    expect(body.lastRunAt).toBeNull();
    expect(body.nextEvaluationAt).toBe(new Date(nextDailyOccurrence("03:00", nowMs)).toISOString());
  });

  test("evaluated with skip reason preserves next as wall-clock occurrence", async () => {
    const nowMs = Date.parse("2026-09-08T02:30:00.000Z");
    const app = createDbMaintenanceRoutes({
      getSchedulerStatus: () => ({
        isStarted: true,
        lastEvaluationAt: "2026-09-08T00:00:00.000Z",
        lastSkipReason: "no prior successful manual run",
        lastRunAt: null,
      }),
      schedulerIntervalMs: 24 * 60 * 60 * 1000,
      readRetentionPolicy: () => ({ enabled: true, cutoffDays: 30, dailyRunAt: "03:00" }),
      nowMs: () => nowMs,
    });
    const res = await app.request("http://localhost/api/admin/db-maintenance/schedule");
    const body = (await res.json()) as {
      lastSkipReason: string | null;
      nextEvaluationAt: string | null;
    };
    expect(body.lastSkipReason).toBe("no prior successful manual run");
    expect(body.nextEvaluationAt).toBe(new Date(nextDailyOccurrence("03:00", nowMs)).toISOString());
  });

  test("custom dailyRunAt 22:15 respects wall-clock occurrence", async () => {
    const nowMs = Date.parse("2026-09-08T10:00:00.000Z");
    const app = createDbMaintenanceRoutes({
      getSchedulerStatus: () => ({
        isStarted: true,
        lastEvaluationAt: null,
        lastSkipReason: null,
        lastRunAt: null,
      }),
      schedulerIntervalMs: 24 * 60 * 60 * 1000,
      readRetentionPolicy: () => ({ enabled: true, cutoffDays: 30, dailyRunAt: "22:15" }),
      nowMs: () => nowMs,
    });
    const res = await app.request("http://localhost/api/admin/db-maintenance/schedule");
    const body = (await res.json()) as { nextEvaluationAt: string | null };
    expect(body.nextEvaluationAt).toBe(new Date(nextDailyOccurrence("22:15", nowMs)).toISOString());
  });
});
