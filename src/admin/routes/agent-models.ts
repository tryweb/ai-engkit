import { Hono } from "hono";
import {
  collectAgentModelState,
  createAgentModelsLib,
  validateFallbackModels,
  REAL_DEPS,
  type AgentModelsDeps,
  type AgentModelsLib,
  type ApplyResult,
} from "../lib/agent-models";
import { parseVerificationMode, type VerificationMode } from "../lib/agent-model-types";
import { createAgentModelReconciler } from "../lib/agent-model-reconciler";
import { listUnhealthyModels, parseModelReference, probeModel, type ProbeResult } from "../lib/model-probe";
import { AgentModelsPage } from "../views/agent-models";
import { validateAgentChain } from "../lib/agent-model-config";
import { readAgentModelPolicy, writeAgentModelPolicy } from "../lib/agent-model-policy";

function isV2(): boolean { return process.env.OMO_ENABLED === "0"; }
function normalizeChainEntries(raw: Record<string, unknown>): Array<{ model: string; variant?: string }> | null {
  const chain = (raw.chain ?? raw.entries) as unknown;
  if (!Array.isArray(chain)) return null;
  return chain as Array<{ model: string; variant?: string }>;
}

const AGENT_KEY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const ALLOWED_MODES = new Set(["free", "economy", "performance"] as const);
type SuggestionMode = "free" | "economy" | "performance";

function validateSuggestionBody(
  body: unknown,
): { readonly providers: readonly string[] | null; readonly mode?: SuggestionMode } | string {
  if (body === undefined || body === null) return { providers: null };
  if (typeof body !== "object" || Array.isArray(body)) return "Request body must be a JSON object";
  const record = body as Record<string, unknown>;
  const providersRaw = record.providers;
  let providers: readonly string[] | null = null;
  if (providersRaw !== undefined) {
    if (!Array.isArray(providersRaw) || providersRaw.some((provider) => typeof provider !== "string" || provider.trim().length === 0)) {
      return "providers must be an array of non-empty strings";
    }
    providers = [...new Set(providersRaw.map((provider) => provider.trim()))];
  }
  const modeRaw = record.mode;
  if (modeRaw !== undefined) {
    if (typeof modeRaw !== "string" || !ALLOWED_MODES.has(modeRaw as SuggestionMode)) {
      return "mode must be one of free, economy, performance";
    }
    return { providers, mode: modeRaw as SuggestionMode };
  }
  return { providers };
}

function validateBatchBody(body: unknown): { changes: Array<{ agent: string; entries: Array<{ model: string; variant?: string }> }>; verification: VerificationMode } | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "Request body must be a JSON object with changes array";
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.changes)) return "changes must be an array";
  const changes = record.changes as unknown[];
  for (const item of changes) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return "each change must be an object with agent and entries";
    const change = item as Record<string, unknown>;
    const agent = change.agent;
    if (typeof agent !== "string" || !AGENT_KEY_PATTERN.test(agent.trim())) return "each change requires a valid agent name";
    const entries = normalizeChainEntries(change);
    if (entries === null) return `agent ${agent}: entries must be an array of { model, variant? }`;
    if (isV2()) {
      if (entries.length !== 0) {
        const err = validateAgentChain(entries);
        if (err !== null) return `agent ${agent}: ${err}`;
      }
    } else {
      const error = validateFallbackModels({ entries });
      if (error !== null) return `agent ${agent}: ${error}`;
    }
  }
  if (record.verification !== undefined) {
    const verification = parseVerificationMode(record.verification);
    if (verification === null) return "verification must be \"readiness\" or \"inference\"";
    return { changes: (changes as Array<Record<string, unknown>>).map((c) => ({ agent: (c.agent as string).trim(), entries: normalizeChainEntries(c as Record<string, unknown>)! })), verification };
  }
  return { changes: (changes as Array<Record<string, unknown>>).map((c) => ({ agent: (c.agent as string).trim(), entries: normalizeChainEntries(c as Record<string, unknown>)! })), verification: "readiness" };
}

