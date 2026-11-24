import { dockerCommand, execInAiDev, type ExecResult } from "./docker";
import {
  isCleanupTier,
  readHostMaintenancePolicy,
  SAFE_TIERS,
  type CleanupTier,
  type HostMaintenancePolicy,
} from "./host-maintenance-policy";

export type RunDocker = (subcommand: string, timeoutMs: number) => Promise<ExecResult>;
export type RunShell = (command: string, timeoutMs: number) => Promise<ExecResult>;

/** Repositories that count as "ai-engkit versions" for keep-newest-N pruning. */
export const AI_ENGKIT_FAMILY_REPOS = ["ghcr.io/tryweb/ai-engkit", "ai-engkit-ai-dev"] as const;

const GB = 1024 * 1024 * 1024;

export interface FilesystemUsage {
  path: string;
  totalBytes: number | null;
  usedBytes: number | null;
  availBytes: number | null;
  usePercent: number | null;
}

export interface DockerReclaimable {
  total: number;
  active: number;
  sizeBytesApprox: number | null;
  reclaimableBytesApprox: number | null;
}

export interface DockerDiskUsage {
  images: DockerReclaimable;
  containers: DockerReclaimable;
  volumes: DockerReclaimable;
  buildCache: DockerReclaimable;
}

export interface HostImageInfo {
  repository: string;
  tag: string;
  id: string;
  createdAt: string;
  sizeBytesApprox: number | null;
  sizeLabel: string;
  inUse: boolean;
}

export interface HostStorage {
  root: FilesystemUsage | null;
  tmp: FilesystemUsage | null;
  docker: DockerDiskUsage | null;
  images: HostImageInfo[];
  collectedAt: string;
}

export type Watermark = "ok" | "warn" | "crit" | "unknown";

export function watermarkFor(availBytes: number | null, policy: HostMaintenancePolicy): Watermark {
  if (availBytes === null || !Number.isFinite(availBytes) || availBytes < 0) return "unknown";
  if (availBytes < policy.watermarkCritGb * GB) return "crit";
  if (availBytes < policy.watermarkWarnGb * GB) return "warn";
  return "ok";
}

/**
 * Parse a Docker human size ("22.88GB", "575MB", "8.43MB", "0B").
 * Docker display sizes are approximate; callers must treat the result as an
 * estimate (never a gate input — gates use `df -B1` exact bytes).
 */
export function parseDockerBytes(label: string): number | null {
  const text = label.trim();
  if (!text) return null;
  const match = /^([\d.]+)\s*([KMGT]?i?B)$/i.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) return null;
  const unit = match[2].toUpperCase().replace("IB", "B");
  const exp = { B: 0, KB: 1, MB: 2, GB: 3, TB: 4 }[unit];
  if (exp === undefined) return null;
  return Math.round(value * 1024 ** exp);
}

/**
 * Parse one `df -B1 <path>` stdout. Returns null when nothing parses so
 * callers degrade to "unknown" instead of throwing.
 */
export function parseDfOutput(stdout: string, path: string): FilesystemUsage | null {
  for (const line of stdout.split("\n")) {
    const match = /^\S+\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+\S+\s*$/.exec(line.trim());
    if (match) {
      return {
        path,
        totalBytes: Number(match[1]),
        usedBytes: Number(match[2]),
        availBytes: Number(match[3]),
        usePercent: Number(match[4]),
      };
    }
  }
  return null;
}

function emptyReclaimable(): DockerReclaimable {
  return { total: 0, active: 0, sizeBytesApprox: null, reclaimableBytesApprox: null };
}

function parseSystemDfRow(row: Record<string, unknown>): DockerReclaimable {
  const total = typeof row["TotalCount"] === "number" ? row["TotalCount"] : Number(row["TotalCount"] ?? 0);
  const active = typeof row["Active"] === "number" ? row["Active"] : Number(row["Active"] ?? 0);
  return {
    total: Number.isFinite(total) ? total : 0,
    active: Number.isFinite(active) ? active : 0,
    sizeBytesApprox: typeof row["Size"] === "string" ? parseDockerBytes(row["Size"]) : null,
    reclaimableBytesApprox:
      typeof row["Reclaimable"] === "string" ? parseDockerBytes(row["Reclaimable"]) : null,
  };
}

