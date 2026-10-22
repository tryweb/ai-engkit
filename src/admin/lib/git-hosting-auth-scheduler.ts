/** Scheduler state and in-flight protection are single-process; multi-process replicas are not protected. */
import {
  GITLAB_TOKEN_ROTATION_ERROR_CODES,
  createGitLabTokenRotationService,
  type GitLabInspectionResult,
  type GitLabRotationOptions,
  type GitLabRotationResult,
  type GitLabTokenRotationErrorCode,
} from "./gitlab-token-rotation";
import {
  EMPTY_GIT_HOSTING_AUTH_STATE,
  loadGitHostingAuthState,
  saveGitHostingAuthState,
  withGitHostingAuthStateLock,
  type GitHostingAuthState,
  type GitLabAuthHostState,
} from "./git-hosting-auth-state";
import { getGhStatusDetails, type GhStatusDetails } from "./gh-auth";
import { listGlabInstances, type GlabInstance } from "./glab-auth";

export const DEFAULT_GIT_HOSTING_AUTH_CHECK_INTERVAL_MS = 86_400_000;
export const DEFAULT_GITLAB_TOKEN_ROTATION_THRESHOLD_DAYS = 7;
export const DEFAULT_GITLAB_TOKEN_ROTATION_LIFETIME_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const ROTATION_CODES = new Set<string>(GITLAB_TOKEN_ROTATION_ERROR_CODES);

export interface GitHostingAuthSchedulerConfig {
  readonly intervalMs: number;
  readonly thresholdDays: number;
  readonly lifetimeDays: number;
}

export interface GitHostingAuthSchedulerDependencies {
  readonly listHosts?: () => Promise<readonly GlabInstance[]>;
  readonly inspectHost?: (hostname: string) => Promise<GitLabInspectionResult>;
  readonly rotateHost?: (hostname: string, options: GitLabRotationOptions) => Promise<GitLabRotationResult>;
  readonly checkGitHub?: () => Promise<GhStatusDetails>;
  readonly loadState?: () => GitHostingAuthState;
  readonly saveState?: (state: GitHostingAuthState) => void;
  readonly withStateLock?: <T>(operation: () => T | Promise<T>) => Promise<T>;
  readonly now?: () => number;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly intervalMs?: number;
  readonly thresholdDays?: number;
  readonly lifetimeDays?: number;
  readonly gitlabVersion?: string;
}

export interface GitHostingAuthTickSummary extends GitHostingAuthState {
  readonly skipped: boolean;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function validLifetime(value: string | undefined): boolean {
  if (value === undefined || value.trim() === "") return true;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0;
}

function configFromEnvironment(environment: Readonly<Record<string, string | undefined>>): GitHostingAuthSchedulerConfig {
  return {
    intervalMs: positiveNumber(environment.GIT_HOSTING_AUTH_CHECK_INTERVAL_MS, DEFAULT_GIT_HOSTING_AUTH_CHECK_INTERVAL_MS),
    thresholdDays: positiveNumber(environment.GITLAB_TOKEN_ROTATION_THRESHOLD_DAYS, DEFAULT_GITLAB_TOKEN_ROTATION_THRESHOLD_DAYS),
    lifetimeDays: positiveNumber(environment.GITLAB_TOKEN_ROTATION_LIFETIME_DAYS, DEFAULT_GITLAB_TOKEN_ROTATION_LIFETIME_DAYS),
  };
}

function isRotationCode(value: string): value is GitLabTokenRotationErrorCode {
  return ROTATION_CODES.has(value);
}

function errorCode(error: unknown): GitLabTokenRotationErrorCode {
  if (error instanceof Error && isRotationCode(error.name)) return error.name;
  return "unreachable";
}

function daysRemaining(expiresAt: string | null, now: number): number | null {
  if (expiresAt === null) return null;
  const expiry = Date.parse(`${expiresAt}T00:00:00Z`);
  return Number.isFinite(expiry) ? Math.ceil((expiry - now) / DAY_MS) : null;
}

function hostState(
  hostname: string,
  inspection: GitLabInspectionResult,
  rotation: GitLabRotationResult | null,
  now: number,
  thresholdDays: number,
): GitLabAuthHostState {
  const checkedAt = new Date(now).toISOString();
  if (inspection.ok === false) {
    return { hostname, validity: "unhealthy", expires_at: null, days_remaining: null, rotation_needed: false, rotation_done: false, error_code: inspection.code, checked_at: checkedAt };
  }
  const metadata = rotation?.ok === true && rotation.rotated === false ? rotation.metadata : inspection.metadata;
  const expiresAt = rotation?.ok && rotation.rotated ? rotation.expiresAt : metadata.expiresAt;
  const rotationNeeded = expiresAt !== null && daysRemaining(expiresAt, now) !== null && (daysRemaining(expiresAt, now) ?? 0) <= thresholdDays;
  if (rotation?.ok === false) {
    return { hostname, validity: "unhealthy", expires_at: expiresAt, days_remaining: daysRemaining(expiresAt, now), rotation_needed: rotationNeeded, rotation_done: false, error_code: rotation.code, checked_at: checkedAt };
  }
  return { hostname, validity: "healthy", expires_at: expiresAt, days_remaining: daysRemaining(expiresAt, now), rotation_needed: rotationNeeded, rotation_done: rotation?.ok === true && rotation.rotated, error_code: null, checked_at: checkedAt };
}

function githubState(details: GhStatusDetails, now: number): GitHostingAuthState["github"] {
  return {
    validity: details.validity,
    expiry: details.expiry,
    expiry_known: !details.expiry_unknown,
    expiry_unknown: details.expiry_unknown,
    checked_at: new Date(now).toISOString(),
  };
}

export function readGitHostingAuthSchedulerConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): GitHostingAuthSchedulerConfig {
  return configFromEnvironment(environment);
}

