export type Tone = "success" | "warning" | "danger" | "neutral";

export interface DashboardCenterSummary {
  readonly state: "connected" | "disabled" | "disconnected" | "unavailable";
  readonly label: string;
  readonly tone: Tone;
  readonly href: "/agent";
  readonly ariaLabel: string;
}

export interface DashboardRuntimeProfile {
  readonly applyState: "applied" | "pending" | "saved-only" | "runtime-unavailable";
  readonly source: "applied-snapshot" | "saved-config" | "unavailable";
  readonly compressionLevel: "off" | "lite" | "standard" | "max" | null;
  readonly toolProfile: "minimal" | "standard" | "power" | null;
  readonly permissionInheritance: "on" | "off" | null;
  readonly crossProjectSearch: boolean | null;
  readonly secretDetectionEnabled: boolean | null;
  readonly secretRedactionEnabled: boolean | null;
  readonly archiveEnabled: boolean | null;
  readonly archiveMaxAgeHours: number | null;
  readonly archiveMaxDiskMb: number | null;
}

export interface RuntimeFieldDisplay {
  readonly label: string;
  readonly value: string;
  readonly tone: Tone;
  readonly ariaLabel: string;
}

export interface ProviderSummary {
  readonly state: "ready" | "needs-credentials" | "pending-activation" | "invalid" | "none" | "unavailable";
  readonly totalCount: number;
  readonly issueCount: number;
  readonly label: string;
  readonly tone: Tone;
  readonly href: "/providers";
}

export interface SubagentSummary {
  readonly state: "effective" | "awaiting-request" | "unverified" | "runtime-mismatch" | "invalid" | "none" | "unavailable";
  readonly configuredCount: number;
  readonly worstCount: number;
  readonly label: string;
  readonly tone: Tone;
  readonly href: "/agent-models";
}

export interface LspSummary {
  readonly state: "in-sync" | "drifted" | "none" | "unavailable";
  readonly totalCount: number;
  readonly enabledCount: number;
  readonly driftCount: number;
  readonly label: string;
  readonly tone: Tone;
  readonly href: "/lsp";
}



// Formatting helpers — en-US deterministic
export function formatIntEnUs(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}
export function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}
export function formatPct(n: number): string {
  return `${n.toFixed(1)}%`;
}
export function formatCpao(n: number): string {
  return `${formatIntEnUs(Math.round(n))}μs`;
}
export function formatEtpao(n: number): string {
  return `${formatIntEnUs(Math.round(n))} tokens`;
}

// Center projection
export function projectCenter(state: string | null | undefined, error: unknown): DashboardCenterSummary {
  const href = "/agent" as const;
  if (state === "connected") return { state: "connected", label: "Connected", tone: "success", href, ariaLabel: "Center Connected" };
  if (state === "disabled") return { state: "disabled", label: "Standalone", tone: "neutral", href, ariaLabel: "Center Standalone" };
  if (state === "disconnected") return { state: "disconnected", label: "Disconnected", tone: "warning", href, ariaLabel: "Center Disconnected" };
  return { state: "unavailable", label: "Unavailable", tone: "danger", href, ariaLabel: "Center Unavailable" };
}

export function centerFromStatus(status: { state: string } | null | undefined, error: unknown): DashboardCenterSummary {
  if (!status) return projectCenter(null, error);
  return projectCenter(status.state, error);
}

// Runtime profile helpers
const COMPRESSION_DISPLAY = {
  off: "Off",
  lite: "Lite",
  standard: "Standard",
  max: "Max",
} as const;
type CompressionKey = keyof typeof COMPRESSION_DISPLAY;
function isCompressionKey(value: string): value is CompressionKey {
  return value in COMPRESSION_DISPLAY;
}
export function formatCompression(value: string | null | undefined): RuntimeFieldDisplay {
  if (typeof value === "string" && isCompressionKey(value)) {
    const v = COMPRESSION_DISPLAY[value];
    return { label: "Compression", value: v, tone: "neutral", ariaLabel: `Compression ${v}` };
  }
  return { label: "Compression", value: "Unknown", tone: "neutral", ariaLabel: "Compression Unknown" };
}