function parseSystemDf(stdout: string): DockerDiskUsage | null {
  const byType = new Map<string, DockerReclaimable>();
  let rows = 0;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof row["Type"] !== "string") continue;
      byType.set(row["Type"], parseSystemDfRow(row));
      rows++;
    } catch {
      return null;
    }
  }
  if (rows === 0) return null;
  return {
    images: byType.get("Images") ?? emptyReclaimable(),
    containers: byType.get("Containers") ?? emptyReclaimable(),
    volumes: byType.get("Local Volumes") ?? emptyReclaimable(),
    buildCache: byType.get("Build Cache") ?? emptyReclaimable(),
  };
}

interface RawImageRow {
  Repository?: unknown;
  Tag?: unknown;
  ID?: unknown;
  CreatedAt?: unknown;
  Size?: unknown;
}

function normalizeId(id: string): string {
  return id.replace(/^sha256:/, "");
}

function imageRefMatches(image: { repository: string; tag: string; id: string }, ref: string): boolean {
  const needle = normalizeId(ref.trim());
  if (!needle) return false;
  if (needle === normalizeId(image.id)) return true;
  if (image.id && (normalizeId(image.id).startsWith(needle) || needle.startsWith(normalizeId(image.id)))) {
    return true;
  }
  return `${image.repository}:${image.tag}` === needle;
}

function parseImageList(stdout: string, inUseRefs: Set<string>): HostImageInfo[] {
  const images: HostImageInfo[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: RawImageRow;
    try {
      row = JSON.parse(trimmed) as RawImageRow;
    } catch {
      continue;
    }
    if (typeof row.Repository !== "string" || typeof row.Tag !== "string") continue;
    const id = typeof row.ID === "string" ? row.ID : "";
    const sizeLabel = typeof row.Size === "string" ? row.Size : "";
    const info: HostImageInfo = {
      repository: row.Repository,
      tag: row.Tag,
      id,
      createdAt: typeof row.CreatedAt === "string" ? row.CreatedAt : "",
      sizeBytesApprox: sizeLabel ? parseDockerBytes(sizeLabel) : null,
      sizeLabel,
      inUse: false,
    };
    for (const ref of inUseRefs) {
      if (imageRefMatches(info, ref)) {
        info.inUse = true;
        break;
      }
    }
    images.push(info);
  }
  return images;
}

export interface CollectDeps {
  docker?: RunDocker;
  exec?: RunShell;
}

export async function collectHostStorage(deps: CollectDeps = {}): Promise<HostStorage> {
  const docker = deps.docker ?? dockerCommand;
  const exec = deps.exec ?? execInAiDev;

  const [rootRaw, tmpRaw, systemDfRaw, imagesRaw, psRaw] = await Promise.all([
    exec("df -B1 / 2>/dev/null || df /", 10_000).catch(() => null),
    exec("df -B1 /tmp 2>/dev/null || df /tmp", 10_000).catch(() => null),
    docker("system df --format '{{json .}}'", 30_000).catch(() => null),
    docker("images --format '{{json .}}'", 30_000).catch(() => null),
    docker("ps --format '{{.Image}}'", 15_000).catch(() => null),
  ]);

  const inUseRefs = new Set<string>();
  if (psRaw && psRaw.exitCode === 0) {
    for (const line of psRaw.stdout.split("\n")) {
      const ref = line.trim();
      if (ref) inUseRefs.add(ref);
    }
  }

  return {
    root: rootRaw && rootRaw.exitCode === 0 ? parseDfOutput(rootRaw.stdout, "/") : null,
    tmp: tmpRaw && tmpRaw.exitCode === 0 ? parseDfOutput(tmpRaw.stdout, "/tmp") : null,
    docker: systemDfRaw && systemDfRaw.exitCode === 0 ? parseSystemDf(systemDfRaw.stdout) : null,
    images: imagesRaw && imagesRaw.exitCode === 0 ? parseImageList(imagesRaw.stdout, inUseRefs) : [],
    collectedAt: new Date().toISOString(),
  };
}

