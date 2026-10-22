/** Single-process rotation lock; multi-process replicas require an external lock. */
import { execInAiDev } from "./docker";
import {
  loginGlabWithToken,
  normalizeHostname,
  readGlabToken,
  type GlabCommand,
} from "./glab-auth";

export const GITLAB_TOKEN_ROTATION_ERROR_CODES = [
  "invalid_expired",
  "insufficient_scope",
  "unsupported_version",
  "impersonation_unconfirmed",
  "persistence_failed",
  "ambiguous_rotation",
  "version_unknown",
  "configuration_invalid",
  "unreachable",
] as const;

export type GitLabTokenRotationErrorCode = (typeof GITLAB_TOKEN_ROTATION_ERROR_CODES)[number];

export interface GitLabTokenMetadata {
  readonly active: boolean;
  readonly revoked: boolean;
  readonly expiresAt: string | null;
  readonly scopes: readonly string[];
  readonly impersonation: boolean;
}

export type GitLabInspectionResult =
  | { readonly ok: true; readonly metadata: GitLabTokenMetadata }
  | { readonly ok: false; readonly code: GitLabTokenRotationErrorCode };

export type GitLabRotationResult =
  | { readonly ok: true; readonly rotated: false; readonly metadata: GitLabTokenMetadata }
  | { readonly ok: true; readonly rotated: true; readonly expiresAt: string }
  | { readonly ok: false; readonly code: GitLabTokenRotationErrorCode };

export interface GitLabRotationOptions {
  readonly gitlabVersion?: string;
  readonly thresholdDays?: number;
  readonly lifetimeDays?: number;
}

export interface GitLabTokenRotationDependencies {
  readonly fetchFn?: GitLabFetch;
  readonly command?: GlabCommand;
  readonly login?: typeof loginGlabWithToken;
  readonly now?: () => number;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly requestTimeoutMs?: number;
}

export type GitLabFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type JsonObject = { readonly [key: string]: unknown };

const locks = new Map<string, Promise<void>>();
const DEFAULT_THRESHOLD_DAYS = 7;
const DEFAULT_LIFETIME_DAYS = 30;
const MINIMUM_GITLAB_VERSION = [17, 9] as const;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().startsWith(value);
}

function readMetadata(value: unknown): GitLabTokenMetadata | null {
  if (!isJsonObject(value)) return null;
  const scopesValue = value.scopes;
  if (!Array.isArray(scopesValue)) return null;
  const scopes = scopesValue.filter((scope): scope is string => typeof scope === "string");
  if (scopes.length !== scopesValue.length) return null;
  const expiresAtValue = value.expires_at;
  if (expiresAtValue !== null && typeof expiresAtValue !== "string") return null;
  if (typeof expiresAtValue === "string" && !isValidDate(expiresAtValue)) return null;
  if (typeof value.active !== "boolean" || typeof value.revoked !== "boolean") return null;
  // GitLab omits `impersonation` for regular PATs; only an explicit true marks
  // an impersonation token, which keeps the confirmation gate fail-closed.
  if (value.impersonation !== undefined && typeof value.impersonation !== "boolean") return null;
  const expiresAt = typeof expiresAtValue === "string" ? expiresAtValue : null;
  return {
    active: value.active,
    revoked: value.revoked,
    expiresAt,
    scopes,
    impersonation: value.impersonation === true,
  };
}

function parseVersion(value: string): readonly [number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (match === null) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return Number.isSafeInteger(major) && Number.isSafeInteger(minor) && Number.isSafeInteger(patch) ? [major, minor] : null;
}

function supportsRotation(value: string): boolean {
  const version = parseVersion(value);
  if (version === null) return false;
  return version[0] > MINIMUM_GITLAB_VERSION[0] ||
    (version[0] === MINIMUM_GITLAB_VERSION[0] && version[1] >= MINIMUM_GITLAB_VERSION[1]);
}

function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && error.name === "TimeoutError";
}

