import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { GhExpiry, GhValidity } from "./gh-auth";
import {
  GITLAB_TOKEN_ROTATION_ERROR_CODES,
  type GitLabTokenRotationErrorCode,
} from "./gitlab-token-rotation";

export const GIT_HOSTING_AUTH_STATE_DEFAULT_PATH = "/opt/ai-engkit/admin-data/git-hosting-auth-state.json";

export type GitLabAuthValidity = "healthy" | "unhealthy";

export interface GitLabAuthHostState {
  readonly hostname: string;
  readonly validity: GitLabAuthValidity;
  readonly expires_at: string | null;
  readonly days_remaining: number | null;
  readonly rotation_needed: boolean;
  readonly rotation_done: boolean;
  readonly error_code: GitLabTokenRotationErrorCode | null;
  readonly checked_at: string;
}

export interface GitHubAuthSummary {
  readonly validity: GhValidity;
  readonly expiry: GhExpiry;
  readonly expiry_known: boolean;
  readonly expiry_unknown: boolean;
  readonly checked_at: string;
}

export interface GitHostingAuthState {
  readonly gitlab: readonly GitLabAuthHostState[];
  readonly github: GitHubAuthSummary;
}

const EMPTY_GITHUB: GitHubAuthSummary = {
  validity: "unreachable",
  expiry: "unknown",
  expiry_known: false,
  expiry_unknown: true,
  checked_at: "",
};

export const EMPTY_GIT_HOSTING_AUTH_STATE: GitHostingAuthState = {
  gitlab: [],
  github: EMPTY_GITHUB,
};

let stateLock: Promise<void> = Promise.resolve();

export async function withGitHostingAuthStateLock<T>(operation: () => T | Promise<T>): Promise<T> {
  const previous = stateLock;
  let release = (): void => undefined;
  stateLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

const ERROR_CODES = new Set<string>(GITLAB_TOKEN_ROTATION_ERROR_CODES);

function statePath(): string {
  return process.env.GIT_HOSTING_AUTH_STATE_PATH || GIT_HOSTING_AUTH_STATE_DEFAULT_PATH;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll("_", "-");
  return normalized === "token" || normalized === "private-token" || normalized === "raw-body" || normalized === "body";
}

function warnSecretKey(key: string): void {
  console.warn(`Dropped secret-bearing auth state key: ${key}`);
}

function stripSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (isSecretKey(key)) {
      warnSecretKey(key);
      continue;
    }
    result[key] = stripSecrets(child);
  }
  return result;
}

function isGitLabHostState(value: unknown): value is GitLabAuthHostState {
  if (!isRecord(value)) return false;
  const validity = value.validity;
  const errorCode = value.error_code;
  return typeof value.hostname === "string" &&
    (validity === "healthy" || validity === "unhealthy") &&
    (value.expires_at === null || typeof value.expires_at === "string") &&
    (value.days_remaining === null || (typeof value.days_remaining === "number" && Number.isFinite(value.days_remaining))) &&
    typeof value.rotation_needed === "boolean" &&
    typeof value.rotation_done === "boolean" &&
    (errorCode === null || (typeof errorCode === "string" && ERROR_CODES.has(errorCode))) &&
    typeof value.checked_at === "string";
}

function isGitHubSummary(value: unknown): value is GitHubAuthSummary {
  if (!isRecord(value)) return false;
  const validity = value.validity;
  const expiry = value.expiry;
  return (validity === "valid" || validity === "invalid-revoked-expired" || validity === "unreachable") &&
    (expiry === "known-within-threshold" || expiry === "unknown") &&
    typeof value.expiry_known === "boolean" &&
    typeof value.expiry_unknown === "boolean" &&
    typeof value.checked_at === "string";
}

function parseState(value: unknown): GitHostingAuthState | null {
  if (!isRecord(value) || !Array.isArray(value.gitlab) || !isGitHubSummary(value.github)) return null;
  if (!value.gitlab.every(isGitLabHostState)) return null;
  return { gitlab: value.gitlab, github: value.github };
}

function redactedState(value: GitHostingAuthState): GitHostingAuthState {
  const stripped = stripSecrets(value);
  const parsed = parseState(stripped);
  return parsed ?? EMPTY_GIT_HOSTING_AUTH_STATE;
}

export function loadGitHostingAuthState(): GitHostingAuthState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath(), "utf8"));
    return parseState(stripSecrets(parsed)) ?? EMPTY_GIT_HOSTING_AUTH_STATE;
  } catch {
    return EMPTY_GIT_HOSTING_AUTH_STATE;
  }
}

export function saveGitHostingAuthState(state: GitHostingAuthState): void {
  const path = statePath();
  const tmp = join(dirname(path), `.git-hosting-auth-state.${process.pid}.${randomUUID()}.tmp`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(redactedState(state), null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}