export interface PlannedImageDeletion {
  kind: "image";
  /** `repository:tag`, or the short id for untagged images. */
  ref: string;
  repository: string;
  tag: string;
  sizeBytesApprox: number | null;
  reason: string;
}

export interface SkippedImage {
  ref: string;
  reason: string;
}

export interface CleanupPlan {
  generatedAt: string;
  tiers: CleanupTier[];
  dangling: PlannedImageDeletion[];
  builder: { keepStorageGb: number; estimatedReclaimBytesApprox: number | null; eligible: boolean };
  versioned: PlannedImageDeletion[];
  skippedProtected: SkippedImage[];
  estimatedReclaimBytesApprox: number | null;
}

function displayRef(image: HostImageInfo): string {
  if (image.repository === "<none>") return normalizeId(image.id) || "<none>";
  return `${image.repository}:${image.tag}`;
}

/**
 * Build a dry-run plan from live storage data. Pure function — safe to call
 * for previews. Never proposes in-use or protected images.
 */
export function planHostMaintenance(storage: HostStorage, policy: HostMaintenancePolicy): CleanupPlan {
  const dangling: PlannedImageDeletion[] = [];
  const versioned: PlannedImageDeletion[] = [];
  const skippedProtected: SkippedImage[] = [];
  const protectedTags = new Set(policy.protectedTags);

  const family: HostImageInfo[] = [];
  for (const image of storage.images) {
    const ref = displayRef(image);
    if (image.inUse) {
      skippedProtected.push({ ref, reason: "in use by a running container" });
      continue;
    }
    if (protectedTags.has(`${image.repository}:${image.tag}`)) {
      skippedProtected.push({ ref, reason: "protected tag" });
      continue;
    }
    if (image.repository === "<none>") {
      dangling.push({
        kind: "image",
        ref,
        repository: image.repository,
        tag: image.tag,
        sizeBytesApprox: image.sizeBytesApprox,
        reason: "dangling (untagged, unused)",
      });
      continue;
    }
    if ((AI_ENGKIT_FAMILY_REPOS as readonly string[]).includes(image.repository)) {
      family.push(image);
    }
  }

  const ranked = [...family].sort((a, b) => {
    const ta = Date.parse(a.createdAt);
    const tb = Date.parse(b.createdAt);
    const na = Number.isNaN(ta) ? Number.NEGATIVE_INFINITY : ta;
    const nb = Number.isNaN(tb) ? Number.NEGATIVE_INFINITY : tb;
    return nb - na;
  });
  ranked.forEach((image, index) => {
    const ref = displayRef(image);
    if (index < policy.keepAiEngkitVersions) {
      skippedProtected.push({ ref, reason: `kept (newest ${policy.keepAiEngkitVersions})` });
    } else {
      versioned.push({
        kind: "image",
        ref,
        repository: image.repository,
        tag: image.tag,
        sizeBytesApprox: image.sizeBytesApprox,
        reason: `superseded (keep newest ${policy.keepAiEngkitVersions})`,
      });
    }
  });

  const builderReclaim = storage.docker?.buildCache.reclaimableBytesApprox ?? null;
  let estimated: number | null = null;
  const add = (n: number | null): void => {
    if (n === null) return;
    estimated = (estimated ?? 0) + n;
  };
  for (const d of [...dangling, ...versioned]) add(d.sizeBytesApprox);
  add(builderReclaim);

  const tiers: CleanupTier[] = [];
  if (dangling.length > 0) tiers.push("dangling");
  if (builderReclaim !== null && builderReclaim > 0) tiers.push("builder");
  if (versioned.length > 0) tiers.push("versioned");

  return {
    generatedAt: new Date().toISOString(),
    tiers,
    dangling,
    builder: {
      keepStorageGb: policy.builderKeepStorageGb,
      estimatedReclaimBytesApprox: builderReclaim,
      eligible: builderReclaim !== null && builderReclaim > 0,
    },
    versioned,
    skippedProtected,
    estimatedReclaimBytesApprox: estimated,
  };
}

