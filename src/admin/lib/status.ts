import {
  isAiDevRunning,
  getAiDevUptime,
  getSelfContainerRef,
  dockerCommand,
  execInAiDev,
  type ExecResult,
} from "./docker";
import { readFileSync } from "node:fs";
import {
  EMPTY_GIT_HOSTING_AUTH_STATE,
  loadGitHostingAuthState,
  type GitHostingAuthState,
} from "./git-hosting-auth-state";
import type { GainStats, LeanCtxSiteStats, ProveReportStats, SavingsReportStats, ValueReportStats } from "./project-tool-status";

export type AuthStatus = "authenticated" | "not authenticated";

export interface ContainerInfo {
  status: "running" | "stopped";
  uptime_seconds: number | null;
  version: string;
}

/** Per-container status/uptime/version for one AI-EngKit container. */
export type ContainerMap = {
  "ai-dev": ContainerInfo;
  "ai-admin": ContainerInfo;
};

export interface StatusResponse {
  /** ai-dev container status — kept alongside containers for backward compatibility. */
  container_status: "running" | "stopped";
  /** ai-dev container uptime — kept alongside containers for backward compatibility. */
  uptime_seconds: number | null;
  containers: ContainerMap;
  restart_count: number;
  gh_auth: AuthStatus;
  glab_auth: AuthStatus;
  git_hosting_auth?: GitHostingAuthStatus;
  git_user: string;
  project_count: number;
  /** Site-level leanCTX statistics; null when no probe is wired or the scan fails. */
  leanctx: LeanCtxSiteStats | null;
  /** LeanCTX token-savings telemetry; null when no probe is wired or the probe fails. */
  gain: GainStats | null;
  /** LeanCTX value-gate telemetry; null when no probe is wired or the probe fails. */
  valueReport: ValueReportStats | null;
  /** LeanCTX Decision Loop evidence-chain telemetry; null when no probe is wired or the probe fails. */
  proveReport: ProveReportStats | null;
  /** LeanCTX period-scoped savings with tool breakdown; null when no probe is wired or the probe fails. */
  savingsReport: SavingsReportStats | null;
  admin_version: string;
  admin_version_mismatch: boolean;
}

export type GitHostingAuthStatus =
  | ({ readonly available: true } & GitHostingAuthState)
  | { readonly available: false };

export interface StatusDeps {
  isAiDevRunning: () => Promise<boolean>;
  getAiDevUptime: () => Promise<number | null>;
  getSelfContainerRef: () => Promise<string>;
  dockerCommand: (subcommand: string, timeoutMs: number) => Promise<ExecResult>;
  execInAiDev: (command: string, timeoutMs: number) => Promise<ExecResult>;
  loadGitHostingAuthState: () => GitHostingAuthState;
  probeLeanCtxSite?: () => Promise<LeanCtxSiteStats | null>;
  probeGain?: () => Promise<GainStats | null>;
  probeValueReport?: () => Promise<ValueReportStats | null>;
  probeProveReport?: () => Promise<ProveReportStats | null>;
  probeSavingsReport?: () => Promise<SavingsReportStats | null>;
}

const DEFAULT_DEPS: StatusDeps = {
  isAiDevRunning,
  getAiDevUptime,
  getSelfContainerRef,
  dockerCommand,
  execInAiDev,
  loadGitHostingAuthState,
};

async function getAdminVersion(): Promise<string> {
  try {
    return readFileSync("/opt/ai-engkit/VERSION", "utf-8").trim();
  } catch {
    return "unknown";
  }
}

async function getAdminImageDigest(deps: StatusDeps): Promise<string | null> {
  const ref = await deps.getSelfContainerRef();
  const result = await deps.dockerCommand(
    `inspect --format='{{.Image}}' ${ref}`,
    10_000,
  );
  if (result.exitCode !== 0 || !result.stdout) return null;
  return result.stdout.trim();
}

async function getAiDevImageDigest(deps: StatusDeps): Promise<string | null> {
  const result = await deps.dockerCommand(
    `inspect --format='{{.Image}}' ai-engkit`,
    10_000,
  );
  if (result.exitCode !== 0 || !result.stdout) return null;
  return result.stdout.trim();
}

