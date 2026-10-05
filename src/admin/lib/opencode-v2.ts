/**
 * OpenCode v2 Integrations API adapter.
 * Wraps `opencode api` CLI inside ai-dev via execInAiDev.
 * Runtime truth is the OpenCode 2.x server; this module maps
 * integrations/credential endpoints to the admin's provider surface.
 * SECURITY: All argv values are shell-quoted; secrets use base64 envelope
 * so host `docker exec` argv never contains raw keys.
 */
import { execInAiDev as _realExec, shellQuote, type ExecResult } from "./docker";

let _exec: typeof _realExec = _realExec;
export function __setExecForTest(fn: typeof _realExec): void {
  _exec = fn;
}
export function __resetExecForTest(): void {
  _exec = _realExec;
}

export type V2IntegrationMethod =
  | { type: "key"; label?: string; form?: unknown }
  | { type: "env"; names: string[] }
  | { type: "oauth"; id: string; label: string; form?: unknown };

export interface V2Integration {
  id: string;
  name: string;
  methods: V2IntegrationMethod[];
  connections: Array<{ type: "credential"; id: string; label: string; method: "key" | "oauth" } | { type: "env"; name: string }>;
}

export interface V2IntegrationList {
  location: { directory: string };
  data: V2Integration[];
}

const DEFAULT_DIRECTORY = "/home/devuser";
const V2_CONFIG_PATH = "/home/devuser/.config/opencode/opencode.json";

function directoryParam(directory?: string): string {
  return directory ?? DEFAULT_DIRECTORY;
}

function assertValidId(value: string, kind: string): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) throw new Error(`Invalid ${kind}: ${value}`);
  if (value.includes("'") || value.includes('"') || value.includes("`") || value.includes("$") || value.includes(";") || value.includes("&") || value.includes("|")) {
    throw new Error(`Invalid ${kind}: ${value}`);
  }
}

function assertValidCredentialId(value: string): void {
  assertValidId(value, "credentialID");
  if (!value.startsWith("cred_")) throw new Error(`Invalid credentialID: ${value}`);
}

function assertValidAttemptId(value: string): void {
  assertValidId(value, "attemptID");
  if (!value.startsWith("con_")) throw new Error(`Invalid attemptID: ${value}`);
}

function quotedParam(key: string, value: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(key)) throw new Error(`Invalid param key: ${key}`);
  return `${key}=${shellQuote(value)}`;
}

async function runApi(op: string, params: string[], data?: string): Promise<ExecResult> {
  if (!/^[a-z0-9.]+$/.test(op)) throw new Error(`Invalid op: ${op}`);
  const quotedParams: string[] = [];
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p === "--param") {
      quotedParams.push(p);
      const next = params[i + 1];
      if (next === undefined) throw new Error("Missing param value");
      const eqIdx = next.indexOf("=");
      if (eqIdx === -1) {
        quotedParams.push(shellQuote(next));
      } else {
        const k = next.slice(0, eqIdx);
        const v = next.slice(eqIdx + 1);
        quotedParams.push(quotedParam(k, v));
      }
      i++;
    } else if (p.includes("=")) {
      const eqIdx = p.indexOf("=");
      const k = p.slice(0, eqIdx);
      const v = p.slice(eqIdx + 1);
      quotedParams.push(quotedParam(k, v));
    } else {
      quotedParams.push(shellQuote(p));
    }
  }
  const opQuoted = shellQuote(op);
  if (data !== undefined) {
    if (typeof data !== "string") throw new Error("Invalid data");
    const b64 = Buffer.from(data).toString("base64");
    if (!/^[A-Za-z0-9+/=]+$/.test(b64)) throw new Error("Invalid base64");
    // Use mktemp + umask 077 + trap for safe temp file; base64 envelope avoids raw secret on host argv
    // Note: base64 is encoding, not encryption — host argv still contains base64, but raw key is not directly visible.
    // Payload is written with 0600 and cleaned via trap even on failure.
    const cmd = `umask 077 && TMP_PAYLOAD=$(mktemp -t opencode-payload.XXXXXX) && trap 'rm -f "$TMP_PAYLOAD"' EXIT && B64=${shellQuote(b64)} && printf '%s' "$B64" | base64 -d > "$TMP_PAYLOAD" && opencode api ${opQuoted} ${quotedParams.join(" ")} -d "$(cat "$TMP_PAYLOAD")" ; RC=$?; rm -f "$TMP_PAYLOAD"; trap - EXIT; exit $RC`;
    return _exec(cmd, 15_000);
  }
  const cmd = `opencode api ${opQuoted} ${quotedParams.join(" ")}`;
  return _exec(cmd, 15_000);
}

