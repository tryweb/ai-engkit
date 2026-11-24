import {
  dockerCommand as defaultDockerCommand,
  execInAiDev as defaultExecInAiDev,
  type ExecResult,
} from "./docker";
import { collectHostDbHealth, DEFAULT_FREE_SPACE_PATH } from "./db-health";
import { getStatus as defaultGetUpgradeStatus } from "./upgrade";
import {
  DEFAULT_HOST_MAINTENANCE_POLICY,
  readHostMaintenancePolicy,
  type HostMaintenancePolicy,
} from "./host-maintenance-policy";

export type HostMaintenanceStep = "assess" | "prune-images" | "prune-builder" | "verify";
export type HostStepStatus = "pending" | "running" | "success" | "failure";
export type HostMaintenanceState = "idle" | "running" | "done" | "failed";

export interface HostMaintenanceEvent {
  id: number;
  step: HostMaintenanceStep;
  status: HostStepStatus;
  message: string;
  timestamp: string;
}

export interface HostMaintenanceResult {
  ok: boolean;
  tiers: string[];
  beforeDf: string | null;
  afterDf: string | null;
  skipReason: string | null;
  finishedAt: string;
}

export interface HostStorageSnapshot {
  freeSpaceBytes: number | null;
  freeSpacePath: string;
  tmpFreeBytes: number | null;
  tmpPath: string | null;
  dockerDfRaw: string | null;
  dbFileSizeBytes: number | null;
  collectedAt: string;
}

export interface VersionedCandidate {
  repository: string;
  tag: string;
  imageId: string;
  createdSince: string;
  size: string;
  excludedReason: string | null;
}

export interface HostMaintenancePlan {
  tiers: string[];
  versionedCandidates: VersionedCandidate[];
  note: string;
}

export type HostTier = "dangling" | "builder" | "versioned";
const SAFE_TIERS: ReadonlySet<string> = new Set(["dangling", "builder"]);

export interface HostMaintenanceDeps {
  docker?: (subcommand: string, timeoutMs?: number) => Promise<ExecResult>;
  exec?: (command: string, timeoutMs?: number) => Promise<ExecResult>;
  getUpgradeState?: () => string;
  readPolicy?: () => HostMaintenancePolicy;
  collectDbHealth?: () => Promise<{ fileSizeBytes: number; freeSpaceBytes: number | null; freeSpacePath: string; inspectionCopyEstimate: { tempPath: string | null; freeBytes: number | null } }>;
  nowMs?: () => number;
}

function resolveDeps(deps: HostMaintenanceDeps = {}): Required<HostMaintenanceDeps> {
  return {
    docker: deps.docker ?? defaultDockerCommand,
    exec: deps.exec ?? defaultExecInAiDev,
    getUpgradeState: deps.getUpgradeState ?? (() => defaultGetUpgradeStatus().state),
    readPolicy: deps.readPolicy ?? readHostMaintenancePolicy,
    collectDbHealth:
      deps.collectDbHealth ??
      (() => collectHostDbHealth().then((h) => ({
        fileSizeBytes: h.fileSizeBytes,
        freeSpaceBytes: h.freeSpaceBytes,
        freeSpacePath: h.freeSpacePath,
        inspectionCopyEstimate: h.inspectionCopyEstimate,
      }))),
    nowMs: deps.nowMs ?? Date.now,
  };
}

// --- in-memory event log (mirrors db-maintenance pattern) ---

let nextEventId = 1;
let currentState: HostMaintenanceState = "idle";
let eventLog: HostMaintenanceEvent[] = [];
let subscribers: ((event: HostMaintenanceEvent) => void)[] = [];
let lastResult: HostMaintenanceResult | null = null;
let lastError: string | null = null;

export function getHostMaintenanceState(): HostMaintenanceState {
  return currentState;
}

export function getHostMaintenanceEventLog(): HostMaintenanceEvent[] {
  return [...eventLog];
}

export function getHostMaintenanceLastResult(): HostMaintenanceResult | null {
  return lastResult;
}

export function getHostMaintenanceLastError(): string | null {
  return lastError;
}

