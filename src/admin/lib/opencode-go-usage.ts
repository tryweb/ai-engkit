import { createHash } from "node:crypto";

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const CACHE_TTL_MS = 60_000;

export interface UsageWindow {
  status: string;
  percent?: number;
  resetsAt?: string;
}

export interface GoUsage {
  usage: {
    rolling: UsageWindow;
    weekly: UsageWindow;
    monthly: UsageWindow;
  };
}

export type GoUsageErrorCode = "invalid_key" | "no_subscription" | "http_error" | "invalid_response";

export type GoUsageResult =
  | { usage: GoUsage; cached: boolean }
  | { ok: false; code: GoUsageErrorCode; cached: false };

export type UsageTone = "ok" | "warn" | "bad" | "muted";
export type GoFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface UsageItem {
  keyId: string;
  masked: string;
  ok: boolean;
  cached: boolean;
  monthly: {
    percent?: number;
    status: string;
    resetsAt?: string;
    resetsIn: string;
    label: string;
    tone: UsageTone;
  };
  rolling: { percent?: number; status: string; resetsIn: string };
  weekly: { percent?: number; status: string; resetsIn: string };
  error?: GoUsageErrorCode;
}

const cache = new Map<string, { usage: GoUsage; expiresAt: number }>();

function keyDigest(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function isWindow(value: unknown): value is UsageWindow {
  if (typeof value !== "object" || value === null) return false;
  const window = value as Record<string, unknown>;
  return typeof window.status === "string" &&
    (window.percent === undefined || typeof window.percent === "number") &&
    (window.resetsAt === undefined || typeof window.resetsAt === "string");
}

function parseUsage(value: unknown): GoUsage | null {
  if (typeof value !== "object" || value === null) return null;
  const usage = (value as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return null;
  const windows = usage as Record<string, unknown>;
  if (!isWindow(windows.rolling) || !isWindow(windows.weekly) || !isWindow(windows.monthly)) return null;
  return { usage: { rolling: windows.rolling, weekly: windows.weekly, monthly: windows.monthly } };
}

export function formatResetsIn(resetsAt: string | undefined, now = new Date()): string {
  if (!resetsAt) return "—";
  const reset = new Date(resetsAt);
  if (Number.isNaN(reset.getTime())) return "—";
  const minutes = Math.max(0, Math.floor((reset.getTime() - now.getTime()) / 60_000));
  if (minutes < 1) return "<1m";
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor((minutes % (24 * 60)) / 60);
  const remainingMinutes = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${remainingMinutes}m`;
  return `${remainingMinutes}m`;
}

export function formatMonthlyLabel(percent: number | undefined, status: string, resetsIn = "—"): string {
  if (status === "invalid_key") return "invalid key";
  if (status === "no_subscription") return "no subscription";
  if (status !== "ok" || typeof percent !== "number" || !Number.isFinite(percent)) return "Monthly —";
  return `Monthly ${percent}% · resets ${resetsIn}`;
}

export function monthlyTone(percent: number | undefined, status: string): UsageTone {
  if (typeof percent !== "number" || !Number.isFinite(percent)) return "muted";
  if (status !== "ok") return "bad";
  if (percent >= 90) return "bad";
  if (percent >= 70) return "warn";
  return "ok";
}

/** The success branch is narrowed with `"usage" in result`; `!result.ok` does not narrow this union in TS. */
export async function fetchGoUsage(key: string, fetchFn: GoFetch = fetch): Promise<GoUsageResult> {
  const digest = keyDigest(key);
  const cached = cache.get(digest);
  if (cached && cached.expiresAt > Date.now()) return { usage: cached.usage, cached: true };
  if (cached) cache.delete(digest);

  let response: Response;
  try {
    response = await fetchFn(USAGE_URL, { headers: { Authorization: `Bearer ${key}` } });
  } catch {
    return { ok: false, code: "http_error", cached: false };
  }
  if (response.status === 401) return { ok: false, code: "invalid_key", cached: false };
  if (response.status === 403) return { ok: false, code: "no_subscription", cached: false };
  if (!response.ok) return { ok: false, code: "http_error", cached: false };

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { ok: false, code: "invalid_response", cached: false };
  }
  const usage = parseUsage(parsed);
  if (!usage) return { ok: false, code: "invalid_response", cached: false };
  cache.set(digest, { usage, expiresAt: Date.now() + CACHE_TTL_MS });
  return { usage, cached: false };
}

function errorWindow(code: GoUsageErrorCode): UsageWindow {
  return { status: code };
}

export function toUsageItemWindows(
  keyId: string,
  masked: string,
  result: GoUsageResult,
  now = new Date(),
): UsageItem {
  const usage = "usage" in result ? result.usage.usage : {
    rolling: errorWindow(result.code),
    weekly: errorWindow(result.code),
    monthly: errorWindow(result.code),
  };
  const monthlyResetsIn = formatResetsIn(usage.monthly.resetsAt, now);
  return {
    keyId,
    masked,
    ok: "usage" in result,
    cached: result.cached,
    monthly: {
      percent: usage.monthly.percent,
      status: usage.monthly.status,
      resetsAt: usage.monthly.resetsAt,
      resetsIn: monthlyResetsIn,
      label: formatMonthlyLabel(usage.monthly.percent, usage.monthly.status, monthlyResetsIn),
      tone: monthlyTone(usage.monthly.percent, usage.monthly.status),
    },
    rolling: {
      percent: usage.rolling.percent,
      status: usage.rolling.status,
      resetsIn: formatResetsIn(usage.rolling.resetsAt, now),
    },
    weekly: {
      percent: usage.weekly.percent,
      status: usage.weekly.status,
      resetsIn: formatResetsIn(usage.weekly.resetsAt, now),
    },
    ...( "usage" in result ? {} : { error: result.code }),
  };
}
