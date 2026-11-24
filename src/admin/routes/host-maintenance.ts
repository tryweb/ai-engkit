import { Hono } from "hono";
import {
  hostMaintenancePolicyPath,
  isCleanupTier,
  readHostMaintenancePolicyFrom,
  validateHostMaintenancePolicy,
  writeHostMaintenancePolicyFrom,
  type CleanupTier,
  type HostMaintenancePolicy,
} from "../lib/host-maintenance-policy";
import {
  collectHostStorage,
  getHostMaintenanceEventLog,
  getHostMaintenanceState,
  getHostMaintenanceStatus,
  planHostMaintenance,
  runHostMaintenance,
  subscribeHostMaintenance,
  watermarkFor,
  type HostStorage,
} from "../lib/host-maintenance";
import {
  DEFAULT_HOST_EVALUATION_INTERVAL_MS,
  getHostSchedulerStatus,
  type HostSchedulerStatus,
} from "../lib/host-maintenance-scheduler";
import { nextDailyOccurrence } from "../lib/maintenance-scheduler";
import { HostMaintenancePage } from "../views/host-maintenance";

export interface HostMaintenanceRoutesDeps {
  collectStorage?: () => Promise<HostStorage>;
  readPolicy?: (filePath: string) => HostMaintenancePolicy;
  planFrom?: (storage: HostStorage, policy: HostMaintenancePolicy) => ReturnType<typeof planHostMaintenance>;
  runCleanup?: (tiers: CleanupTier[], confirmed: boolean) => Promise<unknown>;
  getState?: typeof getHostMaintenanceState;
  getStatus?: typeof getHostMaintenanceStatus;
  getEventLog?: typeof getHostMaintenanceEventLog;
  subscribe?: typeof subscribeHostMaintenance;
  getSchedulerStatus?: () => HostSchedulerStatus;
  schedulerIntervalMs?: number;
  nowMs?: () => number;
  policyPath?: string;
  onPolicySaved?: () => void;
}

const REAL_DEPS: Required<
  Pick<
    HostMaintenanceRoutesDeps,
    | "collectStorage"
    | "getState"
    | "getStatus"
    | "getEventLog"
    | "subscribe"
    | "getSchedulerStatus"
    | "schedulerIntervalMs"
    | "nowMs"
  >
> & {
  readPolicy: (filePath: string) => HostMaintenancePolicy;
  planFrom: (storage: HostStorage, policy: HostMaintenancePolicy) => ReturnType<typeof planHostMaintenance>;
  runCleanup: (tiers: CleanupTier[], confirmed: boolean) => Promise<unknown>;
  policyPath: string;
} = {
  collectStorage: () => collectHostStorage(),
  readPolicy: readHostMaintenancePolicyFrom,
  planFrom: planHostMaintenance,
  runCleanup: (tiers, confirmed) => runHostMaintenance({ tiers, confirmed }),
  getState: getHostMaintenanceState,
  getStatus: getHostMaintenanceStatus,
  getEventLog: getHostMaintenanceEventLog,
  subscribe: subscribeHostMaintenance,
  getSchedulerStatus: getHostSchedulerStatus,
  schedulerIntervalMs: DEFAULT_HOST_EVALUATION_INTERVAL_MS,
  nowMs: Date.now,
  policyPath: hostMaintenancePolicyPath(),
};