function daysFromEnvironment(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function confirmedImpersonationHost(hostname: string, value: string | undefined): boolean {
  return new Set((value ?? "").split(",").map((host) => normalizeHostname(host)).filter(Boolean)).has(hostname);
}

function expirationDate(now: number, lifetimeDays: number): string | null {
  if (!Number.isSafeInteger(lifetimeDays) || lifetimeDays <= 0) return null;
  const date = new Date(now);
  date.setUTCDate(date.getUTCDate() + lifetimeDays);
  const value = date.toISOString().slice(0, 10);
  return isValidDate(value) ? value : null;
}

async function acquireHostLock(hostname: string): Promise<() => void> {
  const previous = locks.get(hostname) ?? Promise.resolve();
  let release = (): void => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current, () => current);
  locks.set(hostname, queued);
  await previous;
  return () => {
    release();
    if (locks.get(hostname) === queued) locks.delete(hostname);
  };
}

export class GitLabTokenRotationService {
  private readonly fetchFn: GitLabFetch;
  private readonly command: GlabCommand;
  private readonly login: typeof loginGlabWithToken;
  private readonly now: () => number;
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly requestTimeoutMs: number;

  public constructor(dependencies: GitLabTokenRotationDependencies = {}) {
    this.fetchFn = dependencies.fetchFn ?? fetch;
    this.command = dependencies.command ?? execInAiDev;
    this.login = dependencies.login ?? loginGlabWithToken;
    this.now = dependencies.now ?? Date.now;
    this.environment = dependencies.environment ?? process.env;
    this.requestTimeoutMs = dependencies.requestTimeoutMs ?? 15_000;
  }

