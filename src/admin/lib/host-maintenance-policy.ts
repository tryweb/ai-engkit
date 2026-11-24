import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const HOST_MAINTENANCE_POLICY_PATH = "/opt/ai-engkit/admin-data/host-maintenance-policy.json";

export function hostMaintenancePolicyPath(): string {
  return Bun.env.HOST_MAINTENANCE_POLICY_PATH || HOST_MAINTENANCE_POLICY_PATH;
}

export interface HostMaintenancePolicy {
  enabled: boolean;
  dailyRunAt: string;
  builderKeepStorageGb: number;
  keepAiEngkitVersions: number;
  watermarkWarnBytes: number;
  watermarkCritBytes: number;
  protectedTags: string[];
}

/**
 * Fail-closed defaults: automatic pruning is OFF until the operator
 * explicitly enables it. Thresholds are in bytes and apply to the
 * opencode data dir free space (see DEFAULT_FREE_SPACE_PATH in db-health).
 * Defaults: warn 10 GiB, crit 8 GiB.
 */
export const DEFAULT_HOST_MAINTENANCE_POLICY: HostMaintenancePolicy = {
  enabled: false,
  dailyRunAt: "03:00",
  builderKeepStorageGb: 5,
  keepAiEngkitVersions: 2,
  watermarkWarnBytes: 10 * 1024 * 1024 * 1024,
  watermarkCritBytes: 8 * 1024 * 1024 * 1024,
  protectedTags: ["postgres:16-alpine"],
};

export const DAILY_RUN_AT_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export interface HostValidationOk {
  ok: true;
  value: HostMaintenancePolicy;
}

export interface HostValidationError {
  ok: false;
  field: string;
  message: string;
}

export type HostValidationResult = HostValidationOk | HostValidationError;

const ALLOWED_FIELDS = new Set([
  "enabled",
  "dailyRunAt",
  "builderKeepStorageGb",
  "keepAiEngkitVersions",
  "watermarkWarnBytes",
  "watermarkCritBytes",
  "protectedTags",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateHostMaintenancePolicy(input: unknown): HostValidationResult {
  if (!isRecord(input)) {
    return { ok: false, field: "policy", message: "must be an object" };
  }
  for (const key of Object.keys(input)) {
    if (!ALLOWED_FIELDS.has(key)) {
      return { ok: false, field: key, message: `${key} is not allowed` };
    }
  }
  if (typeof input.enabled !== "boolean") {
    return { ok: false, field: "enabled", message: "must be a boolean" };
  }
  if (typeof input.dailyRunAt !== "string" || !DAILY_RUN_AT_RE.test(input.dailyRunAt)) {
    return { ok: false, field: "dailyRunAt", message: "must be a string in HH:MM format (00:00-23:59)" };
  }
  const builderGb = input.builderKeepStorageGb;
  if (typeof builderGb !== "number" || !Number.isFinite(builderGb) || builderGb < 1 || builderGb > 100) {
    return { ok: false, field: "builderKeepStorageGb", message: "must be a number between 1 and 100 (GB)" };
  }
  const keep = input.keepAiEngkitVersions;
  if (typeof keep !== "number" || !Number.isInteger(keep) || keep < 1 || keep > 5) {
    return { ok: false, field: "keepAiEngkitVersions", message: "must be an integer between 1 and 5" };
  }
  const warn = input.watermarkWarnBytes;
  const crit = input.watermarkCritBytes;
  if (typeof warn !== "number" || !Number.isInteger(warn) || warn <= 0) {
    return { ok: false, field: "watermarkWarnBytes", message: "must be a positive integer (bytes)" };
  }
  if (typeof crit !== "number" || !Number.isInteger(crit) || crit <= 0) {
    return { ok: false, field: "watermarkCritBytes", message: "must be a positive integer (bytes)" };
  }
  if (crit >= warn) {
    return { ok: false, field: "watermarkCritBytes", message: "must be less than watermarkWarnBytes" };
  }
  const tags = input.protectedTags;
  if (!Array.isArray(tags) || !tags.every((t) => typeof t === "string" && t.length > 0 && t.length <= 256)) {
    return { ok: false, field: "protectedTags", message: "must be an array of non-empty strings" };
  }
  return {
    ok: true,
    value: {
      enabled: input.enabled,
      dailyRunAt: input.dailyRunAt,
      builderKeepStorageGb: builderGb,
      keepAiEngkitVersions: keep,
      watermarkWarnBytes: warn,
      watermarkCritBytes: crit,
      protectedTags: [...tags],
    },
  };
}

export function readHostMaintenancePolicyFrom(filePath: string): HostMaintenancePolicy {
  if (!existsSync(filePath)) return { ...DEFAULT_HOST_MAINTENANCE_POLICY, protectedTags: [...DEFAULT_HOST_MAINTENANCE_POLICY.protectedTags] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    throw new Error("Host maintenance policy is malformed");
  }
  const result = validateHostMaintenancePolicy(parsed);
  if (!result.ok) {
    throw new Error("Host maintenance policy is malformed");
  }
  return result.value;
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
