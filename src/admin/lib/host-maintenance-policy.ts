import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DAILY_RUN_AT_RE, DEFAULT_RETENTION_POLICY } from "./retention-policy";

export const HOST_MAINTENANCE_POLICY_PATH = "/opt/ai-engkit/admin-data/host-maintenance-policy.json";

export function hostMaintenancePolicyPath(): string {
  return Bun.env.HOST_MAINTENANCE_POLICY_PATH || HOST_MAINTENANCE_POLICY_PATH;
}

/** Tiers the scheduler is allowed to run on its own. Anything else needs a human. */
export const SAFE_TIERS = ["dangling", "builder"] as const;
export type SafeTier = (typeof SAFE_TIERS)[number];

/** Tiers the manual run endpoint accepts. "versioned" additionally requires confirmed: true. */
export const ALL_TIERS = ["dangling", "builder", "versioned"] as const;
export type CleanupTier = (typeof ALL_TIERS)[number];

export function isCleanupTier(value: unknown): value is CleanupTier {
  return typeof value === "string" && (ALL_TIERS as readonly string[]).includes(value);
}

export interface HostMaintenancePolicy {
  /** Master switch. Only gates the SAFE_TIERS the scheduler may run. */
  enabled: boolean;
  /** Daily wall-clock run time (server time), HH:MM. */
  dailyRunAt: string;
  /** `docker builder prune --keep-storage` ceiling, in GB. */
  builderKeepStorageGb: number;
  /** How many newest ai-engkit family images to keep when pruning old versions. */
  keepAiEngkitVersions: number;
  /** Free-space watermark (GB) for the amber dashboard state. */
  watermarkWarnGb: number;
  /** Free-space watermark (GB) for the red dashboard state. Must be <= warn. */
  watermarkCritGb: number;
  /** Extra `repository:tag` refs that are never proposed for deletion. */
  protectedTags: string[];
}

export const DEFAULT_HOST_MAINTENANCE_POLICY: HostMaintenancePolicy = {
  enabled: true,
  dailyRunAt: DEFAULT_RETENTION_POLICY.dailyRunAt,
  builderKeepStorageGb: 5,
  keepAiEngkitVersions: 2,
  watermarkWarnGb: 10,
  watermarkCritGb: 8,
  protectedTags: ["postgres:16-alpine"],
};

export interface ValidationResultOk {
  ok: true;
  value: HostMaintenancePolicy;
}

export interface ValidationResultError {
  ok: false;
  field: string;
  message: string;
}

export type ValidationResult = ValidationResultOk | ValidationResultError;

const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/;

function isIntIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

export function validateHostMaintenancePolicy(input: unknown): ValidationResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, field: "policy", message: "must be an object" };
  }
  const record = input as Record<string, unknown>;

  if (typeof record.enabled !== "boolean") {
    return { ok: false, field: "enabled", message: "must be a boolean" };
  }
  if (typeof record.dailyRunAt !== "string" || !DAILY_RUN_AT_RE.test(record.dailyRunAt)) {
    return { ok: false, field: "dailyRunAt", message: "must be a string in HH:MM format (00:00-23:59)" };
  }
  if (!isIntIn(record.builderKeepStorageGb, 1, 100)) {
    return { ok: false, field: "builderKeepStorageGb", message: "must be an integer between 1 and 100" };
  }
  if (!isIntIn(record.keepAiEngkitVersions, 1, 10)) {
    return { ok: false, field: "keepAiEngkitVersions", message: "must be an integer between 1 and 10" };
  }
  if (typeof record.watermarkWarnGb !== "number" || !Number.isFinite(record.watermarkWarnGb) || record.watermarkWarnGb < 1 || record.watermarkWarnGb > 1024) {
    return { ok: false, field: "watermarkWarnGb", message: "must be a number between 1 and 1024" };
  }
  if (typeof record.watermarkCritGb !== "number" || !Number.isFinite(record.watermarkCritGb) || record.watermarkCritGb < 1 || record.watermarkCritGb > 1024) {
    return { ok: false, field: "watermarkCritGb", message: "must be a number between 1 and 1024" };
  }
  if (record.watermarkCritGb > record.watermarkWarnGb) {
    return { ok: false, field: "watermarkCritGb", message: "must be less than or equal to watermarkWarnGb" };
  }
  if (!Array.isArray(record.protectedTags)) {
    return { ok: false, field: "protectedTags", message: "must be an array of repository:tag strings" };
  }
  if (record.protectedTags.length > 50) {
    return { ok: false, field: "protectedTags", message: "must contain at most 50 entries" };
  }
  for (const tag of record.protectedTags) {
    if (typeof tag !== "string" || !TAG_RE.test(tag)) {
      return { ok: false, field: "protectedTags", message: `invalid tag ${JSON.stringify(tag)}` };
    }
  }

  return {
    ok: true,
    value: {
      enabled: record.enabled,
      dailyRunAt: record.dailyRunAt,
      builderKeepStorageGb: record.builderKeepStorageGb,
      keepAiEngkitVersions: record.keepAiEngkitVersions,
      watermarkWarnGb: record.watermarkWarnGb,
      watermarkCritGb: record.watermarkCritGb,
      protectedTags: [...record.protectedTags] as string[],
    },
  };
}

