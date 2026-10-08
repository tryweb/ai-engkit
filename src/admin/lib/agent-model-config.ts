import {
  OMO_CONFIG,
  ROUTING_CONFIG,
  OPENCODE_JSON,
  VARIANTS,
  type AgentChain,
  type AgentModelConfig,
  type ChainEntry,
  type FallbackModelEntry,
  type RoutingConfig,
} from "./agent-model-types";

// Provider segment must be slash-free; the model segment may itself contain
// slashes (e.g. nvidia/<org>/<model> ids served by the live catalog).
const MODEL_REFERENCE_PATTERN = /^[^/\s]+\/\S+$/;
const VALID_AGENT_KEYS = new Set([
  "description",
  "prompt",
  "model",
  "models",
  "fallback_models",
  "reasoning",
  "variant",
  "reasoningEffort",
  "tools",
  "execution_mode",
  "background",
  "max_depth",
  "allowed_subagents",
  "disallowed_tools",
  "max_turns",
  "temperature",
  "disable",
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateFallbackModels(input: unknown): string | null {
  if (!isRecord(input)) return "Request body must be a JSON object";
  if (!Array.isArray(input.entries)) return "entries must be an array of { model, variant? }";
  if (input.entries.length > 1) return "at most one model entry is supported (entries[0] is the primary)";

  for (const entry of input.entries) {
    if (!isRecord(entry)) return "each entry must be an object";
    if (typeof entry.model !== "string" || entry.model.trim().length === 0) {
      return "each entry must have a non-empty string model";
    }
    if (!MODEL_REFERENCE_PATTERN.test(entry.model)) {
      return "each model must use the provider/model format";
    }
    if (entry.variant !== undefined && !VARIANTS.some((variant) => variant === entry.variant)) {
      return `variant must be one of ${VARIANTS.join(", ")}`;
    }
  }
  return null;
}

export function buildJqWriteCommand(agent: string, entries: readonly FallbackModelEntry[]): string {
  const shellQuote = (value: string): string => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const out = "/tmp/omo.jsonc.tmp";
  const [primary] = entries;
  if (primary === undefined) {
    return `jq --arg agent ${shellQuote(agent)} 'del(.agents[$agent].model, .agents[$agent].variant, .agents[$agent].models, .agents[$agent].fallback_models)' ${OMO_CONFIG} > ${out} && mv ${out} ${OMO_CONFIG}`;
  }
  const variantSet = primary.variant
    ? ` | .agents[$agent].variant = ${JSON.stringify(primary.variant)}`
    : " | del(.agents[$agent].variant)";
  return `jq --arg model ${shellQuote(primary.model)} --arg agent ${shellQuote(agent)} '.agents[$agent].model = $model${variantSet} | del(.agents[$agent].models, .agents[$agent].fallback_models)' ${OMO_CONFIG} > ${out} && mv ${out} ${OMO_CONFIG}`;
}

export function validateChainEntry(entry: unknown): string | null {
  if (!isRecord(entry)) return "each entry must be an object";
  if (typeof entry.model !== "string" || entry.model.trim().length === 0) return "each entry must have a non-empty string model";
  if (!MODEL_REFERENCE_PATTERN.test(entry.model)) return "each model must use the provider/model format";
  if (entry.variant !== undefined && typeof entry.variant !== "string") return "variant must be a string";
  if (entry.temperature !== undefined && (typeof entry.temperature !== "number" || entry.temperature < 0 || entry.temperature > 2)) return "temperature must be 0.0..2.0";
  if (entry.top_p !== undefined && (typeof entry.top_p !== "number" || entry.top_p < 0 || entry.top_p > 1)) return "top_p must be 0.0..1.0";
  if (entry.maxTokens !== undefined && (typeof entry.maxTokens !== "number" || !Number.isInteger(entry.maxTokens) || entry.maxTokens < 1 || entry.maxTokens > 200000)) return "maxTokens must be 1..200000";
  return null;
}

export function validateAgentChain(chain: unknown): string | null {
  if (!Array.isArray(chain)) return "chain must be an array";
  if (chain.length < 1 || chain.length > 10) return "chain must have 1..10 entries";
  for (const entry of chain) {
    const err = validateChainEntry(entry);
    if (err !== null) return err;
  }
  return null;
}

export function validateRoutingConfig(input: unknown): { readonly valid: boolean; readonly errors: readonly string[] } {
  if (!isRecord(input)) return { valid: false, errors: ["routing config must be an object"] };
  if (input.version !== 1) return { valid: false, errors: ["version must be 1"] };
  if (!isRecord(input.chains) && input.chains !== undefined) {
    if (typeof input.chains !== "object" || input.chains === null || Array.isArray(input.chains)) return { valid: false, errors: ["chains must be an object"] };
  }
  const chains = (input as Record<string, unknown>).chains;
  if (chains !== undefined && (typeof chains !== "object" || chains === null || Array.isArray(chains))) {
    return { valid: false, errors: ["chains must be an object"] };
  }
  const perAgentErrors: string[] = [];
  if (isRecord(chains)) {
    for (const [agent, value] of Object.entries(chains)) {
      if (!isRecord(value) || !Array.isArray((value as Record<string, unknown>).chain)) {
        perAgentErrors.push(`agent ${agent}: chain must be an array 1..10`);
        continue;
      }
      const chain = (value as Record<string, unknown>).chain as unknown[];
      if (chain.length < 1 || chain.length > 10) perAgentErrors.push(`agent ${agent}: chain must have 1..10 entries`);
      else {
        for (const entry of chain) {
          const e = validateChainEntry(entry);
          if (e !== null) perAgentErrors.push(`agent ${agent}: ${e}`);
        }
      }
    }
  }
  if (perAgentErrors.length > 0) return { valid: false, errors: perAgentErrors };
  return { valid: true, errors: [] };
}

export function buildRoutingWriteCommand(agent: string, chain: readonly ChainEntry[], routingPath: string = ROUTING_CONFIG, opencodePath: string = OPENCODE_JSON): string {
  const shellQuote = (value: string): string => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const routingTmp = "/tmp/routing.json.tmp";
  const opencodeTmp = "/tmp/opencode.json.tmp";
  // routing.json is absent on a fresh V2 volume: nothing seeds it, and the B1
  // plugin treats absence as "routing disabled" (see v2-plugin-bake.md). jq
  // exits 2 reading a missing input file, so every chain write failed with
  // "jq routing write failed" (startup reconcile: changed=12 applied=0
  // failed=12). Seed the empty shape so the first write creates it.
  const seedRouting = `[ -f ${routingPath} ] || printf '%s\\n' '{"version":1,"chains":{}}' > ${routingPath}`;
  if (chain.length === 0) {
    return `${seedRouting} && tmp_routing=$(mktemp "${routingTmp}.XXXXXX") && tmp_opencode=$(mktemp "${opencodeTmp}.XXXXXX") && jq --arg agent ${shellQuote(agent)} 'del(.chains[$agent])' ${routingPath} > "$tmp_routing" 2>/dev/null && chmod 600 "$tmp_routing" && mv "$tmp_routing" ${routingPath} && jq --arg agent ${shellQuote(agent)} 'del(.agent[$agent])' ${opencodePath} > "$tmp_opencode" 2>/dev/null && chmod 600 "$tmp_opencode" && mv "$tmp_opencode" ${opencodePath}`;
  }
  const chainJson = JSON.stringify(chain);
  const head = chain[0]!;
  const variantPart = head.variant ? ` | .agent[$agent].variant = $variant` : ` | del(.agent[$agent].variant)`;
  const variantArg = head.variant ? ` --arg variant ${shellQuote(head.variant)}` : "";
  return `${seedRouting} && tmp_routing=$(mktemp "${routingTmp}.XXXXXX") && tmp_opencode=$(mktemp "${opencodeTmp}.XXXXXX") && jq --arg agent ${shellQuote(agent)} --argjson chain ${shellQuote(chainJson)} '.chains[$agent].chain = $chain' ${routingPath} > "$tmp_routing" 2>/dev/null && chmod 600 "$tmp_routing" && mv "$tmp_routing" ${routingPath} && jq --arg agent ${shellQuote(agent)} --arg model ${shellQuote(head.model)}${variantArg} '.agent[$agent].model = $model${variantPart}' ${opencodePath} > "$tmp_opencode" 2>/dev/null && chmod 600 "$tmp_opencode" && mv "$tmp_opencode" ${opencodePath}`;
}

export function displayNameToKey(displayName: string, knownKeys: ReadonlySet<string>): string | null {
  const lower = displayName.toLowerCase().trim();
  if (knownKeys.has(lower)) return lower;
  const [prefix] = lower.split(" - ");
  const base = (prefix ?? lower).trim();
  const hyphenated = base.replace(/\s+/g, "-");
  if (knownKeys.has(base)) return base;
  if (knownKeys.has(hyphenated)) return hyphenated;
  return null;
}

function toConfiguredEntries(entry: Record<string, unknown>): readonly FallbackModelEntry[] {
  const chain: FallbackModelEntry[] = [];
  if (typeof entry.model === "string" && entry.model.trim().length > 0) {
    const variant = typeof entry.variant === "string" ? entry.variant : undefined;
    chain.push({ model: entry.model, ...(variant ? { variant } : {}) });
  }
  const fallback = Array.isArray(entry.fallback_models) ? entry.fallback_models : [];
  const models = Array.isArray(entry.models) ? entry.models : [];
  for (const model of [...fallback, ...models]) {
    if (typeof model === "string") {
      chain.push({ model });
    } else if (isRecord(model) && typeof model.model === "string" && model.model.trim().length > 0) {
      const variant = typeof model.variant === "string" ? model.variant : undefined;
      chain.push({ model: model.model, ...(variant ? { variant } : {}) });
    }
  }
  return chain;
}

export function parseAgentModelsConfig(stdout: string): Record<string, AgentModelConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};

  const config: Record<string, AgentModelConfig> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (!isRecord(value)) continue;
    config[name] = {
      model: typeof value.model === "string" ? value.model : undefined,
      variant: typeof value.variant === "string" ? value.variant : undefined,
      models: toConfiguredEntries(value),
      invalid: Object.keys(value).some((key) => !VALID_AGENT_KEYS.has(key)),
    };
  }
  return config;
}

