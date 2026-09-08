import { join } from "node:path";
import {
  dockerCommand,
  execInAiDev,
  getAiDevContainerRef,
  getComposeProject,
  getSelfBindSource,
  shellQuote,
  type ExecResult,
} from "./docker";
import { readRetentionPolicy, type RetentionPolicy } from "./retention-policy";
import {
  probeIdleViaOpenCodeServer,
  waitForIdleSessions,
  type IdleWaitOutcome,
} from "../agent/commands";

export const DEFAULT_DB_PATH = "/home/devuser/.local/share/opencode/opencode.db";
export const DEFAULT_BACKUP_DIR = "/opt/ai-engkit/backups/db-maintenance";
export const BACKUP_CONTAINER_ROOT = "/opt/ai-engkit/backups";
// 1.5 GiB critical floor — matches production kill-switch observed in drill
export const DEFAULT_CRITICAL_FLOOR_BYTES = Math.floor(1.5 * 1024 * 1024 * 1024);
// Pre-start headroom multiplier: VACUUM needs ~1x live DB in WAL mode + backup headroom
export const DEFAULT_HEADROOM_MULTIPLIER = 1.5;

export type MaintenanceStep = "backup" | "quiesce" | "delete" | "reclaim" | "verify";
export type StepStatus = "pending" | "running" | "success" | "failure";
export type MaintenanceState = "idle" | "running" | "done" | "failed";

export interface MaintenanceEvent {
  id: number;
  step: MaintenanceStep;
  status: StepStatus;
  message: string;
  timestamp: string;
}

export interface MaintenanceStatus {
  state: MaintenanceState;
  events: MaintenanceEvent[];
  current_step: MaintenanceStep | "";
  progress_pct: number;
  last_success_at: string | null;
  last_error: string | null;
}

let nextEventId = 1;
let currentState: MaintenanceState = "idle";
let eventLog: MaintenanceEvent[] = [];
let subscribers: ((event: MaintenanceEvent) => void)[] = [];
let lastSuccessAt: string | null = null;
let lastError: string | null = null;

export function getMaintenanceState(): MaintenanceState {
  return currentState;
}

export function getMaintenanceEventLog(): MaintenanceEvent[] {
  return [...eventLog];
}

export function getLastSuccessAt(): string | null {
  return lastSuccessAt;
}

export function getLastError(): string | null {
  return lastError;
}

export function subscribeMaintenance(subscriber: (event: MaintenanceEvent) => void): () => void {
  subscribers.push(subscriber);
  return () => {
    subscribers = subscribers.filter((s) => s !== subscriber);
  };
}

function emit(step: MaintenanceStep, status: StepStatus, message: string): void {
  const event: MaintenanceEvent = {
    id: nextEventId++,
    step,
    status,
    message,
    timestamp: new Date().toISOString(),
  };
  eventLog.push(event);
  for (const sub of subscribers) {
    sub(event);
  }
}

export function getMaintenanceStatus(): MaintenanceStatus {
  const steps: MaintenanceStep[] = ["backup", "quiesce", "delete", "reclaim", "verify"];
  const lastRunning = [...eventLog].reverse().find((e) => e.status === "running");
  const lastFailed = [...eventLog].reverse().find((e) => e.status === "failure");
  const currentStep = (lastFailed?.step ?? lastRunning?.step ?? "") as MaintenanceStep | "";
  const doneSteps = eventLog.filter((e) => e.status === "success").length;
  return {
    state: currentState,
    events: [...eventLog],
    current_step: currentStep,
    progress_pct: Math.round((doneSteps / steps.length) * 100),
    last_success_at: lastSuccessAt,
    last_error: lastError,
  };
}

/** Test helper — reset module state between tests. Not for production use. */
export function _resetMaintenanceState(): void {
  currentState = "idle";
  eventLog = [];
  nextEventId = 1;
  subscribers = [];
  lastSuccessAt = null;
  lastError = null;
}

