import type { NormalizedModelMetadata, SourceStatus, WarningCode } from "./model-metadata";

// Reuse existing reconciler capability semantics (no duplicate incompatible rules).
export type SuggestionMode = "free" | "economy" | "performance";

export type PolicyCapability = {
  readonly reasoning?: boolean;
  readonly toolcall?: boolean;
  readonly attachment?: boolean;
  readonly input?: Record<string, unknown>;
};
export type PolicyCapabilityCatalog = ReadonlyMap<string, PolicyCapability>;

export type PolicyCandidate = {
  readonly reference: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly metadata: NormalizedModelMetadata;
  readonly capability: PolicyCapability | undefined;
  readonly capabilityScore: number;
  readonly effectiveCost: number;
};

export type SuggestionMetadata = {
  readonly inputPrice: number | null;
  readonly outputPrice: number | null;
  readonly contextLimit: number | null;
  readonly outputLimit: number | null;
  readonly reasoning: boolean | null;
  readonly toolCall: boolean | null;
  readonly structuredOutput: boolean | null;
  readonly deprecated: boolean;
};

export type AgentSuggestion = {
  readonly model: string;
  readonly metadata: SuggestionMetadata;
  readonly reason: string;
  readonly heuristic: boolean;
};

export type PolicyInput = {
  readonly mode: SuggestionMode;
  readonly providers: readonly string[];
  readonly catalog: readonly string[];
  readonly metadata: ReadonlyMap<string, NormalizedModelMetadata>;
  readonly sourceStatus: SourceStatus;
  readonly sourceAgeMs: number | null;
  readonly warnings: readonly WarningCode[];
  readonly capabilities: PolicyCapabilityCatalog;
  readonly agents: readonly string[];
};

export type PolicyOutput = {
  readonly mode: SuggestionMode;
  readonly providers: readonly string[];
  readonly sourceStatus: SourceStatus;
  readonly sourceAgeMs: number | null;
  readonly warnings: readonly WarningCode[];
  readonly suggestions: ReadonlyMap<string, AgentSuggestion>;
};

import {
  type RoleProfile,
  profileForAgent,
  roleForAgent,
} from "./agent-model-role-profiles";

export type { AgentRole } from "./agent-model-role-profiles";
export { profileForAgent, roleForAgent } from "./agent-model-role-profiles";
const REASON_MAX = 200;

function capReason(s: string): string {
  return s.length <= REASON_MAX ? s : `${s.slice(0, REASON_MAX - 1)}…`;
}

export function category(agent: string): "reasoning" | "exploration" | "general" {
  const role = roleForAgent(agent);
  if (role === "planning" || role === "deep-reasoning" || role === "review") return "reasoning";
  if (role === "exploration" || role === "research") return "exploration";
  return "general";
}

export function capabilityScore(agent: string, capability: PolicyCapability | undefined): number {
  if (capability === undefined) return 0;
  const inputCount = capability.input === undefined ? 0 : Object.keys(capability.input).length;
  switch (category(agent)) {
    case "reasoning":
      return (capability.reasoning === true ? 100 : 0) + (capability.toolcall === true ? 20 : 0) + inputCount;
    case "exploration":
      return (capability.toolcall === true ? 100 : 0) + (capability.reasoning === false ? 20 : 0) + (capability.attachment === true ? 10 : 0);
    case "general":
      return (capability.toolcall === true ? 100 : 0) + (capability.attachment === true ? 20 : 0) + (capability.reasoning === true ? 10 : 0);
    default:
      return 0;
  }
}

