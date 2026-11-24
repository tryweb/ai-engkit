import { Hono } from "hono";
import {
  collectHostStorage,
  getHostMaintenanceEventLog,
  getHostMaintenanceLastError,
  getHostMaintenanceLastResult,
  getHostMaintenanceState,
  planHostMaintenance,
  runHostMaintenance,
  subscribeHostMaintenance,
  watermarkStatus,
  type HostTier,
} from "../lib/host-maintenance";
import {
  DAILY_RUN_AT_RE,
  DEFAULT_HOST_MAINTENANCE_POLICY,
  hostMaintenancePolicyPath,
  readHostMaintenancePolicy,
  readHostMaintenancePolicyFrom,
  validateHostMaintenancePolicy,
  writeHostMaintenancePolicyFrom,
  type HostMaintenancePolicy,
} from "../lib/host-maintenance-policy";
import {
  DEFAULT_EVALUATION_INTERVAL_MS,
  nextDailyOccurrence,
} from "../lib/maintenance-scheduler";
import { handleSseLog } from "./sse-log";
import type { HostSchedulerStatus } from "../lib/host-maintenance-scheduler";

export interface HostMaintenanceRoutesDeps {
  getState?: typeof getHostMaintenanceState;
  getEventLog?: typeof getHostMaintenanceEventLog;
  subscribe?: typeof subscribeHostMaintenance;
  runHost?: typeof runHostMaintenance;
  planHost?: typeof planHostMaintenance;
  collectStorage?: typeof collectHostStorage;
  readPolicy?: typeof readHostMaintenancePolicy;
  readPolicyFrom?: typeof readHostMaintenancePolicyFrom;
  writePolicyFrom?: typeof writeHostMaintenancePolicyFrom;
  getSchedulerStatus?: () => HostSchedulerStatus;
  schedulerIntervalMs?: number;
  nowMs?: () => number;
}

const REAL_DEPS = {
  getState: getHostMaintenanceState,
  getEventLog: getHostMaintenanceEventLog,
  subscribe: subscribeHostMaintenance,
  runHost: runHostMaintenance,
  planHost: planHostMaintenance,
  collectStorage: collectHostStorage,
  readPolicy: readHostMaintenancePolicy,
  readPolicyFrom: readHostMaintenancePolicyFrom,
  writePolicyFrom: writeHostMaintenancePolicyFrom,
  schedulerIntervalMs: DEFAULT_EVALUATION_INTERVAL_MS,
  nowMs: Date.now,
};

export interface HostMaintenanceRoutesOptions extends HostMaintenanceRoutesDeps {
  policyPath?: string;
  onPolicySaved?: () => void;
  getSchedulerStatus?: () => HostSchedulerStatus;
}