export class GitHostingAuthScheduler {
  private readonly listHosts: () => Promise<readonly GlabInstance[]>;
  private readonly inspectHost: (hostname: string) => Promise<GitLabInspectionResult>;
  private readonly rotateHost: (hostname: string, options: GitLabRotationOptions) => Promise<GitLabRotationResult>;
  private readonly checkGitHub: () => Promise<GhStatusDetails>;
  private readonly loadState: () => GitHostingAuthState;
  private readonly saveState: (state: GitHostingAuthState) => void;
  private readonly withStateLock: <T>(operation: () => T | Promise<T>) => Promise<T>;
  private readonly now: () => number;
  private readonly config: GitHostingAuthSchedulerConfig;
  private readonly gitlabVersion: string | undefined;
  private readonly lifetimeConfigurationInvalid: boolean;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  public constructor(dependencies: GitHostingAuthSchedulerDependencies = {}) {
    const environment = dependencies.environment ?? process.env;
    const rotation = createGitLabTokenRotationService({ environment, now: dependencies.now });
    const environmentConfig = configFromEnvironment(environment);
    this.listHosts = dependencies.listHosts ?? listGlabInstances;
    this.inspectHost = dependencies.inspectHost ?? ((hostname) => rotation.inspect(hostname));
    this.rotateHost = dependencies.rotateHost ?? ((hostname, options) => rotation.rotateIfNeeded(hostname, options));
    this.checkGitHub = dependencies.checkGitHub ?? getGhStatusDetails;
    this.loadState = dependencies.loadState ?? loadGitHostingAuthState;
    this.saveState = dependencies.saveState ?? saveGitHostingAuthState;
    this.withStateLock = dependencies.withStateLock ?? withGitHostingAuthStateLock;
    this.now = dependencies.now ?? Date.now;
    this.config = {
      intervalMs: dependencies.intervalMs ?? environmentConfig.intervalMs,
      thresholdDays: dependencies.thresholdDays ?? environmentConfig.thresholdDays,
      lifetimeDays: dependencies.lifetimeDays ?? environmentConfig.lifetimeDays,
    };
    this.gitlabVersion = dependencies.gitlabVersion;
    this.lifetimeConfigurationInvalid = !validLifetime(environment.GITLAB_TOKEN_ROTATION_LIFETIME_DAYS);
  }

  public async tick(): Promise<GitHostingAuthTickSummary> {
    if (this.inFlight) return { ...this.loadState(), skipped: true };
    this.inFlight = true;
    const checkedAt = this.now();
    const hostStates: GitLabAuthHostState[] = [];
    try {
      let hosts: readonly GlabInstance[] = [];
      try {
        hosts = await this.listHosts();
      } catch (error: unknown) {
        console.error("Git hosting auth scheduler host discovery failed: unreachable");
      }
      for (const host of hosts) {
        let inspection: GitLabInspectionResult;
        try {
          inspection = await this.inspectHost(host.hostname);
        } catch (error: unknown) {
          console.error(`Git hosting auth scheduler ${host.hostname}: ${errorCode(error)}`);
          inspection = { ok: false, code: errorCode(error) };
        }
        let rotation: GitLabRotationResult | null = null;
        if (inspection.ok && inspection.metadata.expiresAt !== null && (daysRemaining(inspection.metadata.expiresAt, checkedAt) ?? 0) <= this.config.thresholdDays) {
          if (this.lifetimeConfigurationInvalid) {
            rotation = { ok: false, code: "configuration_invalid" };
          } else {
            try {
              rotation = await this.rotateHost(host.hostname, {
                ...(this.gitlabVersion === undefined ? {} : { gitlabVersion: this.gitlabVersion }),
                thresholdDays: this.config.thresholdDays,
                lifetimeDays: this.config.lifetimeDays,
              });
            } catch (error: unknown) {
              const code = errorCode(error);
              console.error(`Git hosting auth scheduler ${host.hostname}: ${code}`);
              rotation = { ok: false, code };
            }
          }
        }
        hostStates.push(hostState(host.hostname, inspection, rotation, checkedAt, this.config.thresholdDays));
      }
      let github = EMPTY_GIT_HOSTING_AUTH_STATE.github;
      try {
        github = githubState(await this.checkGitHub(), checkedAt);
      } catch (error: unknown) {
        console.error("Git hosting auth scheduler GitHub check failed: unreachable");
      }
      const state: GitHostingAuthState = { gitlab: hostStates, github };
      try {
        await this.withStateLock(() => this.saveState(state));
      } catch (error: unknown) {
        console.error("Git hosting auth scheduler state persistence failed: persistence_failed");
      }
      return { ...state, skipped: false };
    } finally {
      this.inFlight = false;
    }
  }

  public start(): void {
    if (this.timer !== null) return;
    // Startup evaluation is intentionally fire-and-forget so server startup is not blocked by credentials.
    void this.tick().catch(() => console.error("Git hosting auth scheduler startup failed: unreachable"));
    this.timer = setInterval(() => {
      void this.tick().catch(() => console.error("Git hosting auth scheduler evaluation failed: unreachable"));
    }, this.config.intervalMs);
  }

  public stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

export function createGitHostingAuthScheduler(
  dependencies: GitHostingAuthSchedulerDependencies = {},
): GitHostingAuthScheduler {
  return new GitHostingAuthScheduler(dependencies);
}