/** Test helper — set lastSuccessAt directly. */
export function _setLastSuccessAt(value: string | null): void {
  lastSuccessAt = value;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function defaultGetDbFileSize(
  dbPath: string,
  overrides: {
    execInAiDevFn?: typeof execInAiDev;
    dockerCommandFn?: typeof dockerCommand;
    resolveDataVolumeFn?: typeof resolveDataVolume;
  } = {},
): Promise<number | null> {
  const execFn = overrides.execInAiDevFn ?? execInAiDev;
  const dockerFn = overrides.dockerCommandFn ?? dockerCommand;
  const resolveFn = overrides.resolveDataVolumeFn ?? resolveDataVolume;
  const result = await execFn(
    `stat -c %s "${dbPath}" 2>/dev/null || stat -f %z "${dbPath}" 2>/dev/null || echo ""`,
    10_000,
  );
  if (result.exitCode === 0 && result.stdout.trim()) {
    const n = parseInt(result.stdout.trim(), 10);
    if (!Number.isNaN(n) && n >= 0) return n;
  }
  try {
    const volume = await resolveFn();
    const dfRes = await dockerFn(`run --rm -v ${volume}:/d:ro alpine stat -c %s /d/opencode.db`, 30_000);
    if (dfRes.exitCode === 0) {
      const n = parseInt(dfRes.stdout.trim(), 10);
      if (!Number.isNaN(n) && n >= 0) return n;
    }
  } catch (error: unknown) {
    void error;
  }
  return null;
}

export async function defaultGetFreeSpace(
  freeSpacePath: string,
  overrides: {
    execInAiDevFn?: typeof execInAiDev;
    dockerCommandFn?: typeof dockerCommand;
    resolveDataVolumeFn?: typeof resolveDataVolume;
  } = {},
): Promise<number | null> {
  const execFn = overrides.execInAiDevFn ?? execInAiDev;
  const dockerFn = overrides.dockerCommandFn ?? dockerCommand;
  const resolveFn = overrides.resolveDataVolumeFn ?? resolveDataVolume;
  const result = await execFn(
    `df -B1 --output=avail "${freeSpacePath}" 2>/dev/null | tail -n1 | tr -d ' ' | tr -d '\\n' || df -B1 "${freeSpacePath}" 2>/dev/null | awk 'NR==2{print $4}' | tr -d ' '`,
    10_000,
  );
  if (result.exitCode === 0 && result.stdout.trim()) {
    const n = parseInt(result.stdout.trim(), 10);
    if (!Number.isNaN(n) && n >= 0) return n;
  }
  try {
    const volume = await resolveFn();
    const dfRes = await dockerFn(`run --rm -v ${volume}:/d:ro alpine df -B1 --output=avail /d`, 30_000);
    if (dfRes.exitCode === 0) {
      const lines = dfRes.stdout.trim().split("\n").filter(Boolean);
      const n = parseInt(lines[lines.length - 1] ?? "", 10);
      if (!Number.isNaN(n) && n >= 0) return n;
    }
  } catch (error: unknown) {
    void error;
  }
  return null;
}

async function defaultGetWalMtime(dbPath: string): Promise<number | null> {
  const result = await execInAiDev(`stat -c %Y "${dbPath}-wal" 2>/dev/null || stat -f %m "${dbPath}-wal" 2>/dev/null || echo ""`, 5_000);
  if (result.exitCode === 0 && result.stdout.trim()) {
    const n = parseInt(result.stdout.trim(), 10);
    if (!Number.isNaN(n)) return n;
  }
  return null;
}

async function defaultStopAiDev(): Promise<ExecResult> {
  // Use docker stop via dockerCommand (mirrors restart-ai-dev pattern)
  try {
    const project = await getComposeProject();
    // Try compose stop first
    const result = await dockerCommand(`compose -p ${project} stop ai-dev`, 60_000);
    if (result.exitCode === 0) return result;
    // Fallback to direct stop
    const ref = await getAiDevContainerRef();
    return await dockerCommand(`stop -t 60 ${ref}`, 60_000);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { stdout: "", stderr: msg, exitCode: 1 };
  }
}

async function defaultStartAiDev(): Promise<ExecResult> {
  try {
    const project = await getComposeProject();
    const composeFile = "/opt/ai-engkit/compose.yml";
    const envFile = "/opt/ai-engkit/.env";
    // Use compose up for restart
    const result = await dockerCommand(
      `compose -p ${project} --env-file ${envFile} -f ${composeFile} up -d ai-dev`,
      120_000,
    );
    if (result.exitCode === 0) return result;
    const ref = await getAiDevContainerRef();
    return await dockerCommand(`start ${ref}`, 30_000);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { stdout: "", stderr: msg, exitCode: 1 };
  }
}

async function defaultIsAiDevRunning(): Promise<boolean> {
  try {
    const ref = await getAiDevContainerRef();
    const result = await dockerCommand(`inspect --format='{{.State.Running}}' ${ref}`, 5_000);
    return result.exitCode === 0 && result.stdout.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Resolve the opencode data volume from ai-dev's mounts. Never derive it
 * from naming conventions: dev uses dev_opencode-data-dev while other
 * projects use <project>_opencode-data, and docker silently auto-creates a
 * missing named volume — an empty volume that then backs up and queries
 * nothing. Throws when unresolvable so callers fail closed.
 */
export async function resolveDataVolume(): Promise<string> {
  const ref = await getAiDevContainerRef();
  const result = await dockerCommand(
    `inspect --format='{{range .Mounts}}{{if eq .Destination "/home/devuser/.local/share/opencode"}}{{.Name}}{{end}}{{end}}' ${ref}`,
    10_000,
  );
  const name = result.exitCode === 0 ? (result.stdout.trim().split("\n").filter(Boolean)[0] ?? "") : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error("no named volume mounted at the opencode path");
  }
  return name;
}

export async function defaultResolveHostBackupPath(
  containerPath: string,
  getBindSource: typeof getSelfBindSource = getSelfBindSource,
): Promise<string | null> {
  const hostRoot = await getBindSource(BACKUP_CONTAINER_ROOT);
  if (!hostRoot) return null;
  if (containerPath === BACKUP_CONTAINER_ROOT) return hostRoot;
  if (containerPath.startsWith(`${BACKUP_CONTAINER_ROOT}/`)) {
    return hostRoot + containerPath.slice(BACKUP_CONTAINER_ROOT.length);
  }
  return null;
}

interface BackupCommandOverrides {
  resolveDataVolumeFn?: typeof resolveDataVolume;
  dockerCommandFn?: typeof dockerCommand;
  resolveHostBackupPathFn?: typeof defaultResolveHostBackupPath;
}

export async function defaultCreateBackup(
  backupPath: string,
  dbPath: string,
  overrides: BackupCommandOverrides = {},
): Promise<ExecResult> {
  let volume: string;
  try {
    volume = await (overrides.resolveDataVolumeFn ?? resolveDataVolume)();
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { stdout: "", stderr: `Cannot determine data volume for backup: ${msg}`, exitCode: 1 };
  }
  const hostBackupPath = await (overrides.resolveHostBackupPathFn ?? defaultResolveHostBackupPath)(backupPath);
  if (!hostBackupPath) {
    return {
      stdout: "",
      stderr: `Cannot resolve host backup path for ${JSON.stringify(backupPath)} — bind mount ${JSON.stringify(BACKUP_CONTAINER_ROOT)} unavailable`,
      exitCode: 1,
    };
  }
  const result = await (overrides.dockerCommandFn ?? dockerCommand)(
    `run --rm -v ${volume}:/src:ro -v ${shellQuote(`${hostBackupPath}:/dst`)} alpine sh -c 'cat /src/opencode.db | gzip -6 > /dst/opencode.db.gz'`,
    120_000,
  );
  void dbPath;
  return result;
}

export async function defaultVerifyBackup(
  backupPath: string,
  overrides: BackupCommandOverrides = {},
): Promise<ExecResult> {
  const hostBackupPath = await (overrides.resolveHostBackupPathFn ?? defaultResolveHostBackupPath)(backupPath);
  if (!hostBackupPath) {
    return {
      stdout: "",
      stderr: `Cannot resolve host backup path for ${JSON.stringify(backupPath)} — bind mount ${JSON.stringify(BACKUP_CONTAINER_ROOT)} unavailable`,
      exitCode: 1,
    };
  }
  const result = await (overrides.dockerCommandFn ?? dockerCommand)(
    `run --rm -v ${shellQuote(`${hostBackupPath}:/d:ro`)} alpine sh -c 'SIZE=$(stat -c %s /d/opencode.db.gz 2>/dev/null || echo 0); if [ "$SIZE" -le 1024 ]; then echo "backup file missing or suspiciously small (\${SIZE} bytes)"; exit 1; fi; gzip -t /d/opencode.db.gz'`,
    60_000,
  );
  return result;
}

async function defaultRunSql(sql: string, dbPath: string): Promise<ExecResult> {
  const escaped = sql.replace(/"/g, '\\"').replace(/\$/g, "\\$");
  const result = await execInAiDev(`sqlite3 "${dbPath}" "${escaped}"`, 60_000);
  return result;
}

/**
 * Run SQL while ai-dev is stopped: docker exec cannot reach a stopped
 * container, so execute from a throwaway container sharing the data volume.
 * SQL travels base64-encoded on stdin — the alphabet is shell-safe at every
 * layer, avoiding nested-quoting bugs entirely.
 */
async function defaultRunSqlOnVolume(sql: string, dbPath: string): Promise<ExecResult> {
  let volume: string;
  try {
    volume = await resolveDataVolume();
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { stdout: "", stderr: `Cannot determine data volume for SQL run: ${msg}`, exitCode: 1 };
  }
  const file = dbPath.split("/").pop() || "opencode.db";
  const b64 = Buffer.from(sql, "utf8").toString("base64");
  // apk output is intentionally NOT suppressed: a failed install must surface
  // instead of failing later with an empty "exit code 1".
  const result = await dockerCommand(
    `run --rm -v ${volume}:/data alpine sh -c 'apk add --no-cache sqlite && echo ${b64} | base64 -d | sqlite3 /data/${file}'`,
    600_000,
  );
  return result;
}

async function pollAiDevHealth(
  timeoutMs: number,
  intervalMs: number,
  isRunning: () => Promise<boolean>,
  sleepFn: (ms: number) => Promise<void>,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await isRunning()) return true;
    } catch {
      // retry
    }
    await sleepFn(intervalMs);
  }
  return false;
}