function parseSingleVerification(body: unknown): VerificationMode | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "readiness";
  const record = body as Record<string, unknown>;
  if (record.verification === undefined) return "readiness";
  const verification = parseVerificationMode(record.verification);
  if (verification === null) return "verification must be \"readiness\" or \"inference\"";
  return verification;
}

function probeFailureMessage(model: string, probe: ProbeResult): string {
  const reason = probe.reason ?? "unknown probe failure";
  if (probe.status === "retired") return `model ${model} has been retired (end of life): ${reason}`;
  if (probe.status === "wrong_endpoint") {
    const hint = /404\s*page\s*not\s*found/i.test(reason)
      ? model.startsWith("nvidia/")
        ? " Use the model's NVIDIA VLM or Biology endpoint instead of the LLM chat endpoint."
        : " The provider does not expose this model through the configured endpoint."
      : " The catalog entry is not deployed for this account's LLM endpoint.";
    return `model ${model} is not usable through this endpoint: ${reason}.${hint}`;
  }
  return `model ${model} is unavailable: ${reason}`;
}

const MAX_VERIFY_TARGETS = 12;
const VERIFY_TOTAL_DEADLINE_MS = 300_000;

function parseVerifyBody(body: unknown): { readonly agents: readonly string[] | null; readonly verification: VerificationMode } | string {
  if (body === null || body === undefined) return { agents: null, verification: "inference" };
  if (typeof body !== "object" || Array.isArray(body)) return "Request body must be a JSON object";
  const record = body as Record<string, unknown>;
  let agents: readonly string[] | null = null;
  if (record.agents !== undefined) {
    if (!Array.isArray(record.agents)) return "agents must be an array of valid agent names";
    const raw = record.agents as unknown[];
    if (raw.length === 0) {
      agents = null;
    } else {
      const cleaned: string[] = [];
      for (const entry of raw) {
        if (typeof entry !== "string" || entry.trim().length === 0 || !AGENT_KEY_PATTERN.test(entry.trim())) {
          return "agents must be an array of valid agent names";
        }
        cleaned.push(entry.trim());
      }
      agents = [...new Set(cleaned)];
    }
  }
  let verification: VerificationMode = "inference";
  if (record.verification !== undefined) {
    const parsed = parseVerificationMode(record.verification);
    if (parsed === null) return "verification must be \"readiness\" or \"inference\"";
    verification = parsed;
  }
  return { agents, verification };
}