export function createHostMaintenanceRoutes(options: HostMaintenanceRoutesOptions = {}): Hono {
  const { policyPath, onPolicySaved, ...overrides } = options;
  const deps = { ...REAL_DEPS, ...overrides };
  const router = new Hono();
  let startInFlight = false;

  const readPolicy = (): HostMaintenancePolicy =>
    policyPath ? deps.readPolicyFrom(policyPath) : deps.readPolicy();

  router.get("/api/admin/host-maintenance/status", async (c) => {
    try {
      const [storage, plan] = await Promise.all([
        deps.collectStorage(),
        deps.planHost().catch(() => null),
      ]);
      const policy = readPolicy();
      return c.json({
        state: deps.getState(),
        storage,
        watermark: watermarkStatus(storage.freeSpaceBytes, policy),
        policy: { enabled: policy.enabled, dailyRunAt: policy.dailyRunAt },
        lastResult: getHostMaintenanceLastResult(),
        lastError: getHostMaintenanceLastError(),
        versionedTotal: plan?.versionedCandidates.length ?? null,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: "Failed to collect host storage", detail: message }, 500);
    }
  });

  router.get("/api/admin/host-maintenance/plan", async (c) => {
    try {
      const plan = await deps.planHost();
      return c.json(plan);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: "Failed to build maintenance plan", detail: message }, 500);
    }
  });

  router.get("/api/admin/host-maintenance/schedule", (c) => {
    const sched = deps.getSchedulerStatus?.() ?? {
      lastEvaluationAt: null,
      lastSkipReason: null,
      lastRunAt: null,
      isStarted: false,
    };
    let nextEvaluationAt: string | null = null;
    try {
      const policy = readPolicy();
      const raw =
        typeof policy.dailyRunAt === "string" && DAILY_RUN_AT_RE.test(policy.dailyRunAt)
          ? policy.dailyRunAt
          : DEFAULT_HOST_MAINTENANCE_POLICY.dailyRunAt;
      nextEvaluationAt = new Date(nextDailyOccurrence(raw, deps.nowMs())).toISOString();
    } catch {
      nextEvaluationAt = null;
    }
    return c.json({ ...sched, intervalMs: deps.schedulerIntervalMs, nextEvaluationAt });
  });

  router.get("/api/admin/host-maintenance/log", (c) => {
    return handleSseLog(c, { getEventLog: deps.getEventLog, subscribe: deps.subscribe });
  });

  router.post("/api/admin/host-maintenance/run", async (c) => {
    if (deps.getState() === "running" || startInFlight) {
      return c.json({ error: "Host maintenance already in progress" }, 409);
    }
    let body: unknown = {};
    try {
      const text = await c.req.text();
      if (text.trim()) body = JSON.parse(text) as unknown;
    } catch {
      return c.json({ error: "Request body must be valid JSON" }, 400);
    }
    const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const tiersRaw = record["tiers"];
    const tiers: HostTier[] = Array.isArray(tiersRaw) && tiersRaw.length > 0
      ? (tiersRaw as HostTier[])
      : ["dangling", "builder"];
    if (!tiers.every((t) => t === "dangling" || t === "builder" || t === "versioned")) {
      return c.json({ error: "tiers must be a subset of [dangling, builder, versioned]" }, 400);
    }
    if (tiers.includes("versioned")) {
      if (record["confirmed"] !== true) {
        return c.json({ error: "Versioned cleanup requires { confirmed: true } after reviewing /plan" }, 400);
      }
      return c.json(
        { error: "Versioned image removal is manual-only in this version; use /plan candidates and prune explicitly" },
        400,
      );
    }
    if (deps.getState() === "running" || startInFlight) {
      return c.json({ error: "Host maintenance already in progress" }, 409);
    }
    startInFlight = true;
    // Run in background; progress streams via /log (SSE).
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    void deps
      .runHost({ tiers })
      .catch(() => {})
      .finally(() => {
        startInFlight = false;
      });
    return c.json({ status: "started", log_url: "/api/admin/host-maintenance/log" }, 202);
  });

  router.get("/api/admin/host-maintenance/policy", (c) => {
    try {
      return c.json(readPolicy());
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("malformed")) {
        return c.json({ error: "Host maintenance policy is malformed" }, 500);
      }
      return c.json({ error: message }, 500);
    }
  });

  router.put("/api/admin/host-maintenance/policy", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Request body must be valid JSON" }, 400);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return c.json({ error: "Request body must be an object" }, 400);
    }
    const result = validateHostMaintenancePolicy(body);
    if (result.ok === false) {
      return c.json({ error: `${result.field} ${result.message}` }, 400);
    }
    try {
      const policyPathResolved = policyPath ?? hostMaintenancePolicyPath();
      deps.writePolicyFrom(policyPathResolved, result.value);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Could not update host maintenance policy";
      return c.json({ error: message }, 500);
    }
    onPolicySaved?.();
    return c.json({ ok: true, ...result.value });
  });

  return router;
}

const defaultRouter = createHostMaintenanceRoutes();
export default defaultRouter;
