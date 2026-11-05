import {
  OMO_CONFIG,
  ROUTING_CONFIG,
  VARIANTS,
  type AgentModelConfig,
  type ChainEntry,
  type FallbackModelEntry,
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

export function parseRoutingChain(
  entries: unknown,
  allowClear = true,
): { readonly ok: true; readonly entries: readonly ChainEntry[] } | { readonly ok: false; readonly error: string } {
  if (!Array.isArray(entries)) return { ok: false, error: "chain must be an array of { model, variant? }" };
  if ((!allowClear && entries.length === 0) || entries.length > 10) {
    return { ok: false, error: allowClear ? "chain must contain at most 10 entries" : "configured chain must contain 1 to 10 entries" };
  }
  const parsed: ChainEntry[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) return { ok: false, error: "each chain entry must be an object" };
    if (typeof entry.model !== "string" || entry.model.trim().length === 0) {
      return { ok: false, error: "each entry must have a non-empty string model" };
    }
    if (!MODEL_REFERENCE_PATTERN.test(entry.model)) return { ok: false, error: "each model must use the provider/model format" };
    if (entry.variant !== undefined && !VARIANTS.some((variant) => variant === entry.variant)) {
      return { ok: false, error: `variant must be one of ${VARIANTS.join(", ")}` };
    }
    parsed.push({ model: entry.model, ...(typeof entry.variant === "string" ? { variant: entry.variant } : {}) });
  }
  return { ok: true, entries: parsed };
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

export function buildRoutingWriteCommand(agent: string, chain: readonly ChainEntry[]): string {
  const shellQuote = (value: string): string => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const routing = `"$HOME${ROUTING_CONFIG.slice(1)}"`;
  const update = '.version = (.version // 1) | .chains = (.chains // {}) | if ($chain | length) == 0 then del(.chains[$agent]) else .chains[$agent] = {chain: $chain} end';
  return `routing=${routing}; tmp=$(mktemp "${routing}.tmp.XXXXXX") || exit 1; if [ -f "$routing" ]; then jq --arg agent ${shellQuote(agent)} --argjson chain ${shellQuote(JSON.stringify(chain))} '${update}' "$routing" > "$tmp"; else printf '%s\\n' '{"version":1,"chains":{}}' | jq --arg agent ${shellQuote(agent)} --argjson chain ${shellQuote(JSON.stringify(chain))} '${update}' > "$tmp"; fi && chmod 600 "$tmp" && mv "$tmp" "$routing"; code=$?; if [ "$code" -ne 0 ]; then rm -f "$tmp"; fi; exit "$code"`;
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

export function parseRoutingConfig(stdout: string): Record<string, AgentModelConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return {};
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.chains)) return {};
  const config: Record<string, AgentModelConfig> = {};
  for (const [name, raw] of Object.entries(parsed.chains)) {
    if (!isRecord(raw)) {
      config[name] = { invalid: true };
      continue;
    }
    const chain = parseRoutingChain(raw.chain, false);
    if (!chain.ok) {
      config[name] = { invalid: true, models: [] };
      continue;
    }
    const models = chain.entries;
    config[name] = {
      ...(models[0] === undefined ? {} : { model: models[0].model, ...(models[0].variant ? { variant: models[0].variant } : {}) }),
      models,
      invalid: false,
    };
  }
  return config;
}