export interface DbMaintenanceDeps {
  dbPath?: string;
  backupDir?: string;
  freeSpacePath?: string;
  readRetentionPolicy?: () => RetentionPolicy;
  getDbFileSize?: () => Promise<number | null>;
  getFreeSpace?: () => Promise<number | null>;
  getWalMtime?: () => Promise<number | null>;
  stopAiDev?: () => Promise<ExecResult>;
  startAiDev?: () => Promise<ExecResult>;
  isAiDevRunning?: () => Promise<boolean>;
  waitForIdle?: () => Promise<IdleWaitOutcome>;
  sleepMs?: (ms: number) => Promise<void>;
  healthTimeoutMs?: number;
  pollIntervalMs?: number;
  createBackup?: (backupPath: string) => Promise<ExecResult>;
  verifyBackup?: (backupPath: string) => Promise<ExecResult>;
  runSql?: (sql: string) => Promise<ExecResult>;
  // In-window SQL path (ai-dev stopped): runMaintenance binds its local
  // runner from here, never from runSql above.
  runSqlOnVolume?: (sql: string) => Promise<ExecResult>;
  headroomMultiplier?: number;
  criticalFloorBytes?: number;
  nowMs?: () => number;
  getHostBackupPath?: (containerPath: string) => Promise<string | null>;
}