export async function isOpenCodeV2(): Promise<boolean> {
  let r: ExecResult;
  try {
    r = await _exec("opencode --version", 5_000);
  } catch {
    throw new Error("Failed to determine OpenCode version");
  }
  const out = r.stdout.trim();
  if (/(?:^|\s)v?2\.\d+\.\d+\b/.test(out)) return true;
  if (/(?:^|\s)v?1\.\d+\.\d+\b/.test(out)) return false;
  throw new Error(`Unknown OpenCode version: ${out || r.stderr || "empty"}`);
}

function parseJsonGuarded(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON response");
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function guardIntegrationList(obj: unknown): V2IntegrationList {
  if (!isRecord(obj)) throw new Error("Invalid integration list");
  const loc = obj.location;
  if (!isRecord(loc) || typeof loc.directory !== "string") throw new Error("Invalid location");
  if (!Array.isArray(obj.data)) throw new Error("Invalid data");
  const data: V2Integration[] = [];
  for (const item of obj.data) {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.name !== "string" || !Array.isArray(item.methods) || !Array.isArray(item.connections)) {
      throw new Error("Invalid integration entry");
    }
    const methods: V2IntegrationMethod[] = [];
    for (const method of item.methods) {
      if (!isRecord(method)) throw new Error("Invalid integration method");
      if (method.type === "key") {
        methods.push({ type: "key", ...(typeof method.label === "string" ? { label: method.label } : {}), form: method.form });
      } else if (method.type === "oauth" && typeof method.id === "string" && typeof method.label === "string") {
        methods.push({ type: "oauth", id: method.id, label: method.label, form: method.form });
      } else if (method.type === "env" && Array.isArray(method.names) && method.names.every((name): name is string => typeof name === "string")) {
        methods.push({ type: "env", names: method.names });
      } else {
        throw new Error("Invalid integration method");
      }
    }
    const connections: V2Integration["connections"] = [];
    for (const connection of item.connections) {
      if (!isRecord(connection)) throw new Error("Invalid integration connection");
      if (connection.type === "credential" && typeof connection.id === "string" && typeof connection.label === "string" && (connection.method === "key" || connection.method === "oauth")) {
        connections.push({ type: "credential", id: connection.id, label: connection.label, method: connection.method });
      } else if (connection.type === "env" && typeof connection.name === "string") {
        connections.push({ type: "env", name: connection.name });
      } else {
        throw new Error("Invalid integration connection");
      }
    }
    data.push({ id: item.id, name: item.name, methods, connections });
  }
  return { location: { directory: loc.directory }, data };
}

export async function listIntegrations(directory?: string): Promise<V2IntegrationList> {
  const dir = directoryParam(directory);
  if (!dir.startsWith("/") || dir.includes("'") || dir.includes('"')) throw new Error("Invalid directory");
  const result = await runApi("integration.list", ["--param", `location.directory=${dir}`]);
  if (result.exitCode !== 0) throw new Error(result.stderr || "integration.list failed");
  const parsed = parseJsonGuarded(result.stdout);
  return guardIntegrationList(parsed);
}

export async function connectKey(
  integrationID: string,
  key: string,
  opts: { label?: string; answer?: Record<string, string | number | boolean | string[]>; directory?: string } = {},
): Promise<void> {
  assertValidId(integrationID, "integrationID");
  if (typeof key !== "string" || key.length === 0) throw new Error("Invalid key");
  const dir = directoryParam(opts.directory);
  if (!dir.startsWith("/")) throw new Error("Invalid directory");
  const payload: Record<string, unknown> = { key };
  if (opts.label !== undefined) {
    if (typeof opts.label !== "string") throw new Error("Invalid label");
    payload.label = opts.label;
  }
  if (opts.answer !== undefined) {
    if (!isRecord(opts.answer)) throw new Error("Invalid answer");
    payload.answer = opts.answer;
  }
  const result = await runApi("integration.connect.key", ["--param", `integrationID=${integrationID}`, "--param", `location.directory=${dir}`], JSON.stringify(payload));
  if (result.exitCode !== 0) throw new Error(result.stderr || "integration.connect.key failed");
}

export async function credentialActivate(credentialID: string): Promise<void> {
  assertValidCredentialId(credentialID);
  const result = await runApi("credential.activate", ["--param", `credentialID=${credentialID}`]);
  if (result.exitCode !== 0) throw new Error(result.stderr || "credential.activate failed");
}

export async function credentialRemove(credentialID: string): Promise<void> {
  assertValidCredentialId(credentialID);
  const result = await runApi("credential.remove", ["--param", `credentialID=${credentialID}`]);
  if (result.exitCode !== 0) throw new Error(result.stderr || "credential.remove failed");
}