export function parseRoutingConfig(stdout: string): RoutingConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { version: 1, chains: {} };
  }
  if (!isRecord(parsed)) return { version: 1, chains: {} };
  const version = parsed.version === 1 ? 1 : 1;
  const defaultsRaw = isRecord(parsed.defaults) ? parsed.defaults : {};
  const defaults: Record<string, unknown> = {};
  if (typeof defaultsRaw.cooldownSeconds === "number" && defaultsRaw.cooldownSeconds >= 1 && defaultsRaw.cooldownSeconds <= 3600) defaults.cooldownSeconds = defaultsRaw.cooldownSeconds;
  if (typeof defaultsRaw.maxFallbackAttempts === "number" && defaultsRaw.maxFallbackAttempts >= 1 && defaultsRaw.maxFallbackAttempts <= 10) defaults.maxFallbackAttempts = defaultsRaw.maxFallbackAttempts;
  if (typeof defaultsRaw.notifyOnFallback === "boolean") defaults.notifyOnFallback = defaultsRaw.notifyOnFallback;
  const chainsRaw = isRecord(parsed.chains) ? parsed.chains : {};
  const chains: Record<string, AgentChain> = {};
  for (const [agent, value] of Object.entries(chainsRaw)) {
    if (!isRecord(value) || !Array.isArray(value.chain)) continue;
    const rawChain = value.chain as unknown[];
    const validEntries: ChainEntry[] = [];
    for (const entry of rawChain) {
      if (!isRecord(entry) || typeof entry.model !== "string" || !MODEL_REFERENCE_PATTERN.test(entry.model)) continue;
      const ce: ChainEntry = { model: entry.model };
      if (typeof entry.variant === "string" && entry.variant.length > 0) (ce as { variant?: string }).variant = entry.variant;
      if (typeof entry.reasoningEffort === "string") (ce as { reasoningEffort?: string }).reasoningEffort = entry.reasoningEffort;
      if (typeof entry.textVerbosity === "string") (ce as { textVerbosity?: string }).textVerbosity = entry.textVerbosity;
      if (typeof entry.reasoningSummary === "string") (ce as { reasoningSummary?: string }).reasoningSummary = entry.reasoningSummary;
      if (typeof entry.temperature === "number" && entry.temperature >= 0 && entry.temperature <= 2) (ce as { temperature?: number }).temperature = entry.temperature;
      if (typeof entry.top_p === "number" && entry.top_p >= 0 && entry.top_p <= 1) (ce as { top_p?: number }).top_p = entry.top_p;
      if (typeof entry.maxTokens === "number" && Number.isInteger(entry.maxTokens) && entry.maxTokens >= 1 && entry.maxTokens <= 200000) (ce as { maxTokens?: number }).maxTokens = entry.maxTokens;
      if (isRecord(entry.thinking) && (entry.thinking.type === "enabled" || entry.thinking.type === "disabled")) {
        const t: { type: "enabled" | "disabled"; budgetTokens?: number } = { type: entry.thinking.type };
        if (typeof entry.thinking.budgetTokens === "number") t.budgetTokens = entry.thinking.budgetTokens;
        (ce as { thinking?: { type: "enabled" | "disabled"; budgetTokens?: number } }).thinking = t;
      }
      validEntries.push(ce);
    }
    if (validEntries.length < 1 || validEntries.length > 10) continue;
    const ac: AgentChain = { chain: validEntries };
    if (typeof value.cooldownSeconds === "number" && value.cooldownSeconds >= 1 && value.cooldownSeconds <= 3600) (ac as { cooldownSeconds?: number }).cooldownSeconds = value.cooldownSeconds;
    if (typeof value.maxFallbackAttempts === "number" && value.maxFallbackAttempts >= 1 && value.maxFallbackAttempts <= 10) (ac as { maxFallbackAttempts?: number }).maxFallbackAttempts = value.maxFallbackAttempts;
    if (typeof value.notifyOnFallback === "boolean") (ac as { notifyOnFallback?: boolean }).notifyOnFallback = value.notifyOnFallback;
    chains[agent] = ac;
  }
  return { version, ...(Object.keys(defaults).length ? { defaults } : {}), chains };
}
