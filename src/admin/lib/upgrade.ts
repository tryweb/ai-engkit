import {
  execInAiDev,
  dockerCommand,
  getAiDevContainerRef,
  getComposeProject,
  getSiblingDevContainerName,
  isAiDevRunning,
  type ExecResult,
} from "./docker";
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, rmSync, statSync, readdirSync, chmodSync } from "node:fs";
import { basename, join } from "node:path";
import { readEnvFile, writeEnvFile, type EnvVars } from "./env";
import { KEYS_PATH } from "./provider-keys";
import { resolveImageRef } from "./image-ref";
import {
  UPGRADE_BASE_FILE,
  buildRecreateSubcommand,
  getOverlayStatus,
  overlayLabel,
  resolveEffectiveCompose,
  resolveOverlay,
  validateEffectiveCompose,
  type EffectiveCompose,
  type OverlayConfigDeps,
  type OverlayResolution,
  type ValidateEffectiveOptions,
  type ValidationResult,
} from "./compose-overlay";

const BACKUP_DIR = "/opt/ai-engkit/backups";
const COMPOSE_FILE = "/opt/ai-engkit/compose.yml";
const ENV_FILE = "/opt/ai-engkit/.env";
const UPSTREAM_REPO = "https://raw.githubusercontent.com/tryweb/ai-engkit";

/**
 * Upstream raw-content base for upgrade assets (compose file,
 * .env.example). Pinned installs (AI_ENGKIT_VERSION in .env) fetch assets
 * matching their running version instead of whatever main currently has.
 */
function upstreamBase(): string {
  const version = readEnvFile().AI_ENGKIT_VERSION?.trim();
  return version ? `${UPSTREAM_REPO}/${version}` : `${UPSTREAM_REPO}/main`;
}

/** BACKUP_RETENTION from .env: positive integer, default 5 (mirrors upgrade.sh). */
export function resolveBackupRetention(env: EnvVars): number {
  const raw = env.BACKUP_RETENTION;
  if (raw === undefined || !/^[0-9]+$/.test(raw)) return 5;
  const n = Number(raw);
  return n >= 1 ? n : 5;
}

/** Delete oldest pre-* backup dirs beyond retention; returns the removed names. */
export function pruneOldBackups(backupRoot: string, retention: number): string[] {
  if (retention < 1) return [];
  let dirs: string[];
  try {
    dirs = readdirSync(backupRoot).filter((d: string) => d.startsWith("pre-")).sort();
  } catch {
    return [];
  }
  const toRemove = dirs.length - retention;
  if (toRemove <= 0) return [];
  const removed: string[] = [];
  for (const d of dirs.slice(0, toRemove)) {
    rmSync(join(backupRoot, d), { recursive: true, force: true });
    removed.push(d);
  }
  return removed;
}

/** Parse the reconcile script's {"added":N} output; null when not parseable. */
export function parseReconcileOutput(stdout: string): { added: number } | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const added = (parsed as Record<string, unknown>).added;
    if (typeof added !== "number" || !Number.isInteger(added) || added < 0) return null;
    return { added };
  } catch {
    return null;
  }
}

export type UpgradeStep =
  | "digest_compare"
  | "backup"
  | "merge_env"
  | "recreate"
  | "poll_health"
  | "reconcile"
  | "cleanup";

export type StepStatus = "pending" | "running" | "success" | "failure";

export interface UpgradeEvent {
  id: number;
  step: UpgradeStep;
  status: StepStatus;
  message: string;
  timestamp: string;
}

let nextEventId = 1;

export type UpgradeState = "idle" | "running" | "completed" | "failed";

let currentState: UpgradeState = "idle";
let eventLog: UpgradeEvent[] = [];
let logSubscribers: ((event: UpgradeEvent) => void)[] = [];

export function getState(): UpgradeState {
  return currentState;
}

export function getEventLog(): UpgradeEvent[] {
  return [...eventLog];
}

export function subscribe(subscriber: (event: UpgradeEvent) => void): () => void {
  logSubscribers.push(subscriber);
  return () => {
    logSubscribers = logSubscribers.filter((s) => s !== subscriber);
  };
}

function emit(step: UpgradeStep, status: StepStatus, message: string): void {
  const event: UpgradeEvent = {
    id: nextEventId++,
    step,
    status,
    message,
    timestamp: new Date().toISOString(),
  };
  eventLog.push(event);
  for (const sub of logSubscribers) {
    sub(event);
  }
}