// ---------------------------------------------------------------------------
// Execution + module state (mirrors lib/db-maintenance naming).
// ---------------------------------------------------------------------------

export type HostMaintenanceState = "idle" | "running" | "done" | "failed";

export interface HostMaintenanceEvent {
  at: string;
  tier: CleanupTier | "all";
  message: string;
}

export interface TierResult {
  tier: CleanupTier;
  exitCode: number;
  outputTail: string;
  removedRefs: string[];
}

export interface CleanupRunResult {
  startedAt: string;
  finishedAt: string;
  tiers: TierResult[];
  availBeforeBytes: number | null;
  availAfterBytes: number | null;
  freedBytes: number | null;
  ok: boolean;
}

export interface HostMaintenanceStatus {
  state: HostMaintenanceState;
  lastRunAt: string | null;
  lastError: string | null;
  lastFreedBytes: number | null;
}

let maintenanceState: HostMaintenanceState = "idle";
let lastRunAt: string | null = null;
let lastError: string | null = null;
let lastFreedBytes: number | null = null;
let eventLog: HostMaintenanceEvent[] = [];
const subscribers = new Set<(event: HostMaintenanceEvent) => void>();

const MAX_EVENTS = 200;

function emit(tier: CleanupTier | "all", message: string): void {
  const event: HostMaintenanceEvent = { at: new Date().toISOString(), tier, message };
  eventLog.push(event);
  if (eventLog.length > MAX_EVENTS) eventLog = eventLog.slice(-MAX_EVENTS);
  for (const sub of subscribers) {
    try {
      sub(event);
    } catch {
      // A broken subscriber must never break cleanup.
    }
  }
}

export function getHostMaintenanceState(): HostMaintenanceState {
  return maintenanceState;
}

export function getHostMaintenanceEventLog(): HostMaintenanceEvent[] {
  return [...eventLog];
}

export function getLastHostMaintenanceAt(): string | null {
  return lastRunAt;
}

export function getLastHostMaintenanceError(): string | null {
  return lastError;
}

export function subscribeHostMaintenance(subscriber: (event: HostMaintenanceEvent) => void): () => void {
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
  };
}

export function getHostMaintenanceStatus(): HostMaintenanceStatus {
  return { state: maintenanceState, lastRunAt, lastError, lastFreedBytes };
}

/** Test seam — resets module state. */
export function _resetHostMaintenanceState(): void {
  maintenanceState = "idle";
  lastRunAt = null;
  lastError = null;
  lastFreedBytes = null;
  eventLog = [];
}

function tail(text: string, max = 2000): string {
  if (text.length <= max) return text;
  return text.slice(-max);
}

export interface RunHostMaintenanceDeps {
  docker?: RunDocker;
  exec?: RunShell;
  policy?: HostMaintenancePolicy;
  readPolicy?: () => HostMaintenancePolicy;
  tiers?: CleanupTier[];
  /** Required when tiers include "versioned". */
  confirmed?: boolean;
}

/**
 * Execute cleanup tiers against live (re-collected) storage data.
 * The plan is rebuilt inside the run so a caller-supplied preview can never
 * delete an image that became in-use after the preview.
 */
