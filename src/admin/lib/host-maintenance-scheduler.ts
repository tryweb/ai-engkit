import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  DAILY_RUN_AT_RE,
  DEFAULT_HOST_MAINTENANCE_POLICY,
  readHostMaintenancePolicy,
  type HostMaintenancePolicy,
} from "./host-maintenance-policy";
import { runHostMaintenance, type HostMaintenanceDeps } from "./host-maintenance";
import { nextDailyOccurrence } from "./maintenance-scheduler";

export const HOST_MAINTENANCE_SCHEDULER_STATE_PATH = "/opt/ai-engkit/admin-data/host-maintenance-scheduler.json";
export const HOST_MAINTENANCE_EVALUATION_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function hostMaintenanceSchedulerStatePath(): string {
  return Bun.env.HOST_MAINTENANCE_SCHEDULER_STATE_PATH || HOST_MAINTENANCE_SCHEDULER_STATE_PATH;
}

export interface HostSchedulerStateFile {
  lastEvaluationAt: string | null;
  lastSkipReason: string | null;
  lastRunAt: string | null;
}

export interface HostSchedulerStatus extends HostSchedulerStateFile {
  isStarted: boolean;
}

export interface HostMaintenanceSchedulerDeps {
  readPolicy?: () => HostMaintenancePolicy;
  getUpgradeState?: () => string;
  getHostState?: () => string;
  runHostMaintenance?: (deps?: HostMaintenanceDeps) => Promise<{ ok: boolean }>;
  hostDeps?: HostMaintenanceDeps;
  nowMs?: () => number;
  statePath?: string;
  intervalMs?: number;
  readState?: () => HostSchedulerStateFile | null;
  writeState?: (state: HostSchedulerStateFile) => void;
}

export interface HostEvaluateResult {
  ran: boolean;
  skipReason: string | null;
  evaluationAt: string;
}

function defaultReadState(statePath: string): HostSchedulerStateFile | null {
  if (!existsSync(statePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf-8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const rec = parsed as Record<string, unknown>;
    const lastEvaluationAt =
      typeof rec["lastEvaluationAt"] === "string" || rec["lastEvaluationAt"] === null
        ? (rec["lastEvaluationAt"] as string | null)
        : null;
    const lastSkipReason =
      typeof rec["lastSkipReason"] === "string" || rec["lastSkipReason"] === null
        ? (rec["lastSkipReason"] as string | null)
        : null;
    const lastRunAt =
      typeof rec["lastRunAt"] === "string" || rec["lastRunAt"] === null
        ? (rec["lastRunAt"] as string | null)
        : null;
    return { lastEvaluationAt, lastSkipReason, lastRunAt };
  } catch {
    return null;
  }
}

function defaultWriteState(statePath: string, state: HostSchedulerStateFile): void {
  mkdirSync(dirname(statePath), { recursive: true });
  const tmp = join(dirname(statePath), `.host-maintenance-scheduler.json.tmp.${Date.now()}`);
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, statePath);
}

function resolveDeps(deps: HostMaintenanceSchedulerDeps = {}): Required<HostMaintenanceSchedulerDeps> {
  const statePath = deps.statePath ?? hostMaintenanceSchedulerStatePath();
  const intervalMs = deps.intervalMs ?? HOST_MAINTENANCE_EVALUATION_INTERVAL_MS;
  const nowMs = deps.nowMs ?? Date.now;
  return {
    readPolicy: deps.readPolicy ?? readHostMaintenancePolicy,
    getUpgradeState: deps.getUpgradeState ?? (() => "idle"),
    getHostState: deps.getHostState ?? (() => "idle"),
    runHostMaintenance: deps.runHostMaintenance ?? runHostMaintenance,
    hostDeps: deps.hostDeps ?? {},
    nowMs,
    statePath,
    intervalMs,
    readState: deps.readState ?? (() => defaultReadState(statePath)),
    writeState: deps.writeState ?? ((s: HostSchedulerStateFile) => defaultWriteState(statePath, s)),
  };
}

function resolveDailyRunAt(readPolicy: () => HostMaintenancePolicy): string {
  try {
    const policy = readPolicy();
    if (typeof policy.dailyRunAt === "string" && DAILY_RUN_AT_RE.test(policy.dailyRunAt)) {
      return policy.dailyRunAt;
    }
  } catch {}
  return DEFAULT_HOST_MAINTENANCE_POLICY.dailyRunAt;
}