export function getStatus(
  overlayDeps: OverlayConfigDeps = {},
): {
  state: UpgradeState;
  events: UpgradeEvent[];
  current_step: UpgradeStep | "";
  progress_pct: number;
  overlay: ReturnType<typeof getOverlayStatus>;
} {
  const steps: UpgradeStep[] = ["digest_compare", "backup", "merge_env", "recreate", "poll_health", "reconcile", "cleanup"];
  const lastRunning = [...eventLog].reverse().find((e) => e.status === "running");
  const lastFailed = [...eventLog].reverse().find((e) => e.status === "failure");
  const currentStep = lastFailed?.step || lastRunning?.step || "";
  const doneSteps = eventLog.filter((e) => e.status === "success").length;
  const totalSteps = steps.length;
  return {
    state: currentState,
    events: [...eventLog],
    current_step: currentStep,
    progress_pct: Math.round((doneSteps / totalSteps) * 100),
    overlay: getOverlayStatus({ readEnv: readEnvFile, ...overlayDeps }),
  };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchLatestCompose(): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(`${upstreamBase()}/docker-compose.yml`, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Deterministic seams for the upgrade pipeline. Every field is optional and
 * defaults to the real production implementation, so `runUpgrade()` with no
 * arguments behaves exactly as before. Tests inject fakes here instead of
 * touching Docker, the network, or host paths.
 */
export interface MergeEnvDeps {
  readEnv?: () => EnvVars;
  writeEnv?: (vars: EnvVars) => void;
  fetchEnvExample?: () => Promise<string | null>;
}

export interface PollHealthDeps {
  isRunning?: () => Promise<boolean>;
  sleepMs?: (ms: number) => Promise<void>;
  intervalMs?: number;
}

export interface UpgradeDeps extends MergeEnvDeps, PollHealthDeps {
  backupDir?: string;
  composeFile?: string;
  stagedBaseFile?: string;
  envFile?: string;
  keysFile?: string;
  versionFile?: string;
  resolveImage?: () => string;
  readLocalVersion?: () => string | null;
  ensureComposeFile?: () => Promise<void>;
  pullImage?: (imageRef: string) => Promise<ExecResult>;
  getContainerRef?: () => Promise<string>;
  snapshotSettings?: (containerRef: string, destPath: string) => Promise<ExecResult>;
  fetchComposeText?: () => Promise<string | null>;
  writeComposeText?: (content: string) => void;
  writeStagedBase?: (content: string) => void;
  getProject?: () => Promise<string>;
  composeUp?: (subcommand: string) => Promise<ExecResult>;
  resolveOverlayState?: () => OverlayResolution;
  validateOverlay?: (options: ValidateEffectiveOptions) => Promise<ValidationResult>;
  reconcile?: () => Promise<ExecResult>;
  pruneOld?: (backupRoot: string, retention: number) => string[];
  pruneImages?: () => Promise<ExecResult>;
  healthTimeoutMs?: number;
}

async function defaultFetchEnvExample(): Promise<string | null> {
  const result = await execInAiDev(`curl -sS ${upstreamBase()}/.env.example 2>/dev/null || true`, 30_000);
  if (result.exitCode !== 0 || !result.stdout) return null;
  return result.stdout;
}

async function defaultEnsureComposeFile(composeFile: string, resolveImage: () => string): Promise<void> {
  try {
    const st = statSync(composeFile);
    if (!st.isDirectory()) return;
    rmSync(composeFile, { recursive: true });
  } catch (err: unknown) {
    if (existsSync(composeFile)) {
      void err;
      return;
    }
    void err;
  }
  let siblingName = "ai-engkit-dev";
  try {
    siblingName = await getSiblingDevContainerName();
  } catch (err: unknown) {
    void err;
  }
  writeFileSync(
    composeFile,
    `services:\n  ai-dev:\n    image: ${resolveImage()}\n    container_name: ${siblingName}\n    restart: unless-stopped\n`,
  );
}

function defaultReadLocalVersion(versionFile: string): string | null {
  try {
    return readFileSync(versionFile, "utf-8").trim();
  } catch (err: unknown) {
    void err;
    return null;
  }
}

export async function runUpgrade(deps: UpgradeDeps = {}): Promise<boolean> {
  if (currentState === "running") {
    throw new Error("Upgrade already in progress");
  }

  const backupDir = deps.backupDir ?? BACKUP_DIR;
  const composeFile = deps.composeFile ?? COMPOSE_FILE;
  const stagedBaseFile = deps.stagedBaseFile ?? UPGRADE_BASE_FILE;
  const envFile = deps.envFile ?? ENV_FILE;
  const keysFile = deps.keysFile ?? KEYS_PATH;
  const versionFile = deps.versionFile ?? "/opt/ai-engkit/VERSION";
  const resolveImage = deps.resolveImage ?? resolveImageRef;
  const readLocalVersion = deps.readLocalVersion ?? (() => defaultReadLocalVersion(versionFile));
  const ensureComposeFile = deps.ensureComposeFile ?? (() => defaultEnsureComposeFile(composeFile, resolveImage));
  const pullImage = deps.pullImage ?? ((ref: string) => dockerCommand(`pull ${ref}`, 180_000));
  const getContainerRef = deps.getContainerRef ?? getAiDevContainerRef;
  const snapshotSettings =
    deps.snapshotSettings ??
    ((ref: string, dest: string) =>
      dockerCommand(`cp ${ref}:/home/devuser/.config/openchamber/settings.json ${dest}`, 30_000));
  const fetchComposeText = deps.fetchComposeText ?? fetchLatestCompose;
  const writeComposeText = deps.writeComposeText ?? ((content: string) => writeFileSync(composeFile, content));
  const writeStagedBase = deps.writeStagedBase ?? ((content: string) => writeFileSync(stagedBaseFile, content));
  const getProject = deps.getProject ?? getComposeProject;
  const composeUp = deps.composeUp ?? ((subcommand: string) => dockerCommand(subcommand, 300_000));
  const resolveOverlayState =
    deps.resolveOverlayState ?? (() => resolveOverlay({ readEnv: deps.readEnv ?? readEnvFile }));
  const validateOverlay = deps.validateOverlay ?? validateEffectiveCompose;
  const reconcile =
    deps.reconcile ?? (() => execInAiDev("/opt/ai-engkit/scripts/reconcile-openchamber-projects.sh", 60_000));
  const pruneOld = deps.pruneOld ?? pruneOldBackups;
  const pruneImages = deps.pruneImages ?? (() => dockerCommand("image prune -f", 60_000));
  const healthTimeoutMs = deps.healthTimeoutMs ?? 120_000;

  // Pre-flight: ensure compose file is a regular file (not a DooD-empty directory)
  await ensureComposeFile();

  // Dev build guard: version=dev indicates a locally-built image, skip upgrade
  const localVersion = readLocalVersion();
  if (localVersion === "dev") {
    throw new Error("Dev build detected. Upgrade is only available for production releases (ghcr.io/tryweb/ai-engkit:latest).");
  }

  currentState = "running";
  eventLog = [];

  // Rollback tracking: only recreate/poll_health failures roll back, using the
  // backup created by this run. Digest/backup/merge failures never roll back.
  let backupPath: string | null = null;
  let overlay: OverlayResolution = { active: false };
  let validationFailed = false;

  try {
    try {
      overlay = resolveOverlayState();
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      emit("backup", "failure", `Domain overlay configuration is invalid: ${detail}`);
      currentState = "failed";
      return false;
    }

    // Step 1: Digest compare
    emit("digest_compare", "running", "Fetching latest image digest...");
    const pullResult = await pullImage(resolveImage());
    if (pullResult.exitCode !== 0) {
      throw new Error(`Failed to pull image: ${pullResult.stderr}`);
    }
    emit("digest_compare", "success", "Latest image pulled successfully");

    // Step 2: Backup
    emit("backup", "running", "Creating pre-upgrade backup...");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    backupPath = join(backupDir, `pre-${timestamp}`);
    mkdirSync(backupPath, { recursive: true, mode: 0o700 });
    chmodSync(backupPath, 0o700);
    if (existsSync(envFile)) {
      copySensitive(envFile, join(backupPath, ".env"));
    }
    if (existsSync(composeFile)) {
      try {
        const st = statSync(composeFile);
        if (!st.isDirectory()) copySensitive(composeFile, join(backupPath, "compose.yml"));
      } catch (err: unknown) {
        void err;
      }
    }
    if (overlay.active) {
      try {
        const st = statSync(stagedBaseFile);
        if (!st.isDirectory()) copySensitive(stagedBaseFile, join(backupPath, "compose-upgrade-base.yml"));
      } catch (err: unknown) {
        void err;
      }
      const overlayBackupDir = join(backupPath, "overlay");
      mkdirSync(overlayBackupDir, { recursive: true, mode: 0o700 });
      chmodSync(overlayBackupDir, 0o700);
      try {
        copySensitive(overlay.canonicalPath, join(overlayBackupDir, basename(overlay.canonicalPath)));
      } catch (err: unknown) {
        void err;
      }
      writeSensitive(join(backupPath, "overlay-reference.txt"), `${overlay.reference}\n${overlay.canonicalPath}\n`);
    }
    if (existsSync(keysFile)) {
      copySensitive(keysFile, join(backupPath, "provider-keys.json"));
    }
    const backupNotes: string[] = [];
    // Snapshot the registration list while the old image still runs; the new
    // image may start with a fresh list that needs reconciling against it.
    const devRef = await getContainerRef();
    const snapshot = await snapshotSettings(devRef, join(backupPath, "openchamber-settings.json"));
    if (snapshot.exitCode === 0) {
      try {
        chmodSync(join(backupPath, "openchamber-settings.json"), 0o600);
      } catch (err: unknown) {
        void err;
      }
    }
    backupNotes.push(
      snapshot.exitCode === 0 ? "OpenChamber settings snapshot saved" : "OpenChamber settings not found, snapshot skipped",
    );
    if (overlay.active) backupNotes.push(`domain overlay ${overlayLabel(overlay)} preserved`);
    emit(
      "backup",
      "success",
      `Backup saved to ${backupPath}${backupNotes.length > 0 ? ` (${backupNotes.join("; ")})` : ""}`,
    );

    // Step 3: Merge .env
    emit("merge_env", "running", "Merging new environment variables...");
    await mergeEnvFromUpstream(deps);
    emit("merge_env", "success", "Environment variables merged");

    // Step 4: Recreate ai-dev
    emit(
      "recreate",
      "running",
      overlay.active
        ? `Domain overlay ${overlayLabel(overlay)} active: staging upstream base and validating the effective configuration before recreating ai-dev...`
        : "Fetching latest docker-compose.yml, then recreating ai-dev with new image...",
    );
    // Apply the latest compose file from upstream so services added since the
    // last deploy take effect. Fail closed when unreachable: throwing before
    // writeComposeText/composeUp leaves the live compose file untouched, and
    // rollback below restores the backed-up file, so forward progress must
    // never run on stale compose content. Cleanup/pruning only runs on success.
    // With an overlay the upstream content is staged as the base file instead of
    // overwriting the domain-owned active file, then the effective base+overlay
    // configuration is validated before any container is recreated.
    const latestCompose = await fetchComposeText();
    if (latestCompose === null) throw new Error("Failed to fetch latest docker-compose.yml");
    const project = await getProject();
    let effective: EffectiveCompose = {
      overlayActive: false,
      files: [composeFile],
      overlayReference: null,
    };
    if (overlay.active) {
      // Validate the new upstream base against the overlay before committing it,
      // so a validation failure never replaces the effective configuration.
      const stagingPath = `${stagedBaseFile}.staging`;
      writeFileSync(stagingPath, latestCompose, { mode: 0o600 });
      let validationError: string | null = null;
      try {
        const validation = await validateOverlay({ overlay, baseFile: stagingPath, project, envFile });
        if (!validation.ok) {
          validationError = "error" in validation ? validation.error : "unknown validation failure";
        }
      } finally {
        rmSync(stagingPath, { force: true });
      }
      if (validationError !== null) {
        validationFailed = true;
        throw new Error(`Effective Compose validation failed: ${validationError}`);
      }
      writeStagedBase(latestCompose);
      effective = resolveEffectiveCompose(overlay, {
        paths: { activeFile: composeFile, stagedBaseFile },
      });
      emit("recreate", "running", `Effective base+overlay configuration validated (${overlayLabel(overlay)}); recreating ai-dev...`);
    } else {
      writeComposeText(latestCompose);
    }
    const recreateSubcommand = buildRecreateSubcommand({
      project,
      envFile,
      effective,
      action: "up -d --force-recreate ai-dev",
    });
    const recreateResult = await composeUp(recreateSubcommand);
    if (recreateResult.exitCode !== 0) {
      throw new Error(
        `Failed to recreate ai-dev: ${recreateResult.stderr || recreateResult.stdout || `exit code ${recreateResult.exitCode}`}`,
      );
    }
    emit("recreate", "success", overlay.active ? "ai-dev recreated with base+overlay configuration" : "ai-dev container recreated");

    // Step 5: Poll health
    emit("poll_health", "running", "Waiting for ai-dev to become healthy...");
    const healthy = await pollAiDevHealth(healthTimeoutMs, deps);
    if (!healthy) {
      throw new Error("ai-dev did not become healthy within timeout");
    }
    emit("poll_health", "success", "ai-dev is healthy");

    // Step 6: Reconcile OpenChamber registrations. Soft step on purpose:
    // a reconcile failure must not fail the upgrade; the manual
    // Projects → Sync flow stays available as the fallback.
    emit("reconcile", "running", "Reconciling OpenChamber project registrations...");
    const reconcileResult = await reconcile();
    if (reconcileResult.exitCode === 0) {
      const parsed = parseReconcileOutput(reconcileResult.stdout);
      if (parsed !== null && parsed.added > 0) {
        emit("reconcile", "success", `${parsed.added} project registration${parsed.added === 1 ? "" : "s"} restored`);
      } else if (parsed !== null) {
        emit("reconcile", "success", "Registration list is consistent; nothing needed restoring");
      } else {
        emit("reconcile", "success", `Reconcile finished: ${reconcileResult.stdout.trim() || "no output"}`);
      }
    } else {
      const detail = reconcileResult.stderr.trim() || reconcileResult.stdout.trim() || `exit code ${reconcileResult.exitCode}`;
      emit("reconcile", "success", `Reconcile skipped: ${detail} (manual sync remains available)`);
    }

    // Step 7: Cleanup. Old backups are pruned only on the success path so a
    // failed upgrade never deletes history it might need for recovery.
    emit("cleanup", "running", "Cleaning up old images...");
    await pruneImages();
    const pruned = pruneOld(backupDir, resolveBackupRetention((deps.readEnv ?? readEnvFile)()));
    emit("cleanup", "success", pruned.length > 0 ? `Upgrade complete (${pruned.length} old backup(s) pruned)` : "Upgrade complete");

    currentState = "completed";
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Determine which step failed
    const failedStep = eventLog
      .filter((e) => e.status === "running")
      .pop()?.step;
    if (failedStep) {
      let failureMessage = msg;
      if (backupPath !== null && (failedStep === "recreate" || failedStep === "poll_health")) {
        const rollbackSummary = await rollbackToBackup(backupPath, {
          envFile,
          composeFile,
          stagedBaseFile,
          overlay,
          getProject,
          composeUp,
          skipCompose: validationFailed,
        });
        failureMessage = `${msg} (rollback: ${rollbackSummary})`;
      }
      emit(failedStep, "failure", failureMessage);
    }
    currentState = "failed";
    return false;
  }
}

/** Copy one configuration input into a backup directory with owner-only mode. */
function copySensitive(source: string, destination: string): void {
  cpSync(source, destination);
  chmodSync(destination, 0o600);
}

/** Write sensitive backup metadata with owner-only mode. */
function writeSensitive(destination: string, content: string): void {
  writeFileSync(destination, content, { mode: 0o600 });
  chmodSync(destination, 0o600);
}

interface RollbackOps {
  readonly envFile: string;
  readonly composeFile: string;
  readonly stagedBaseFile: string;
  readonly overlay: OverlayResolution;
  readonly getProject: () => Promise<string>;
  readonly composeUp: (subcommand: string) => Promise<ExecResult>;
  /** True when validation failed before compose up, so nothing needs re-running. */
  readonly skipCompose?: boolean;
}

/** Same usable-base rule as resolveEffectiveCompose: exists, a regular file, size > 0. */
function isUsableComposeBase(path: string): boolean {
  try {
    const st = statSync(path);
    return st.isFile() && st.size > 0;
  } catch (err: unknown) {
    void err;
    return false;
  }
}

function effectiveAfterRestore(
  ops: RollbackOps,
  stagedBaseRestored: boolean,
): { readonly effective: EffectiveCompose; readonly note: string } {
  if (ops.overlay.active) {
    if (stagedBaseRestored && isUsableComposeBase(ops.stagedBaseFile)) {
      return {
        effective: {
          overlayActive: true,
          files: [ops.stagedBaseFile, ops.overlay.canonicalPath],
          overlayReference: ops.overlay.reference,
        },
        note: "",
      };
    }
    // Fresh installs stage a zero-byte base: a restored-but-empty staged file
    // is unusable, so fall back to the active Compose file as the overlay base
    // (matching resolveEffectiveCompose) instead of recomposing against it.
    if (isUsableComposeBase(ops.composeFile)) {
      return {
        effective: {
          overlayActive: true,
          files: [ops.composeFile, ops.overlay.canonicalPath],
          overlayReference: ops.overlay.reference,
        },
        note: "",
      };
    }
    return {
      effective: { overlayActive: false, files: [ops.composeFile], overlayReference: null },
      note: "overlay was not previously staged, restored base-only configuration",
    };
  }
  return { effective: { overlayActive: false, files: [ops.composeFile], overlayReference: null }, note: "" };
}

/**
 * Restore the prior effective configuration inputs from this run's backup and
 * re-run Compose so the previous deployment is live again. Returns a short
 * summary and never throws, so the original failure stays visible. Overlay
 * content lives on a read-only mount and is never modified, so it is not
 * rewritten; an incompletely restorable overlay is reported as a partial result.
 */
async function rollbackToBackup(backupPath: string, ops: RollbackOps): Promise<string> {
  const restored: string[] = [];
  const errors: string[] = [];
  const pairs: Array<readonly [string, string]> = [
    [".env", ops.envFile],
    ["compose.yml", ops.composeFile],
    ["compose-upgrade-base.yml", ops.stagedBaseFile],
  ];
  let stagedBaseRestored = false;
  for (const [backupName, target] of pairs) {
    const source = join(backupPath, backupName);
    try {
      if (!existsSync(source)) continue;
      const bytes = readFileSync(source);
      writeFileSync(target, bytes);
      restored.push(backupName);
      if (backupName === "compose-upgrade-base.yml") stagedBaseRestored = true;
    } catch (err: unknown) {
      errors.push(`${backupName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const { effective, note } = effectiveAfterRestore(ops, stagedBaseRestored);
  if (note) errors.push(`overlay restore incomplete (${note})`);
  if (ops.skipCompose === true) {
    if (errors.length > 0) {
      return `partial (restored: ${restored.length > 0 ? restored.join(", ") : "none"}; errors: ${errors.join("; ")})`;
    }
    return `restored ${restored.length > 0 ? restored.join(", ") : "nothing to restore"}; validation failed before recreate, running configuration unchanged`;
  }
  try {
    const project = await ops.getProject();
    const subcommand = buildRecreateSubcommand({
      project,
      envFile: ops.envFile,
      effective,
      action: "up -d --force-recreate ai-dev",
    });
    const recompose = await ops.composeUp(subcommand);
    if (recompose.exitCode !== 0) {
      errors.push(
        `compose up: ${recompose.stderr || recompose.stdout || `exit code ${recompose.exitCode}`}`,
      );
    }
  } catch (err: unknown) {
    errors.push(`compose up: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (errors.length > 0) {
    return `partial (restored: ${restored.length > 0 ? restored.join(", ") : "none"}; errors: ${errors.join("; ")})`;
  }
  return `restored ${restored.length > 0 ? restored.join(", ") : "nothing to restore"} and re-ran compose up`;
}

export async function mergeEnvFromUpstream(deps: MergeEnvDeps = {}): Promise<void> {
  const readEnv = deps.readEnv ?? readEnvFile;
  const writeEnv = deps.writeEnv ?? writeEnvFile;
  const fetchExample = deps.fetchEnvExample ?? defaultFetchEnvExample;
  const currentEnv = readEnv();
  // Fetch .env.example from upstream
  const example = await fetchExample();
  if (!example) return;
  for (const line of example.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!key || key in currentEnv) continue;
    // Preserve the upstream default (substring after the first '=').
    currentEnv[key] = trimmed.slice(eqIdx + 1).trim();
  }
  writeEnv(currentEnv);
}

export async function pollAiDevHealth(timeoutMs: number, deps: PollHealthDeps = {}): Promise<boolean> {
  const isRunning = deps.isRunning ?? isAiDevRunning;
  const sleepFn = deps.sleepMs ?? sleep;
  const intervalMs = deps.intervalMs ?? 3000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isRunning()) {
      return true;
    }
    await sleepFn(intervalMs);
  }
  return false;
}