const TOOLS_DISPLAY = {
  minimal: "Minimal",
  standard: "Standard",
  power: "Power",
} as const;
type ToolKey = keyof typeof TOOLS_DISPLAY;
function isToolKey(value: string): value is ToolKey {
  return value in TOOLS_DISPLAY;
}
export function formatTools(value: string | null | undefined): RuntimeFieldDisplay {
  if (typeof value === "string" && isToolKey(value)) {
    const v = TOOLS_DISPLAY[value];
    return { label: "Tools", value: v, tone: "neutral", ariaLabel: `Tools ${v}` };
  }
  return { label: "Tools", value: "Unknown", tone: "neutral", ariaLabel: "Tools Unknown" };
}

export function formatArchive(enabled: boolean | null | undefined, hours: number | null | undefined): RuntimeFieldDisplay {
  if (enabled === false) return { label: "Archive", value: "Off", tone: "neutral", ariaLabel: "Archive Off" };
  if (enabled === true && typeof hours === "number" && Number.isFinite(hours) && hours > 0) {
    const h = Math.round(hours);
    return { label: "Archive", value: `On · ${h}h`, tone: "neutral", ariaLabel: `Archive On ${h}h` };
  }
  return { label: "Archive", value: "Unknown", tone: "neutral", ariaLabel: "Archive Unknown" };
}

export type SecurityInputs = {
  secretDetectionEnabled: boolean | null;
  secretRedactionEnabled: boolean | null;
  crossProjectSearch: boolean | null;
};

export function deriveSecurity(inputs: SecurityInputs): RuntimeFieldDisplay & { detail: Array<{ label: string; value: string }> } {
  const { secretDetectionEnabled, secretRedactionEnabled, crossProjectSearch } = inputs;
  const detail: Array<{ label: string; value: string }> = [
    { label: "Secret detection", value: secretDetectionEnabled === null ? "Unknown" : secretDetectionEnabled ? "On" : "Off" },
    { label: "Secret redaction", value: secretRedactionEnabled === null ? "Unknown" : secretRedactionEnabled ? "On" : "Off" },
    { label: "Cross-project search", value: crossProjectSearch === null ? "Unknown" : crossProjectSearch ? "On" : "Off" },
  ];
  // permission inheritance not part of posture but detail will be added by caller
  if (secretDetectionEnabled === null || secretRedactionEnabled === null || crossProjectSearch === null) {
    return { label: "Security", value: "Unknown", tone: "neutral", ariaLabel: "Security Unknown", detail };
  }
  if (!secretDetectionEnabled || !secretRedactionEnabled) {
    return { label: "Security", value: "At risk", tone: "danger", ariaLabel: "Security At risk", detail };
  }
  if (crossProjectSearch) {
    return { label: "Security", value: "Review", tone: "warning", ariaLabel: "Security Review", detail };
  }
  return { label: "Security", value: "Protected", tone: "success", ariaLabel: "Security Protected", detail };
}

export function formatPermissionInheritance(value: "on" | "off" | null): string {
  if (value === "on") return "On";
  if (value === "off") return "Off";
  return "Unknown";
}

export function formatApplyState(applyState: DashboardRuntimeProfile["applyState"]): RuntimeFieldDisplay {
  switch (applyState) {
    case "applied": return { label: "Apply", value: "Applied", tone: "success", ariaLabel: "Apply Applied" };
    case "pending": return { label: "Apply", value: "Pending apply", tone: "warning", ariaLabel: "Apply Pending apply" };
    case "saved-only": return { label: "Apply", value: "Saved config only", tone: "neutral", ariaLabel: "Apply Saved config only" };
    case "runtime-unavailable": return { label: "Apply", value: "Runtime profile unavailable", tone: "danger", ariaLabel: "Apply Runtime profile unavailable" };
    default: {
      const _exhaustive: never = applyState;
      return { label: "Apply", value: "Unknown", tone: "neutral", ariaLabel: "Apply Unknown" };
    }
  }
}

