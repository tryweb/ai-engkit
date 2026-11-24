import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  getHostMaintenanceState,
  getLastHostMaintenanceError,
  runHostMaintenance,
} from "./host-maintenance";
import type { CleanupTier } from "./host-maintenance-policy";
import {
  readHostMaintenancePolicy,
  SAFE_TIERS,
  type HostMaintenancePolicy,
} from "./host-maintenance-policy";
import { DAILY_RUN_AT_RE } from "./retention-policy";
import { nextDailyOccurrence } from "./maintenance-scheduler";

export const HOST_SCHEDULER_STATE_PATH = "/opt/ai-engkit/admin-data/host-maintenance-scheduler.json";
export const DEFAULT_HOST_EVALUATION_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function hostSchedulerStatePath(): string {
  return Bun.env.HOST_MAINTENANCE_SCHEDULER_STATE_PATH || HOST_SCHEDULER_STATE_PATH;
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
  getState?: () => string;
  getLastError?: () => string | null;
  runCleanup?: (tiers: CleanupTier[]) => Promise<{ ok: boolean }>;
  /** Fail-closed guard: while an upgrade runs, the scheduler only skips. */
  isUpgradeRunning?: () => boolean | Promise<boolean>;
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
    const text = readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const rec = parsed as Record<string, unknown>;
    const str = (key: string): string | null => {
      const value = rec[key];
      return typeof value === "string" || value === null ? (value as string | null) : null;
    };
    return { lastEvaluationAt: str("lastEvaluationAt"), lastSkipReason: str("lastSkipReason"), lastRunAt: str("lastRunAt") };
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

function resolveHostDeps(deps: HostMaintenanceSchedulerDeps = {}): Required<HostMaintenanceSchedulerDeps> {
  const statePath = deps.statePath ?? hostSchedulerStatePath();
  const intervalMs = deps.intervalMs ?? DEFAULT_HOST_EVALUATION_INTERVAL_MS;
  const nowMs = deps.nowMs ?? Date.now;
  return {
    readPolicy: deps.readPolicy ?? readHostMaintenancePolicy,
    getState: deps.getState ?? getHostMaintenanceState,
    getLastError: deps.getLastError ?? getLastHostMaintenanceError,
    runCleanup:
      deps.runCleanup ?? ((tiers) => runHostMaintenance({ tiers })),
    isUpgradeRunning: deps.isUpgradeRunning ?? (() => false),
    nowMs,
    statePath,
    intervalMs,
    readState: deps.readState ?? (() => defaultReadState(statePath)),
    writeState: deps.writeState ?? ((s) => defaultWriteState(statePath, s)),
  };
}

function resolveDailyRunAt(readPolicy: () => HostMaintenancePolicy): string {
  try {
    const policy = readPolicy();
    if (typeof policy.dailyRunAt === "string" && DAILY_RUN_AT_RE.test(policy.dailyRunAt)) {
      return policy.dailyRunAt;
    }
  } catch {}
  return "03:00";
}

export async function evaluateHostMaintenanceScheduler(
  deps: HostMaintenanceSchedulerDeps = {},
): Promise<HostEvaluateResult> {
  const r = resolveHostDeps(deps);
  const now = r.nowMs();
  const evaluationAt = new Date(now).toISOString();

  let ran = false;
  let skipReason: string | null = null;

  try {
    const policy = r.readPolicy();
    if (!policy.enabled) {
      skipReason = "policy disabled";
    } else if (await r.isUpgradeRunning()) {
      skipReason = "upgrade in progress";
    } else if (r.getState() === "running") {
      skipReason = "maintenance already in progress";
    } else {
      // The scheduler only ever runs the safe tiers. Old-version pruning
      // ("versioned") always needs a human confirmation via the run endpoint.
      const result = await r.runCleanup([...SAFE_TIERS]);
      if (result.ok) {
        ran = true;
        skipReason = null;
      } else {
        const err = r.getLastError();
        skipReason = err ?? "guard failure";
        ran = false;
      }
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    skipReason = msg;
    ran = false;
  }

  const prev = r.readState();
  const lastRunAt = ran ? evaluationAt : (prev?.lastRunAt ?? null);
  r.writeState({ lastEvaluationAt: evaluationAt, lastSkipReason: skipReason, lastRunAt });

  return { ran, skipReason, evaluationAt };
}

export function getHostSchedulerStatus(deps: HostMaintenanceSchedulerDeps = {}): HostSchedulerStatus {
  const r = resolveHostDeps(deps);
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

export function createHostMaintenanceScheduler(
  deps: HostMaintenanceSchedulerDeps = {},
): HostMaintenanceScheduler {
  const r = resolveHostDeps(deps);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let started = false;
  let inMemoryStatus: HostSchedulerStateFile = r.readState() ?? {
    lastEvaluationAt: null,
    lastSkipReason: null,
    lastRunAt: null,
  };

  const syncFromFile = (): void => {
    const s = r.readState();
    if (s) inMemoryStatus = s;
  };

  async function doEvaluate(): Promise<HostEvaluateResult> {
    const result = await evaluateHostMaintenanceScheduler({
      readPolicy: r.readPolicy,
      getState: r.getState,
      getLastError: r.getLastError,
      runCleanup: r.runCleanup,
      isUpgradeRunning: r.isUpgradeRunning,
      nowMs: r.nowMs,
      statePath: r.statePath,
      intervalMs: r.intervalMs,
      readState: r.readState,
      writeState: (s) => {
        inMemoryStatus = s;
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
    const delay = Math.max(0, nextMs - now);
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
    }, delay);
  }

  function start(): void {
    if (started) return;
    started = true;
    syncFromFile();
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
    getStatus: () => ({ ...inMemoryStatus, isStarted: started }),
  };
}
