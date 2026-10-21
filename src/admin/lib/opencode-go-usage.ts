/**
 * Opencode Go quota — per-key monthly usage display.
 * Official endpoint: GET https://opencode.ai/zen/go/v1/usage
 * Auth: Authorization: Bearer <api-key>
 * Returns: { usage: { rolling|weekly|monthly: { status, percent, resetsAt } } }
 */
import { createHash } from "node:crypto";

export const GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
export const GO_USAGE_TTL_MS = 60_000;
export const GO_USAGE_TIMEOUT_MS = 10_000;

export interface GoUsageWindow {
  status: string;
  percent: number;
  resetsAt: string;
}

export interface GoUsage {
  rolling: GoUsageWindow | null;
  weekly: GoUsageWindow | null;
  monthly: GoUsageWindow | null;
}

export type GoUsageFetchImpl = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<Response>;

export type GoUsageResult =
  | { ok: true; usage: GoUsage; cached: boolean }
  | { ok: false; code: "invalid_key" | "no_subscription" | "upstream" | "timeout"; message: string; status?: number };

interface CacheEntry {
  expiresAt: number;
  usage: GoUsage;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 32);
}

export function __clearGoUsageCacheForTest(): void {
  cache.clear();
}

function isWindow(v: unknown): v is GoUsageWindow {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.status === "string" &&
    typeof r.percent === "number" &&
    Number.isFinite(r.percent) &&
    typeof r.resetsAt === "string"
  );
}

export function parseGoUsagePayload(payload: unknown): GoUsage | null {
  if (typeof payload !== "object" || payload === null) return null;
  const usage = (payload as Record<string, unknown>).usage;
  if (typeof usage !== "object" || usage === null) return null;
  const u = usage as Record<string, unknown>;
  const pick = (k: string): GoUsageWindow | null => (isWindow(u[k]) ? (u[k] as GoUsageWindow) : null);
  const out: GoUsage = { rolling: pick("rolling"), weekly: pick("weekly"), monthly: pick("monthly") };
  if (!out.rolling && !out.weekly && !out.monthly) return null;
  return out;
}

async function fetchWithTimeout(
  fetchImpl: GoUsageFetchImpl,
  url: string,
  apiKey: string,
  timeoutMs: number,
): Promise<Response> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      signal: c.signal,
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      const err = new Error(`timeout after ${timeoutMs}ms`);
      err.name = "TimeoutError";
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

export async function fetchGoUsage(
  apiKey: string,
  options: {
    fetchImpl?: GoUsageFetchImpl;
    now?: () => number;
    timeoutMs?: number;
    noCache?: boolean;
  } = {},
): Promise<GoUsageResult> {
  const key = (apiKey ?? "").trim();
  if (!key) return { ok: false, code: "invalid_key", message: "missing key" };
  const nowFn = options.now ?? (() => Date.now());
  const now = nowFn();
  const ck = cacheKey(key);
  if (!options.noCache) {
    const hit = cache.get(ck);
    if (hit && hit.expiresAt > now) return { ok: true, usage: hit.usage, cached: true };
  }
  const fetchImpl = options.fetchImpl ?? (fetch as unknown as GoUsageFetchImpl);
  const timeoutMs = options.timeoutMs ?? GO_USAGE_TIMEOUT_MS;
  let res: Response;
  try {
    res = await fetchWithTimeout(fetchImpl, GO_USAGE_URL, key, timeoutMs);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("timeout")) return { ok: false, code: "timeout", message: msg };
    return { ok: false, code: "upstream", message: msg };
  }
  if (res.status === 401) return { ok: false, code: "invalid_key", message: "invalid key", status: 401 };
  if (res.status === 403)
    return { ok: false, code: "no_subscription", message: "no Go subscription", status: 403 };
  if (!res.ok) return { ok: false, code: "upstream", message: `http ${res.status}`, status: res.status };
  try {
    const json: unknown = await res.json();
    const usage = parseGoUsagePayload(json);
    if (!usage) return { ok: false, code: "upstream", message: "malformed payload" };
    cache.set(ck, { expiresAt: now + GO_USAGE_TTL_MS, usage });
    return { ok: true, usage, cached: false };
  } catch (e) {
    return { ok: false, code: "upstream", message: e instanceof Error ? e.message : "parse error" };
  }
}

/** "17d 18h" / "5h 4m" / "42m" / "<1m" —精簡倒數,方便一眼判別. */
export function formatResetsIn(resetsAt: string, nowMs = Date.now()): string {
  const target = Date.parse(resetsAt);
  if (!Number.isFinite(target)) return "—";
  const diff = target - nowMs;
  if (diff <= 0) return "now";
  const days = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff % 86_400_000) / 3_600_000);
  const mins = Math.floor((diff % 3_600_000) / 60_000);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}m`;
  return "<1m";
}

/** Monthly 精簡標籤: "Monthly 39% · resets 17d 18h" */
export function formatMonthlyLabel(monthly: GoUsageWindow | null, nowMs = Date.now()): string {
  if (!monthly) return "Monthly —";
  if (monthly.status !== "ok") return `Monthly ${monthly.status} · resets ${formatResetsIn(monthly.resetsAt, nowMs)}`;
  return `Monthly ${monthly.percent}% · resets ${formatResetsIn(monthly.resetsAt, nowMs)}`;
}

/** 徽章顏色: ok(<70) / warn(70-89) / exhausted(>=90 或非 ok). */
export function monthlyTone(monthly: GoUsageWindow | null): "ok" | "warn" | "exhausted" | "muted" {
  if (!monthly) return "muted";
  if (monthly.status !== "ok") return "exhausted";
  if (monthly.percent >= 90) return "exhausted";
  if (monthly.percent >= 70) return "warn";
  return "ok";
}

export interface GoUsageItemWindows {
  monthly: {
    percent: number;
    status: string;
    resetsAt: string;
    resetsIn: string;
    label: string;
    tone: "ok" | "warn" | "exhausted" | "muted";
  } | null;
  rolling: { percent: number; status: string; resetsIn: string } | null;
  weekly: { percent: number; status: string; resetsIn: string } | null;
}

/** Bulk API 單 key 的用量欄位 — v1 registry 與 v2 credential 共用同一 shape. */
export function toUsageItemWindows(usage: GoUsage, now: number): GoUsageItemWindows {
  const m = usage.monthly;
  const rolling = usage.rolling;
  const weekly = usage.weekly;
  return {
    monthly: m
      ? {
          percent: m.percent,
          status: m.status,
          resetsAt: m.resetsAt,
          resetsIn: formatResetsIn(m.resetsAt, now),
          label: formatMonthlyLabel(m, now),
          tone: monthlyTone(m),
        }
      : null,
    rolling: rolling
      ? { percent: rolling.percent, status: rolling.status, resetsIn: formatResetsIn(rolling.resetsAt, now) }
      : null,
    weekly: weekly
      ? { percent: weekly.percent, status: weekly.status, resetsIn: formatResetsIn(weekly.resetsAt, now) }
      : null,
  };
}
