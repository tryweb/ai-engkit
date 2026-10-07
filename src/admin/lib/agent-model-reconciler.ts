import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { displayNameToKey } from "./agent-model-config";
import { createAgentModelsLib, type AgentModelsLib } from "./agent-models";
import { fetchModelMetadata } from "./model-metadata";
import { readAgentModelPolicy } from "./agent-model-policy";
import { readPinnedAgents } from "./agent-model-pinned";
import { capabilityScore, compareReferences, suggestForMode, type PolicyCapabilityCatalog, type SuggestionMode } from "./agent-model-suggestion-policy";
import { profileForAgent } from "./agent-model-role-profiles";
import { parseModelReference, probeModel, pruneStaleProbeCacheForProvider, type ProbeResult } from "./model-probe";
import {
  CONFIGURABLE_NATIVE_AGENTS,
  MANAGED_OPENCODE_DIR,
  NATIVE12_AGENTS,
  type AgentModelsDeps,
  type AgentModelChange,
  type ApplyResult,
  type ChainEntry,
  type FallbackModelEntry,
  type ResolvedModel,
  type RoutingConfig,
  type VerificationMode,
} from "./agent-model-types";

// Maximum distinct provider/model probes permitted during one reconciliation.
const MAX_PROBES = 12;
// The lock directory is created atomically, so its existence is the lock state.
const LOCK_SUFFIX = ".cache/openchamber/agent-model-reconcile.lock";
let pending = false;
let active = false;

export type ReconcileSummary = {
  readonly changed: number;
  readonly applied: number;
  readonly failed: number;
  readonly agents: readonly string[];
  readonly results: readonly ReconcileAgentResult[];
};

export type ReconcileAgentResult = {
  readonly agent: string;
  readonly status: ApplyResult["status"];
  readonly error: string | null;
  readonly resolved: ResolvedModel | null;
};

type Capability = {
  readonly reasoning?: boolean;
  readonly toolcall?: boolean;
  readonly attachment?: boolean;
  readonly input?: Record<string, unknown>;
};

type CapabilityCatalog = ReadonlyMap<string, Capability>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameEntries(left: readonly FallbackModelEntry[], right: readonly FallbackModelEntry[]): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const other = right[index];
    return other?.model === entry.model && other?.variant === entry.variant;
  });
}

function resultForNoop(entries: readonly FallbackModelEntry[]): ApplyResult {
  const resolved = entries[0]?.model;
  if (resolved === undefined) return { ok: true, status: "cleared", resolved: null, requestVerified: null };
  const parsed = parseModelReference(resolved);
  return {
    ok: true,
    status: "verified",
    resolved: parsed === null ? null : { providerID: parsed.providerID, modelID: parsed.modelID },
    requestVerified: null,
  };
}