/**
 * Daily evaluation. Deliberately has NO "prior manual run" gate (unlike the
 * DB maintenance scheduler): host hygiene triggers on watermark/policy only.
 */
export async function evaluateHostMaintenanceScheduler(
  deps: HostMaintenanceSchedulerDeps = {},
): Promise<HostEvaluateResult> {
  const r = resolveDeps(deps);
  const now = r.nowMs();
  const evaluationAt = new Date(now).toISOString();
  let ran = false;
  let skipReason: string | null = null;
  try {
    const policy = r.readPolicy();
    if (!policy.enabled) {
      skipReason = "policy disabled";
    } else if (r.getUpgradeState() === "running") {
      skipReason = "upgrade_in_progress";
    } else if (r.getHostState() === "running") {
      skipReason = "host maintenance already in progress";
    } else {
      await r.runHostMaintenance({ ...r.hostDeps, readPolicy: r.readPolicy });
      ran = true;
    }
  } catch (error: unknown) {
    skipReason = error instanceof Error ? error.message : String(error);
    ran = false;
  }
  const prev = r.readState();
  const lastRunAt = ran ? evaluationAt : (prev?.lastRunAt ?? null);
  r.writeState({ lastEvaluationAt: evaluationAt, lastSkipReason: skipReason, lastRunAt });
  return { ran, skipReason, evaluationAt };
}

export function getHostSchedulerStatus(deps: HostMaintenanceSchedulerDeps = {}): HostSchedulerStatus {
  const r = resolveDeps(deps);
  const fileState = r.readState();
  return {
    lastEvaluationAt: fileState?.lastEvaluationAt ?? null,
    lastSkipReason: fileState?.lastSkipReason ?? null,
    lastRunAt: fileState?.lastRunAt ?? null,
    isStarted: false,
  };
}

export interface HostMaintenanceScheduler {
  start(): void;
  stop(): void;
  reschedule(): void;
  isStarted(): boolean;
  evaluate(): Promise<HostEvaluateResult>;
  getStatus(): HostSchedulerStatus;
}

export function createHostMaintenanceScheduler(deps: HostMaintenanceSchedulerDeps = {}): HostMaintenanceScheduler {
  const r = resolveDeps(deps);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let started = false;
  let inMemory: HostSchedulerStateFile = r.readState() ?? {
    lastEvaluationAt: null,
    lastSkipReason: null,
    lastRunAt: null,
  };

  async function doEvaluate(): Promise<HostEvaluateResult> {
    const result = await evaluateHostMaintenanceScheduler({
      readPolicy: r.readPolicy,
      getUpgradeState: r.getUpgradeState,
      getHostState: r.getHostState,
      runHostMaintenance: r.runHostMaintenance,
      hostDeps: r.hostDeps,
      nowMs: r.nowMs,
      statePath: r.statePath,
      intervalMs: r.intervalMs,
      readState: r.readState,
      writeState: (s) => {
        inMemory = s;
        r.writeState(s);
      },
    });
    return result;
  }

  function scheduleNext(): void {
    if (!started) return;
    const now = r.nowMs();
    const dailyRunAt = resolveDailyRunAt(r.readPolicy);
    let nextMs: number;
    try {
      nextMs = nextDailyOccurrence(dailyRunAt, now);
    } catch {
      nextMs = now + r.intervalMs;
    }
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      if (!started) return;
      void doEvaluate()
        .catch((error: unknown) => {
          console.error(
            "Host maintenance scheduler evaluation failed:",
            error instanceof Error ? error.message : String(error),
          );
        })
        .finally(() => {
          scheduleNext();
        });
    }, Math.max(0, nextMs - now));
  }

  function start(): void {
    if (started) return;
    started = true;
    const s = r.readState();
    if (s) inMemory = s;
    scheduleNext();
  }

  function stop(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    started = false;
  }

  function reschedule(): void {
    if (started) scheduleNext();
  }

  return {
    start,
    stop,
    reschedule,
    isStarted: () => started,
    evaluate: doEvaluate,
    getStatus: () => {
      const fileState = r.readState();
      const base = fileState ?? inMemory;
      return { ...base, isStarted: started };
    },
  };
}