export function createAgentModelsRoutes(deps: AgentModelsDeps): Hono {
  const lib = createAgentModelsLib(deps);
  const reconciler = createAgentModelReconciler(deps);
  const agentModels = new Hono();

  agentModels.get("/api/agent-models", async (c) => {
    const password = lib.getServerPassword();
    const state = await collectAgentModelState(lib, password);
    return c.json(state);
  });

  agentModels.post("/api/agent-models/suggestions", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = validateSuggestionBody(body);
    if (typeof parsed === "string") return c.json({ error: parsed }, 400);

    const password = lib.getServerPassword();
    if (password === null) return c.json({ error: "OPENCODE_SERVER_PASSWORD is not set in .env" }, 409);
    const state = await collectAgentModelState(lib, password);
    if (!state.catalogAvailable) return c.json({ error: "model catalog unavailable" }, 409);

    const connected = new Set(state.providers);
    const unknown = parsed.providers?.find((provider) => !connected.has(provider));
    if (unknown !== undefined) return c.json({ error: `provider ${unknown} is not connected` }, 400);
    const selected = parsed.providers === null || parsed.providers.length === 0
      || parsed.providers.length === state.providers.length
      ? null
      : parsed.providers;
    if (parsed.mode !== undefined) {
      const out = await reconciler.suggestExplicit(parsed.mode, selected);
      const suggestions: Record<string, { readonly model: string; readonly metadata: { readonly inputPrice: number | null; readonly outputPrice: number | null; readonly contextLimit: number | null; readonly outputLimit: number | null; readonly reasoning: boolean | null; readonly toolCall: boolean | null; readonly structuredOutput: boolean | null; readonly deprecated: boolean }; readonly reason: string; readonly heuristic: boolean }> = {};
      for (const [agent, entry] of out.suggestions) {
        suggestions[agent] = {
          model: entry.model,
          metadata: { ...entry.metadata },
          reason: entry.reason,
          heuristic: entry.heuristic,
        };
      }
      return c.json({
        mode: out.mode,
        providers: [...out.providers],
        sourceStatus: out.sourceStatus,
        sourceAgeMs: out.sourceAgeMs,
        warnings: [...out.warnings],
        suggestions,
      });
    }
    const suggestions = await reconciler.suggest(selected);
    const result: Record<string, readonly { readonly model: string; readonly variant?: string }[]> = {};
    for (const [agent, entries] of suggestions) result[agent] = entries;
    return c.json({ suggestions: result, providers: state.providers });
  });

  agentModels.get("/api/agent-models/policy", async (c) => {
    const mode = await readAgentModelPolicy(deps);
    return c.json({ mode });
  });

  agentModels.put("/api/agent-models/policy", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return c.json({ error: "Request body must be a JSON object" }, 400);
    }
    const mode = (body as Record<string, unknown>).mode;
    if (typeof mode !== "string" || !ALLOWED_MODES.has(mode as SuggestionMode)) {
      return c.json({ error: "mode must be one of free, economy, performance" }, 400);
    }
    const result = await writeAgentModelPolicy(deps, mode as SuggestionMode);
    if (!result.ok) return c.json({ error: result.error ?? "policy write failed" }, 500);
    return c.json({ mode });
  });

  // Batch endpoint: single restart for N changes
  agentModels.put("/api/agent-models", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = validateBatchBody(body);
    if (typeof parsed === "string") {
      return c.json({ error: parsed }, 400);
    }
    if (parsed.changes.length === 0) return c.json({ results: {} });

    const password = lib.getServerPassword();
    if (password === null) {
      return c.json(
        {
          error:
            "OPENCODE_SERVER_PASSWORD is not set in .env — live verification and restart-on-save are unavailable. Set it via the Environment page to enable applying agent models.",
        },
        409,
      );
    }

    const state = await collectAgentModelState(lib, password);
    const knownAgents = new Set(state.agents.map((entry) => entry.name));
    for (const change of parsed.changes) {
      const agent = change.agent.trim();
      if (!knownAgents.has(agent)) {
        return c.json({ error: `agent ${agent} is not a configurable live subagent` }, 403);
      }
    }
    if (!state.catalogAvailable && parsed.changes.some((change) => change.entries.length > 0)) {
      return c.json({ error: "model catalog unavailable" }, 409);
    }
    const catalog = new Set(state.catalog);
    for (const change of parsed.changes) {
      if (change.entries.some((entry) => !catalog.has(entry.model))) {
        return c.json({ error: `model ${change.entries.find((e) => !catalog.has(e.model))?.model} is not available in the current environment catalog` }, 400);
      }
    }

    if (parsed.verification === "inference" && !isV2()) {
      for (const change of parsed.changes) {
        for (const entry of change.entries) {
          const ref = parseModelReference(entry.model);
          if (ref === null) continue;
          const probe: ProbeResult = await probeModel(deps, ref.providerID, ref.modelID);
          if (probe.status === "retired" || probe.status === "wrong_endpoint" || probe.status === "unavailable") {
            return c.json({ error: probeFailureMessage(entry.model, probe) }, 400);
          }
        }
      }
    }

    // Single snapshot/write/restart for the whole batch
    const batchChanges = parsed.changes.map((change) => ({ agent: change.agent.trim(), entries: change.entries }));
    const results = await lib.applyAndVerifyBatch(batchChanges, parsed.verification);
    const resultsRecord: Record<string, ApplyResult> = {};
    for (const [agent, result] of results) {
      resultsRecord[agent] = result;
    }
    return c.json({ results: resultsRecord });
  });

  agentModels.put("/api/agent-models/:agent", async (c) => {
    const agent = c.req.param("agent").trim();
    if (!AGENT_KEY_PATTERN.test(agent)) {
      return c.json({ error: "invalid agent name" }, 400);
    }

    const body: unknown = await c.req.json().catch(() => null);
    const verificationRaw = parseSingleVerification(body);
    if (typeof verificationRaw === "string" && verificationRaw.startsWith("verification")) {
      return c.json({ error: verificationRaw }, 400);
    }
    const verification: VerificationMode = verificationRaw === "inference" ? "inference" : "readiness";
    if (body !== null && typeof body === "object" && !Array.isArray(body)) {
      const br = body as Record<string, unknown>;
      const ent = normalizeChainEntries(br);
      if (ent === null && br.entries !== undefined && br.chain !== undefined) {
        return c.json({ error: "entries must be an array of { model, variant? }" }, 400);
      }
      if (ent !== null) {
        if (isV2()) {
          if (ent.length !== 0) {
            const e = validateAgentChain(ent);
            if (e !== null) return c.json({ error: e }, 400);
          }
        } else {
          const error = validateFallbackModels({ entries: ent });
          if (error !== null) return c.json({ error }, 400);
        }
      } else {
        const error = validateFallbackModels(body);
        if (error !== null) return c.json({ error }, 400);
      }
    } else {
      const error = validateFallbackModels(body);
      if (error !== null) return c.json({ error }, 400);
    }

    const password = lib.getServerPassword();
    if (password === null) {
      return c.json(
        {
          error:
            "OPENCODE_SERVER_PASSWORD is not set in .env — live verification and restart-on-save are unavailable. Set it via the Environment page to enable applying agent models.",
        },
        409,
      );
    }

    const rawBody = body as Record<string, unknown>;
    const entries = (normalizeChainEntries(rawBody) ?? (rawBody.entries as Array<{ model: string; variant?: string }>) ?? []) as Array<{ model: string; variant?: string }>;
    const state = await collectAgentModelState(lib, password);
    if (!state.agents.some((entry) => entry.name === agent)) {
      return c.json({ error: "agent is not a configurable live subagent" }, 403);
    }
    if (!state.catalogAvailable && entries.length > 0) {
      return c.json({ error: "model catalog unavailable" }, 409);
    }
    const catalog = new Set(state.catalog);
    if (entries.some((entry) => !catalog.has(entry.model))) {
      return c.json({ error: "model is not available in the current environment catalog" }, 400);
    }

    if (verification === "inference" && !isV2()) {
      for (const entry of entries) {
        const ref = parseModelReference(entry.model);
        if (ref === null) continue;
        const probe: ProbeResult = await probeModel(deps, ref.providerID, ref.modelID);
        if (probe.status === "retired" || probe.status === "wrong_endpoint" || probe.status === "unavailable") {
          return c.json({ error: probeFailureMessage(entry.model, probe) }, 400);
        }
      }
    }

    const result = await reconciler.applyAgent(agent, entries, verification);
    return c.json(result);
  });

  agentModels.post("/api/agent-models/verify", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = parseVerifyBody(body);
    if (typeof parsed === "string") {
      return c.json({ error: parsed }, 400);
    }
    const { agents: requestedAgents, verification } = parsed;
    const password = lib.getServerPassword();
    if (password === null) return c.json({ error: "OPENCODE_SERVER_PASSWORD is not set in .env" }, 409);
    const state = await collectAgentModelState(lib, password);

    const configurableNames = new Set(state.agents.map((entry) => entry.name));
    const configuredByAgent = new Map<string, string | null>();
    for (const entry of state.agents) {
      const primary = entry.configured[0]?.model ?? null;
      configuredByAgent.set(entry.name, primary);
    }

    let targetAgents: readonly string[];
    if (requestedAgents === null || requestedAgents.length === 0) {
      targetAgents = state.agents.filter((entry) => (configuredByAgent.get(entry.name) ?? null) !== null).map((entry) => entry.name);
    } else {
      const unknown = requestedAgents.find((agent) => !configurableNames.has(agent));
      if (unknown !== undefined) {
        return c.json({ error: `agent ${unknown} is not a configurable live subagent` }, 400);
      }
      targetAgents = requestedAgents;
    }

    if (targetAgents.length === 0) {
      return c.json({ verification, results: {}, summary: { total: 0, healthy: 0, unconfigured: 0, failed: 0, verification } });
    }

    if (targetAgents.length > MAX_VERIFY_TARGETS) {
      return c.json({ error: `too many agents to verify: ${targetAgents.length} exceeds limit ${MAX_VERIFY_TARGETS}` }, 400);
    }

    const distinctModels = new Set<string>();
    for (const agent of targetAgents) {
      const model = configuredByAgent.get(agent) ?? null;
      if (model !== null) distinctModels.add(model);
    }
    if (distinctModels.size > MAX_VERIFY_TARGETS) {
      return c.json({ error: `too many distinct models to verify: ${distinctModels.size} exceeds limit ${MAX_VERIFY_TARGETS}` }, 400);
    }

    const probeCache = new Map<string, ProbeResult>();
    const deadlineAt = Date.now() + VERIFY_TOTAL_DEADLINE_MS;

    async function probeForModel(model: string): Promise<ProbeResult> {
      const cached = probeCache.get(model);
      if (cached !== undefined) return cached;
      const ref = parseModelReference(model);
      if (ref === null) {
        const result: ProbeResult = { status: "unavailable", reason: "invalid model reference" };
        probeCache.set(model, result);
        return result;
      }
      if (verification === "readiness") {
        const result: ProbeResult = { status: "healthy", reason: "readiness verification does not probe" };
        probeCache.set(model, result);
        return result;
      }
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        const result: ProbeResult = { status: "timeout", reason: "verification deadline exceeded" };
        probeCache.set(model, result);
        return result;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<ProbeResult>((resolve) => {
        timer = setTimeout(() => resolve({ status: "timeout", reason: "verification deadline exceeded" }), remainingMs);
      });
      let result: ProbeResult;
      try {
        result = await Promise.race([probeModel(deps, ref.providerID, ref.modelID), deadline]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      probeCache.set(model, result);
      return result;
    }

    const results: Record<string, { readonly model: string | null; readonly status: string; readonly reason?: string; readonly verification: VerificationMode }> = {};
    for (const agent of targetAgents) {
      const model = configuredByAgent.get(agent) ?? null;
      if (model === null) {
        results[agent] = { model: null, status: "unconfigured", reason: "agent has no configured primary model", verification };
        continue;
      }
      const probe = await probeForModel(model);
      results[agent] = { model, status: probe.status, ...(probe.reason !== undefined ? { reason: probe.reason } : {}), verification };
    }

    const summary = {
      total: targetAgents.length,
      healthy: Object.values(results).filter((entry) => entry.status === "healthy").length,
      unconfigured: Object.values(results).filter((entry) => entry.status === "unconfigured").length,
      failed: Object.values(results).filter((entry) => entry.status !== "healthy" && entry.status !== "unconfigured").length,
      verification,
    };

    return c.json({ verification, results, summary });
  });

  agentModels.get("/api/agent-models/unhealthy", async (c) => {
    const unhealthy = await listUnhealthyModels(deps);
    return c.json({ unhealthy: [...unhealthy] });
  });

  agentModels.get("/api/agent-models/verify-model", async (c) => {
    const modelRef = c.req.query("model");
    if (!modelRef) return c.json({ error: "model parameter required" }, 400);

    const ref = parseModelReference(modelRef);
    if (ref === null) return c.json({ error: "invalid model format — expected provider/model" }, 400);

    const probe = await probeModel(deps, ref.providerID, ref.modelID);
    return c.json({ model: modelRef, ...probe });
  });

  agentModels.get("/agent-models", async (c) => {
    const password = lib.getServerPassword();
    const state = await collectAgentModelState(lib, password);
    const unhealthy = await listUnhealthyModels(deps);
    const unhealthyReasons: Record<string, string> = {};
    for (const u of unhealthy) {
      if (u.reason) unhealthyReasons[u.model] = u.reason;
    }
    return c.html(AgentModelsPage({ ...state, unhealthyModels: unhealthy.map((u) => u.model), unhealthyReasons }));
  });

  return agentModels;
}

export const agentModelsRoutes = createAgentModelsRoutes(REAL_DEPS);

export default agentModelsRoutes;
