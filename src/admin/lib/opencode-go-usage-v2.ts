/**
 * Opencode Go quota for OpenCode v2 (Integrations API credentials).
 *
 * v2 key values live in ai-dev's opencode.db and are intentionally NOT
 * retrievable ("stored securely"). So the usage lookup runs INSIDE ai-dev:
 * one remote shell script reads the credential value from sqlite, curls the
 * official usage endpoint, and prints only { http, usage } — the raw key
 * never leaves ai-dev and never reaches the browser.
 */
import { execInAiDev, type ExecResult } from "./docker";
import { parseGoUsagePayload, type GoUsage } from "./opencode-go-usage";

export const GO_USAGE_V2_TTL_MS = 60_000;
export const GO_USAGE_V2_TIMEOUT_MS = 20_000;
const GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

export interface GoUsageV2Deps {
  readonly execInAiDev: (command: string, timeoutMs: number) => Promise<ExecResult>;
}

const REAL_V2_DEPS: GoUsageV2Deps = { execInAiDev };

type V2CacheEntry = { expiresAt: number; usage: GoUsage };
const cache = new Map<string, V2CacheEntry>();

export function __clearGoUsageV2CacheForTest(): void {
  cache.clear();
}

/** Credential IDs are `cred_` + safe chars; anything else is rejected before shell use. */
export function isValidV2CredentialId(id: string): boolean {
  return /^cred_[A-Za-z0-9._-]+$/.test(id);
}

export type GoUsageV2Result =
  | { ok: true; usage: GoUsage; cached: boolean }
  | { ok: false; code: "nocred" | "invalid_key" | "no_subscription" | "upstream" | "timeout"; message: string; status?: number };

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Remote script: sqlite → curl → jq-wrapped single-line JSON.
 * stdout contract: {"ok":true,"http":200,"usage":{...}|null} or {"ok":false,"code":"nocred"}.
 * The key material only exists inside ai-dev's shell; stdout carries percentages alone.
 */
export function buildGoUsageV2Script(credentialId: string): string {
  const id = shellSingleQuote(credentialId);
  return [
    `DB="\${HOME:-/home/devuser}/.local/share/opencode/opencode.db"`,
    `ID=${id}`,
    `KEY=$(sqlite3 "$DB" "SELECT value FROM credential WHERE id='$ID' AND integration_id='opencode-go' LIMIT 1;")`,
    `if [ -z "$KEY" ]; then printf '{"ok":false,"code":"nocred"}'; exit 0; fi`,
    // v2 stores an envelope like {"type":"api","key":"oc_sk_..."} — the Bearer is .key.
    `APIKEY=$(printf '%s' "$KEY" | jq -r 'if type=="object" then (.key // empty) else . end' 2>/dev/null)`,
    `if [ -z "$APIKEY" ]; then printf '{"ok":false,"code":"badcred"}'; exit 0; fi`,
    `TMP=$(mktemp -t go-usage.XXXXXX); trap 'rm -f "$TMP"' EXIT`,
    `CODE=$(curl -sS --max-time 10 -o "$TMP" -w '%{http_code}' -H "Authorization: Bearer $APIKEY" -H 'Accept: application/json' '${GO_USAGE_URL}' 2>/dev/null) || CODE="000"`,
    `RAW=$(cat "$TMP" 2>/dev/null || true); rm -f "$TMP"; trap - EXIT`,
    `jq -n --arg code "$CODE" --arg raw "$RAW" '{ok:true,http:($code|tonumber),usage:(try (($raw|fromjson|.usage)//null) catch null)}'`,
  ].join("\n");
}

interface RemoteOk {
  ok: true;
  http: number;
  usage: unknown;
}

function parseRemoteStdout(stdout: string): RemoteOk | { ok: false; code: "nocred" | "badcred" } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const r = parsed as Record<string, unknown>;
  if (r.ok === false && (r.code === "nocred" || r.code === "badcred")) {
    return { ok: false, code: r.code };
  }
  if (r.ok !== true || typeof r.http !== "number") return null;
  return { ok: true, http: r.http, usage: r.usage };
}

export async function fetchGoUsageV2(
  credentialId: string,
  deps: GoUsageV2Deps = REAL_V2_DEPS,
  nowMs = Date.now(),
): Promise<GoUsageV2Result> {
  const id = (credentialId ?? "").trim();
  if (!isValidV2CredentialId(id)) return { ok: false, code: "nocred", message: "unknown credential" };
  const hit = cache.get(id);
  if (hit && hit.expiresAt > nowMs) return { ok: true, usage: hit.usage, cached: true };
  let res: ExecResult;
  try {
    res = await deps.execInAiDev(buildGoUsageV2Script(id), GO_USAGE_V2_TIMEOUT_MS);
  } catch (e) {
    return { ok: false, code: "timeout", message: e instanceof Error ? e.message : String(e) };
  }
  if (res.exitCode !== 0) return { ok: false, code: "upstream", message: res.stderr || "remote lookup failed" };
  const remote = parseRemoteStdout(res.stdout);
  if (remote === null) return { ok: false, code: "upstream", message: "malformed remote payload" };
  if (remote.ok === false && remote.code === "nocred") {
    return { ok: false, code: "nocred", message: "credential not found" };
  }
  if (remote.ok === false) return { ok: false, code: "upstream", message: "unreadable credential" };
  if (remote.http === 401) return { ok: false, code: "invalid_key", message: "invalid key", status: 401 };
  if (remote.http === 403) return { ok: false, code: "no_subscription", message: "no Go subscription", status: 403 };
  if (remote.http === 0) return { ok: false, code: "upstream", message: "request failed" };
  if (remote.http < 200 || remote.http >= 300) {
    return { ok: false, code: "upstream", message: `http ${remote.http}`, status: remote.http };
  }
  const usage = parseGoUsagePayload({ usage: remote.usage });
  if (!usage) return { ok: false, code: "upstream", message: "malformed usage payload" };
  cache.set(id, { expiresAt: nowMs + GO_USAGE_V2_TTL_MS, usage });
  return { ok: true, usage, cached: false };
}
