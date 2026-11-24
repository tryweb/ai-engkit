import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostMaintenanceRoutes } from "./host-maintenance";
import { DEFAULT_HOST_MAINTENANCE_POLICY, type HostMaintenancePolicy } from "../lib/host-maintenance-policy";
import type { HostStorage } from "../lib/host-maintenance";

const GB = 1024 * 1024 * 1024;

function fixtureStorage(): HostStorage {
  return {
    root: { path: "/", totalBytes: 100 * GB, usedBytes: 90 * GB, availBytes: 10 * GB, usePercent: 90 },
    tmp: null,
    docker: {
      images: { total: 1, active: 0, sizeBytesApprox: GB, reclaimableBytesApprox: GB },
      containers: { total: 0, active: 0, sizeBytesApprox: null, reclaimableBytesApprox: 0 },
      volumes: { total: 0, active: 0, sizeBytesApprox: null, reclaimableBytesApprox: null },
      buildCache: { total: 4, active: 0, sizeBytesApprox: 4 * GB, reclaimableBytesApprox: 3 * GB },
    },
    images: [],
    collectedAt: new Date().toISOString(),
  };
}

describe("host maintenance routes", () => {
  let dir: string;
  let policyPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hm-routes-"));
    policyPath = join(dir, "policy.json");
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function makeApp(overrides: Parameters<typeof createHostMaintenanceRoutes>[0] = {}) {
    return createHostMaintenanceRoutes({
      collectStorage: async () => fixtureStorage(),
      getState: () => "idle",
      getStatus: () => ({ state: "idle", lastRunAt: null, lastError: null, lastFreedBytes: null }),
      getEventLog: () => [],
      subscribe: () => () => {},
      getSchedulerStatus: () => ({
        lastEvaluationAt: null,
        lastSkipReason: null,
        lastRunAt: null,
        isStarted: true,
      }),
      nowMs: () => new Date("2026-11-24T00:00:00Z").getTime(),
      policyPath,
      ...overrides,
    });
  }

  test("GET status returns storage, watermark and maintenance state", async () => {
    const app = makeApp();
    const res = await app.request("http://localhost/api/admin/host-maintenance/status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { watermark: string; storage: HostStorage };
    // 10GB free with warn=10/crit=8 → exactly at warn boundary is "ok" (>= warn), use 10GB → ok
    expect(["ok", "warn"]).toContain(body.watermark);
    expect(body.storage.root?.availBytes).toBe(10 * GB);
  });

  test("GET plan returns dry-run tiers", async () => {
    const app = makeApp();
    const res = await app.request("http://localhost/api/admin/host-maintenance/plan");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tiers: string[] };
    expect(body.tiers).toContain("builder");
  });

  test("GET policy falls back to defaults when file is missing", async () => {
    const app = makeApp();
    const res = await app.request("http://localhost/api/admin/host-maintenance/policy");
    expect(res.status).toBe(200);
    const body = (await res.json()) as HostMaintenancePolicy;
    expect(body.enabled).toBe(true);
  });

  test("PUT policy validates and persists, then notifies", async () => {
    let saved = 0;
    const app = makeApp({ onPolicySaved: () => saved++ });
    const bad = await app.request("http://localhost/api/admin/host-maintenance/policy", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...DEFAULT_HOST_MAINTENANCE_POLICY, dailyRunAt: "whenever" }),
    });
    expect(bad.status).toBe(400);

    const good = await app.request("http://localhost/api/admin/host-maintenance/policy", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...DEFAULT_HOST_MAINTENANCE_POLICY, enabled: false }),
    });
    expect(good.status).toBe(200);
    expect(saved).toBe(1);
    const reread = await app.request("http://localhost/api/admin/host-maintenance/policy");
    expect(((await reread.json()) as HostMaintenancePolicy).enabled).toBe(false);
  });

  test("POST run defaults to safe tiers and returns 202", async () => {
    const seen: Array<{ tiers: string[]; confirmed: boolean }> = [];
    const app = makeApp({
      runCleanup: async (tiers, confirmed) => {
        seen.push({ tiers: [...tiers], confirmed });
      },
    });
    const res = await app.request("http://localhost/api/admin/host-maintenance/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(202);
    expect(seen).toHaveLength(1);
    expect(seen[0].tiers).toEqual(["dangling", "builder"]);
  });

  test("POST run rejects versioned without confirmation", async () => {
    let ran = 0;
    const app = makeApp({
      runCleanup: async () => {
        ran++;
      },
    });
    const res = await app.request("http://localhost/api/admin/host-maintenance/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tiers: ["versioned"] }),
    });
    expect(res.status).toBe(400);
    expect(ran).toBe(0);
  });

  test("POST run rejects unknown tiers", async () => {
    const app = makeApp({ runCleanup: async () => {} });
    const res = await app.request("http://localhost/api/admin/host-maintenance/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tiers: ["nuke"] }),
    });
    expect(res.status).toBe(400);
  });

  test("POST run returns 409 while running", async () => {
    const app = makeApp({ getState: () => "running" });
    const res = await app.request("http://localhost/api/admin/host-maintenance/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
  });

  test("GET schedule reports next evaluation", async () => {
    const app = makeApp();
    const res = await app.request("http://localhost/api/admin/host-maintenance/schedule");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { isStarted: boolean; nextEvaluationAt: string | null };
    expect(body.isStarted).toBe(true);
    expect(body.nextEvaluationAt).toContain("2026-11-24");
  });

  test("GET log history returns events", async () => {
    const app = makeApp({
      getEventLog: () => [{ at: "2026-11-24T00:00:00Z", tier: "all" as const, message: "cleanup done" }],
    });
    const res = await app.request("http://localhost/api/admin/host-maintenance/log?history=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ message: string }>;
    expect(body).toHaveLength(1);
  });

  test("GET page renders", async () => {
    const app = makeApp();
    const res = await app.request("http://localhost/host-maintenance");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Host Maintenance");
  });
});
