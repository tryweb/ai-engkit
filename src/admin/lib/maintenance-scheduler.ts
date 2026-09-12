import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  getLastError,
  getLastSuccessAt,
  getMaintenanceState,
  runMaintenance,
  type DbMaintenanceDeps,
} from "./db-maintenance";
import {
  DAILY_RUN_AT_RE,
  DEFAULT_RETENTION_POLICY,
  readRetentionPolicy,
  type RetentionPolicy,
} from "./retention-policy";

export const SCHEDULER_STATE_PATH = "/opt/ai-engkit/admin-data/maintenance-scheduler.json";
export const DEFAULT_EVALUATION_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function nextDailyOccurrence(timeHHMM: string, nowMs: number): number {
  if (typeof timeHHMM !== "string" || !DAILY_RUN_AT_RE.test(timeHHMM)) {
    throw new Error(`dailyRunAt ${String(timeHHMM)} must be a string in HH:MM format (00:00-23:59)`);
  }
  const [hhStr, mmStr] = timeHHMM.split(":");
  const hh = Number(hhStr);
  const mm = Number(mmStr);
  const now = new Date(nowMs);
  const candidate = new Date(now);
  candidate.setHours(hh, mm, 0, 0);
  if (candidate.getTime() <= nowMs) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate.getTime();
}

function resolveDailyRunAt(readRetention: () => RetentionPolicy): string {
  try {
    const policy = readRetention();
    if (typeof policy.dailyRunAt === "string" && DAILY_RUN_AT_RE.test(policy.dailyRunAt)) {
      return policy.dailyRunAt;
    }
  } catch {}
  return DEFAULT_RETENTION_POLICY.dailyRunAt;
}

export function schedulerStatePath(): string {
  return Bun.env.MAINTENANCE_SCHEDULER_STATE_PATH || SCHEDULER_STATE_PATH;
}

export interface SchedulerStateFile {
  lastEvaluationAt: string | null;
  lastSkipReason: string | null;
  lastRunAt: string | null;
}

export interface SchedulerStatus extends SchedulerStateFile {
  isStarted: boolean;
}

export interface MaintenanceSchedulerDeps {
  readRetentionPolicy?: () => RetentionPolicy;
  getLastSuccessAt?: () => string | null;
  getMaintenanceState?: () => string;
  getLastError?: () => string | null;
  runMaintenance?: (deps?: DbMaintenanceDeps) => Promise<boolean>;
  maintenanceDeps?: DbMaintenanceDeps;
  nowMs?: () => number;
  statePath?: string;
  intervalMs?: number;
  readState?: () => SchedulerStateFile | null;
  writeState?: (state: SchedulerStateFile) => void;
}

export interface EvaluateResult {
  ran: boolean;
  skipReason: string | null;
  evaluationAt: string;
}