export function subscribeHostMaintenance(subscriber: (event: HostMaintenanceEvent) => void): () => void {
  subscribers.push(subscriber);
  return () => {
    subscribers = subscribers.filter((s) => s !== subscriber);
  };
}

function emit(step: HostMaintenanceStep, status: HostStepStatus, message: string): void {
  const event: HostMaintenanceEvent = {
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

/** Test helper — reset module state between tests. Not for production use. */
export function _resetHostMaintenanceState(): void {
  currentState = "idle";
  eventLog = [];
  nextEventId = 1;
  subscribers = [];
  lastResult = null;
  lastError = null;
}

function parseBytes(raw: string): number | null {
  const n = parseInt(raw.trim(), 10);
  if (Number.isNaN(n) || n < 0) return null;
  return n;
}

async function systemDfRaw(docker: (subcommand: string, timeoutMs?: number) => Promise<ExecResult>): Promise<string | null> {
  try {
    const r = await docker("system df", 30_000);
    if (r.exitCode !== 0) return null;
    return r.stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function collectHostStorage(deps: HostMaintenanceDeps = {}): Promise<HostStorageSnapshot> {
  const r = resolveDeps(deps);
  const [db, dfRaw] = await Promise.all([
    r.collectDbHealth().catch(() => null),
    systemDfRaw(r.docker),
  ]);
  return {
    freeSpaceBytes: db?.freeSpaceBytes ?? null,
    freeSpacePath: db?.freeSpacePath ?? DEFAULT_FREE_SPACE_PATH,
    tmpFreeBytes: db?.inspectionCopyEstimate.freeBytes ?? null,
    tmpPath: db?.inspectionCopyEstimate.tempPath ?? null,
    dockerDfRaw: dfRaw,
    dbFileSizeBytes: db?.fileSizeBytes ?? null,
    collectedAt: new Date(r.nowMs()).toISOString(),
  };
}

export function watermarkStatus(
  freeSpaceBytes: number | null,
  policy: HostMaintenancePolicy = DEFAULT_HOST_MAINTENANCE_POLICY,
): "ok" | "warn" | "crit" | "unknown" {
  if (freeSpaceBytes === null) return "unknown";
  if (freeSpaceBytes < policy.watermarkCritBytes) return "crit";
  if (freeSpaceBytes < policy.watermarkWarnBytes) return "warn";
  return "ok";
}

function parseImagesTable(stdout: string): Array<{ repository: string; tag: string; imageId: string; createdSince: string; size: string }> {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const out: Array<{ repository: string; tag: string; imageId: string; createdSince: string; size: string }> = [];
  for (const line of lines) {
    const parts = line.split(/\s{2,}/).map((p) => p.trim());
    if (parts.length < 5) continue;
    const [repository, tag, imageId, createdSince, size] = parts as [string, string, string, string, string];
    if (!repository || !imageId) continue;
    out.push({ repository, tag, imageId, createdSince, size });
  }
  return out;
}

async function runningImageRefs(docker: (subcommand: string, timeoutMs?: number) => Promise<ExecResult>): Promise<Set<string>> {
  try {
    const r = await docker("ps --format {{.Image}}", 15_000);
    if (r.exitCode !== 0) return new Set();
    return new Set(r.stdout.split("\n").map((s) => s.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

/**
 * Read-only dry-run: which P0 tiers apply, plus P1 versioned candidates.
 * Never deletes anything. Running containers' images and protected tags
 * are always excluded from versioned candidates.
 */
export async function planHostMaintenance(deps: HostMaintenanceDeps = {}): Promise<HostMaintenancePlan> {
  const r = resolveDeps(deps);
  const policy = r.readPolicy();
  const [imagesRaw, running] = await Promise.all([
    // Quote the format template: parseSubcommand splits on unquoted spaces,
    // and the template itself contains the double-space column separators.
    r.docker("images --format '{{.Repository}}  {{.Tag}}  {{.ID}}  {{.CreatedSince}}  {{.Size}}'", 15_000).catch(() => null),
    runningImageRefs(r.docker),
  ]);
  const rows = imagesRaw && imagesRaw.exitCode === 0 ? parseImagesTable(imagesRaw.stdout) : [];
  const aiEngkitRows = rows.filter((img) => img.repository.includes("ai-engkit"));
  // Newest-first is approximated by input order (docker sorts by created desc by default).
  const protectedSet = new Set(policy.protectedTags.map((t) => t.trim()).filter(Boolean));
  const candidates: VersionedCandidate[] = aiEngkitRows.map((img, idx) => {
    const ref = `${img.repository}:${img.tag}`;
    let excludedReason: string | null = null;
    if (running.has(img.imageId) || running.has(ref) || running.has(`${img.repository}`)) {
      excludedReason = "in-use by running container";
    } else if (protectedSet.has(ref) || protectedSet.has(img.tag) || protectedSet.has(img.repository)) {
      excludedReason = "protected tag";
    } else if (idx < policy.keepAiEngkitVersions) {
      excludedReason = `within keepAiEngkitVersions=${policy.keepAiEngkitVersions}`;
    }
    return { ...img, excludedReason };
  });
  return {
    tiers: ["dangling", "builder"],
    versionedCandidates: candidates,
    note: "P0 tiers (dangling, builder) are safe for automation. Versioned image removal is manual-only in this version.",
  };
}

export interface RunHostMaintenanceOptions extends HostMaintenanceDeps {
  tiers?: HostTier[];
}

/**
 * Execute P0 tiers only. Throws on upgrade-in-progress or concurrent run.
 * P1 `versioned` tier is rejected: manual flow only (plan → confirm in UI,
 * no automatic execution in this version).
 */
export async function runHostMaintenance(options: RunHostMaintenanceOptions = {}): Promise<HostMaintenanceResult> {
  const r = resolveDeps(options);
  const tiers = options.tiers ?? ["dangling", "builder"];
  if (currentState === "running") {
    throw new Error("Host maintenance already in progress");
  }
  if (r.getUpgradeState() === "running") {
    throw new Error("upgrade_in_progress");
  }
  for (const t of tiers) {
    if (!SAFE_TIERS.has(t)) {
      throw new Error(`tier ${t} requires manual confirmation flow (not auto-executed)`);
    }
  }
  const policy = r.readPolicy();
  const keepGb = Math.trunc(policy.builderKeepStorageGb);
  if (!Number.isInteger(keepGb) || keepGb < 1 || keepGb > 100) {
    throw new Error("builderKeepStorageGb out of range");
  }

  currentState = "running";
  lastError = null;
  emit("assess", "running", `Assessing host storage (tiers: ${tiers.join(",")})`);
  const beforeDf = await systemDfRaw(r.docker);
  emit("assess", "success", "Assessment snapshot captured");

  try {
    if (tiers.includes("dangling")) {
      emit("prune-images", "running", "Pruning dangling images (image prune -f)");
      const res = await r.docker("image prune -f", 60_000);
      if (res.exitCode !== 0) {
        throw new Error(`image prune failed: ${res.stderr || res.stdout || `exit ${res.exitCode}`}`);
      }
      emit("prune-images", "success", "Dangling image prune complete");
    }
    if (tiers.includes("builder")) {
      emit("prune-builder", "running", `Pruning builder cache (keep ${keepGb}GB)`);
      const res = await r.docker(`builder prune -f --keep-storage=${keepGb}GB`, 120_000);
      if (res.exitCode !== 0) {
        throw new Error(`builder prune failed: ${res.stderr || res.stdout || `exit ${res.exitCode}`}`);
      }
      emit("prune-builder", "success", "Builder cache prune complete");
    }
    const afterDf = await systemDfRaw(r.docker);
    emit("verify", "success", "Host maintenance complete");
    currentState = "done";
    lastResult = { ok: true, tiers: [...tiers], beforeDf, afterDf, skipReason: null, finishedAt: new Date(r.nowMs()).toISOString() };
    return lastResult;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    emit("verify", "failure", msg);
    currentState = "failed";
    lastError = msg;
    throw error;
  }
}

export function getHostMaintenanceStatus(): {
  state: HostMaintenanceState;
  lastResult: HostMaintenanceResult | null;
  lastError: string | null;
} {
  return { state: currentState, lastResult, lastError };
}
