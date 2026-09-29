import { existsSync, readFileSync } from "node:fs";

export type ChainEntry = {
  model: string;
  variant?: string;
  reasoningEffort?: string;
  textVerbosity?: string;
  reasoningSummary?: string;
  temperature?: number;
  top_p?: number;
  maxTokens?: number;
  thinking?: { type: "enabled" | "disabled"; budgetTokens?: number };
};

export type AgentChain = {
  chain: ChainEntry[];
  cooldownSeconds?: number;
  maxFallbackAttempts?: number;
  notifyOnFallback?: boolean;
};

export type RoutingConfig = {
  version: number;
  defaults: {
    cooldownSeconds: number;
    maxFallbackAttempts: number;
    notifyOnFallback: boolean;
  };
  chains: Record<string, AgentChain>;
};

const MODEL_RE = /^[^\/\s]+\/\S+$/;
const VALID_VERSION = 1;

function normalizeAgentKey(k: string): string {
  return k.toLowerCase().trim();
}

export function parseRoutingConfig(raw: unknown): { config?: RoutingConfig; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { errors: ["chains must be an object", "invalid top-level"] };
  }
  const obj = raw as Record<string, unknown>;
  // unknown top-level keys ignored except version/defaults/chains/$schema
  if (obj["version"] !== VALID_VERSION) {
    return { errors: [`unsupported version: ${String(obj["version"])}`] };
  }
  if (obj["chains"] === undefined || obj["chains"] === null || typeof obj["chains"] !== "object" || Array.isArray(obj["chains"])) {
    return { errors: ["chains must be an object"] };
  }
  const defaultsRaw = (obj["defaults"] as Record<string, unknown>) || {};
  let cooldownSeconds = 60;
  let maxFallbackAttempts = 3;
  let notifyOnFallback = false;
  if (typeof defaultsRaw["cooldownSeconds"] === "number") {
    const v = defaultsRaw["cooldownSeconds"];
    if (Number.isInteger(v) && v >= 1 && v <= 3600) cooldownSeconds = v;
    else errors.push(`defaults.cooldownSeconds out of range, using default`);
  }
  if (typeof defaultsRaw["maxFallbackAttempts"] === "number") {
    const v = defaultsRaw["maxFallbackAttempts"];
    if (Number.isInteger(v) && v >= 1 && v <= 10) maxFallbackAttempts = v;
    else errors.push(`defaults.maxFallbackAttempts out of range, using default`);
  }
  if (typeof defaultsRaw["notifyOnFallback"] === "boolean") notifyOnFallback = defaultsRaw["notifyOnFallback"];

  const chainsIn = obj["chains"] as Record<string, unknown>;
  const chains: Record<string, AgentChain> = {};

  for (const [rawKey, rawVal] of Object.entries(chainsIn)) {
    const key = rawKey; // preserve verbatim for storage, but lookup uses normalized
    // warn on unknown agent keys but accept
    if (!(rawVal && typeof rawVal === "object" && !Array.isArray(rawVal))) {
      errors.push(`chains.${key}: must be object`);
      continue;
    }
    const ac = rawVal as Record<string, unknown>;
    const chainRaw = ac["chain"];
    if (!Array.isArray(chainRaw) || chainRaw.length < 1 || chainRaw.length > 10) {
      errors.push(`chains.${key}.chain must be array 1..10`);
      continue;
    }
    const chain: ChainEntry[] = [];
    for (let i = 0; i < chainRaw.length; i++) {
      const e = chainRaw[i] as Record<string, unknown>;
      if (!e || typeof e !== "object" || Array.isArray(e) || typeof e["model"] !== "string" || !MODEL_RE.test(e["model"])) {
        errors.push(`chains.${key}.chain[${i}].model invalid`);
        continue;
      }
      const entry: ChainEntry = { model: e["model"] };
      if (typeof e["variant"] === "string" && e["variant"].length > 0) entry.variant = e["variant"];
      if (typeof e["reasoningEffort"] === "string") entry.reasoningEffort = e["reasoningEffort"];
      if (typeof e["textVerbosity"] === "string") entry.textVerbosity = e["textVerbosity"];
      if (typeof e["reasoningSummary"] === "string") entry.reasoningSummary = e["reasoningSummary"];
      if (typeof e["temperature"] === "number" && e["temperature"] >= 0 && e["temperature"] <= 2) entry.temperature = e["temperature"];
      if (typeof e["top_p"] === "number" && e["top_p"] >= 0 && e["top_p"] <= 1) entry.top_p = e["top_p"];
      if (typeof e["maxTokens"] === "number" && Number.isInteger(e["maxTokens"]) && e["maxTokens"] >= 1 && e["maxTokens"] <= 200000) entry.maxTokens = e["maxTokens"];
      if (e["thinking"] && typeof e["thinking"] === "object" && !Array.isArray(e["thinking"])) {
        const th = e["thinking"] as Record<string, unknown>;
        if (th["type"] === "enabled" || th["type"] === "disabled") {
          entry.thinking = { type: th["type"] as "enabled" | "disabled", ...(typeof th["budgetTokens"] === "number" ? { budgetTokens: th["budgetTokens"] } : {}) };
        }
      }
      chain.push(entry);
    }
    if (chain.length === 0) {
      errors.push(`chains.${key}: chain empty after filtering invalid entries`);
      continue;
    }
    // duplicate detection warned but allowed
    const seen = new Set<string>();
    for (const c of chain) {
      if (seen.has(c.model)) errors.push(`chains.${key}: duplicate model ${c.model} warned`);
      seen.add(c.model);
    }
    const out: AgentChain = { chain };
    if (typeof ac["cooldownSeconds"] === "number" && Number.isInteger(ac["cooldownSeconds"]) && ac["cooldownSeconds"] >= 1 && ac["cooldownSeconds"] <= 3600) {
      out.cooldownSeconds = ac["cooldownSeconds"];
    } else if (ac["cooldownSeconds"] !== undefined) {
      errors.push(`chains.${key}.cooldownSeconds out of range, using default`);
    }
    if (typeof ac["maxFallbackAttempts"] === "number" && Number.isInteger(ac["maxFallbackAttempts"]) && ac["maxFallbackAttempts"] >= 1 && ac["maxFallbackAttempts"] <= 10) {
      out.maxFallbackAttempts = ac["maxFallbackAttempts"];
    } else if (ac["maxFallbackAttempts"] !== undefined) {
      errors.push(`chains.${key}.maxFallbackAttempts out of range, using default`);
    }
    if (typeof ac["notifyOnFallback"] === "boolean") out.notifyOnFallback = ac["notifyOnFallback"];
    chains[normalizeAgentKey(key)] = out;
    // also keep verbatim key if different for warning, but normalized is lookup key; preserve verbatim not needed as lookup is normalized
    // store under normalized; hyphenated preserved verbatim because lowercasing doesn't change hyphen
  }

  const config: RoutingConfig = {
    version: 1,
    defaults: { cooldownSeconds, maxFallbackAttempts, notifyOnFallback },
    chains,
  };
  return { config, errors };
}