export function parseCapabilities(stdout: string): CapabilityCatalog {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return new Map(); }
  if (isRecord(parsed) && Array.isArray((parsed as Record<string, unknown>).data)) {
    const arr = (parsed as Record<string, unknown>).data as unknown[];
    const map = new Map<string, Capability>();
    for (const entry of arr) {
      if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.providerID !== "string") continue;
      const caps = isRecord(entry.capabilities) ? entry.capabilities : isRecord(entry.model) ? (entry.model as Record<string, unknown>) : null;
      const raw: Record<string, unknown> | null = caps !== null && isRecord(caps) ? (caps as Record<string, unknown>) : isRecord(entry) ? entry : null;
      if (raw === null) continue;
      const capsObj = isRecord(raw.capabilities) ? raw.capabilities as Record<string, unknown> : raw;
      const reasoning = typeof capsObj.reasoning === "boolean" ? capsObj.reasoning : undefined;
      const toolcall = typeof capsObj.tools === "boolean" ? capsObj.tools : typeof capsObj.toolcall === "boolean" ? capsObj.toolcall : typeof capsObj.toolCall === "boolean" ? capsObj.toolCall : undefined;
      const inputRaw = capsObj.input ?? (isRecord(entry.input) ? entry.input : undefined);
      const input = Array.isArray(inputRaw)
        ? Object.fromEntries(inputRaw.filter((value): value is string => typeof value === "string").map((value) => [value, true]))
        : isRecord(inputRaw) ? inputRaw : undefined;
      const attachment = typeof capsObj.attachment === "boolean" ? capsObj.attachment : input !== undefined ? input.image === true : undefined;
      if (reasoning === undefined && toolcall === undefined && attachment === undefined && input === undefined) {
        if (!isRecord(entry.capabilities) && !isRecord(capsObj)) continue;
      }
      const key = `${entry.providerID}/${entry.id}`;
      map.set(key, {
        reasoning,
        toolcall,
        attachment,
        ...(input === undefined ? {} : { input }),
      });
    }
    if (map.size > 0) return map;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.all)) return new Map();
  const capabilities = new Map<string, Capability>();
  for (const provider of parsed.all) {
    if (!isRecord(provider) || typeof provider.id !== "string" || !isRecord(provider.models)) continue;
    for (const [model, value] of Object.entries(provider.models)) {
      if (!isRecord(value) || !isRecord(value.capabilities)) continue;
      const raw = value.capabilities;
      const input = isRecord(raw.input) ? raw.input : undefined;
      capabilities.set(`${provider.id}/${model}`, {
        reasoning: typeof raw.reasoning === "boolean" ? raw.reasoning : undefined,
        toolcall: typeof raw.toolcall === "boolean" ? raw.toolcall : undefined,
        attachment: typeof raw.attachment === "boolean" ? raw.attachment : undefined,
        ...(input === undefined ? {} : { input }),
      });
    }
  }
  return capabilities;
}

export function parseV2Capabilities(stdout: string): CapabilityCatalog {
  return parseCapabilities(stdout);
}

export async function fetchCapabilityCatalog(deps: AgentModelsDeps, password: string): Promise<CapabilityCatalog> {
  const auth = Buffer.from(`opencode:${password}`).toString("base64");
  const managedDir = MANAGED_OPENCODE_DIR;
  const script = `for f in ${managedDir}/*.json; do
  [ -f "\$f" ] || continue
  pid=\$(jq -r '.pid' "\$f" 2>/dev/null); port=\$(jq -r '.port' "\$f" 2>/dev/null)
  [ -n "\$pid" ] && [ -n "\$port" ] || continue; kill -0 "\$pid" 2>/dev/null || continue
  curl -fsS -m 3 -H "Authorization: Basic ${auth}" "http://127.0.0.1:\${port}/api/model" 2>/dev/null && exit 0
  curl -fsS -m 3 -H "Authorization: Basic ${auth}" "http://127.0.0.1:\${port}/api/provider" 2>/dev/null && exit 0
  curl -fsS -m 3 -H "Authorization: Basic ${auth}" "http://127.0.0.1:\${port}/provider" 2>/dev/null && exit 0
done
exit 2`;
  const result = await deps.exec(script, 90_000);
  return result.exitCode === 0 ? parseCapabilities(result.stdout) : new Map();
}

function isProvenIneligible(
  agent: string,
  modelRef: string,
  metadata: ReadonlyMap<string, import("./model-metadata").NormalizedModelMetadata>,
  capabilities: CapabilityCatalog,
): boolean {
  const meta = metadata.get(modelRef);
  if (meta?.deprecated === true) return true;
  const profile = profileForAgent(agent);
  if (meta !== undefined) {
    if (meta.contextLimit !== null && meta.contextLimit < profile.minContext) return true;
    if (meta.outputLimit !== null && meta.outputLimit < profile.minOutput) return true;
    if (profile.requiredReasoning && meta.reasoning === false) return true;
    if (profile.requiredToolCall && meta.toolCall === false) return true;
  }
  if (profile.requiredAttachment) {
    const cap = capabilities.get(modelRef);
    if (cap?.attachment === false) return true;
  }
  return false;
}