export function compareReferences(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function effectiveCost(m: NormalizedModelMetadata): number {
  if (m.inputPrice === null || m.outputPrice === null) return Infinity;
  return m.inputPrice * 0.6 + m.outputPrice * 0.4;
}

export function isContextInadequate(m: NormalizedModelMetadata): boolean {
  return m.contextLimit === null;
}

export function saturatedFit(
  value: number,
  min: number,
  preferred: number,
): number {
  if (min === preferred) return 1;
  const raw = (value - min) / (preferred - min);
  if (raw <= 0) return 0;
  if (raw >= 1) return 1;
  return raw;
}
function toSuggestionMetadata(m: NormalizedModelMetadata): SuggestionMetadata {
  return {
    inputPrice: m.inputPrice,
    outputPrice: m.outputPrice,
    contextLimit: m.contextLimit,
    outputLimit: m.outputLimit,
    reasoning: m.reasoning,
    toolCall: m.toolCall,
    structuredOutput: m.structuredOutput,
    deprecated: m.deprecated,
  };
}
function joinCandidates(
  catalog: readonly string[],
  metadata: ReadonlyMap<string, NormalizedModelMetadata>,
  providers: readonly string[],
  capabilities: PolicyCapabilityCatalog,
): PolicyCandidate[] {
  const providerSet = providers.length === 0 ? null : new Set(providers);
  const seen = new Set<string>();
  const candidates: PolicyCandidate[] = [];
  for (const ref of catalog) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    // provider scope filter
    const slash = ref.indexOf("/");
    if (slash === -1) continue;
    const providerId = ref.slice(0, slash);
    if (providerSet !== null && !providerSet.has(providerId)) continue;
    const meta = metadata.get(ref);
    if (meta === undefined) continue;
    // identity match already via ref; providerId/modelId consistency check
    if (meta.reference !== ref) continue;
    // Unmatched/deprecated handled in ranking filters, but keep here only joined
    const cap = capabilities.get(ref);
    // Use any agent placeholder for score? Score is per-agent, compute later per agent ranking, but store base?
    // Effective cost is mode-agnostic
    candidates.push({
      reference: ref,
      providerId,
      modelId: ref.slice(slash + 1),
      metadata: meta,
      capability: cap,
      capabilityScore: 0, // placeholder, computed per-agent
      effectiveCost: effectiveCost(meta),
    });
  }
  return candidates;
}

function isRoleEligible(
  profile: RoleProfile,
  candidate: PolicyCandidate,
): boolean {
  const m = candidate.metadata;
  if (m.deprecated) return false;
  if (m.contextLimit === null || m.outputLimit === null) return false;
  if (m.contextLimit < profile.minContext) return false;
  if (m.outputLimit < profile.minOutput) return false;
  if (profile.requiredReasoning && m.reasoning !== true) return false;
  if (profile.requiredToolCall && m.toolCall !== true) return false;
  if (profile.requiredAttachment && candidate.capability?.attachment !== true)
    return false;
  return true;
}
function filterFree(
  agent: string,
  candidates: readonly PolicyCandidate[],
  sourceStatus: SourceStatus,
): PolicyCandidate[] {
  if (sourceStatus !== "fresh") return [];
  const profile = profileForAgent(agent);
  return candidates.filter((c) => {
    // Zero-cost gate: inputPrice/outputPrice !== 0 already excludes null (null !== 0); keep role eligibility gates
    if (c.metadata.inputPrice !== 0 || c.metadata.outputPrice !== 0)
      return false;
    if (!isRoleEligible(profile, c)) return false;
    return true;
  });
}
function filterEconomyPerformance(
  agent: string,
  candidates: readonly PolicyCandidate[],
): PolicyCandidate[] {
  const profile = profileForAgent(agent);
  return candidates.filter((c) => isRoleEligible(profile, c));
}
type ScoredCandidate = PolicyCandidate & { readonly roleScore: number };
function computeRoleScores(
  profile: RoleProfile,
  candidates: readonly PolicyCandidate[],
): { scored: ScoredCandidate[]; heuristic: boolean } {
  if (candidates.length === 0) return { scored: [], heuristic: true };
  // Benchmark comparability: <2 values → omit benchmark weight and renormalize; performance is heuristic
  const benchValues = candidates
    .map((c) => c.metadata.benchmarkScore)
    .filter((v): v is number => v !== null);
  const comparable = benchValues.length >= 2;
  let minBench = 0;
  let maxBench = 0;
  if (comparable) {
    minBench = Math.min(...benchValues);
    maxBench = Math.max(...benchValues);
  }
  const scored: ScoredCandidate[] = candidates.map((c) => {
    const m = c.metadata;
    const cap = c.capability;
    const contextLimit = m.contextLimit;
    const outputLimit = m.outputLimit;
    if (contextLimit === null || outputLimit === null) {
      return { ...c, roleScore: 0 };
    }
    const contextFit = saturatedFit(
      contextLimit,
      profile.minContext,
      profile.prefContext,
    );
    const outputFit = saturatedFit(
      outputLimit,
      profile.minOutput,
      profile.prefOutput,
    );
    const reasoningScore = m.reasoning === true ? 1 : 0;
    const toolCallScore = m.toolCall === true ? 1 : 0;
    const attachmentScore = cap?.attachment === true ? 1 : 0;
    const structuredScore = m.structuredOutput === true ? 1 : 0;
    let benchmarkScore: number;
    if (!comparable) benchmarkScore = 0;
    else {
      const raw = m.benchmarkScore;
      if (raw === null) benchmarkScore = 0;
      else if (maxBench === minBench) benchmarkScore = 0.5;
      else benchmarkScore = (raw - minBench) / (maxBench - minBench);
    }
    const w = profile.weights;
    let sum = 0;
    let wsum = 0;
    const add = (weight: number, score: number): void => {
      if (weight === 0) return;
      sum += weight * score;
      wsum += weight;
    };
    if (comparable) add(w.benchmark, benchmarkScore);
    add(w.reasoning, reasoningScore);
    add(w.toolCall, toolCallScore);
    add(w.attachment, attachmentScore);
    add(w.structured, structuredScore);
    add(w.context, contextFit);
    add(w.output, outputFit);
    const roleScore = wsum === 0 ? 0 : sum / wsum;
    return { ...c, roleScore };
  });
  return { scored, heuristic: !comparable };
}
function sortEconomy(
  agent: string,
  candidates: PolicyCandidate[],
): { sorted: ScoredCandidate[]; heuristic: boolean } {
  const profile = profileForAgent(agent);
  const { scored } = computeRoleScores(profile, candidates);
  scored.sort((a, b) => {
    if (a.effectiveCost !== b.effectiveCost) {
      const aInf = !Number.isFinite(a.effectiveCost);
      const bInf = !Number.isFinite(b.effectiveCost);
      if (aInf && bInf) {
      } else if (aInf) return 1;
      else if (bInf) return -1;
      else return a.effectiveCost - b.effectiveCost;
    }
    if (a.roleScore !== b.roleScore) return b.roleScore - a.roleScore;
    return compareReferences(a.reference, b.reference);
  });
  return { sorted: scored, heuristic: false };
}
function sortPerformance(
  agent: string,
  candidates: PolicyCandidate[],
): { sorted: ScoredCandidate[]; heuristic: boolean } {
  const profile = profileForAgent(agent);
  const { scored, heuristic } = computeRoleScores(profile, candidates);
  scored.sort((a, b) => {
    if (a.roleScore !== b.roleScore) return b.roleScore - a.roleScore;
    return compareReferences(a.reference, b.reference);
  });
  return { sorted: scored, heuristic };
}
function decidingDimensions(
  profile: RoleProfile,
  heuristic: boolean,
): string[] {
  const w = profile.weights;
  const parts: string[] = [];
  if (w.benchmark > 0 && !heuristic) parts.push("benchmark");
  if (w.reasoning > 0) parts.push("reasoning");
  if (w.toolCall > 0) parts.push("toolCall");
  if (w.attachment > 0) parts.push("attachment");
  if (w.structured > 0) parts.push("structured");
  if (w.context > 0) parts.push("contextFit");
  if (w.output > 0) parts.push("outputFit");
  return parts;
}
function isHighRiskRole(role: string): boolean {
  return role === "review" || role === "deep-reasoning";
}