export function parseHostMaintenancePolicyJSON(text: string): HostMaintenancePolicy | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  // Backfill newer fields so old files stay readable.
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const rec = parsed as Record<string, unknown>;
    const backfilled: Record<string, unknown> = { ...rec };
    if (!("dailyRunAt" in rec)) backfilled.dailyRunAt = DEFAULT_HOST_MAINTENANCE_POLICY.dailyRunAt;
    if (!("protectedTags" in rec)) backfilled.protectedTags = [...DEFAULT_HOST_MAINTENANCE_POLICY.protectedTags];
    const result = validateHostMaintenancePolicy(backfilled);
    if (!result.ok) return null;
    return result.value;
  }
  return null;
}

export function readHostMaintenancePolicyFrom(filePath: string): HostMaintenancePolicy {
  if (!existsSync(filePath)) return { ...DEFAULT_HOST_MAINTENANCE_POLICY, protectedTags: [...DEFAULT_HOST_MAINTENANCE_POLICY.protectedTags] };
  const text = readFileSync(filePath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Host maintenance policy is malformed");
  }
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const rec = parsed as Record<string, unknown>;
    const normalized: Record<string, unknown> = { ...rec };
    if (!("dailyRunAt" in rec)) normalized.dailyRunAt = DEFAULT_HOST_MAINTENANCE_POLICY.dailyRunAt;
    if (!("protectedTags" in rec)) normalized.protectedTags = [...DEFAULT_HOST_MAINTENANCE_POLICY.protectedTags];
    const result = validateHostMaintenancePolicy(normalized);
    if (!result.ok) {
      throw new Error("Host maintenance policy is malformed");
    }
    return result.value;
  }
  throw new Error("Host maintenance policy is malformed");
}

export function readHostMaintenancePolicy(): HostMaintenancePolicy {
  return readHostMaintenancePolicyFrom(hostMaintenancePolicyPath());
}

export function writeHostMaintenancePolicyFrom(filePath: string, policy: HostMaintenancePolicy): void {
  const validation = validateHostMaintenancePolicy(policy);
  if (validation.ok === false) {
    throw new Error(`${validation.field} ${validation.message}`);
  }

  if (existsSync(filePath) && !statSync(filePath).isFile()) {
    throw new Error(`host-maintenance-policy.json is not a regular file: ${filePath}`);
  }

  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = join(dirname(filePath), `.host-maintenance-policy.json.tmp.${Date.now()}`);
  writeFileSync(tmp, `${JSON.stringify(validation.value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, filePath);
}

export function writeHostMaintenancePolicy(policy: HostMaintenancePolicy): void {
  writeHostMaintenancePolicyFrom(hostMaintenancePolicyPath(), policy);
}
