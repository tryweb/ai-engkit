import { Hono } from "hono";
import { execInAiDev } from "../lib/docker";
import {
  listGlabInstances,
  loginGlabWithToken,
  logoutGlab,
  normalizeHostname,
} from "../lib/glab-auth";
import {
  loadGitHostingAuthState,
  saveGitHostingAuthState,
  withGitHostingAuthStateLock,
  type GitHostingAuthState,
  type GitLabAuthHostState,
} from "../lib/git-hosting-auth-state";
import {
  createGitLabTokenRotationService,
  type GitLabRotationOptions,
  type GitLabRotationResult,
  type GitLabTokenRotationErrorCode,
} from "../lib/gitlab-token-rotation";

const DEFAULT_THRESHOLD_DAYS = 7;
const DEFAULT_LIFETIME_DAYS = 30;

type GlabAuthDeps = {
  readonly listInstances: typeof listGlabInstances;
  readonly loginWithToken: typeof loginGlabWithToken;
  readonly logout: typeof logoutGlab;
  readonly exec: typeof execInAiDev;
  readonly rotate: (hostname: string, options: GitLabRotationOptions) => Promise<GitLabRotationResult>;
  readonly loadState: () => GitHostingAuthState;
  readonly saveState: (state: GitHostingAuthState) => void;
  readonly withStateLock?: <T>(operation: () => T | Promise<T>) => Promise<T>;
  readonly now: () => number;
};

const REAL_DEPS: GlabAuthDeps = {
  listInstances: listGlabInstances,
  loginWithToken: loginGlabWithToken,
  logout: logoutGlab,
  exec: execInAiDev,
  rotate: (hostname, options) => createGitLabTokenRotationService().rotateIfNeeded(hostname, options),
  loadState: loadGitHostingAuthState,
  saveState: saveGitHostingAuthState,
  withStateLock: withGitHostingAuthStateLock,
  now: Date.now,
};

const ROTATION_ERROR_STATUS: Record<GitLabTokenRotationErrorCode, 200 | 403 | 500 | 502> = {
  invalid_expired: 200,
  insufficient_scope: 403,
  unsupported_version: 403,
  impersonation_unconfirmed: 403,
  ambiguous_rotation: 500,
  persistence_failed: 500,
  version_unknown: 502,
  configuration_invalid: 500,
  unreachable: 502,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBareHostname(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed === normalizeHostname(trimmed) &&
    /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/.test(trimmed);
}

function parseRotationBody(value: unknown): string | null {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !isBareHostname(value.hostname)) return null;
  return normalizeHostname(value.hostname);
}

function daysRemaining(expiresAt: string | null, now: number): number | null {
  if (expiresAt === null) return null;
  const expiry = Date.parse(`${expiresAt}T00:00:00Z`);
  return Number.isFinite(expiry) ? Math.ceil((expiry - now) / (24 * 60 * 60 * 1000)) : null;
}

function stateForRotation(hostname: string, result: GitLabRotationResult, now: number): GitLabAuthHostState {
  if (result.ok === false) {
    return {
      hostname,
      validity: "unhealthy",
      expires_at: null,
      days_remaining: null,
      rotation_needed: true,
      rotation_done: false,
      error_code: result.code,
      checked_at: new Date(now).toISOString(),
    };
  }
  if (result.rotated === true) {
    const expiresAt = result.expiresAt;
    return {
      hostname,
      validity: "healthy",
      expires_at: expiresAt,
      days_remaining: daysRemaining(expiresAt, now),
      rotation_needed: false,
      rotation_done: result.rotated,
      error_code: null,
      checked_at: new Date(now).toISOString(),
    };
  }
  const expiresAt = result.metadata.expiresAt;
  return {
    hostname,
    validity: "healthy",
    expires_at: expiresAt,
    days_remaining: daysRemaining(expiresAt, now),
    rotation_needed: false,
    rotation_done: false,
    error_code: null,
    checked_at: new Date(now).toISOString(),
  };
}

async function persistRotationState(deps: GlabAuthDeps, hostname: string, result: GitLabRotationResult): Promise<void> {
  const persist = (): void => {
    const state = deps.loadState();
    const hostState = stateForRotation(hostname, result, deps.now());
    deps.saveState({
      ...state,
      gitlab: [...state.gitlab.filter((host) => host.hostname !== hostname), hostState],
    });
  };
  if (deps.withStateLock === undefined) {
    persist();
    return;
  }
  await deps.withStateLock(persist);
}

function createGlabAuth(deps: GlabAuthDeps): Hono {
  const glabAuth = new Hono();

  glabAuth.get("/api/auth/glab/status", async (c) => {
    const instances = await deps.listInstances();
    const anyAuth = instances.some((i) => i.authenticated);
    const hostname = c.req.query("hostname");
    const detail = deps.loadState();
    if (hostname) {
      const inst = instances.find((i) => i.hostname === hostname);
      return c.json({ status: inst ? (inst.authenticated ? "authenticated" : "not authenticated") : "not authenticated", instances, detail });
    }
    return c.json({ status: anyAuth ? "authenticated" : "not authenticated", instances, detail });
  });

  glabAuth.post("/api/auth/glab/start", async (c) => {
    const body = await c.req.json().catch(() => ({ hostname: "gitlab.com" }));
    const hostname = normalizeHostname(body.hostname || "gitlab.com");
    const token = body.token || "";

    if (token) {
      const result = await deps.loginWithToken(hostname, token);
      if ("error" in result) {
        return c.json({ error: result.error }, 500);
      }
      return c.json({ ok: true });
    }

    const result = await deps.exec(
      `glab auth login --hostname ${JSON.stringify(hostname)} 2>&1 || true`,
      30_000,
    );
    const output = result.stdout || result.stderr;

    let deviceCode = "";
    let verificationUri = "https://gitlab.com/activate";

    const codeMatch = output.match(/(?:code|Code):\s*([A-Z0-9-]+)/);
    if (codeMatch) deviceCode = codeMatch[1];

    const uriMatch = output.match(/https?:\/\/[^\s]+/);
    if (uriMatch) verificationUri = uriMatch[0];

    return c.json({ device_code: deviceCode, verification_uri: verificationUri });
  });

  glabAuth.post("/api/auth/glab/logout", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const hostname = body.hostname || "";
    await deps.logout(hostname);
    return c.json({ ok: true });
  });

  glabAuth.post("/api/auth/glab/rotate", async (c) => {
    const hostname = parseRotationBody(await c.req.json().catch(() => null));
    if (hostname === null) return c.json({ ok: false, hostname: "", rotated: false, errorCode: "invalid_hostname" }, 400);

    // Stable mapping: expired credentials are actionable state (200), policy failures are 403,
    // ambiguous/persistence failures are operator errors (500), and network failures are 502.
    let result: GitLabRotationResult;
    try {
      result = await deps.rotate(hostname, {
        thresholdDays: DEFAULT_THRESHOLD_DAYS,
        lifetimeDays: DEFAULT_LIFETIME_DAYS,
      });
    } catch {
      result = { ok: false, code: "unreachable" };
    }

    try {
      await persistRotationState(deps, hostname, result);
    } catch {
      result = { ok: false, code: "persistence_failed" };
    }

    if (result.ok === true) {
      return c.json({ ok: true, hostname, rotated: result.rotated, errorCode: null }, 200);
    }
    return c.json({ ok: false, hostname, rotated: false, errorCode: result.code }, ROTATION_ERROR_STATUS[result.code]);
  });

  return glabAuth;
}

export const glabAuth = createGlabAuth(REAL_DEPS);
export { createGlabAuth };
export default glabAuth;