export async function credentialUpdate(credentialID: string, label: string): Promise<void> {
  assertValidCredentialId(credentialID);
  if (typeof label !== "string") throw new Error("Invalid label");
  const result = await runApi("credential.update", ["--param", `credentialID=${credentialID}`], JSON.stringify({ label }));
  if (result.exitCode !== 0) throw new Error(result.stderr || "credential.update failed");
}

export interface OAuthConnectResult {
  attemptID: string;
  url?: string;
  instructions?: string;
}

function guardOAuthConnect(obj: unknown): OAuthConnectResult {
  if (!isRecord(obj) || !isRecord(obj.data)) throw new Error("Invalid oauth connect");
  const data = obj.data as Record<string, unknown>;
  if (typeof data.attemptID !== "string") throw new Error("Invalid attemptID");
  return { attemptID: data.attemptID, url: typeof data.url === "string" ? data.url : undefined, instructions: typeof data.instructions === "string" ? data.instructions : undefined };
}

export async function oauthConnect(
  integrationID: string,
  methodID: string,
  opts: { answer?: Record<string, unknown>; label?: string; directory?: string } = {},
): Promise<OAuthConnectResult> {
  assertValidId(integrationID, "integrationID");
  assertValidId(methodID, "methodID");
  const dir = directoryParam(opts.directory);
  const payload: Record<string, unknown> = { methodID };
  if (opts.answer !== undefined) {
    if (!isRecord(opts.answer)) throw new Error("Invalid answer");
    payload.answer = opts.answer;
  }
  if (opts.label !== undefined) {
    if (typeof opts.label !== "string") throw new Error("Invalid label");
    payload.label = opts.label;
  }
  const result = await runApi("integration.oauth.connect", ["--param", `integrationID=${integrationID}`, "--param", `location.directory=${dir}`], JSON.stringify(payload));
  if (result.exitCode !== 0) throw new Error(result.stderr || "oauth.connect failed");
  const parsed = parseJsonGuarded(result.stdout);
  return guardOAuthConnect(parsed);
}

function guardOAuthStatus(obj: unknown): { status: string; message?: string } {
  if (!isRecord(obj) || !isRecord(obj.data)) throw new Error("Invalid oauth status");
  const data = obj.data as Record<string, unknown>;
  if (typeof data.status !== "string") throw new Error("Invalid status");
  return { status: data.status, message: typeof data.message === "string" ? data.message : undefined };
}

export async function oauthStatus(integrationID: string, attemptID: string, directory?: string): Promise<{ status: string; message?: string }> {
  assertValidId(integrationID, "integrationID");
  assertValidAttemptId(attemptID);
  const dir = directoryParam(directory);
  const result = await runApi("integration.oauth.status", ["--param", `integrationID=${integrationID}`, "--param", `attemptID=${attemptID}`, "--param", `location.directory=${dir}`]);
  if (result.exitCode !== 0) throw new Error(result.stderr || "oauth.status failed");
  const parsed = parseJsonGuarded(result.stdout);
  return guardOAuthStatus(parsed);
}

export async function oauthComplete(integrationID: string, attemptID: string, code?: string, directory?: string): Promise<void> {
  assertValidId(integrationID, "integrationID");
  assertValidAttemptId(attemptID);
  const dir = directoryParam(directory);
  const payload = code !== undefined ? { code } : {};
  if (code !== undefined && typeof code !== "string") throw new Error("Invalid code");
  const result = await runApi("integration.oauth.complete", ["--param", `integrationID=${integrationID}`, "--param", `attemptID=${attemptID}`, "--param", `location.directory=${dir}`], JSON.stringify(payload));
  if (result.exitCode !== 0) throw new Error(result.stderr || "oauth.complete failed");
}

export async function oauthCancel(integrationID: string, attemptID: string, directory?: string): Promise<void> {
  assertValidId(integrationID, "integrationID");
  assertValidAttemptId(attemptID);
  const dir = directoryParam(directory);
  const result = await runApi("integration.oauth.cancel", ["--param", `integrationID=${integrationID}`, "--param", `attemptID=${attemptID}`, "--param", `location.directory=${dir}`]);
  if (result.exitCode !== 0) throw new Error(result.stderr || "oauth.cancel failed");
}

export async function wellknownAdd(url: string, directory?: string): Promise<void> {
  if (typeof url !== "string" || !url.startsWith("http")) throw new Error("Invalid url");
  const dir = directoryParam(directory);
  const result = await runApi("integration.wellknown.add", ["--param", `location.directory=${dir}`], JSON.stringify({ url }));
  if (result.exitCode !== 0) throw new Error(result.stderr || "wellknown.add failed");
}

/* V2 custom provider via plural `providers` in opencode.json */

export interface V2ProviderEntity {
  package?: string;
  settings?: Record<string, unknown>;
  models?: Record<string, unknown>;
  name?: string;
  [key: string]: unknown;
}