  public async inspect(hostnameInput: string): Promise<GitLabInspectionResult> {
    const hostname = normalizeHostname(hostnameInput);
    let token: string | null;
    try {
      token = await readGlabToken(hostname, this.command);
    } catch (error: unknown) {
      if (error instanceof Error) return { ok: false, code: "unreachable" };
      throw error;
    }
    if (token === null) return { ok: false, code: "invalid_expired" };

    let response: Response;
    try {
      response = await this.fetchFn(`https://${hostname}/api/v4/personal_access_tokens/self`, {
        headers: { "PRIVATE-TOKEN": token },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error: unknown) {
      if (isTimeout(error) || error instanceof TypeError) return { ok: false, code: "unreachable" };
      throw error;
    }
    if (response.status === 401) return { ok: false, code: "invalid_expired" };
    if (response.status === 403) return { ok: false, code: "insufficient_scope" };
    if (response.status === 404 || !response.ok) return { ok: false, code: "unreachable" };
    const metadata = readMetadata(await response.json());
    return metadata === null ? { ok: false, code: "unreachable" } : { ok: true, metadata };
  }

  public async fetchGitLabVersion(hostnameInput: string): Promise<string | null> {
    const hostname = normalizeHostname(hostnameInput);
    let token: string | null;
    try {
      token = await readGlabToken(hostname, this.command);
    } catch (error: unknown) {
      if (error instanceof Error) return null;
      throw error;
    }
    if (token === null) return null;

    let response: Response;
    try {
      response = await this.fetchFn(`https://${hostname}/api/v4/version`, {
        headers: { "PRIVATE-TOKEN": token },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error: unknown) {
      if (isTimeout(error) || error instanceof TypeError) return null;
      throw error;
    }
    if (!response.ok) return null;
    let body: unknown;
    try {
      body = await response.json();
    } catch (error: unknown) {
      if (error instanceof Error) return null;
      throw error;
    }
    if (!isJsonObject(body) || typeof body.version !== "string" || parseVersion(body.version) === null) return null;
    return body.version;
  }

  public async rotateIfNeeded(hostnameInput: string, options: GitLabRotationOptions = {}): Promise<GitLabRotationResult> {
    const hostname = normalizeHostname(hostnameInput);
    const release = await acquireHostLock(hostname);
    try {
      return await this.rotateLocked(hostname, options);
    } finally {
      release();
    }
  }

  private async rotateLocked(hostname: string, options: GitLabRotationOptions): Promise<GitLabRotationResult> {
    const inspection = await this.inspect(hostname);
    if (inspection.ok === false) return { ok: false, code: inspection.code };
    const { metadata } = inspection;
    if (!metadata.active || metadata.revoked) return { ok: false, code: "invalid_expired" };
    // Tokens without an expiry never need rotation.
    if (metadata.expiresAt === null) return { ok: true, rotated: false, metadata };
    if (Date.parse(`${metadata.expiresAt}T00:00:00Z`) <= this.now()) {
      return { ok: false, code: "invalid_expired" };
    }
    const gitlabVersion = options.gitlabVersion ?? await this.fetchGitLabVersion(hostname);
    if (gitlabVersion === null) return { ok: false, code: "version_unknown" };
    if (!supportsRotation(gitlabVersion)) return { ok: false, code: "unsupported_version" };
    if (!metadata.scopes.includes("read_repository") || !metadata.scopes.includes("self_rotate")) {
      return { ok: false, code: "insufficient_scope" };
    }
    if (metadata.impersonation && !confirmedImpersonationHost(hostname, this.environment.GITLAB_IMPERSONATION_ROTATION_CONFIRMED_HOSTS)) {
      return { ok: false, code: "impersonation_unconfirmed" };
    }
    const thresholdDays = options.thresholdDays ?? daysFromEnvironment(this.environment.GITLAB_TOKEN_ROTATION_THRESHOLD_DAYS, DEFAULT_THRESHOLD_DAYS);
    const expiry = Date.parse(`${metadata.expiresAt}T00:00:00Z`);
    if (expiry - this.now() > thresholdDays * 24 * 60 * 60 * 1000) {
      return { ok: true, rotated: false, metadata };
    }
    const lifetimeDays = options.lifetimeDays ?? daysFromEnvironment(this.environment.GITLAB_TOKEN_ROTATION_LIFETIME_DAYS, DEFAULT_LIFETIME_DAYS);
    const expiresAt = expirationDate(this.now(), lifetimeDays);
    if (expiresAt === null) return { ok: false, code: "unreachable" };

    let response: Response;
    try {
      const token = await readGlabToken(hostname, this.command);
      if (token === null) return { ok: false, code: "invalid_expired" };
      response = await this.fetchFn(`https://${hostname}/api/v4/personal_access_tokens/self/rotate`, {
        method: "POST",
        headers: { "PRIVATE-TOKEN": token, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ expires_at: expiresAt }).toString(),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error: unknown) {
      // A timeout can mean GitLab rotated successfully; retrying could reuse an invalid token family.
      if (isTimeout(error) || error instanceof TypeError) return { ok: false, code: "ambiguous_rotation" };
      throw error;
    }
    if (!response.ok) return { ok: false, code: response.status >= 500 ? "ambiguous_rotation" : "unreachable" };
    const rotated = await response.json();
    if (!isJsonObject(rotated) || typeof rotated.token !== "string" || rotated.token.length === 0) {
      return { ok: false, code: "ambiguous_rotation" };
    }
    const replacementExpiresAt = typeof rotated.expires_at === "string" && isValidDate(rotated.expires_at) ? rotated.expires_at : expiresAt;
    const loginResult = await this.login(hostname, rotated.token, this.command);
    if (!loginResult.ok) return { ok: false, code: "persistence_failed" };
    const helperResult = await this.command(
      `printf 'protocol=https\\nhost=${hostname}\\n\\n' | GIT_TERMINAL_PROMPT=0 git credential fill >/dev/null 2>&1`,
      5_000,
    );
    if (helperResult.exitCode !== 0) return { ok: false, code: "persistence_failed" };
    return { ok: true, rotated: true, expiresAt: replacementExpiresAt };
  }
}

export function createGitLabTokenRotationService(
  dependencies: GitLabTokenRotationDependencies = {},
): GitLabTokenRotationService {
  return new GitLabTokenRotationService(dependencies);
}