export async function runHostMaintenance(deps: RunHostMaintenanceDeps = {}): Promise<CleanupRunResult> {
  if (maintenanceState === "running") {
    throw new Error("host maintenance is already running");
  }
  const tiers = deps.tiers ?? [...SAFE_TIERS];
  if (tiers.length === 0) {
    throw new Error("no cleanup tiers requested");
  }
  for (const tier of tiers) {
    if (!isCleanupTier(tier)) {
      throw new Error(`unknown cleanup tier ${JSON.stringify(tier)}`);
    }
  }
  if (tiers.includes("versioned") && deps.confirmed !== true) {
    throw new Error('the "versioned" tier requires explicit confirmation');
  }

  const docker = deps.docker ?? dockerCommand;
  const exec = deps.exec ?? execInAiDev;
  const policy = deps.policy ?? (deps.readPolicy ? deps.readPolicy() : readHostMaintenancePolicy());

  maintenanceState = "running";
  lastError = null;
  const startedAt = new Date().toISOString();
  emit("all", `cleanup started (tiers: ${tiers.join(", ")})`);

  const tierResults: TierResult[] = [];
  let ok = true;
  let availBeforeBytes: number | null = null;
  try {
    const before = await collectHostStorage({ docker, exec });
    availBeforeBytes = before.root?.availBytes ?? null;
    const plan = planHostMaintenance(before, policy);

    if (tiers.includes("dangling")) {
      emit("dangling", `pruning dangling images (${plan.dangling.length} planned)`);
      const result = await docker("image prune -f", 120_000);
      tierResults.push({
        tier: "dangling",
        exitCode: result.exitCode,
        outputTail: tail(`${result.stdout}\n${result.stderr}`),
        removedRefs: plan.dangling.map((d) => d.ref),
      });
      emit("dangling", result.exitCode === 0 ? "dangling prune done" : `dangling prune failed (exit ${result.exitCode})`);
      if (result.exitCode !== 0) ok = false;
    }

    if (tiers.includes("builder")) {
      emit("builder", `pruning build cache (keep ${policy.builderKeepStorageGb}GB)`);
      const result = await docker(
        `builder prune -f --keep-storage ${policy.builderKeepStorageGb}GB`,
        300_000,
      );
      tierResults.push({
        tier: "builder",
        exitCode: result.exitCode,
        outputTail: tail(`${result.stdout}\n${result.stderr}`),
        removedRefs: [],
      });
      emit("builder", result.exitCode === 0 ? "build cache prune done" : `build cache prune failed (exit ${result.exitCode})`);
      if (result.exitCode !== 0) ok = false;
    }

    if (tiers.includes("versioned")) {
      const removedRefs: string[] = [];
      let versionedOk = true;
      for (const deletion of plan.versioned) {
        emit("versioned", `removing ${deletion.ref}`);
        const result = await docker(`rmi ${deletion.ref}`, 120_000);
        if (result.exitCode === 0) {
          removedRefs.push(deletion.ref);
        } else {
          versionedOk = false;
          emit("versioned", `failed to remove ${deletion.ref} (exit ${result.exitCode})`);
        }
      }
      tierResults.push({
        tier: "versioned",
        exitCode: versionedOk ? 0 : 1,
        outputTail: `removed ${removedRefs.length}/${plan.versioned.length}`,
        removedRefs,
      });
      if (!versionedOk) ok = false;
    }
  } catch (error: unknown) {
    ok = false;
    const message = error instanceof Error ? error.message : String(error);
    lastError = message;
    emit("all", `cleanup failed: ${message}`);
  }

  let availAfterBytes: number | null = null;
  try {
    const after = await collectHostStorage({ docker, exec });
    availAfterBytes = after.root?.availBytes ?? null;
  } catch {
    availAfterBytes = null;
  }
  const freedBytes =
    availBeforeBytes !== null && availAfterBytes !== null ? availAfterBytes - availBeforeBytes : null;

  const finishedAt = new Date().toISOString();
  maintenanceState = ok ? "done" : "failed";
  lastRunAt = finishedAt;
  lastFreedBytes = freedBytes;
  if (!ok && lastError === null) {
    lastError = "one or more tiers failed";
  }
  emit("all", ok ? `cleanup done (freed ~${freedBytes ?? "unknown"} bytes)` : "cleanup finished with failures");

  return { startedAt, finishedAt, tiers: tierResults, availBeforeBytes, availAfterBytes, freedBytes, ok };
}
