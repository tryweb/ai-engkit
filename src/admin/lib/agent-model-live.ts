import { displayNameToKey, isRecord } from "./agent-model-config";
import { createAgentModelHistoryClient } from "./agent-model-history";
import {
  MANAGED_OPENCODE_DIR,
  type AgentModelsDeps,
  type ResolvedModel,
} from "./agent-model-types";

function buildManagedFetchScript(auth: string, endpoint: string): string {
  return `for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  for f in ${MANAGED_OPENCODE_DIR}/*.json; do
    [ -f "\$f" ] || continue
    pid=\$(jq -r '.pid' "\$f" 2>/dev/null)
    port=\$(jq -r '.port' "\$f" 2>/dev/null)
    [ -n "\$pid" ] && [ -n "\$port" ] || continue
    kill -0 "\$pid" 2>/dev/null || continue
    OUT=\$(curl -fsS -m 3 -H "Authorization: Basic ${auth}" "http://127.0.0.1:\${port}${endpoint}" 2>/dev/null) && { printf '%s' "\$OUT"; exit 0; }
  done
  sleep 1
done
exit 2`;
}

function buildAgentFetchScript(auth: string): string {
  return buildManagedFetchScript(auth, "/agent");
}

function buildV2AgentFetchScript(auth: string): string {
  return buildManagedFetchScript(auth, "/api/agent?location%5Bdirectory%5D=%2Fhome%2Fdevuser%2Fworkspace");
}

function buildV2ProviderFetchScript(auth: string): string {
  return buildManagedFetchScript(auth, "/api/provider");
}

function buildV2ModelFetchScript(auth: string): string {
  return buildManagedFetchScript(auth, "/api/model");
}

function parseV2SubagentNames(stdout: string): readonly string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray((parsed as Record<string, unknown>).data)) return null;
  const arr = (parsed as Record<string, unknown>).data as unknown[];
  const names: string[] = [];
  for (const entry of arr) {
    if (!isRecord(entry)) continue;
    const rawId = typeof entry.id === "string" ? entry.id : typeof entry.name === "string" ? entry.name : null;
    if (rawId === null || rawId.length === 0) continue;
    if (entry.mode !== "subagent") continue;
    names.push(rawId);
  }
  return names;
}

function parseV1SubagentNames(stdout: string): readonly string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const names = (parsed as unknown[])
    .filter((agent): agent is Record<string, unknown> => isRecord(agent))
    .filter((agent) => typeof agent.name === "string" && (agent.name as string).length > 0 && agent.mode === "subagent")
    .map((agent) => agent.name as string)
    .filter((name): name is string => typeof name === "string");
  return names;
}

export type VerificationModelRef = {
  readonly providerID: string;
  readonly modelID: string;
  readonly variant?: string;
};