export function loadRoutingConfigFromPaths(paths: string[]): { config?: RoutingConfig; errors: string[]; path?: string } {
  // per-project overrides global: last-wins merge
  let merged: RoutingConfig | undefined;
  let lastPath: string | undefined;
  const allErrors: string[] = [];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const rawText = readFileSync(p, "utf8");
      // JSONC: strip comments not needed for strict JSON, but allow // and /* */
      const stripped = rawText.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      const parsed = JSON.parse(stripped);
      const { config, errors } = parseRoutingConfig(parsed);
      allErrors.push(...errors.map((e) => `${p}: ${e}`));
      if (config) {
        if (!merged) merged = config;
        else {
          // merge: per-project overrides global last-wins for chains and defaults
          merged.defaults = { ...merged.defaults, ...config.defaults };
          merged.chains = { ...merged.chains, ...config.chains };
        }
        lastPath = p;
      }
    } catch (e) {
      allErrors.push(`${p}: JSON parse error ${(e as Error).message}`);
      // whole file rejected, routing disabled for that file but continue
    }
  }
  if (!merged) return { errors: allErrors };
  return { config: merged, errors: allErrors, path: lastPath };
}

export function getChain(config: RoutingConfig | undefined, agent: string): ChainEntry[] | undefined {
  if (!config) return undefined;
  const k = normalizeAgentKey(agent);
  return config.chains[k]?.chain;
}

export function getMaxFallbackAttempts(config: RoutingConfig | undefined, agent: string): number {
  if (!config) return 3;
  const k = normalizeAgentKey(agent);
  const ac = config.chains[k];
  if (ac?.maxFallbackAttempts !== undefined) return ac.maxFallbackAttempts;
  return config.defaults.maxFallbackAttempts ?? 3;
}

export function parseModelString(model: string): { providerID: string; modelID: string } | undefined {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash >= model.length - 1) return undefined;
  const providerID = model.slice(0, slash);
  const modelID = model.slice(slash + 1);
  if (/\s/.test(providerID) || /\s/.test(modelID)) return undefined;
  return { providerID, modelID };
}
