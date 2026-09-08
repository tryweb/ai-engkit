import { describe, test, expect } from "bun:test";
import { createDbMaintenanceRoutes } from "./db-maintenance";
import type { MaintenanceEvent } from "../lib/db-maintenance";

function makeEvent(step: MaintenanceEvent["step"], status: MaintenanceEvent["status"]): MaintenanceEvent {
  return { id: 1, step, status, message: "msg", timestamp: new Date().toISOString() };
}

describe("blocker: /api/admin/db-maintenance/log SSE cleanup", () => {
  test("unsubscribes on terminal verify success and avoids enqueue-after-close", async () => {
    let capturedCb: ((e: MaintenanceEvent) => void) | null = null;
    let unsubCalls = 0;
    const mockUnsub = () => {
      unsubCalls++;
    };
    const mockSubscribe = (cb: (e: MaintenanceEvent) => void) => {
      capturedCb = cb;
      return mockUnsub;
    };
    const app = createDbMaintenanceRoutes({
      getState: () => "idle",
      getStatus: () => ({ state: "idle", events: [], current_step: "", progress_pct: 0, last_success_at: null, last_error: null }) as never,
      getEventLog: () => [],
      subscribe: mockSubscribe as never,
      runMaintenance: async () => true,
      getDeleteCounts: async () => ({ sessions: 0, eventSequences: 0 }),
      readRetentionPolicy: () => ({ enabled: true, cutoffDays: 30, dailyRunAt: "03:00" }),
    });

    const res = await app.request("http://localhost/api/admin/db-maintenance/log");
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    expect(capturedCb).not.toBeNull();

    // Trigger terminal event
    capturedCb!(makeEvent("verify", "success"));
    expect(unsubCalls).toBe(1);

    // Enqueue-after-close must be avoided: second event after close should not throw
    let threw = false;
    try {
      capturedCb!(makeEvent("verify", "success"));
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(unsubCalls).toBe(1); // idempotent: second terminal does not double-unsub

    // After 1.1s the stream should be closed; reading should be done
    await new Promise((r) => setTimeout(r, 1100));
    // Cancel remaining reader to cleanup
    try {
      await reader?.cancel();
    } catch {}
    expect(unsubCalls).toBe(1); // cancel after terminal should not add another unsub
  });

  test("unsubscribes on request abort", async () => {
    let capturedCb: ((e: MaintenanceEvent) => void) | null = null;
    let unsubCalls = 0;
    const mockSubscribe = (cb: (e: MaintenanceEvent) => void) => {
      capturedCb = cb;
      return () => {
        unsubCalls++;
      };
    };
    const app = createDbMaintenanceRoutes({
      getState: () => "idle",
      getStatus: () => ({ state: "idle", events: [], current_step: "", progress_pct: 0, last_success_at: null, last_error: null }) as never,
      getEventLog: () => [],
      subscribe: mockSubscribe as never,
      runMaintenance: async () => true,
      getDeleteCounts: async () => ({ sessions: 0, eventSequences: 0 }),
      readRetentionPolicy: () => ({ enabled: true, cutoffDays: 30, dailyRunAt: "03:00" }),
    });

    const controller = new AbortController();
    const req = new Request("http://localhost/api/admin/db-maintenance/log", { signal: controller.signal });
    const res = await app.request(req);
    expect(res.status).toBe(200);
    expect(capturedCb).not.toBeNull();
    expect(unsubCalls).toBe(0);
    controller.abort();
    // Give event loop a tick for abort listener
    await new Promise((r) => setTimeout(r, 10));
    expect(unsubCalls).toBe(1);
    // Second abort should be idempotent
    controller.abort();
    await new Promise((r) => setTimeout(r, 10));
    expect(unsubCalls).toBe(1);
    // Cleanup reader
    try {
      await res.body?.cancel();
    } catch {}
  });

  test("unsubscribes on stream cancel", async () => {
    let unsubCalls = 0;
    const mockSubscribe = (cb: (e: MaintenanceEvent) => void) => {
      void cb;
      return () => {
        unsubCalls++;
      };
    };
    const app = createDbMaintenanceRoutes({
      getState: () => "idle",
      getStatus: () => ({ state: "idle", events: [], current_step: "", progress_pct: 0, last_success_at: null, last_error: null }) as never,
      getEventLog: () => [],
      subscribe: mockSubscribe as never,
      runMaintenance: async () => true,
      getDeleteCounts: async () => ({ sessions: 0, eventSequences: 0 }),
      readRetentionPolicy: () => ({ enabled: true, cutoffDays: 30, dailyRunAt: "03:00" }),
    });

    const res = await app.request("http://localhost/api/admin/db-maintenance/log");
    expect(res.status).toBe(200);
    expect(unsubCalls).toBe(0);
    await res.body?.cancel();
    expect(unsubCalls).toBe(1);
    // Second cancel should be idempotent
    try {
      await res.body?.cancel();
    } catch {}
    expect(unsubCalls).toBe(1);
  });

  test("enqueue-after-close is avoided: no throw when event emitted after abort", async () => {
    let capturedCb: ((e: MaintenanceEvent) => void) | null = null;
    let unsubCalls = 0;
    const mockSubscribe = (cb: (e: MaintenanceEvent) => void) => {
      capturedCb = cb;
      return () => {
        unsubCalls++;
      };
    };
    const app = createDbMaintenanceRoutes({
      getState: () => "idle",
      getStatus: () => ({ state: "idle", events: [], current_step: "", progress_pct: 0, last_success_at: null, last_error: null }) as never,
      getEventLog: () => [],
      subscribe: mockSubscribe as never,
      runMaintenance: async () => true,
      getDeleteCounts: async () => ({ sessions: 0, eventSequences: 0 }),
      readRetentionPolicy: () => ({ enabled: true, cutoffDays: 30, dailyRunAt: "03:00" }),
    });

    const controller = new AbortController();
    const req = new Request("http://localhost/api/admin/db-maintenance/log", { signal: controller.signal });
    const res = await app.request(req);
    expect(capturedCb).not.toBeNull();
    controller.abort();
    await new Promise((r) => setTimeout(r, 10));
    expect(unsubCalls).toBe(1);
    let threw = false;
    try {
      capturedCb!(makeEvent("backup", "running"));
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    try {
      await res.body?.cancel();
    } catch {}
  });

  test("unsubscribes on terminal verify failure", async () => {
    let unsubCalls = 0;
    let capturedCb: ((e: MaintenanceEvent) => void) | null = null;
    const mockSubscribe = (cb: (e: MaintenanceEvent) => void) => {
      capturedCb = cb;
      return () => {
        unsubCalls++;
      };
    };
    const app = createDbMaintenanceRoutes({
      getState: () => "idle",
      getStatus: () => ({ state: "idle", events: [], current_step: "", progress_pct: 0, last_success_at: null, last_error: null }) as never,
      getEventLog: () => [],
      subscribe: mockSubscribe as never,
      runMaintenance: async () => true,
      getDeleteCounts: async () => ({ sessions: 0, eventSequences: 0 }),
      readRetentionPolicy: () => ({ enabled: true, cutoffDays: 30, dailyRunAt: "03:00" }),
    });

    const res = await app.request("http://localhost/api/admin/db-maintenance/log");
    capturedCb!(makeEvent("verify", "failure"));
    expect(unsubCalls).toBe(1);
    try {
      await res.body?.cancel();
    } catch {}
  });
});
