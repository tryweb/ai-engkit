import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const RETENTION_POLICY_PATH = "/opt/ai-engkit/admin-data/retention-policy.json";

export function retentionPolicyPath(): string {
  return Bun.env.RETENTION_POLICY_PATH || RETENTION_POLICY_PATH;
}

export interface RetentionPolicy {
  enabled: boolean;
  cutoffDays: number;
  dailyRunAt: string;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = { enabled: false, cutoffDays: 30, dailyRunAt: "03:00" };

export const DAILY_RUN_AT_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export interface ValidationResultOk {
  ok: true;
  value: RetentionPolicy;
}

export interface ValidationResultError {
  ok: false;
  field: string;
  message: string;
}

export type ValidationResult = ValidationResultOk | ValidationResultError;

const ALLOWED_FIELDS = new Set(["enabled", "cutoffDays", "dailyRunAt"]);

export function validateRetentionPolicy(input: unknown): ValidationResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, field: "policy", message: "must be an object" };
  }

  const record = input as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (!ALLOWED_FIELDS.has(key)) {
      if (key === "archive" || key === "action") {
        return { ok: false, field: key, message: `${key} action is not supported` };
      }
      return { ok: false, field: key, message: `${key} is not allowed` };
    }
  }

  if (!("enabled" in record)) {
    return { ok: false, field: "enabled", message: "must be a boolean" };
  }
  if (typeof record.enabled !== "boolean") {
    return { ok: false, field: "enabled", message: "must be a boolean" };
  }

  if (!("cutoffDays" in record)) {
    return { ok: false, field: "cutoffDays", message: "must be an integer between 1 and 365" };
  }

  const cutoff = record.cutoffDays;
  if (typeof cutoff !== "number" || !Number.isInteger(cutoff) || cutoff < 1 || cutoff > 365) {
    return { ok: false, field: "cutoffDays", message: "must be an integer between 1 and 365" };
  }

  if (!("dailyRunAt" in record)) {
    return { ok: false, field: "dailyRunAt", message: "must be a string in HH:MM format (00:00-23:59)" };
  }

  const dailyRunAt = record.dailyRunAt;
  if (typeof dailyRunAt !== "string" || !DAILY_RUN_AT_RE.test(dailyRunAt)) {
    return { ok: false, field: "dailyRunAt", message: "must be a string in HH:MM format (00:00-23:59)" };
  }

  return { ok: true, value: { enabled: record.enabled, cutoffDays: cutoff, dailyRunAt } };
}

export function parseRetentionPolicyJSON(text: string): RetentionPolicy | null {
  try {
    const parsed: unknown = JSON.parse(text);
    let normalized: unknown = parsed;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>;
      if (!("dailyRunAt" in rec)) {
        normalized = { ...rec, dailyRunAt: DEFAULT_RETENTION_POLICY.dailyRunAt };
      }
    }
    const result = validateRetentionPolicy(normalized);
    if (!result.ok) return null;
    return result.value;
  } catch {
    return null;
  }
}

function withDefaultDailyRunAt(parsed: unknown): unknown {
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const rec = parsed as Record<string, unknown>;
    if (!("dailyRunAt" in rec)) {
      return { ...rec, dailyRunAt: DEFAULT_RETENTION_POLICY.dailyRunAt };
    }
  }
  return parsed;
}

export function readRetentionPolicyFrom(filePath: string): RetentionPolicy {
  if (!existsSync(filePath)) return { ...DEFAULT_RETENTION_POLICY };
  const text = readFileSync(filePath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Retention policy is malformed");
  }
  parsed = withDefaultDailyRunAt(parsed);
  const result = validateRetentionPolicy(parsed);
  if (!result.ok) {
    throw new Error("Retention policy is malformed");
  }
  return result.value;
}

export function readRetentionPolicy(): RetentionPolicy {
  return readRetentionPolicyFrom(retentionPolicyPath());
}

export function writeRetentionPolicyFrom(filePath: string, policy: RetentionPolicy): void {
  const validation = validateRetentionPolicy(policy);
  if (validation.ok === false) {
    throw new Error(`${validation.field} ${validation.message}`);
  }

  if (existsSync(filePath) && !statSync(filePath).isFile()) {
    throw new Error(`retention-policy.json is not a regular file: ${filePath}`);
  }

  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = join(dirname(filePath), `.retention-policy.json.tmp.${Date.now()}`);
  writeFileSync(tmp, `${JSON.stringify(validation.value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, filePath);
}

export function writeRetentionPolicy(policy: RetentionPolicy): void {
  writeRetentionPolicyFrom(retentionPolicyPath(), policy);
}