export function createAgentModelReconciler(deps: AgentModelsDeps) {
  const lib: AgentModelsLib = createAgentModelsLib(deps);
  const lockPath = join(process.env.HOME ?? homedir(), LOCK_SUFFIX);
  const probes = new Map<string, ProbeResult>();
  let probeCount = 0;

  async function probe(ref: string): Promise<ProbeResult> {
    const cached = probes.get(ref);
    if (cached !== undefined) return cached;
    if (probeCount >= MAX_PROBES) return { status: "retryable", reason: "probe budget exhausted" };
    const parsed = parseModelReference(ref);
    if (parsed === null) return { status: "mismatch", reason: "invalid model reference" };
    probeCount += 1;
    const result = await probeModel(deps, parsed.providerID, parsed.modelID);
    probes.set(ref, result);
    return result;
  }

  function sortedCandidates(
    agent: string,
    catalog: readonly string[],
    capabilities: CapabilityCatalog,
    allowed: ReadonlySet<string> | null,
  ): readonly string[] {
    const filtered = catalog.filter((ref) => {
      const parsed = parseModelReference(ref);
      if (parsed === null) return false;
      if (allowed !== null && !allowed.has(parsed.providerID)) return false;
      return true;
    });
    // deduplicate while preserving first occurrence, then sort deterministically
    const distinct = [...new Set(filtered)];
    distinct.sort((left, right) => {
      const diff = capabilityScore(agent, capabilities.get(right)) - capabilityScore(agent, capabilities.get(left));
      if (diff !== 0) return diff;
      return compareReferences(left, right);
    });
    return distinct;
  }

  async function pickFirstHealthy(candidates: readonly string[]): Promise<string | null> {
    for (const ref of candidates) {
      const result = await probe(ref);
      if (result.status === "healthy") return ref;
      if (result.status === "retryable" && result.reason === "probe budget exhausted") return null;
    }
    return null;
  }

  function isV2(): boolean { return process.env.OMO_ENABLED === "0"; }

  async function namesAndResolved(
    password: string,
    config: Readonly<Record<string, { readonly models?: readonly FallbackModelEntry[] }>> | RoutingConfig,
  ): Promise<{ readonly names: readonly string[]; readonly resolved: ReadonlyMap<string, ResolvedModel> }> {
    const [names, resolvedMap] = await Promise.all([
      lib.fetchSubagentNames(password),
      lib.fetchResolvedAgentModels(password),
    ]);
    const keys = isV2() && (config as RoutingConfig).chains !== undefined
      ? Object.keys((config as RoutingConfig).chains)
      : Object.keys(config as Record<string, unknown>);
    const knownKeys = new Set(keys);
    const gatingAgents: readonly string[] = isV2() ? (NATIVE12_AGENTS as readonly string[]) : (CONFIGURABLE_NATIVE_AGENTS as readonly string[]);
    const configurable = new Set<string>();
    for (const name of names) {
      const key = displayNameToKey(name, knownKeys) ?? name.toLowerCase();
      if ((gatingAgents as readonly string[]).includes(key) || (!isV2() && knownKeys.has(key))) configurable.add(key);
    }
    if (isV2()) {
      for (const agent of NATIVE12_AGENTS) configurable.add(agent);
      for (const k of keys) if ((gatingAgents as readonly string[]).includes(k)) configurable.add(k);
    }
    const mapped = new Map<string, ResolvedModel>();
    for (const [name, model] of resolvedMap ?? []) {
      const key = displayNameToKey(name, knownKeys) ?? name.toLowerCase();
      if (!mapped.has(key)) mapped.set(key, model);
    }
    return { names: [...configurable].sort(), resolved: mapped };
  }

  async function runOnce(): Promise<ReconcileSummary> {
    const password = lib.getServerPassword();
    if (password === null) return { changed: 0, applied: 0, failed: 0, agents: [], results: [] };
    const v2 = isV2();
    const config = v2 && typeof (lib as unknown as { readRoutingConfig?: () => Promise<RoutingConfig> }).readRoutingConfig === "function"
      ? await (lib as unknown as { readRoutingConfig: () => Promise<RoutingConfig> }).readRoutingConfig()
      : await lib.readAgentModelsConfig();
    const [snapshot, state] = await Promise.all([
      lib.fetchProviderSnapshot(password),
      namesAndResolved(password, config as unknown as Record<string, { readonly models?: readonly FallbackModelEntry[] }>),
    ]);
    if (v2) {
      const policyMode = await readAgentModelPolicy(deps);
      const capabilities = await fetchCapabilityCatalog(deps, password);
      const metadata = await fetchModelMetadata();
      const connected = new Set(snapshot.connectedProviders);
      const catalogSet = new Set(snapshot.catalog);
      const policyCapabilities: PolicyCapabilityCatalog = new Map(
        [...capabilities.entries()].map(([k, v]) => [k, v as import("./agent-model-suggestion-policy").PolicyCapability]),
      );
      const output = suggestForMode({
        mode: policyMode,
        providers: [...snapshot.connectedProviders],
        catalog: [...snapshot.catalog],
        metadata: metadata.models,
        sourceStatus: metadata.sourceStatus,
        sourceAgeMs: metadata.sourceAgeMs,
        warnings: [...metadata.warnings],
        capabilities: policyCapabilities,
        agents: [...state.names],
      });
      const changed: AgentModelChange[] = [];
      const decisions: Array<Record<string, unknown>> = [];
      const pinnedAgents = await readPinnedAgents(deps);
      const getChain = (agent: string): readonly ChainEntry[] | readonly FallbackModelEntry[] => {
        return ((config as RoutingConfig).chains[agent]?.chain ?? []) as readonly ChainEntry[];
      };
      probes.clear();
      probeCount = 0;
      const shouldProbeFree = policyMode === "free" && metadata.sourceStatus === "fresh";
      async function findHealthyFree(agent: string, initialSuggestion: string | null): Promise<{ model: string | null; probeStatus: string | null }> {
        if (!shouldProbeFree || initialSuggestion === null) return { model: initialSuggestion, probeStatus: null };
        let remaining = [...snapshot.catalog];
        let current: string | null = initialSuggestion;
        let lastStatus: string | null = null;
        const tried = new Set<string>();
        while (current !== null && !tried.has(current)) {
          tried.add(current);
          if (probeCount >= MAX_PROBES) {
            lastStatus = "probe_budget_exhausted";
            break;
          }
          const res = await probe(current);
          lastStatus = res.status;
          if (res.status === "healthy") return { model: current, probeStatus: res.status };
          remaining = remaining.filter((c) => c !== current);
          if (remaining.length === 0) break;
          const nextOut = suggestForMode({
            mode: policyMode,
            providers: [...snapshot.connectedProviders],
            catalog: remaining,
            metadata: metadata.models,
            sourceStatus: metadata.sourceStatus,
            sourceAgeMs: metadata.sourceAgeMs,
            warnings: [...metadata.warnings],
            capabilities: policyCapabilities,
            agents: [agent],
          });
          current = nextOut.suggestions.get(agent)?.model ?? null;
        }
        return { model: null, probeStatus: lastStatus };
      }
      for (const agent of state.names) {
        const configured = getChain(agent) as readonly FallbackModelEntry[];
        const primary = configured[0];
        const resolved = state.resolved.get(agent);
        const resolvedRef = resolved === undefined ? null : `${resolved.providerID}/${resolved.modelID}`;
        const initialSuggestion = output.suggestions.get(agent)?.model ?? null;
        let desired: readonly FallbackModelEntry[] | null = null;
        let observedStatus = "policy";
        let probeStatus: string | null = null;
        if (primary !== undefined && pinnedAgents.has(agent)) {
          desired = configured as readonly FallbackModelEntry[];
          observedStatus = "pinned_manual";
        } else if (primary !== undefined) {
          const parsed = parseModelReference(primary.model);
          const inCatalog = catalogSet.has(primary.model);
          const connectedOk = parsed !== null && connected.has(parsed.providerID);
          const provenBad = isProvenIneligible(agent, primary.model, metadata.models, capabilities);
          const keep = inCatalog && connectedOk && !provenBad;
          if (keep) {
            desired = configured as readonly FallbackModelEntry[];
            observedStatus = "keep_valid_configured";
          } else if (initialSuggestion !== null) {
            if (shouldProbeFree) {
              const found = await findHealthyFree(agent, initialSuggestion);
              if (found.model !== null) {
                desired = [{ model: found.model }];
                probeStatus = found.probeStatus;
                observedStatus = !inCatalog ? "not_in_catalog" : !connectedOk ? "provider_not_connected" : "proven_ineligible";
              } else {
                desired = null;
                probeStatus = found.probeStatus;
                observedStatus = probeStatus === "probe_budget_exhausted" ? "probe_budget_exhausted" : "no_healthy_free_candidate";
              }
            } else {
              desired = [{ model: initialSuggestion }];
              observedStatus = !inCatalog ? "not_in_catalog" : !connectedOk ? "provider_not_connected" : provenBad ? "proven_ineligible" : "not_eligible";
            }
          } else {
            desired = null;
            observedStatus = "no_policy_suggestion";
          }
        } else {
          if (initialSuggestion !== null) {
            if (shouldProbeFree) {
              const found = await findHealthyFree(agent, initialSuggestion);
              if (found.model !== null) {
                desired = [{ model: found.model }];
                probeStatus = found.probeStatus;
                observedStatus = "configure_policy";
              } else {
                desired = null;
                probeStatus = found.probeStatus;
                observedStatus = probeStatus === "probe_budget_exhausted" ? "probe_budget_exhausted" : "no_healthy_free_candidate";
              }
            } else {
              desired = [{ model: initialSuggestion }];
              observedStatus = "configure_policy";
            }
          } else {
            desired = null;
            observedStatus = "no_policy_suggestion";
          }
        }
        const changedForAgent = desired !== null && !sameEntries(configured, desired);
        const decision = desired === null
          ? "no_usable_model"
          : changedForAgent
            ? primary === undefined ? "configure_candidate" : "replace_unusable_configured"
            : primary === undefined ? "keep_healthy_assigned" : "keep_healthy_configured";
        decisions.push({
          agent,
          configured: primary?.model ?? null,
          assigned: resolvedRef,
          probe: observedStatus,
          probeStatus,
          desired: desired?.[0]?.model ?? null,
          policyMode,
          sourceStatus: metadata.sourceStatus,
          changed: changedForAgent,
          decision,
        });
        if (changedForAgent && desired !== null) changed.push({ agent, entries: desired });
      }
      for (const decision of decisions) {
        console.error(`[agent-models] decision ${JSON.stringify(decision)}`);
      }
      let failed = 0;
      const results: ReconcileAgentResult[] = [];
      const batchResults = await lib.applyAndVerifyBatch(changed, "readiness");
      for (const { agent } of changed) {
        const result = batchResults.get(agent)
          ?? { ok: false, status: "write_failed" as const, error: "agent model batch returned no result" };
        if (!result.ok) failed += 1;
        results.push({
          agent,
          status: result.status,
          error: "error" in result ? result.error ?? null : null,
          resolved: "resolved" in result ? result.resolved ?? null : null,
        });
      }
      return {
        changed: changed.length,
        applied: changed.length - failed,
        failed,
        agents: changed.map(({ agent }) => agent),
        results,
      };
    }
    await Promise.all(snapshot.connectedProviders.map((providerID) => pruneStaleProbeCacheForProvider(deps, providerID)));
    const capabilities = await fetchCapabilityCatalog(deps, password);
    const connected = new Set(snapshot.connectedProviders);
    const changed: AgentModelChange[] = [];
    const decisions: Array<Record<string, unknown>> = [];
    const getChain = (agent: string): readonly ChainEntry[] | readonly FallbackModelEntry[] => {
      if (v2 && (config as RoutingConfig).chains !== undefined) return ((config as RoutingConfig).chains[agent]?.chain ?? []) as readonly ChainEntry[];
      return ((config as Record<string, { models?: readonly FallbackModelEntry[] }>)[agent]?.models ?? []);
    };
    for (const agent of state.names) {
      const configured = getChain(agent) as readonly FallbackModelEntry[];
      const primary = configured[0];
      const resolved = state.resolved.get(agent);
      const resolvedRef = resolved === undefined ? null : `${resolved.providerID}/${resolved.modelID}`;
      let observedStatus = "not_checked";
      let desired: readonly FallbackModelEntry[] | null = null;
      if (primary !== undefined) {
        const parsed = parseModelReference(primary.model);
        const status = parsed === null
          ? await probe(primary.model)
          : !connected.has(parsed.providerID) ? null : await probe(primary.model);
        observedStatus = status?.status ?? "not_checked";
        if (status?.status === "healthy" || (status !== null && !["unavailable", "retired", "wrong_endpoint"].includes(status.status))) {
          desired = [primary];
        } else {
          const candidates = sortedCandidates(agent, snapshot.catalog, capabilities, null);
          const selected = await pickFirstHealthy(candidates);
          if (selected !== null) desired = [{ model: selected }];
          else desired = null;
        }
      } else {
        if (resolved !== undefined && resolvedRef !== null && connected.has(resolved.providerID)) {
          const status = await probe(resolvedRef);
          observedStatus = status.status;
          if (status.status === "healthy" || !["unavailable", "retired", "wrong_endpoint"].includes(status.status)) {
            desired = [];
          }
        }
        if (desired === null) {
          const candidates = sortedCandidates(agent, snapshot.catalog, capabilities, null);
          const selected = await pickFirstHealthy(candidates);
          if (selected !== null) desired = [{ model: selected }];
          else desired = null;
        }
      }
      const changedForAgent = desired !== null && !sameEntries(configured, desired);
      const decision = desired === null
        ? "no_usable_model"
        : changedForAgent
          ? primary === undefined ? "configure_candidate" : "replace_unusable_configured"
          : primary === undefined ? "keep_healthy_assigned" : "keep_healthy_configured";
      decisions.push({
        agent,
        configured: primary?.model ?? null,
        assigned: resolvedRef,
        probe: observedStatus,
        desired: desired?.[0]?.model ?? null,
        changed: changedForAgent,
        decision,
      });
      if (changedForAgent && desired !== null) changed.push({ agent, entries: desired });
    }
    for (const decision of decisions) {
      console.error(`[agent-models] decision ${JSON.stringify(decision)}`);
    }
    let failed = 0;
    const results: ReconcileAgentResult[] = [];
    const batchResults = await lib.applyAndVerifyBatch(changed, "inference");
    for (const { agent } of changed) {
      const result = batchResults.get(agent)
        ?? { ok: false, status: "write_failed" as const, error: "agent model batch returned no result" };
      if (!result.ok) failed += 1;
      results.push({
        agent,
        status: result.status,
        error: "error" in result ? result.error ?? null : null,
        resolved: "resolved" in result ? result.resolved ?? null : null,
      });
    }
    return {
      changed: changed.length,
      applied: changed.length - failed,
      failed,
      agents: changed.map(({ agent }) => agent),
      results,
    };
  }

  async function suggestExplicit(
    mode: SuggestionMode,
    selectedProviders: readonly string[] | null,
    metadataOptions: { readonly fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>; readonly now?: () => number } = {},
  ): Promise<import("./agent-model-suggestion-policy").PolicyOutput> {
    const password = lib.getServerPassword();
    if (password === null) {
      return {
        mode,
        providers: selectedProviders === null ? [] : [...selectedProviders],
        sourceStatus: "unavailable" as const,
        sourceAgeMs: null,
        warnings: ["metadata_unavailable" as const],
        suggestions: new Map(),
      };
    }
    const [metadata, snapshot, state, capabilities] = await Promise.all([
      fetchModelMetadata(metadataOptions),
      lib.fetchProviderSnapshot(password),
      (async () => {
        const cfg = isV2() && typeof (lib as unknown as { readRoutingConfig?: () => Promise<RoutingConfig> }).readRoutingConfig === "function"
          ? await (lib as unknown as { readRoutingConfig: () => Promise<RoutingConfig> }).readRoutingConfig()
          : await lib.readAgentModelsConfig();
        return namesAndResolved(password, cfg as unknown as Record<string, { readonly models?: readonly FallbackModelEntry[] }>);
      })(),
      fetchCapabilityCatalog(deps, password),
    ]);
    const effectiveProviders: readonly string[] =
      selectedProviders === null || selectedProviders.length === 0
        ? [...snapshot.connectedProviders].sort()
        : [...selectedProviders].sort();
    // Narrow metadata to selected scope for freshness? Policy join filters by provider set already;
    // but we pass effective scope to policy and keep response providers as effective.
    const policyCapabilities: PolicyCapabilityCatalog = new Map(
      [...capabilities.entries()].map(([k, v]) => [k, v as import("./agent-model-suggestion-policy").PolicyCapability]),
    );
    const output = suggestForMode({
      mode,
      providers: selectedProviders === null || selectedProviders.length === 0 ? [] : [...selectedProviders],
      catalog: [...snapshot.catalog],
      metadata: metadata.models,
      sourceStatus: metadata.sourceStatus,
      sourceAgeMs: metadata.sourceAgeMs,
      warnings: [...metadata.warnings],
      capabilities: policyCapabilities,
      agents: [...state.names],
    });
    // Ensure explicit path never triggers probes: assert by not calling probe helpers.
    // Override providers to effective for response contract.
    return {
      ...output,
      providers: [...effectiveProviders],
    };
  }

  async function suggest(providers: readonly string[] | null = null): Promise<ReadonlyMap<string, readonly FallbackModelEntry[]>> {
    const password = lib.getServerPassword();
    if (password === null) return new Map();
    probes.clear();
    probeCount = 0;
    const config = isV2() && typeof (lib as unknown as { readRoutingConfig?: () => Promise<RoutingConfig> }).readRoutingConfig === "function"
      ? await (lib as unknown as { readRoutingConfig: () => Promise<RoutingConfig> }).readRoutingConfig()
      : await lib.readAgentModelsConfig();
    const [snapshot, state] = await Promise.all([
      lib.fetchProviderSnapshot(password),
      namesAndResolved(password, config as unknown as Record<string, { readonly models?: readonly FallbackModelEntry[] }>),
    ]);
    const allowed = providers === null ? null : new Set(providers);
    const capabilities = await fetchCapabilityCatalog(deps, password);
    const suggestions = new Map<string, readonly FallbackModelEntry[]>();
    for (const agent of state.names) {
      const candidates = sortedCandidates(agent, snapshot.catalog, capabilities, allowed);
      const selected = await pickFirstHealthy(candidates);
      if (selected !== null) {
        suggestions.set(agent, [{ model: selected }]);
      }
    }
    return suggestions;
  }

  async function withLock<T>(work: () => Promise<T>, fallback: T): Promise<T> {
    if (active) { pending = true; return fallback; }
    try {
      mkdirSync(dirname(lockPath), { recursive: true });
      mkdirSync(lockPath, { recursive: false });
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") { pending = true; return fallback; }
      throw error;
    }
    active = true;
    try { return await work(); } finally {
      active = false;
      rmSync(lockPath, { recursive: true, force: true });
    }
  }

  async function reconcileAll(): Promise<ReconcileSummary> {
    let summary: ReconcileSummary = { changed: 0, applied: 0, failed: 0, agents: [], results: [] };
    do {
      pending = false;
      probes.clear();
      probeCount = 0;
      let didRun = false;
      summary = await withLock(async () => { didRun = true; return runOnce(); }, summary);
      if (!didRun) return summary;
    } while (pending && !active);
    return summary;
  }

  async function applyAgent(agent: string, entries: readonly FallbackModelEntry[], verification: VerificationMode = "readiness"): Promise<ApplyResult> {
    return withLock(async () => {
      const v2 = isV2();
      if (v2 && typeof (lib as unknown as { readRoutingConfig?: () => Promise<RoutingConfig> }).readRoutingConfig === "function") {
        const routing = await (lib as unknown as { readRoutingConfig: () => Promise<RoutingConfig> }).readRoutingConfig();
        const current = (routing.chains[agent]?.chain ?? []) as readonly FallbackModelEntry[];
        return sameEntries(current, entries) ? resultForNoop(entries) : lib.applyAndVerify(agent, entries, verification);
      }
      const config = await lib.readAgentModelsConfig();
      const current = config[agent]?.models ?? [];
      return sameEntries(current, entries) ? resultForNoop(entries) : lib.applyAndVerify(agent, entries, verification);
    }, resultForNoop(entries));
  }

  return { reconcileAll, applyAgent, suggest, suggestExplicit };
}