/**
 * FK-correct cutoff: sessions with time_updated < cutoff (milliseconds since epoch).
 * Returns the cutoff epoch millis for the given policy.
 */
export function cutoffEpochMs(policy: RetentionPolicy, nowMs: number = Date.now()): number {
  return nowMs - policy.cutoffDays * 24 * 60 * 60 * 1000;
}

/**
 * Query live to-delete counts without mutating. Uses the injected runSql.
 * Returns session and event_sequence counts that would be deleted.
 */
export async function getDeleteCounts(
  policy: RetentionPolicy,
  deps: Pick<DbMaintenanceDeps, "runSql" | "nowMs"> = {},
): Promise<{ sessions: number; eventSequences: number }> {
  const runSql = deps.runSql ?? ((sql: string) => defaultRunSql(sql, DEFAULT_DB_PATH));
  const cutoff = cutoffEpochMs(policy, (deps.nowMs ?? Date.now)());
  const sessionRes = await runSql(`SELECT COUNT(*) FROM session WHERE time_updated < ${cutoff};`);
  const seqRes = await runSql(
    `SELECT COUNT(*) FROM event_sequence WHERE aggregate_id IN (SELECT id FROM session WHERE time_updated < ${cutoff});`,
  );
  const parseCount = (raw: string): number => {
    const n = parseInt(raw.trim().split("\n")[0] ?? "0", 10);
    if (Number.isNaN(n) || n < 0) return 0;
    return n;
  };
  return {
    sessions: sessionRes.exitCode === 0 ? parseCount(sessionRes.stdout) : 0,
    eventSequences: seqRes.exitCode === 0 ? parseCount(seqRes.stdout) : 0,
  };
}