function defaultReadState(statePath: string): SchedulerStateFile | null {
  if (!existsSync(statePath)) return null;
  try {
    const text = readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(text) as unknown;
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

function defaultWriteState(statePath: string, state: SchedulerStateFile): void {
  mkdirSync(dirname(statePath), { recursive: true });
  const tmp = join(dirname(statePath), `.maintenance-scheduler.json.tmp.${Date.now()}`);
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, statePath);
}

function resolveDeps(deps: MaintenanceSchedulerDeps = {}): Required<MaintenanceSchedulerDeps> {
  const statePath = deps.statePath ?? schedulerStatePath();
  const intervalMs = deps.intervalMs ?? DEFAULT_EVALUATION_INTERVAL_MS;
  const nowMs = deps.nowMs ?? Date.now;
  const readRetention = deps.readRetentionPolicy ?? readRetentionPolicy;
  const getSuccess = deps.getLastSuccessAt ?? getLastSuccessAt;
  const getState = deps.getMaintenanceState ?? getMaintenanceState;
  const getError = deps.getLastError ?? getLastError;
  const run = deps.runMaintenance ?? runMaintenance;
  const readState =
    deps.readState ??
    (() => defaultReadState(statePath));
  const writeState =
    deps.writeState ??
    ((s: SchedulerStateFile) => defaultWriteState(statePath, s));
  return {
    readRetentionPolicy: readRetention,
    getLastSuccessAt: getSuccess,
    getMaintenanceState: getState,
    getLastError: getError,
    runMaintenance: run,
    maintenanceDeps: deps.maintenanceDeps ?? {},
    nowMs,
    statePath,
    intervalMs,
    readState,
    writeState,
  };
}

export async function evaluateMaintenanceScheduler(
  deps: MaintenanceSchedulerDeps = {},
): Promise<EvaluateResult> {
  const r = resolveDeps(deps);
  const now = r.nowMs();
  const evaluationAt = new Date(now).toISOString();

  let ran = false;
  let skipReason: string | null = null;

  try {
    const policy = r.readRetentionPolicy();
    if (!policy.enabled) {
      skipReason = "policy disabled";
    } else if (!r.getLastSuccessAt()) {
      skipReason = "no prior successful manual run";
    } else if (r.getMaintenanceState() === "running") {
      skipReason = "maintenance already in progress";
    } else {
      const result = await r.runMaintenance(r.maintenanceDeps);
      if (result) {
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
  const nextState: SchedulerStateFile = {
    lastEvaluationAt: evaluationAt,
    lastSkipReason: skipReason,
    lastRunAt,
  };
  r.writeState(nextState);

  return { ran, skipReason, evaluationAt };
}

/**
 * Read persisted scheduler state only. isStarted is always false here —
 * use the instance getStatus() for the live value.
 */
export function getSchedulerStatus(deps: MaintenanceSchedulerDeps = {}): SchedulerStatus {
  const r = resolveDeps(deps);
  const fileState = r.readState();
  return {
    lastEvaluationAt: fileState?.lastEvaluationAt ?? null,
    lastSkipReason: fileState?.lastSkipReason ?? null,
    lastRunAt: fileState?.lastRunAt ?? null,
    isStarted: false,
  };
}

export interface MaintenanceScheduler {
  start(): void;
  stop(): void;
  reschedule(): void;
  isStarted(): boolean;
  evaluate(): Promise<EvaluateResult>;
  getStatus(): SchedulerStatus;
}

export function createMaintenanceScheduler(
  deps: MaintenanceSchedulerDeps = {},
): MaintenanceScheduler {
  const r = resolveDeps(deps);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let started = false;
  let inMemoryStatus: SchedulerStateFile = r.readState() ?? {
    lastEvaluationAt: null,
    lastSkipReason: null,
    lastRunAt: null,
  };

  const syncFromFile = (): void => {
    const s = r.readState();
    if (s) inMemoryStatus = s;
  };

  async function doEvaluate(): Promise<EvaluateResult> {
    const result = await evaluateMaintenanceScheduler({
      readRetentionPolicy: r.readRetentionPolicy,
      getLastSuccessAt: r.getLastSuccessAt,
      getMaintenanceState: r.getMaintenanceState,
      getLastError: r.getLastError,
      runMaintenance: r.runMaintenance,
      maintenanceDeps: r.maintenanceDeps,
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
    const dailyRunAt = resolveDailyRunAt(r.readRetentionPolicy);
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
            "Maintenance scheduler evaluation failed:",
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

  function isStartedFn(): boolean {
    return started;
  }

  function getStatus(): SchedulerStatus {
    // Prefer in-memory but fallback to file for visibility after restart
    const fileState = r.readState();
    const base = fileState ?? inMemoryStatus;
    return {
      lastEvaluationAt: base.lastEvaluationAt,
      lastSkipReason: base.lastSkipReason,
      lastRunAt: base.lastRunAt,
      isStarted: started,
    };
  }

  return {
    start,
    stop,
    reschedule,
    isStarted: isStartedFn,
    evaluate: doEvaluate,
    getStatus,
  };
}

export function _readSchedulerStateForTest(statePath: string): SchedulerStateFile | null {
  return defaultReadState(statePath);
}