// Provider readiness aggregation
export interface ProviderMetaLike {
  readonly keyManagement: boolean;
  readonly hasApiKey: boolean;
  readonly authStoreKeyPresent: boolean;
  readonly oauthConnected: boolean;
  readonly registry: { activeKeyId: string | null };
  readonly virtual?: boolean;
  readonly baseURL?: string;
}

export function aggregateProviderSummary(input: { invalid: boolean; providers: ProviderMetaLike[] } | null | undefined): ProviderSummary {
  const href = "/providers" as const;
  if (!input) return { state: "unavailable", totalCount: 0, issueCount: 0, label: "Status unavailable", tone: "neutral", href };
  if (input.invalid) return { state: "invalid", totalCount: input.providers.length, issueCount: input.providers.length, label: "Provider configuration invalid", tone: "danger", href };
  const providers = input.providers.filter((provider) =>
    provider.virtual !== true ||
    provider.hasApiKey ||
    provider.authStoreKeyPresent ||
    provider.oauthConnected ||
    provider.registry.activeKeyId !== null,
  );
  if (providers.length === 0) return { state: "none", totalCount: 0, issueCount: 0, label: "No providers configured", tone: "warning", href };

  let pending = 0;
  let needs = 0;
  let ready = 0;
  for (const p of providers) {
    if (p.keyManagement) {
      const isReady = p.oauthConnected || p.authStoreKeyPresent;
      const isPending = !!p.registry.activeKeyId && !p.authStoreKeyPresent && !p.oauthConnected;
      if (isPending) pending++;
      else if (isReady) ready++;
      else needs++;
    } else {
      if (p.hasApiKey || (p.baseURL?.trim() ?? "") !== "") ready++;
      else needs++;
    }
  }
  if (pending > 0) {
    const label = pending === 1 ? "1 pending activation" : `${pending} pending activation`;
    return { state: "pending-activation", totalCount: providers.length, issueCount: pending, label, tone: "warning", href };
  }
  if (needs > 0) {
    const r = ready;
    const label = needs === 1 ? `${r} ready · 1 needs credentials` : `${r} ready · ${needs} need credentials`;
    return { state: "needs-credentials", totalCount: providers.length, issueCount: needs, label, tone: "warning", href };
  }
  // all ready
  const label = providers.length === 1 ? "1 provider ready" : `${providers.length} providers ready`;
  return { state: "ready", totalCount: providers.length, issueCount: 0, label, tone: "success", href };
}

// SubAgent aggregation
import type { AgentModelEntry } from "./agent-model-types";

export function aggregateSubagentSummary(entries: readonly AgentModelEntry[] | null | undefined, catalogAvailable: boolean | null = true): SubagentSummary {
  const href = "/agent-models" as const;
  if (entries === null || entries === undefined || catalogAvailable === false) {
    return { state: "unavailable", configuredCount: 0, worstCount: 0, label: "Status unavailable", tone: "neutral", href };
  }
  const configured = entries.filter((e) => e.source !== "plugin");
  const configuredCount = configured.length;
  if (configuredCount === 0) return { state: "none", configuredCount: 0, worstCount: 0, label: "No SubAgents configured", tone: "neutral", href };

  type EffectivenessCountKey = "invalid" | "runtime_mismatch" | "unverified" | "awaiting_request" | "effective";
  const counts: Record<EffectivenessCountKey, number> = { invalid: 0, runtime_mismatch: 0, unverified: 0, awaiting_request: 0, effective: 0 };
  function isCountedEffectiveness(value: string): value is EffectivenessCountKey {
    return value === "invalid" || value === "runtime_mismatch" || value === "unverified" || value === "awaiting_request" || value === "effective";
  }
  for (const e of configured) {
    const eff = e.effectiveness;
    if (isCountedEffectiveness(eff)) counts[eff] += 1;
  }
  // precedence invalid > runtime_mismatch > unverified > awaiting_request > effective
  if (counts.invalid > 0) {
    const c = counts.invalid;
    const label = c === 1 ? "1 invalid configuration" : `${c} invalid configurations`;
    return { state: "invalid", configuredCount, worstCount: c, label, tone: "danger", href };
  }
  if (counts.runtime_mismatch > 0) {
    const c = counts.runtime_mismatch;
    const label = c === 1 ? "1 runtime mismatch" : `${c} runtime mismatches`;
    return { state: "runtime-mismatch", configuredCount, worstCount: c, label, tone: "danger", href };
  }
  if (counts.unverified > 0) {
    const c = counts.unverified;
    const label = `${c} unverified`;
    return { state: "unverified", configuredCount, worstCount: c, label, tone: "warning", href };
  }
  if (counts.awaiting_request > 0) {
    const c = counts.awaiting_request;
    const label = `${configuredCount} configured · ${c} awaiting verification`;
    return { state: "awaiting-request", configuredCount, worstCount: c, label, tone: "neutral", href };
  }
  // all effective
  const eff = counts.effective;
  return { state: "effective", configuredCount, worstCount: eff, label: `${eff}/${configuredCount} effective`, tone: "success", href };
}