function tieGroup(
  sorted: readonly ScoredCandidate[],
  mode: SuggestionMode,
): ScoredCandidate[] {
  if (sorted.length === 0) return [];
  const top = sorted[0];
  if (top === undefined) return [];
  if (mode === "free") {
    return sorted.filter((c) => c.roleScore === top.roleScore);
  }
  if (mode === "economy") {
    return sorted.filter(
      (c) =>
        c.effectiveCost === top.effectiveCost && c.roleScore === top.roleScore,
    );
  }
  return sorted.filter((c) => c.roleScore === top.roleScore);
}

function selectDiverseWinner(
  sorted: readonly ScoredCandidate[],
  mode: SuggestionMode,
  profile: RoleProfile,
  codingModel: string | null,
  modelReuse: ReadonlyMap<string, number>,
  providerReuse: ReadonlyMap<string, number>,
): { winner: ScoredCandidate; diversified: boolean; crossReview: boolean } {
  if (sorted.length === 0) throw new Error("selectDiverseWinner: empty sorted");
  const group = tieGroup(sorted, mode);
  if (group.length <= 1) {
    const w = sorted[0];
    if (w === undefined) throw new Error("selectDiverseWinner: missing top");
    return { winner: w, diversified: false, crossReview: false };
  }
  const baselineRef = group[0]?.reference ?? sorted[0]?.reference ?? "";
  const candidates = [...group];
  const highRisk = isHighRiskRole(profile.role);
  const crossReviewActive = highRisk && codingModel !== null;
  candidates.sort((a, b) => {
    if (crossReviewActive && codingModel !== null) {
      const aDiff = a.reference !== codingModel ? 0 : 1;
      const bDiff = b.reference !== codingModel ? 0 : 1;
      if (aDiff !== bDiff) return aDiff - bDiff;
    }
    const aModelReuse = modelReuse.get(a.reference) ?? 0;
    const bModelReuse = modelReuse.get(b.reference) ?? 0;
    if (aModelReuse !== bModelReuse) return aModelReuse - bModelReuse;
    const aProvReuse = providerReuse.get(a.providerId) ?? 0;
    const bProvReuse = providerReuse.get(b.providerId) ?? 0;
    if (aProvReuse !== bProvReuse) return aProvReuse - bProvReuse;
    return compareReferences(a.reference, b.reference);
  });
  const winner = candidates[0];
  if (winner === undefined) throw new Error("selectDiverseWinner: missing winner");
  const diversified = winner.reference !== baselineRef;
  const crossReview =
    diversified &&
    crossReviewActive &&
    winner.reference !== codingModel &&
    group.some((c) => c.reference === codingModel);
  return { winner, diversified, crossReview };
}