export function buildRequestVerificationScript(auth: string, agent: string, model?: VerificationModelRef): string {
  const agentBase64 = Buffer.from(agent).toString("base64");
  const providerBase64 = model ? Buffer.from(model.providerID).toString("base64") : "";
  const modelBase64 = model ? Buffer.from(model.modelID).toString("base64") : "";
  const variantBase64 = model?.variant ? Buffer.from(model.variant).toString("base64") : "";
  if (process.env.OMO_ENABLED === "0") {
    return `for f in ${MANAGED_OPENCODE_DIR}/*.json; do
  [ -f "\$f" ] || continue
  pid=\$(jq -r '.pid' "\$f" 2>/dev/null)
  port=\$(jq -r '.port' "\$f" 2>/dev/null)
  [ -n "\$pid" ] && [ -n "\$port" ] || continue
  kill -0 "\$pid" 2>/dev/null || continue
  BASE="http://127.0.0.1:\${port}"
  AGENT=\$(printf '%s' '${agentBase64}' | base64 -d)
  if [ -n '${providerBase64}' ] && [ -n '${modelBase64}' ]; then
    MODEL_JSON=\$(jq -nc --arg p "\$(printf '%s' '${providerBase64}' | base64 -d)" --arg m "\$(printf '%s' '${modelBase64}' | base64 -d)" --arg v "\$(printf '%s' '${variantBase64}' | base64 -d)" '{providerID:\$p,id:\$m} + (if \$v == "" then {} else {variant:\$v} end)')
  else
    MODEL_JSON=null
  fi
  SESSION=\$(jq -nc --arg agent "\$AGENT" --arg dir "/home/devuser/workspace" --argjson model "\$MODEL_JSON" '{agent:\$agent,location:{directory:\$dir}} + (if \$model == null then {} else {model:\$model} end)' | curl -fsS -m 5 -H "Authorization: Basic ${auth}" -H 'Content-Type: application/json' -X POST "\$BASE/api/session" -d @- 2>/dev/null | jq -r '.data.id // .id // empty')
  [ -n "\$SESSION" ] || exit 2
  curl -fsS -m 10 -H "Authorization: Basic ${auth}" -H 'Content-Type: application/json' -X POST "\$BASE/api/session/\${SESSION}/prompt" -d "\$(jq -nc --arg agent "\$AGENT" '{agent:\$agent,text:"Reply with exactly OK."}')" >/dev/null 2>&1 || true
  curl -fsS -m 45 -H "Authorization: Basic ${auth}" -X POST "\$BASE/api/experimental/session/\${SESSION}/wait" >/dev/null 2>&1 || true
  MSG=\$(curl -fsS -m 10 -H "Authorization: Basic ${auth}" "\$BASE/api/session/\${SESSION}/message" 2>/dev/null || true)
  OUT=\$(printf '%s' "\$MSG" | jq -c --arg agent "\$AGENT" '[.data[]? | select(.type=="assistant" and .agent==\$agent and (.error==null) and (.model.id | type=="string") and (.model.providerID | type=="string"))] | last | if .==null then empty else {info:{role:"assistant",modelID:.model.id,providerID:.model.providerID}} end' 2>/dev/null || true)
  curl -fsS -m 5 -H "Authorization: Basic ${auth}" -X DELETE "\$BASE/api/session/\${SESSION}" >/dev/null 2>&1 || true
  printf '%s' "\$OUT"
  exit 0
done
exit 2`;
  }
  return `for f in ${MANAGED_OPENCODE_DIR}/*.json; do
  [ -f "\$f" ] || continue
  pid=\$(jq -r '.pid' "\$f" 2>/dev/null)
  port=\$(jq -r '.port' "\$f" 2>/dev/null)
  [ -n "\$pid" ] && [ -n "\$port" ] || continue
  kill -0 "\$pid" 2>/dev/null || continue
  BASE="http://127.0.0.1:\${port}"
  AGENT=\$(printf '%s' '${agentBase64}' | base64 -d)
  SESSION=\$(jq -nc --arg agent "\$AGENT" '{agent:\$agent,title:"agent model verification"}' | curl -fsS -m 5 -H "Authorization: Basic ${auth}" -H 'Content-Type: application/json' -X POST "\$BASE/session" -d @- 2>/dev/null | jq -r '.id // empty')
  [ -n "\$SESSION" ] || exit 2
  OUT=\$(curl -fsS -m 45 -H "Authorization: Basic ${auth}" -H 'Content-Type: application/json' -X POST "\$BASE/session/\${SESSION}/message" -d "\$(jq -nc --arg agent \"\$AGENT\" '{agent:\$agent,parts:[{type:\"text\",text:\"Reply with exactly OK.\"}]}')" 2>/dev/null || true)
  curl -fsS -m 5 -H "Authorization: Basic ${auth}" -X DELETE "\$BASE/session/\${SESSION}" >/dev/null 2>&1 || true
  printf '%s' "\$OUT"
  exit 0
done
exit 2`;
}

