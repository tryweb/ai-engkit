import type { ExecResult } from "./docker";

export interface FallbackModelEntry {
  readonly model: string;
  readonly variant?: string;
}

export interface AgentModelChange {
  readonly agent: string;
  readonly entries: readonly FallbackModelEntry[];
}

export interface ResolvedModel {
  readonly modelID: string;
  readonly providerID: string;
}

export interface AgentModelEntry {
  readonly name: string;
  readonly configured: readonly FallbackModelEntry[];
  /** Model assignment reported by OpenCode's /agent endpoint. */
  readonly resolved: ResolvedModel | null;
  /** Model metadata reported by the most recent successful request for this agent. */
  readonly requestVerified: ResolvedModel | null;
  readonly providerConnected: boolean;
  readonly source: "configured" | "inherited" | "plugin";
  readonly invalid: boolean;
  readonly effectiveness: "effective" | "runtime_mismatch" | "awaiting_request" | "invalid" | "plugin" | "unverified";
}

export interface AgentModelConfig {
  readonly model?: string;
  readonly variant?: string;
  readonly models?: readonly FallbackModelEntry[];
  readonly invalid: boolean;
}

export type ApplyResult =
  | {
      readonly ok: true;
      readonly status: "verified" | "cleared";
      readonly resolved: ResolvedModel | null;
      readonly requestVerified: ResolvedModel | null;
    }
  | {
      readonly ok: true;
      readonly status: "applied_with_quota_warning";
      readonly resolved: ResolvedModel | null;
      readonly requestVerified: ResolvedModel | null;
      readonly warning: string;
    }
  | {
      readonly ok: false;
      readonly status: "runtime_mismatch";
      readonly configured: string;
      readonly resolved: ResolvedModel | null;
      readonly requestVerified: ResolvedModel | null;
      readonly error: string;
    }
  | { readonly ok: false; readonly status: "write_failed"; readonly error: string }
  | { readonly ok: false; readonly status: "restart_failed"; readonly error: string }
  | { readonly ok: false; readonly status: "rollback_failed"; readonly error: string }
  | { readonly ok: false; readonly status: "probe_failed"; readonly error: string }
  | { readonly ok: false; readonly status: "unverified"; readonly error: string };

export interface AgentModelsDeps {
  readonly exec: (command: string, timeoutMs?: number) => Promise<ExecResult>;
  readonly restart: () => Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }>;
  readonly readEnv: () => Record<string, string>;
}

export const OMO_CONFIG = "~/.omo/omo.jsonc";
export const MANAGED_OPENCODE_DIR = "~/.config/openchamber/managed-opencode";
export const CONFIGURABLE_NATIVE_AGENTS = ["general", "plan"] as const;
export const VARIANTS = ["low", "medium", "high", "xhigh", "max"] as const;

// ── Native routing (v2) — flag-gated via OMO_ENABLED === "0" ──
// V1 path (OMO_ENABLED=1 or unset) : OMO_CONFIG / CONFIGURABLE_NATIVE_AGENTS(2) remain canonical.
// V2 path (OMO_ENABLED=0)          : ROUTING_CONFIG + OPENCODE_JSON + 12 native agents.
export const ROUTING_CONFIG = "~/.config/opencode/routing.json";
export const OPENCODE_JSON = "~/.config/opencode/opencode.json";

export const NATIVE12_AGENTS = [
  "plan",
  "prometheus",
  "explore",
  "oracle",
  "librarian",
  "multimodal-looker",
  "metis",
  "momus",
  "sisyphus",
  "hephaestus",
  "atlas",
  "sisyphus-junior",
] as const;

// V2 built-ins that share the same chain namespace (B1 §4.3) — kept separate
// from NATIVE12 for UI filtering but valid as routing keys.
export const V2_BUILTIN_AGENTS = ["build", "general", "scout", "compaction", "title", "summary"] as const;

export function isNativeV2Enabled(): boolean {
  return process.env.OMO_ENABLED === "0";
}

export function getConfigurableNativeAgents(): readonly string[] {
  return isNativeV2Enabled() ? (NATIVE12_AGENTS as readonly string[]) : (CONFIGURABLE_NATIVE_AGENTS as readonly string[]);
}

// ── Chain types per trial/B1-ROUTING-SPEC.md:§4.4 ──
export interface ChainEntry {
  readonly model: string;
  readonly variant?: string;
  readonly reasoningEffort?: string;
  readonly textVerbosity?: string;
  readonly reasoningSummary?: string;
  readonly temperature?: number;
  readonly top_p?: number;
  readonly maxTokens?: number;
  readonly thinking?: { readonly type: "enabled" | "disabled"; readonly budgetTokens?: number };
}

export interface AgentChain {
  readonly chain: readonly ChainEntry[];
  readonly cooldownSeconds?: number;
  readonly maxFallbackAttempts?: number;
  readonly notifyOnFallback?: boolean;
}

export interface RoutingDefaults {
  readonly cooldownSeconds?: number;
  readonly maxFallbackAttempts?: number;
  readonly notifyOnFallback?: boolean;
}

export interface RoutingConfig {
  readonly version: number;
  readonly defaults?: RoutingDefaults;
  readonly chains: Record<string, AgentChain>;
  readonly $schema?: string;
}

export interface PerAgentError {
  readonly agent: string;
  readonly errors: readonly string[];
}

export type VerificationMode = "readiness" | "inference";
export const VERIFICATION_MODES = ["readiness", "inference"] as const;

export function parseVerificationMode(value: unknown): VerificationMode | null {
  if (value === undefined) return "readiness";
  if (typeof value === "string" && (value === "readiness" || value === "inference")) return value;
  return null;
}