function reasonFor(
  mode: SuggestionMode,
  profile: RoleProfile,
  candidate: ScoredCandidate,
  heuristic: boolean,
  diversityMarker: string | null,
): string {
  const scoreStr = candidate.roleScore.toFixed(2);
  const role = profile.role;
  const ref = candidate.reference;
  const diversitySuffix = diversityMarker === null ? "" : ` · ${diversityMarker}`;
  if (mode === "economy") {
    const costStr = Number.isFinite(candidate.effectiveCost)
      ? `cost ${candidate.effectiveCost.toFixed(2)}`
      : "cost unknown";
    return capReason(
      `${mode} · role ${role} · score ${scoreStr} · ${costStr} · ${ref}${diversitySuffix}`,
    );
  }
  const dims = decidingDimensions(profile, heuristic).join(",");
  const base = `${mode} · role ${role} · score ${scoreStr} · ${dims} · ${ref}`;
  if (heuristic && mode === "performance")
    return capReason(`${base} · heuristic (no comparable benchmark)${diversitySuffix}`);
  if (mode === "free") return capReason(`${base} · zero cost · fresh${diversitySuffix}`);
  return capReason(`${base}${diversitySuffix}`);
}
export function suggestForMode(input: PolicyInput): PolicyOutput {
  const joined = joinCandidates(
    input.catalog,
    input.metadata,
    input.providers,
    input.capabilities,
  );
  const suggestions = new Map<string, AgentSuggestion>();
  const modelReuse = new Map<string, number>();
  const providerReuse = new Map<string, number>();
  let codingModel: string | null = null;
  for (const agent of input.agents) {
    const profile = profileForAgent(agent);
    let sorted: ScoredCandidate[] = [];
    let heuristic = false;
    if (input.mode === "free") {
      const filtered = filterFree(agent, joined, input.sourceStatus);
      // free ranking: roleScore desc, reference asc (cost equal zero, so cost tie)
      const res = computeRoleScores(profile, filtered);
      res.scored.sort((a, b) => {
        if (a.roleScore !== b.roleScore) return b.roleScore - a.roleScore;
        return compareReferences(a.reference, b.reference);
      });
      sorted = res.scored;
      heuristic = false;
    } else if (input.mode === "economy") {
      const filtered = filterEconomyPerformance(agent, joined);
      const res = sortEconomy(agent, filtered);
      sorted = res.sorted;
      heuristic = res.heuristic;
    } else {
      const filtered = filterEconomyPerformance(agent, joined);
      const res = sortPerformance(agent, filtered);
      sorted = res.sorted;
      heuristic = res.heuristic;
    }
    if (sorted.length === 0) continue;
    const { winner, diversified, crossReview } = selectDiverseWinner(
      sorted,
      input.mode,
      profile,
      codingModel,
      modelReuse,
      providerReuse,
    );
    const isPerf = input.mode === "performance";
    const marker = diversified ? (crossReview ? "cross-review" : "diversity") : null;
    suggestions.set(agent, {
      model: winner.reference,
      metadata: toSuggestionMetadata(winner.metadata),
      reason: reasonFor(
        input.mode,
        profile,
        winner,
        isPerf ? heuristic : false,
        marker,
      ),
      heuristic: isPerf ? heuristic : false,
    });
    modelReuse.set(
      winner.reference,
      (modelReuse.get(winner.reference) ?? 0) + 1,
    );
    providerReuse.set(
      winner.providerId,
      (providerReuse.get(winner.providerId) ?? 0) + 1,
    );
    if (profile.role === "coding") codingModel = winner.reference;
  }
  return {
    mode: input.mode,
    providers: [...input.providers],
    sourceStatus: input.sourceStatus,
    sourceAgeMs: input.sourceAgeMs,
    warnings: [...input.warnings],
    suggestions,
  };
}
export const _test = {
  isContextInadequate,
  effectiveCost,
  saturatedFit,
  profileForAgent,
  computeRoleScores,
  roleForAgent,
};