function buildRecentRequestScript(auth: string, agent: string): string {
  const agentBase64 = Buffer.from(agent).toString("base64");
  if (process.env.OMO_ENABLED === "0") {
    return `for f in ${MANAGED_OPENCODE_DIR}/*.json; do
  [ -f "\$f" ] || continue
  pid=\$(jq -r '.pid' "\$f" 2>/dev/null)
  port=\$(jq -r '.port' "\$f" 2>/dev/null)
  [ -n "\$pid" ] && [ -n "\$port" ] || continue
  kill -0 "\$pid" 2>/dev/null || continue
  BASE="http://127.0.0.1:\${port}"
  AGENT=\$(printf '%s' '${agentBase64}' | base64 -d)
  SESSIONS=\$(curl -fsS -m 10 -H "Authorization: Basic ${auth}" "\$BASE/api/session?limit=100&location%5Bdirectory%5D=%2Fhome%2Fdevuser%2Fworkspace" 2>/dev/null || true)
  for SESSION in \$(printf '%s' "\$SESSIONS" | jq -r '(.data // .)[] | .id' 2>/dev/null); do
    OUT=\$(curl -fsS -m 10 -H "Authorization: Basic ${auth}" "\$BASE/api/session/\${SESSION}/message" 2>/dev/null || true)
    MODEL=\$(printf '%s' "\$OUT" | jq -c --arg agent "\$AGENT" '[.data[]? | select(.type=="assistant" and .agent==\$agent and (.error==null) and (.model.id | type=="string") and (.model.providerID | type=="string")) | {info:{role:"assistant",modelID:.model.id,providerID:.model.providerID}}] | last // empty' 2>/dev/null || true)
    [ -n "\$MODEL" ] && { printf '%s' "\$MODEL"; exit 0; }
  done
  exit 2
done
exit 2`;
  }
  return `for f in ${MANAGED_OPENCODE_DIR}/*.json; do
  [ -f "\$f" ] || continue
  pid=\$(jq -r '.pid' "\$f" 2>/dev/null)
  port=\$(jq -r '.port' "\$f" 2>/dev/null)
  [ -n "\$pid" ] && [ -n "\$port" ] || continue
  kill -0 "\$pid" 2>/dev/null || continue
  BASE="http://127.0.0.1:\${port}"
  AGENT=\$(printf '%s' '${agentBase64}' | base64 -d)
  SESSIONS=\$(curl -fsS -m 10 -H "Authorization: Basic ${auth}" "\$BASE/session?limit=100" 2>/dev/null || true)
  for SESSION in \$(printf '%s' "\$SESSIONS" | jq -r --arg agent "\$AGENT" '.[] | select(.agent == $agent) | .id' 2>/dev/null); do
    OUT=\$(curl -fsS -m 10 -H "Authorization: Basic ${auth}" "\$BASE/session/\${SESSION}/message" 2>/dev/null || true)
    MODEL=\$(printf '%s' "\$OUT" | jq -c '[.[] | .info | select(.role == "assistant" and (.error == null) and (.modelID | type == "string") and (.providerID | type == "string"))] | last | if . == null then empty else {info: {role,modelID,providerID}} end' 2>/dev/null || true)
    [ -n "\$MODEL" ] && { printf '%s' "\$MODEL"; exit 0; }
  done
  exit 2
done
exit 2`;
}

function parseV2Providers(stdout: string): readonly string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray((parsed as Record<string, unknown>).data)) return null;
  const arr = (parsed as Record<string, unknown>).data as unknown[];
  const ids: string[] = [];
  for (const entry of arr) {
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0) continue;
    ids.push(entry.id);
  }
  return ids;
}

function parseV2ModelCatalog(stdout: string): readonly string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray((parsed as Record<string, unknown>).data)) return null;
  const arr = (parsed as Record<string, unknown>).data as unknown[];
  const catalog = new Set<string>();
  for (const entry of arr) {
    if (!isRecord(entry)) continue;
    if (typeof entry.id !== "string" || entry.id.length === 0) continue;
    if (typeof entry.providerID !== "string" || entry.providerID.length === 0) continue;
    // Filter to active enabled models (V2 split semantics per SHIM-SPEC §5 M3)
    if (entry.enabled === false) continue;
    if (typeof entry.status === "string" && entry.status !== "active") continue;
    catalog.add(`${entry.providerID}/${entry.id}`);
  }
  return [...catalog].sort();
}

function parseProviderSnapshot(stdout: string): { readonly connectedProviders: readonly string[]; readonly catalog: readonly string[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.connected) || !Array.isArray(parsed.all)) return null;

  const connectedProviders = parsed.connected.filter((provider): provider is string => typeof provider === "string");
  const connected = new Set(connectedProviders);
  const catalog = new Set<string>();
  for (const provider of parsed.all) {
    if (!isRecord(provider) || typeof provider.id !== "string" || !connected.has(provider.id)) continue;
    if (!isRecord(provider.models)) continue;
    for (const model of Object.keys(provider.models)) catalog.add(`${provider.id}/${model}`);
  }
  return { connectedProviders, catalog: [...catalog].sort() };
}

function parseSuccessfulRequestModel(stdout: string): ResolvedModel | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }

  function extract(value: unknown): ResolvedModel | null {
    if (!isRecord(value)) return null;
    if (isRecord(value.info)) {
      const info = value.info;
      if (info.role === "assistant" && typeof info.modelID === "string" && typeof info.providerID === "string" && (info.error === undefined || info.error === null)) {
        return { modelID: info.modelID, providerID: info.providerID };
      }
    }
    if (value.type !== "assistant" || !isRecord(value.model) || (value.error !== undefined && value.error !== null)) return null;
    if (typeof value.model.id !== "string" || typeof value.model.providerID !== "string") return null;
    return { modelID: value.model.id, providerID: value.model.providerID };
  }

  const data = isRecord(parsed) ? parsed.data : undefined;
  const candidates = Array.isArray(data) ? data : [data, parsed];
  let resolved: ResolvedModel | null = null;
  for (const candidate of candidates) {
    const current = extract(candidate);
    if (current !== null) resolved = current;
  }
  return resolved;
}

