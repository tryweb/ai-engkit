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

export const OMO_CONFIG = "~/.config/opencode/oh-my-opencode-slim.json";
export const MANAGED_OPENCODE_DIR = "~/.config/openchamber/managed-opencode";
export const CONFIGURABLE_NATIVE_AGENTS = ["general", "plan"] as const;
export const VARIANTS = ["low", "medium", "high", "xhigh", "max"] as const;

export type VerificationMode = "readiness" | "inference";
export const VERIFICATION_MODES = ["readiness", "inference"] as const;

export function parseVerificationMode(value: unknown): VerificationMode | null {
  if (value === undefined) return "readiness";
  if (typeof value === "string" && (value === "readiness" || value === "inference")) return value;
  return null;
}
