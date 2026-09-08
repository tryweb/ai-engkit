import { Hono } from "hono";
import {
  getMaintenanceStatus,
  getMaintenanceState,
  getMaintenanceEventLog,
  subscribeMaintenance,
  runMaintenance,
  getDeleteCounts,
  type DbMaintenanceDeps,
} from "../lib/db-maintenance";
import {
  DAILY_RUN_AT_RE,
  DEFAULT_RETENTION_POLICY,
  readRetentionPolicy,
} from "../lib/retention-policy";
import {
  DEFAULT_EVALUATION_INTERVAL_MS,
  getSchedulerStatus,
  nextDailyOccurrence,
  type SchedulerStatus,
} from "../lib/maintenance-scheduler";

export interface DbMaintenanceRoutesDeps {
  getState?: typeof getMaintenanceState;
  getStatus?: typeof getMaintenanceStatus;
  getEventLog?: typeof getMaintenanceEventLog;
  subscribe?: typeof subscribeMaintenance;
  runMaintenance?: typeof runMaintenance;
  getDeleteCounts?: typeof getDeleteCounts;
  readRetentionPolicy?: typeof readRetentionPolicy;
  maintenanceDeps?: DbMaintenanceDeps;
  getSchedulerStatus?: () => SchedulerStatus;
  schedulerIntervalMs?: number;
  nowMs?: () => number;
}

const REAL_DEPS: Required<
  Pick<DbMaintenanceRoutesDeps, "getState" | "getStatus" | "getEventLog" | "subscribe" | "readRetentionPolicy" | "getSchedulerStatus"> & {
    runMaintenance: typeof runMaintenance;
    getDeleteCounts: typeof getDeleteCounts;
    schedulerIntervalMs: number;
    nowMs: () => number;
  }
> = {
  getState: getMaintenanceState,
  getStatus: getMaintenanceStatus,
  getEventLog: getMaintenanceEventLog,
  subscribe: subscribeMaintenance,
  runMaintenance,
  getDeleteCounts,
  readRetentionPolicy,
  getSchedulerStatus,
  schedulerIntervalMs: DEFAULT_EVALUATION_INTERVAL_MS,
  nowMs: Date.now,
};

export function createDbMaintenanceRoutes(options: DbMaintenanceRoutesDeps = {}): Hono {
  const deps = { ...REAL_DEPS, ...options };
  const router = new Hono();
  let startInFlight = false;

  router.get("/api/admin/db-maintenance/status", (c) => {
    return c.json(deps.getStatus());
  });

  router.get("/api/admin/db-maintenance/schedule", (c) => {
    const sched = deps.getSchedulerStatus();
    const intervalMs = deps.schedulerIntervalMs;
    let nextEvaluationAt: string | null = null;
    try {
      const policy = deps.readRetentionPolicy();
      const raw =
        typeof policy.dailyRunAt === "string" && DAILY_RUN_AT_RE.test(policy.dailyRunAt)
          ? policy.dailyRunAt
          : DEFAULT_RETENTION_POLICY.dailyRunAt;
      const nowMs = deps.nowMs();
      nextEvaluationAt = new Date(nextDailyOccurrence(raw, nowMs)).toISOString();
    } catch {
      try {
        const nowMs = deps.nowMs();
        nextEvaluationAt = new Date(
          nextDailyOccurrence(DEFAULT_RETENTION_POLICY.dailyRunAt, nowMs),
        ).toISOString();
      } catch {
        nextEvaluationAt = null;
      }
    }
    return c.json({
      isStarted: sched.isStarted,
      lastEvaluationAt: sched.lastEvaluationAt,
      lastSkipReason: sched.lastSkipReason,
      lastRunAt: sched.lastRunAt,
      intervalMs,
      nextEvaluationAt,
    });
  });

  router.get("/api/admin/db-maintenance/counts", async (c) => {
    try {
      const policy = deps.readRetentionPolicy();
      const counts = await deps.getDeleteCounts(policy, deps.maintenanceDeps ?? {});
      return c.json({ ...counts, cutoffDays: policy.cutoffDays, enabled: policy.enabled });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: "Failed to get delete counts", detail: message }, 500);
    }
  });

  router.get("/api/admin/db-maintenance/log", (c) => {
    const history = c.req.query("history");
    if (history === "1") {
      return c.json(deps.getEventLog());
    }

    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");

    let closed = false;
    let cleaned = false;
    let unsub: (() => void) | null = null;
    let ctrl: ReadableStreamDefaultController<string> | null = null;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      unsub?.();
    };
    const safeClose = (): void => {
      if (closed) return;
      closed = true;
      cleanup();
      try {
        ctrl?.close();
      } catch (error: unknown) {
        if (!(error instanceof TypeError)) throw error;
      }
    };
    const safeEnqueue = (data: string): void => {
      if (closed) return;
      ctrl?.enqueue(data);
    };
    const stream = new ReadableStream<string>({
      start(controller) {
        ctrl = controller;
        for (const event of deps.getEventLog()) {
          safeEnqueue(`data: ${JSON.stringify(event)}\n\n`);
        }
        unsub = deps.subscribe((event) => {
          safeEnqueue(`data: ${JSON.stringify(event)}\n\n`);
          if (event.step === "verify" && (event.status === "success" || event.status === "failure")) {
            cleanup();
            setTimeout(() => safeClose(), 1000);
          }
        });
        c.req.raw.signal.addEventListener("abort", () => {
          safeClose();
        }, { once: true });
      },
      cancel() {
        safeClose();
      },
    });

    return c.body(stream);
  });

  router.post("/api/admin/db-maintenance/run", async (c) => {
    const state = deps.getState();
    if (state === "running" || startInFlight) {
      return c.json({ error: "Maintenance already in progress", status: deps.getStatus() }, 409);
    }

    let body: unknown = {};
    try {
      const text = await c.req.text();
      if (text.trim()) body = JSON.parse(text) as unknown;
    } catch {
      return c.json({ error: "Request body must be valid JSON" }, 400);
    }

    const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    if (record["confirm"] !== true) {
      return c.json({ error: "Maintenance requires { confirm: true }" }, 400);
    }

    if (startInFlight || deps.getState() === "running") {
      return c.json({ error: "Maintenance already in progress", status: deps.getStatus() }, 409);
    }

    startInFlight = true;
    const runDeps = deps.maintenanceDeps ?? {};
    void deps.runMaintenance(runDeps).catch(() => {}).finally(() => {
      startInFlight = false;
    });

    return c.json({ status: "started", log_url: "/api/admin/db-maintenance/log" }, 202);
  });

  return router;
}

const defaultRouter = createDbMaintenanceRoutes();
export default defaultRouter;
