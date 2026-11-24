import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostMaintenanceRoutes } from "./host-maintenance";
import { DEFAULT_HOST_MAINTENANCE_POLICY } from "../lib/host-maintenance-policy";
import { nextDailyOccurrence } from "../lib/maintenance-scheduler";
import type { HostMaintenanceEvent, HostMaintenanceResult } from "../lib/host-maintenance";

const policy = {
  ...DEFAULT_HOST_MAINTENANCE_POLICY,
  protectedTags: [...DEFAULT_HOST_MAINTENANCE_POLICY.protectedTags],
};

describe("host maintenance routes", () => {
  test("versioned run without confirmed is rejected (400)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "host-routes-"));
    try {
      const app = createHostMaintenanceRoutes({
        policyPath: join(directory, "policy.json"),
        collectStorage: async () => ({
          freeSpaceBytes: 1,
          freeSpacePath: "/data",
          tmpFreeBytes: null,
          tmpPath: null,
          dockerDfRaw: null,
          dbFileSizeBytes: null,
          collectedAt: new Date().toISOString(),
        }),
        planHost: async () => ({ tiers: ["dangling", "builder"], versionedCandidates: [], note: "" }),
        readPolicyFrom: () => policy,
      });
      const res = await app.request("http://localhost/api/admin/host-maintenance/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tiers: ["versioned"] }),
      });
      expect(res.status).toBe(400);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("policy PUT rejects unknown fields and bad dailyRunAt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "host-routes-"));
    try {
      const app = createHostMaintenanceRoutes({
        policyPath: join(directory, "policy.json"),
        readPolicyFrom: () => policy,
      });
      const bad = await app.request("http://localhost/api/admin/host-maintenance/policy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...policy, dailyRunAt: "99:99" }),
      });
      expect(bad.status).toBe(400);
      const unknown = await app.request("http://localhost/api/admin/host-maintenance/policy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...policy, pruneAll: true }),
      });
      expect(unknown.status).toBe(400);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("schedule reports nextEvaluationAt from policy dailyRunAt", async () => {    const directory = await mkdtemp(join(tmpdir(), "host-routes-"));
    try {
      const app = createHostMaintenanceRoutes({
        policyPath: join(directory, "policy.json"),
        readPolicyFrom: () => policy,
        getSchedulerStatus: () => ({
          lastEvaluationAt: null,
          lastSkipReason: null,
          lastRunAt: null,
          isStarted: false,
        }),
        nowMs: () => new Date("2026-01-01T00:00:00Z").getTime(),
      });
      const res = await app.request("http://localhost/api/admin/host-maintenance/schedule");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { nextEvaluationAt: string | null };
      const expected = new Date(
        nextDailyOccurrence("03:00", new Date("2026-01-01T00:00:00Z").getTime()),
      ).toISOString();
      expect(body.nextEvaluationAt).toBe(expected);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("run returns 202 and second concurrent run returns 409", async () => {
    const directory = await mkdtemp(join(tmpdir(), "host-routes-"));
    try {
      let runCalls = 0;
      const app = createHostMaintenanceRoutes({
        policyPath: join(directory, "policy.json"),
        getState: () => "idle",
        readPolicyFrom: () => policy,
        // Never settles: keeps startInFlight true so the second POST hits 409.
        runHost: (() => {
          runCalls++;
          return new Promise<HostMaintenanceResult>(() => {});
        }) as never,
      });
      const first = await app.request("http://localhost/api/admin/host-maintenance/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tiers: ["dangling", "builder"] }),
      });
      expect(first.status).toBe(202);
      expect(runCalls).toBe(1);
      const second = await app.request("http://localhost/api/admin/host-maintenance/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tiers: ["dangling"] }),
      });
      expect(second.status).toBe(409);
      expect(runCalls).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("log SSE unsubscribes on terminal verify event via shared helper", async () => {
    const directory = await mkdtemp(join(tmpdir(), "host-routes-"));
    try {
      let capturedCb: ((e: HostMaintenanceEvent) => void) | null = null;
      let unsubCalls = 0;
      const app = createHostMaintenanceRoutes({
        policyPath: join(directory, "policy.json"),
        getState: () => "idle",
        getEventLog: () => [],
        subscribe: ((cb: (e: HostMaintenanceEvent) => void) => {
          capturedCb = cb;
          return () => {
            unsubCalls++;
          };
        }) as typeof import("../lib/host-maintenance").subscribeHostMaintenance,
        readPolicyFrom: () => policy,
      });
      const res = await app.request("http://localhost/api/admin/host-maintenance/log");
      expect(res.status).toBe(200);
      expect(capturedCb).not.toBeNull();
      capturedCb!({ id: 1, step: "verify", status: "success", message: "done", timestamp: new Date().toISOString() });
      expect(unsubCalls).toBe(1);
      try {
        await res.body?.cancel();
      } catch {}
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