async function getAiDevVersion(deps: StatusDeps): Promise<string> {
  const result = await deps.execInAiDev(
    "cat /opt/ai-engkit/VERSION 2>/dev/null || echo ''",
    10_000,
  );
  return result.stdout.trim();
}

async function getSelfUptime(deps: StatusDeps): Promise<number | null> {
  const ref = await deps.getSelfContainerRef();
  const result = await deps.dockerCommand(
    `inspect --format='{{.State.StartedAt}}' ${ref}`,
    10_000,
  );
  if (result.exitCode !== 0 || !result.stdout.trim()) return null;
  const startedAt = new Date(result.stdout.trim());
  return Math.floor((Date.now() - startedAt.getTime()) / 1000);
}

function getGitHostingAuthStatus(deps: StatusDeps): GitHostingAuthStatus {
  try {
    const state = deps.loadGitHostingAuthState();
    return state === EMPTY_GIT_HOSTING_AUTH_STATE ? { available: false } : { available: true, ...state };
  } catch {
    return { available: false };
  }
}

export async function collectStatus(overrides: Partial<StatusDeps> = {}): Promise<StatusResponse> {
  const deps: StatusDeps = { ...DEFAULT_DEPS, ...overrides };
  const [containerRunning, uptime, ghResult, glabResult, gitResult, projectsResult, leanctx, gain, valueReport, proveReport, savingsReport, adminVersion, adminDigest, aiDevDigest, aiDevVersion, selfUptime, gitHostingAuth] =
    await Promise.all([
      deps.isAiDevRunning(),
      deps.getAiDevUptime(),
      deps.execInAiDev("gh auth status 2>&1 || true", 10_000),
      deps.execInAiDev("glab auth status 2>&1 || true", 10_000),
      deps.execInAiDev("git config --global user.name 2>/dev/null || echo ''", 10_000),
      deps.execInAiDev("ls ~/workspace/ 2>/dev/null | wc -l || echo '0'", 10_000),
      deps.probeLeanCtxSite ? deps.probeLeanCtxSite() : Promise.resolve(null),
      deps.probeGain ? deps.probeGain() : Promise.resolve(null),
      deps.probeValueReport ? deps.probeValueReport() : Promise.resolve(null),
      deps.probeProveReport ? deps.probeProveReport() : Promise.resolve(null),
      deps.probeSavingsReport ? deps.probeSavingsReport() : Promise.resolve(null),
      getAdminVersion(),
      getAdminImageDigest(deps),
      getAiDevImageDigest(deps),
      getAiDevVersion(deps),
      getSelfUptime(deps),
      Promise.resolve(getGitHostingAuthStatus(deps)),
    ]);

  const ghAuth: AuthStatus = ghResult.stdout.includes("Logged in") || ghResult.stderr.includes("Logged in")
    ? "authenticated"
    : "not authenticated";
  const glabAuth: AuthStatus = glabResult.stdout.includes("Logged in") || glabResult.stderr.includes("Logged in")
    ? "authenticated"
    : "not authenticated";
  const gitUser = gitResult.stdout.trim();
  const projectCount = parseInt(projectsResult.stdout.trim() || "0", 10);
  const adminVersionMismatch = adminDigest !== null && aiDevDigest !== null && adminDigest !== aiDevDigest;
  // The agent process runs inside the admin container; reaching this point means it is up.
  const adminStatus: "running" | "stopped" = "running";

  return {
    container_status: containerRunning ? "running" : "stopped",
    uptime_seconds: uptime,
    containers: {
      "ai-dev": {
        status: containerRunning ? "running" : "stopped",
        uptime_seconds: uptime,
        version: aiDevVersion,
      },
      "ai-admin": {
        status: adminStatus,
        uptime_seconds: selfUptime,
        version: adminVersion,
      },
    },
    restart_count: 0,
    gh_auth: ghAuth,
    glab_auth: glabAuth,
    git_hosting_auth: gitHostingAuth,
    git_user: gitUser,
    project_count: projectCount,
    leanctx,
    gain,
    valueReport,
    proveReport,
    savingsReport,
    admin_version: adminVersion,
    admin_version_mismatch: adminVersionMismatch,
  };
}
