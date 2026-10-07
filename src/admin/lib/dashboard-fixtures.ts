import type { DashboardRuntimeProfile, ProviderSummary, SubagentSummary } from "./dashboard-aggregates";
import type { LeanCtxAppliedSnapshot } from "./leanctx-applied-snapshot";
import type { AgentModelEntry } from "./agent-model-types";

export const FIXTURE_RUNTIME_PROFILES: Record<string, DashboardRuntimeProfile> = {
  appliedLite: {
    applyState: "applied",
    source: "applied-snapshot",
    compressionLevel: "lite",
    toolProfile: "power",
    permissionInheritance: "on",
    crossProjectSearch: false,
    secretDetectionEnabled: true,
    secretRedactionEnabled: true,
    archiveEnabled: true,
    archiveMaxAgeHours: 48,
    archiveMaxDiskMb: 500,
  },
  pendingMax: {
    applyState: "pending",
    source: "applied-snapshot",
    compressionLevel: "max",
    toolProfile: "minimal",
    permissionInheritance: "off",
    crossProjectSearch: true,
    secretDetectionEnabled: true,
    secretRedactionEnabled: true,
    archiveEnabled: true,
    archiveMaxAgeHours: 72,
    archiveMaxDiskMb: 1000,
  },
  savedOnly: {
    applyState: "saved-only",
    source: "saved-config",
    compressionLevel: "standard",
    toolProfile: "standard",
    permissionInheritance: null,
    crossProjectSearch: null,
    secretDetectionEnabled: null,
    secretRedactionEnabled: null,
    archiveEnabled: null,
    archiveMaxAgeHours: null,
    archiveMaxDiskMb: null,
  },
  unavailable: {
    applyState: "runtime-unavailable",
    source: "unavailable",
    compressionLevel: null,
    toolProfile: null,
    permissionInheritance: null,
    crossProjectSearch: null,
    secretDetectionEnabled: null,
    secretRedactionEnabled: null,
    archiveEnabled: null,
    archiveMaxAgeHours: null,
    archiveMaxDiskMb: null,
  },
  atRisk: {
    applyState: "applied",
    source: "applied-snapshot",
    compressionLevel: "lite",
    toolProfile: "power",
    permissionInheritance: "on",
    crossProjectSearch: false,
    secretDetectionEnabled: true,
    secretRedactionEnabled: false,
    archiveEnabled: true,
    archiveMaxAgeHours: 48,
    archiveMaxDiskMb: 500,
  },
  review: {
    applyState: "applied",
    source: "applied-snapshot",
    compressionLevel: "lite",
    toolProfile: "power",
    permissionInheritance: "on",
    crossProjectSearch: true,
    secretDetectionEnabled: true,
    secretRedactionEnabled: true,
    archiveEnabled: true,
    archiveMaxAgeHours: 24,
    archiveMaxDiskMb: 200,
  },
  archiveOff: {
    applyState: "applied",
    source: "applied-snapshot",
    compressionLevel: "off",
    toolProfile: "minimal",
    permissionInheritance: "off",
    crossProjectSearch: false,
    secretDetectionEnabled: true,
    secretRedactionEnabled: true,
    archiveEnabled: false,
    archiveMaxAgeHours: null,
    archiveMaxDiskMb: null,
  },
  archiveUnknown: {
    applyState: "applied",
    source: "applied-snapshot",
    compressionLevel: "lite",
    toolProfile: "power",
    permissionInheritance: null,
    crossProjectSearch: false,
    secretDetectionEnabled: true,
    secretRedactionEnabled: true,
    archiveEnabled: true,
    archiveMaxAgeHours: null,
    archiveMaxDiskMb: null,
  },
};

export const FIXTURE_SNAPSHOT: LeanCtxAppliedSnapshot = {
  version: 1,
  fingerprint: "a".repeat(64),
  compressionLevel: "lite",
  toolProfile: "power",
  permissionInheritance: "on",
  crossProjectSearch: false,
  secretDetectionEnabled: true,
  secretRedactionEnabled: true,
  archiveEnabled: true,
  archiveMaxAgeHours: 48,
  archiveMaxDiskMb: 500,
};

export const FIXTURE_PROVIDER_READY: ProviderSummary = {
  state: "ready",
  totalCount: 2,
  issueCount: 0,
  label: "2 providers ready",
  tone: "success",
  href: "/providers",
};

export const FIXTURE_PROVIDER_PENDING: ProviderSummary = {
  state: "pending-activation",
  totalCount: 3,
  issueCount: 1,
  label: "1 pending activation",
  tone: "warning",
  href: "/providers",
};

export const FIXTURE_PROVIDER_NEEDS: ProviderSummary = {
  state: "needs-credentials",
  totalCount: 3,
  issueCount: 1,
  label: "2 ready · 1 needs credentials",
  tone: "warning",
  href: "/providers",
};

export const FIXTURE_PROVIDER_NONE: ProviderSummary = {
  state: "none",
  totalCount: 0,
  issueCount: 0,
  label: "No providers configured",
  tone: "warning",
  href: "/providers",
};

export const FIXTURE_SUBAGENT_EFFECTIVE: SubagentSummary = {
  state: "effective",
  configuredCount: 9,
  worstCount: 9,
  label: "9/9 effective",
  tone: "success",
  href: "/agent-models",
};

export const FIXTURE_SUBAGENT_AWAITING: SubagentSummary = {
  state: "awaiting-request",
  configuredCount: 9,
  worstCount: 6,
  label: "9 configured · 6 awaiting verification",
  tone: "neutral",
  href: "/agent-models",
};

export const FIXTURE_SUBAGENT_INVALID: SubagentSummary = {
  state: "invalid",
  configuredCount: 5,
  worstCount: 2,
  label: "2 invalid configurations",
  tone: "danger",
  href: "/agent-models",
};

export function makeAgentEntry(overrides: Partial<AgentModelEntry>): AgentModelEntry {
  return {
    name: "general",
    configured: [],
    resolved: null,
    requestVerified: null,
    lastSuccessfulRequestAt: null,
    providerConnected: true,
    source: "configured",
    pinned: false,
    invalid: false,
    effectiveness: "effective",
    ...overrides,
  };
}