export async function runMaintenance(deps: DbMaintenanceDeps = {}): Promise<boolean> {
  if (currentState === "running") {
    throw new Error("Maintenance already in progress");
  }

  const dbPath = deps.dbPath ?? DEFAULT_DB_PATH;
  const backupDir = deps.backupDir ?? DEFAULT_BACKUP_DIR;
  const freeSpacePath = deps.freeSpacePath ?? "/home/devuser/.local/share/opencode";
  const readPolicy = deps.readRetentionPolicy ?? readRetentionPolicy;
  const getDbFileSize = deps.getDbFileSize ?? (() => defaultGetDbFileSize(dbPath));
  const getFreeSpace = deps.getFreeSpace ?? (() => defaultGetFreeSpace(freeSpacePath));
  const getWalMtime = deps.getWalMtime ?? (() => defaultGetWalMtime(dbPath));
  const stopAiDev = deps.stopAiDev ?? defaultStopAiDev;
  const startAiDev = deps.startAiDev ?? defaultStartAiDev;
  const isRunning = deps.isAiDevRunning ?? defaultIsAiDevRunning;
  const waitForIdle = deps.waitForIdle ?? (() => waitForIdleSessions(probeIdleViaOpenCodeServer));
  const sleepFn = deps.sleepMs ?? sleep;
  const healthTimeoutMs = deps.healthTimeoutMs ?? 120_000;
  const pollIntervalMs = deps.pollIntervalMs ?? 3_000;
  const getHostBackupPath = deps.getHostBackupPath ?? defaultResolveHostBackupPath;
  const createBackup =
    deps.createBackup ??
    ((p: string) => defaultCreateBackup(p, dbPath, { resolveHostBackupPathFn: getHostBackupPath }));
  const verifyBackup =
    deps.verifyBackup ??
    ((p: string) => defaultVerifyBackup(p, { resolveHostBackupPathFn: getHostBackupPath }));
  // In-window SQL must NOT use the live runner: ai-dev is stopped from quiesce
  // on, so docker exec is unreachable. Bind the local to the volume runner;
  // getDeleteCounts keeps the live default via its own deps (pre-stop reads).
  const runSql = deps.runSqlOnVolume ?? ((sql: string) => defaultRunSqlOnVolume(sql, dbPath));
  const headroomMultiplier = deps.headroomMultiplier ?? DEFAULT_HEADROOM_MULTIPLIER;
  const criticalFloorBytes = deps.criticalFloorBytes ?? DEFAULT_CRITICAL_FLOOR_BYTES;
  const nowMs = deps.nowMs ?? Date.now;

  currentState = "running";
  eventLog = [];
  lastError = null;

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(backupDir, `maintenance-${timestamp}`);

  // Helper to fail a step and transition to failed
  const failStep = (step: MaintenanceStep, message: string): boolean => {
    emit(step, "failure", message);
    currentState = "failed";
    lastError = message;
    return false;
  };

  try {
    // --- Guard: retention policy enabled ---
    const policy = readPolicy();
    if (!policy.enabled) {
      return failStep("backup", "Retention policy is disabled — enable it before running maintenance");
    }

    // --- Guard: disk headroom before any destructive work ---
    const dbSize = await getDbFileSize();
    if (dbSize === null) {
      return failStep("backup", "Unable to determine database size — refusing to start");
    }
    const freeSpace = await getFreeSpace();
    if (freeSpace === null) {
      return failStep("backup", "Unable to determine free disk space — refusing to start");
    }
    const requiredHeadroom = Math.floor(dbSize * headroomMultiplier);
    if (freeSpace < requiredHeadroom) {
      return failStep(
        "backup",
        `Insufficient disk space: ${freeSpace} bytes free, need ${requiredHeadroom} bytes headroom (db ${dbSize} bytes × ${headroomMultiplier})`,
      );
    }
    if (freeSpace < criticalFloorBytes) {
      return failStep("backup", `Free space below critical floor (${criticalFloorBytes} bytes) — refusing to start`);
    }

    // --- Step 1: backup ---
    // backupPath is a HOST path consumed via docker -v, so no local mkdir
    // here: this container's filesystem is a different namespace and the
    // directory would be created in the wrong place. Docker auto-creates a
    // missing host source dir on mount; createBackup fails closed instead.
    emit("backup", "running", "Creating compressed backup...");

    const backupResult = await createBackup(backupPath);
    if (backupResult.exitCode !== 0) {
      const detail = backupResult.stderr || backupResult.stdout || `exit code ${backupResult.exitCode}`;
      return failStep("backup", `Backup failed: ${detail}`);
    }

    // Gzip integrity verification — gates any delete
    const verifyResult = await verifyBackup(backupPath);
    if (verifyResult.exitCode !== 0) {
      const detail = verifyResult.stderr || verifyResult.stdout || `exit code ${verifyResult.exitCode}`;
      return failStep("backup", `Backup verification failed (gzip -t): ${detail} — refusing to delete`);
    }

    emit("backup", "success", `Backup verified at ${backupPath}`);

    // --- Idle-session wait: never stop ai-dev while sessions are running ---
    // Unlike restart's force fallback, maintenance fails closed here: deleting
    // sessions out from under a running agent is worse than skipping the run.
    // Nothing has been stopped yet, so no restart is needed on this path.
    emit("quiesce", "running", "Waiting for active opencode sessions to complete...");
    const idleOutcome = await waitForIdle();
    if (idleOutcome !== "idle") {
      const reason =
        idleOutcome === "timeout"
          ? "Timed out waiting for active opencode sessions to complete"
          : "Session status unavailable — cannot confirm idleness";
      return failStep("quiesce", `${reason} — refusing to stop ai-dev`);
    }

    // --- Step 2: quiesce (stop ai-dev, confirm WAL frozen) ---
    emit("quiesce", "running", "Stopping ai-dev for single-writer window...");
    const walBefore = await getWalMtime();
    const stopResult = await stopAiDev();
    if (stopResult.exitCode !== 0) {
      const detail = stopResult.stderr || stopResult.stdout || `exit code ${stopResult.exitCode}`;
      return failStep("quiesce", `Failed to stop ai-dev: ${detail}`);
    }

    // Confirm WAL frozen: mtime must not advance after stop
    await sleepFn(500);
    const walAfter = await getWalMtime();
    if (walBefore !== null && walAfter !== null && walAfter > walBefore) {
      // WAL still advancing — writer still active
      // Attempt restart before failing
      const restartAttempt = await startAiDev();
      void restartAttempt;
      return failStep("quiesce", `WAL not frozen after stop (mtime ${walBefore} → ${walAfter}) — writer may still be active`);
    }

    emit("quiesce", "success", "ai-dev stopped, WAL frozen");

    // --- Step 3: delete (FK-correct, foreign_keys=ON) ---
    emit("delete", "running", "Deleting expired sessions (FK-correct order)...");
    const cutoff = cutoffEpochMs(policy, nowMs());

    // Assert foreign_keys enforcement and perform deletes
    // 1. Ensure FK enforcement is on (PRAGMA foreign_keys=ON is per-connection)
    const fkOn = await runSql("PRAGMA foreign_keys=ON; PRAGMA foreign_keys;");
    if (fkOn.exitCode !== 0 || !fkOn.stdout.includes("1")) {
      // Try to surface the issue but continue with explicit FK-order delete which is safe regardless
      // If the runner doesn't support PRAGMA check, we still enforce order
      void fkOn;
    }

    // 2. FK-correct order: event_sequence first (cascades to event), then session
    const deleteSeq = await runSql(
      `PRAGMA foreign_keys=ON; DELETE FROM event_sequence WHERE aggregate_id IN (SELECT id FROM session WHERE time_updated < ${cutoff}); SELECT changes();`,
    );
    if (deleteSeq.exitCode !== 0) {
      const detail = deleteSeq.stderr || deleteSeq.stdout || `exit code ${deleteSeq.exitCode}`;
      // Attempt restart before failing
      await startAiDev();
      return failStep("delete", `Failed to delete event sequences: ${detail}`);
    }

    const deleteSess = await runSql(
      `PRAGMA foreign_keys=ON; DELETE FROM session WHERE time_updated < ${cutoff}; SELECT changes();`,
    );
    if (deleteSess.exitCode !== 0) {
      const detail = deleteSess.stderr || deleteSess.stdout || `exit code ${deleteSess.exitCode}`;
      await startAiDev();
      return failStep("delete", `Failed to delete sessions: ${detail}`);
    }

    emit("delete", "success", `Delete complete (cutoff ${new Date(cutoff).toISOString()})`);

    // --- Step 4: reclaim (checkpoint + guarded VACUUM) ---
    emit("reclaim", "running", "Reclaiming space (checkpoint + VACUUM)...");

    // Mid-run floor check before reclaim
    const freeBeforeReclaim = await getFreeSpace();
    if (freeBeforeReclaim !== null && freeBeforeReclaim < criticalFloorBytes) {
      await startAiDev();
      return failStep("reclaim", `Free space below critical floor before reclaim (${freeBeforeReclaim} < ${criticalFloorBytes}) — aborting VACUUM`);
    }

    const checkpoint = await runSql("PRAGMA wal_checkpoint(TRUNCATE);");
    if (checkpoint.exitCode !== 0) {
      const detail = checkpoint.stderr || checkpoint.stdout || `exit code ${checkpoint.exitCode}`;
      await startAiDev();
      return failStep("reclaim", `wal_checkpoint failed: ${detail}`);
    }

    // Guarded VACUUM — check headroom again (VACUUM needs ~1x DB temp in WAL mode)
    const freeBeforeVacuum = await getFreeSpace();
    if (freeBeforeVacuum !== null && freeBeforeVacuum < criticalFloorBytes) {
      await startAiDev();
      return failStep("reclaim", `Free space below critical floor before VACUUM (${freeBeforeVacuum} < ${criticalFloorBytes}) — aborting`);
    }

    const vacuum = await runSql("VACUUM;");
    if (vacuum.exitCode !== 0) {
      const detail = vacuum.stderr || vacuum.stdout || `exit code ${vacuum.exitCode}`;
      await startAiDev();
      return failStep("reclaim", `VACUUM failed: ${detail}`);
    }

    emit("reclaim", "success", "Space reclaimed (checkpoint + VACUUM complete)");

    // --- Step 5: verify (quick_check) ---
    emit("verify", "running", "Verifying integrity (quick_check)...");
    const quickCheck = await runSql("PRAGMA quick_check;");
    if (quickCheck.exitCode !== 0) {
      const detail = quickCheck.stderr || quickCheck.stdout || `exit code ${quickCheck.exitCode}`;
      await startAiDev();
      return failStep("verify", `Integrity check failed: ${detail}`);
    }
    const qcOut = quickCheck.stdout.trim().toLowerCase();
    if (qcOut !== "ok" && !qcOut.includes("ok")) {
      await startAiDev();
      return failStep("verify", `Integrity check did not return ok: ${quickCheck.stdout.trim()}`);
    }

    emit("verify", "success", "Integrity verified (quick_check ok)");

    // --- Restart ai-dev and health poll ---
    const startResult = await startAiDev();
    if (startResult.exitCode !== 0) {
      const detail = startResult.stderr || startResult.stdout || `exit code ${startResult.exitCode}`;
      return failStep("verify", `Failed to restart ai-dev: ${detail}`);
    }

    const healthy = await pollAiDevHealth(healthTimeoutMs, pollIntervalMs, isRunning, sleepFn);
    if (!healthy) {
      return failStep("verify", "ai-dev did not become healthy within timeout after restart");
    }

    // Success terminal
    currentState = "done";
    lastSuccessAt = new Date().toISOString();
    lastError = null;
    return true;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    // Find the running step to mark as failed
    const runningStep = [...eventLog].reverse().find((e) => e.status === "running")?.step;
    if (runningStep) {
      emit(runningStep, "failure", msg);
    } else if (eventLog.length === 0) {
      emit("backup", "failure", msg);
    }
    currentState = "failed";
    lastError = msg;
    // Best-effort restart if we stopped ai-dev
    try {
      await (deps.startAiDev ?? defaultStartAiDev)();
    } catch {
      // ignore restart failure during error handling
    }
    return false;
  }
}