function translateV1ToV2(entry: Record<string, unknown>): V2ProviderEntity {
  const out: V2ProviderEntity = {};
  if (typeof entry.name === "string") out.name = entry.name;
  if (typeof entry.npm === "string") out.package = entry.npm;
  else if (typeof entry.package === "string") out.package = entry.package;
  const opts = entry.options as Record<string, unknown> | undefined;
  const settings = entry.settings as Record<string, unknown> | undefined;
  const srcSettings = opts ?? settings;
  if (isRecord(srcSettings)) {
    const s: Record<string, unknown> = { ...srcSettings };
    delete s.apiKey;
    if (Object.keys(s).length > 0) out.settings = s;
  }
  if (out.package === "@ai-sdk/openai-compatible") out.package = "@opencode/ai/providers/openai-compatible";
  if (out.package === "@ai-sdk/openai") out.package = "@opencode/ai/providers/openai";
  if (out.package === "@ai-sdk/anthropic") out.package = "@opencode/ai/providers/anthropic";
  if (out.package === "@ai-sdk/google") out.package = "@opencode/ai/providers/google";
  if (isRecord(entry.models)) out.models = entry.models as Record<string, unknown>;
  return out;
}

export async function upsertV2Provider(name: string, entry: Record<string, unknown>): Promise<void> {
  assertValidId(name, "providerName");
  const v2Entry = translateV1ToV2(entry);
  const b64 = Buffer.from(JSON.stringify(v2Entry)).toString("base64");
  if (!/^[A-Za-z0-9+/=]+$/.test(b64)) throw new Error("Invalid base64");
  const nameQ = shellQuote(name);
  const b64Q = shellQuote(b64);
  const configQ = shellQuote(V2_CONFIG_PATH);
  const cmd = `umask 077 && TMP_VAL=$(mktemp -t v2val.XXXXXX) && TMP_NEW=$(mktemp -t v2new.XXXXXX) && trap 'rm -f "$TMP_VAL" "$TMP_NEW"' EXIT && B64=${b64Q} && printf '%s' "$B64" | base64 -d > "$TMP_VAL" && jq --arg name ${nameQ} --slurpfile val "$TMP_VAL" '.providers[$name] = $val[0]' ${configQ} > "$TMP_NEW" && mv "$TMP_NEW" ${configQ} && rm -f "$TMP_VAL" "$TMP_NEW" && trap - EXIT && opencode reload`;
  const res = await _exec(cmd, 15_000);
  if (res.exitCode !== 0) throw new Error(res.stderr || "upsertV2Provider failed");
}

export async function deleteV2Provider(name: string): Promise<void> {
  assertValidId(name, "providerName");
  const nameQ = shellQuote(name);
  const configQ = shellQuote(V2_CONFIG_PATH);
  const cmd = `umask 077 && TMP_NEW=$(mktemp -t v2new.XXXXXX) && trap 'rm -f "$TMP_NEW"' EXIT && jq --arg name ${nameQ} 'del(.providers[$name])' ${configQ} > "$TMP_NEW" && mv "$TMP_NEW" ${configQ} && trap - EXIT && opencode reload`;
  const res = await _exec(cmd, 15_000);
  if (res.exitCode !== 0) throw new Error(res.stderr || "deleteV2Provider failed");
}

export async function listV2ProvidersRaw(): Promise<unknown> {
  const result = await runApi("provider.list", ["--param", `location.directory=${directoryParam()}`]);
  if (result.exitCode !== 0) throw new Error(result.stderr || "provider.list failed");
  return parseJsonGuarded(result.stdout);
}

export async function listV2ModelsRaw(): Promise<unknown> {
  const result = await runApi("model.list", ["--param", `location.directory=${directoryParam()}`]);
  if (result.exitCode !== 0) throw new Error(result.stderr || "model.list failed");
  return parseJsonGuarded(result.stdout);
}

export async function readV2ProviderEntries(): Promise<Record<string, unknown>> {
  const result = await _exec(`jq -c '.providers // {}' ${shellQuote(V2_CONFIG_PATH)}`, 5_000);
  if (result.exitCode !== 0) throw new Error("Could not read V2 provider configuration");
  const parsed = parseJsonGuarded(result.stdout);
  if (!isRecord(parsed)) throw new Error("Invalid V2 provider configuration");
  const entries: Record<string, unknown> = {};
  for (const [id, entry] of Object.entries(parsed)) {
    if (!isRecord(entry)) throw new Error("Invalid V2 provider entry");
    const settings = isRecord(entry.settings) ? { ...entry.settings } : {};
    delete settings.apiKey;
    const clean: Record<string, unknown> = { ...entry, settings, npm: entry.package, options: settings };
    delete clean.apiKey;
    entries[id] = clean;
  }
  return entries;
}