function parseConnectedProviders(stdout: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.connected)) return [];
  return parsed.connected.filter((provider): provider is string => typeof provider === "string");
}

function parseCachedCatalog(stdout: string, connectedProviders: readonly string[]): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];

  const connected = new Set(connectedProviders);
  const catalog = new Set<string>();
  for (const [provider, value] of Object.entries(parsed)) {
    if (!connected.has(provider)) continue;
    if (!isRecord(value) || !isRecord(value.models)) continue;
    for (const model of Object.keys(value.models)) catalog.add(`${provider}/${model}`);
  }
  return [...catalog].sort();
}

export function createAgentModelLiveClient(deps: Pick<AgentModelsDeps, "exec">) {
  const history = createAgentModelHistoryClient(deps);
  async function fetchResolvedAgentModels(password: string): Promise<Map<string, ResolvedModel> | null> {
    const auth = Buffer.from(`opencode:${password}`).toString("base64");
    const v2 = process.env.OMO_ENABLED === "0";
    const result = await deps.exec(v2 ? buildV2AgentFetchScript(auth) : buildAgentFetchScript(auth), 90_000);
    if (result.exitCode !== 0 || !result.stdout) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return null;
    }
    if (v2) {
      if (!isRecord(parsed) || !Array.isArray(parsed.data)) return null;
      const models = new Map<string, ResolvedModel>();
      for (const agent of parsed.data) {
        if (!isRecord(agent) || typeof agent.id !== "string" || !isRecord(agent.model)) continue;
        if (typeof agent.model.id !== "string" || typeof agent.model.providerID !== "string") continue;
        models.set(agent.id, {
          modelID: agent.model.id,
          providerID: agent.model.providerID,
        });
      }
      if (models.size > 0) return models;
      for (let attempt = 1; attempt < 5; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const retryResult = await deps.exec(buildV2AgentFetchScript(auth), 90_000);
        if (retryResult.exitCode !== 0 || !retryResult.stdout) continue;
        let retryParsed: unknown;
        try {
          retryParsed = JSON.parse(retryResult.stdout);
        } catch {
          continue;
        }
        if (!isRecord(retryParsed) || !Array.isArray(retryParsed.data)) continue;
        const retryModels = new Map<string, ResolvedModel>();
        for (const agent of retryParsed.data) {
          if (!isRecord(agent) || typeof agent.id !== "string" || !isRecord(agent.model)) continue;
          if (typeof agent.model.id !== "string" || typeof agent.model.providerID !== "string") continue;
          retryModels.set(agent.id, {
            modelID: agent.model.id,
            providerID: agent.model.providerID,
          });
        }
        if (retryModels.size > 0) return retryModels;
      }
      return models;
    }
    if (!Array.isArray(parsed)) return null;

    const models = new Map<string, ResolvedModel>();
    for (const agent of parsed) {
      if (!isRecord(agent) || typeof agent.name !== "string" || !isRecord(agent.model)) continue;
      if (typeof agent.model.modelID !== "string" || typeof agent.model.providerID !== "string") continue;
      models.set(agent.name, {
        modelID: agent.model.modelID,
        providerID: agent.model.providerID,
      });
    }
    return models;
  }

  async function fetchSubagentNames(password: string): Promise<readonly string[]> {
    const auth = Buffer.from(`opencode:${password}`).toString("base64");
    const v2Result = await deps.exec(buildV2AgentFetchScript(auth), 90_000);
    if (v2Result.exitCode === 0 && v2Result.stdout) {
      const v2Names = parseV2SubagentNames(v2Result.stdout);
      if (v2Names !== null) return v2Names;
    }
    // REMOVE WHEN: Admin E2E passes against a V2 managed server (knownAgents
    // gate green via the V2 path alone). V1 fallback is transitional scaffolding,
    // not a compatibility promise — see trial/DECISIONS.md Doctrine.
    const result = await deps.exec(buildAgentFetchScript(auth), 90_000);
    if (result.exitCode !== 0 || !result.stdout) return [];
    const v1Names = parseV1SubagentNames(result.stdout);
    return v1Names ?? [];
  }

  async function resolveRuntimeAgentName(password: string, agent: string): Promise<string> {
    const resolvedMap = await fetchResolvedAgentModels(password);
    if (resolvedMap?.has(agent)) return agent;
    const displayName = [...(resolvedMap?.keys() ?? [])]
      .find((name) => displayNameToKey(name, new Set([agent])) === agent);
    return displayName ?? agent;
  }

  async function fetchConnectedCatalog(password: string | null): Promise<readonly string[]> {
    const snapshot = await fetchProviderSnapshot(password);
    return snapshot.catalog;
  }

  async function fetchProviderSnapshot(password: string | null): Promise<{
    readonly connectedProviders: readonly string[];
    readonly catalog: readonly string[];
    readonly source: "live" | "cache" | "unavailable";
  }> {
    if (password !== null) {
      const auth = Buffer.from(`opencode:${password}`).toString("base64");
      const v2ProviderResult = await deps.exec(buildV2ProviderFetchScript(auth), 90_000);
      const v2Providers = v2ProviderResult.exitCode === 0 ? parseV2Providers(v2ProviderResult.stdout) : null;
      if (v2Providers !== null) {
        const v2ModelResult = await deps.exec(buildV2ModelFetchScript(auth), 90_000);
        const v2Catalog = v2ModelResult.exitCode === 0 ? parseV2ModelCatalog(v2ModelResult.stdout) : null;
        if (v2Catalog !== null) {
          const providerSet = new Set(v2Providers);
          const filtered = v2Catalog.filter((entry) => providerSet.has(entry.split("/")[0] ?? ""));
          return { connectedProviders: v2Providers, catalog: filtered, source: "live" };
        }
      }
      if (v2ProviderResult.exitCode === 0) {
        const v1FromV2 = parseProviderSnapshot(v2ProviderResult.stdout);
        if (v1FromV2 !== null) return { ...v1FromV2, source: "live" };
      }
      // REMOVE WHEN: Admin catalog-409 gate green via V2 /api/provider + /api/model alone (verified live against OpenCode 2.0.15 ai-engkit-v2). V1 fallback is transitional scaffolding, not a compatibility promise — see trial/DECISIONS.md Doctrine.
      const liveResult = await deps.exec(buildManagedFetchScript(auth, "/provider"), 90_000);
      const liveSnapshot = liveResult.exitCode === 0 ? parseProviderSnapshot(liveResult.stdout) : null;
      if (liveSnapshot !== null) return { ...liveSnapshot, source: "live" };
    }

    const connectedResult = await deps.exec(
      `cat ~/.cache/oh-my-opencode/connected-providers.json 2>/dev/null`,
      10_000,
    );
    const connectedProviders = connectedResult.exitCode === 0
      ? parseConnectedProviders(connectedResult.stdout)
      : [];
    const cacheResult = await deps.exec(`cat ~/.cache/opencode/models.json 2>/dev/null`, 15_000);
    if (cacheResult.exitCode !== 0) return { connectedProviders: [], catalog: [], source: "unavailable" };
    return { connectedProviders, catalog: parseCachedCatalog(cacheResult.stdout, connectedProviders), source: "cache" };
  }

  async function fetchSuccessfulRequestModel(password: string, agent: string, model?: VerificationModelRef): Promise<ResolvedModel | null> {
    const auth = Buffer.from(`opencode:${password}`).toString("base64");
    const result = await deps.exec(buildRequestVerificationScript(auth, agent, model), 90_000);
    const parsed = result.exitCode === 0 ? parseSuccessfulRequestModel(result.stdout) : null;
    if (parsed !== null) return parsed;
    const runtimeAgent = await resolveRuntimeAgentName(password, agent);
    if (runtimeAgent === agent) return null;
    const retry = await deps.exec(buildRequestVerificationScript(auth, runtimeAgent, model), 90_000);
    return retry.exitCode === 0 ? parseSuccessfulRequestModel(retry.stdout) : null;
  }

  async function fetchRecentSuccessfulRequestModel(password: string, agent: string): Promise<ResolvedModel | null> {
    const auth = Buffer.from(`opencode:${password}`).toString("base64");
    const result = await deps.exec(buildRecentRequestScript(auth, agent), 90_000);
    const parsed = result.exitCode === 0 ? parseSuccessfulRequestModel(result.stdout) : null;
    if (parsed !== null) return parsed;
    const runtimeAgent = await resolveRuntimeAgentName(password, agent);
    if (runtimeAgent === agent) return null;
    const retry = await deps.exec(buildRecentRequestScript(auth, runtimeAgent), 90_000);
    return retry.exitCode === 0 ? parseSuccessfulRequestModel(retry.stdout) : null;
  }

  return {
    fetchConnectedCatalog,
    fetchProviderSnapshot,
    fetchRecentRequestModels: history.fetchRecentRequestModels,
    fetchRecentSuccessfulRequestModel,
    fetchSuccessfulRequestModel,
    fetchResolvedAgentModels,
    fetchSubagentNames,
  };
}