export function createHostMaintenanceRoutes(options: HostMaintenanceRoutesDeps = {}): Hono {
  const deps = { ...REAL_DEPS, ...options };
  const router = new Hono();
  let startInFlight = false;

  const loadPolicy = (): HostMaintenancePolicy => deps.readPolicy(deps.policyPath);

  router.get("/api/admin/host-maintenance/status", async (c) => {
    try {
      const [storage, policy] = await Promise.all([
        deps.collectStorage(),
        Promise.resolve(loadPolicy()),
      ]);
      const avail = storage.root?.availBytes ?? null;
      return c.json({
        storage,
        watermark: watermarkFor(avail, policy),
        watermarkGb: { warn: policy.watermarkWarnGb, crit: policy.watermarkCritGb },
        maintenance: deps.getStatus(),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: "Failed to collect host storage", detail: message }, 500);
    }
  });

  router.get("/api/admin/host-maintenance/plan", async (c) => {
    try {
      const [storage, policy] = await Promise.all([
        deps.collectStorage(),
        Promise.resolve(loadPolicy()),
      ]);
      return c.json(deps.planFrom(storage, policy));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: "Failed to build cleanup plan", detail: message }, 500);
    }
  });

  router.post("/api/admin/host-maintenance/run", async (c) => {
    if (deps.getState() === "running" || startInFlight) {
      return c.json({ error: "Host maintenance already in progress", status: deps.getStatus() }, 409);
    }

    let body: unknown = {};
    try {
      const text = await c.req.text();
      if (text.trim()) body = JSON.parse(text) as unknown;
    } catch {
      return c.json({ error: "Request body must be valid JSON" }, 400);
    }
    const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;

    let tiers: CleanupTier[] = ["dangling", "builder"];
    if ("tiers" in record && record.tiers !== undefined) {
      if (!Array.isArray(record.tiers) || record.tiers.length === 0) {
        return c.json({ error: "tiers must be a non-empty array" }, 400);
      }
      const parsed: CleanupTier[] = [];
      for (const tier of record.tiers) {
        if (!isCleanupTier(tier)) {
          return c.json({ error: `unknown cleanup tier ${JSON.stringify(tier)}` }, 400);
        }
        if (!parsed.includes(tier)) parsed.push(tier);
      }
      tiers = parsed;
    }
    const confirmed = record["confirmed"] === true;
    if (tiers.includes("versioned") && !confirmed) {
      return c.json({ error: 'the "versioned" tier requires { confirmed: true }' }, 400);
    }

    if (deps.getState() === "running" || startInFlight) {
      return c.json({ error: "Host maintenance already in progress", status: deps.getStatus() }, 409);
    }

    startInFlight = true;
    void Promise.resolve()
      .then(() => deps.runCleanup(tiers, confirmed))
      .catch(() => {})
      .finally(() => {
        startInFlight = false;
      });

    return c.json({ status: "started", tiers, log_url: "/api/admin/host-maintenance/log" }, 202);
  });

  router.get("/api/admin/host-maintenance/log", (c) => {
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
    const isTerminal = (message: string): boolean =>
      message.startsWith("cleanup done") || message.startsWith("cleanup finished");
    const stream = new ReadableStream<string>({
      start(controller) {
        ctrl = controller;
        for (const event of deps.getEventLog()) {
          safeEnqueue(`data: ${JSON.stringify(event)}\n\n`);
        }
        unsub = deps.subscribe((event) => {
          safeEnqueue(`data: ${JSON.stringify(event)}\n\n`);
          if (event.tier === "all" && isTerminal(event.message)) {
            cleanup();
            setTimeout(() => safeClose(), 1000);
          }
        });
        c.req.raw.signal.addEventListener(
          "abort",
          () => {
            safeClose();
          },
          { once: true },
        );
      },
      cancel() {
        safeClose();
      },
    });

    return c.body(stream);
  });

  router.get("/api/admin/host-maintenance/schedule", (c) => {
    const sched = deps.getSchedulerStatus();
    const intervalMs = deps.schedulerIntervalMs;
    let nextEvaluationAt: string | null = null;
    try {
      const policy = loadPolicy();
      nextEvaluationAt = new Date(nextDailyOccurrence(policy.dailyRunAt, deps.nowMs())).toISOString();
    } catch {
      nextEvaluationAt = null;
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

  router.get("/api/admin/host-maintenance/policy", (c) => {
    try {
      return c.json(loadPolicy());
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Could not read host maintenance policy";
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
      writeHostMaintenancePolicyFrom(deps.policyPath, result.value);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Could not update host maintenance policy";
      return c.json({ error: message }, 500);
    }

    options.onPolicySaved?.();

    return c.json({ ok: true, ...result.value });
  });

  router.get("/host-maintenance", (c) => c.html(HostMaintenancePage()));

  return router;
}

const defaultRouter = createHostMaintenanceRoutes();
export default defaultRouter;