// LSP summary aggregation — mirrors ProviderSummary pattern for site-summary pill
export function aggregateLspSummary(
  input: { inSync: number; drifted: number; enabled: number; total?: number } | null | undefined,
): LspSummary {
  const href = "/lsp" as const;
  if (!input) return { state: "unavailable", totalCount: 0, enabledCount: 0, driftCount: 0, label: "Status unavailable", tone: "neutral", href };
  const inSync = Math.max(0, Math.floor(input.inSync));
  const drifted = Math.max(0, Math.floor(input.drifted));
  const total = input.total !== undefined ? Math.max(0, Math.floor(input.total)) : inSync + drifted;
  if (total === 0) return { state: "unavailable", totalCount: 0, enabledCount: 0, driftCount: 0, label: "Status unavailable", tone: "neutral", href };
  const enabled = Math.max(0, Math.floor(input.enabled));
  if (enabled === 0) {
    return { state: "none", totalCount: total, enabledCount: 0, driftCount: 0, label: "None enabled", tone: "neutral", href };
  }
  if (drifted > 0) {
    const label = `${enabled} enabled · ${drifted} drifted`;
    return { state: "drifted", totalCount: total, enabledCount: enabled, driftCount: drifted, label, tone: "warning", href };
  }
  const label = `${enabled} enabled · ${enabled} in sync`;
  return { state: "in-sync", totalCount: total, enabledCount: enabled, driftCount: 0, label, tone: "success", href };
}

// DB health helpers — deterministic en-US, reuse MetricCard/StatusPill pattern
export interface DbHealthCounts {
  readonly session: number;
  readonly event: number;
  readonly message: number;
  readonly part: number;
}

export interface DbHealthSummary {
  readonly fileSizeBytes: number;
  readonly freelistCount: number;
  readonly rowCounts: DbHealthCounts;
  readonly freeSpaceBytes: number | null;
  readonly freeSpacePath: string;
  readonly dbPath: string;
  readonly collectedAt: string;
}

export function formatBytesEnUs(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${new Intl.NumberFormat("en-US").format(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function deriveDbHealthFreeSpaceTone(freeSpaceBytes: number | null): Tone {
  if (freeSpaceBytes === null) return "neutral";
  if (freeSpaceBytes < 1 * 1024 * 1024 * 1024) return "danger";
  if (freeSpaceBytes < 5 * 1024 * 1024 * 1024) return "warning";
  return "success";
}

export function formatDbHealthFileSize(bytes: number): RuntimeFieldDisplay {
  return {
    label: "DB Size",
    value: formatBytesEnUs(bytes),
    tone: "neutral",
    ariaLabel: `Database size ${formatBytesEnUs(bytes)}`,
  };
}

export function toneToClass(tone: Tone, kind: "pill" | "badge"): string {
  if (kind === "pill") return `status-pill status-pill--${tone}`;
  return `badge badge-${tone}`;
}
