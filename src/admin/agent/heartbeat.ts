import { execInAiDev } from "../lib/docker";
import {
  EMPTY_GIT_HOSTING_AUTH_STATE,
  loadGitHostingAuthState,
  type GitHostingAuthState,
} from "../lib/git-hosting-auth-state";
import type { ContainerMap, StatusResponse } from "../lib/status";
import type { UpdateCheckResult } from "../routes/versions";

export interface StatusReport {
  container_status: "running" | "stopped";
  uptime_seconds: number | null;
  /** Per-container status/uptime/version for ai-dev and ai-admin. */
  containers: ContainerMap;
  versions: Record<string, string>;
  gh_auth: "authenticated" | "not authenticated";
  glab_auth: "authenticated" | "not authenticated";
  admin_version: string;
  admin_version_mismatch: boolean;
  upgrade_state: string;
  upgrade_available: boolean;
  latest_version: string;
  readonly gitHostingAuth?: GitHostingAuthState;
}

export interface HeartbeatDeps {
  collectStatus: () => Promise<StatusResponse>;
  getVersions: () => Promise<Record<string, string>>;
  getUpdateCheck: () => Promise<UpdateCheckResult>;
}

function getVersion(command: string): Promise<string> {
  return execInAiDev(command, 15_000).then(
    (result) => {
      if (result.exitCode !== 0 || !result.stdout) return "";
      return result.stdout.split("\n")[0]?.trim() ?? "";
    },
    () => "",
  );
}

function loadAuthHealth(): GitHostingAuthState {
  try {
    return loadGitHostingAuthState();
  } catch (error) {
    if (error instanceof Error) console.warn("Unable to load git-hosting auth state", error.message);
    else console.warn("Unable to load git-hosting auth state", String(error));
    return EMPTY_GIT_HOSTING_AUTH_STATE;
  }
}

/** Collect component versions from the shared ai-dev command adapter. */
export async function getComponentVersions(): Promise<Record<string, string>> {
  const [aiEngkit, openCode, openChamber, docker] = await Promise.all([
    getVersion("cat /opt/ai-engkit/VERSION"),
    getVersion("opencode --version 2>/dev/null || echo ''"),
    getVersion("/home/devuser/.bun/bin/openchamber --version 2>/dev/null || echo ''"),
    getVersion("docker --version 2>/dev/null | cut -d' ' -f3 | tr -d ',' || echo ''"),
  ]);

  return {
    "AI-EngKit": aiEngkit,
    OpenCode: openCode,
    OpenChamber: openChamber,
    Docker: docker,
  };
}

/** Build the heartbeat payload from the shared local status collector. */
export async function buildStatusReport(
  deps: HeartbeatDeps,
  upgradeState: string,
): Promise<StatusReport> {
  const [status, versions, updateCheck] = await Promise.all([
    deps.collectStatus(),
    deps.getVersions(),
    deps.getUpdateCheck(),
  ]);

  return {
    container_status: status.container_status,
    uptime_seconds: status.uptime_seconds,
    containers: status.containers,
    versions,
    gh_auth: status.gh_auth,
    glab_auth: status.glab_auth,
    admin_version: status.admin_version,
    admin_version_mismatch: status.admin_version_mismatch,
    upgrade_state: upgradeState,
    upgrade_available: updateCheck.update_available,
    latest_version: updateCheck.latest,
    gitHostingAuth: loadAuthHealth(),
  };
}

/** Return the fixed delay between heartbeat reports. */
export function heartbeatIntervalMs(): number {
  return 60_000;
}
