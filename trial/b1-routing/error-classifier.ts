type ErrorInfo = { name?: string; message?: string; statusCode?: number };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function getNested(v: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(v)) return undefined;
  const val = (v as Record<string, unknown>)[key];
  return isRecord(val) ? val : undefined;
}
function getVal(rec: Record<string, unknown> | undefined, key: string): unknown {
  try { return rec?.[key]; } catch { return undefined; }
}

export function getErrorMessage(error: unknown): string {
  if (!error) return "";
  if (typeof error === "string") return error.toLowerCase();
  if (!isRecord(error)) {
    try { return JSON.stringify(error).toLowerCase(); } catch { return ""; }
  }
  const data = getNested(error, "data");
  const nestedError = getNested(error, "error");
  const dataError = getNested(data, "error");
  for (const rec of [data, nestedError, error, dataError] as Record<string, unknown>[]) {
    if (!rec) continue;
    const m = getVal(rec, "message");
    if (typeof m === "string" && m.length > 0) return m.toLowerCase();
  }
  const name = getVal(error as Record<string, unknown>, "name");
  if (typeof name === "string") {
    const match = name.match(/:\s*(.+)/);
    if (match) return (match[1] ?? "").toLowerCase();
  }
  try { return JSON.stringify(error).toLowerCase(); } catch { return ""; }
}

export function getStatusCode(error: unknown, retryCodes?: readonly number[]): number | undefined {
  const DEFAULT = [429, 500, 502, 503, 504] as const;
  if (isRecord(error)) {
    const sc = getVal(error as Record<string, unknown>, "statusCode");
    if (typeof sc === "number") return sc;
    const st = getVal(error as Record<string, unknown>, "status");
    if (typeof st === "number") return st;
  }
  const root = isRecord(error) ? error as Record<string, unknown> : undefined;
  for (const rec of [getNested(root, "data"), getNested(root, "error"), getNested(root, "cause")] as (Record<string, unknown> | undefined)[]) {
    if (!rec) continue;
    const sc = getVal(rec, "statusCode");
    if (typeof sc === "number") return sc;
  }
  const codes = retryCodes ?? DEFAULT;
  const pattern = new RegExp(`\\b(${codes.join("|")})\\b`);
  const msg = getErrorMessage(error);
  const m = msg.match(pattern);
  if (m?.[1]) return parseInt(m[1], 10);
  return undefined;
}

export function getRetryableSignal(error: unknown): boolean | undefined {
  if (!isRecord(error)) return undefined;
  const root = error as Record<string, unknown>;
  for (const rec of [root, getNested(root, "data"), getNested(root, "error"), getNested(getNested(root, "data"), "error"), getNested(root, "cause")] as (Record<string, unknown> | undefined)[]) {
    if (!rec) continue;
    const r = getVal(rec, "isRetryable");
    if (typeof r === "boolean") return r;
  }
  return undefined;
}

const TOKEN_LIMIT_PATTERNS = [
  "prompt is too long", "is too long", "context_length_exceeded", "token limit", "context length", "too many tokens",
];
const TOKEN_LIMIT_NAMES: Record<string, boolean> = { contextlengtherror: true, context_length_exceeded: true };

export function isTokenLimitError(error: { name?: string; message?: string } | undefined): boolean {
  if (!error) return false;
  const retryable = isRetryableModelError({ name: error.name, message: error.message });
  if (!retryable && error.name) {
    if (TOKEN_LIMIT_NAMES[error.name.toLowerCase()]) return true;
  }
  if (error.message) {
    const lower = error.message.toLowerCase();
    for (const p of TOKEN_LIMIT_PATTERNS) if (lower.indexOf(p) !== -1) return true;
    return false;
  }
  return false;
}

export function isUnrecoverableRequestError(error: unknown): boolean {
  if (!error) return false;
  const sc = getStatusCode(error);
  if (sc === undefined || (sc !== 400 && sc !== 422)) return false;
  return getRetryableSignal(error) === false;
}

const RETRYABLE_NAMES: Record<string, boolean> = { providermodelnotfounderror: true, ratelimiterror: true, modelunavailableerror: true, providerconnectionerror: true, authenticationerror: true };
const STOP_NAMES: Record<string, boolean> = { quotaexceedederror: true, insufficientcreditserror: true, freeusagelimiterror: true };
const NON_RETRYABLE_NAMES: Record<string, boolean> = { messageabortederror: true, permissiondeniederror: true, contextlengtherror: true, timeouterror: true, validationerror: true, syntaxerror: true, usererror: true };

const RETRYABLE_PATTERNS = [
  "rate_limit","rate limit","usage_limit_reached","quota","all credentials for model","cooling down","not found","unavailable","too many requests","over limit","overloaded","bad gateway","bad request","unknown provider","provider not found","model_not_supported","connection error","network error","service unavailable","internal_server_error","free usage","temporarily unavailable","try again","503","502","504","429","529","selected provider is forbidden","provider is forbidden","server_error","upstream request failed",
];
const STOP_PATTERNS = [
  "quota will reset after","quota exceeded","free usage limit","billing limit","payment required","out of credits","insufficient credits","insufficient balance","daily call limit","recharge and try",
];

export function isRetryableModelError(error: ErrorInfo): boolean {
  if (error.name) {
    const n = error.name.toLowerCase();
    if (NON_RETRYABLE_NAMES[n]) return false;
    if (STOP_NAMES[n]) return false;
    if (RETRYABLE_NAMES[n]) return true;
  }
  const msg = (error.message ?? "").toLowerCase();
  for (const p of STOP_PATTERNS) if (msg.indexOf(p) !== -1) return false;
  if (msg.indexOf("retrying in") !== -1) {
    for (const p of ["rate limit","cooling down","credentials for model"]) if (msg.indexOf(p) !== -1) return true;
  }
  if (error.statusCode != null && (error.statusCode === 429 || error.statusCode === 503 || error.statusCode === 529)) return true;
  for (const p of RETRYABLE_PATTERNS) if (msg.indexOf(p) !== -1) return true;
  return false;
}

export function toErrorInfo(error: unknown): ErrorInfo {
  if (!error) return {};
  if (typeof error === "string") return { message: error };
  if (!isRecord(error)) return { message: getErrorMessage(error) };
  const rec = error as Record<string, unknown>;
  const name = typeof rec["name"] === "string" ? (rec["name"] as string) : undefined;
  const message = getErrorMessage(error);
  const statusCode = getStatusCode(error);
  return { name, message, statusCode };
}
