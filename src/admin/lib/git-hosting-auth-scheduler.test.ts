import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GhStatusDetails } from "./gh-auth";
import type { GitHostingAuthState } from "./git-hosting-auth-state";
import { GitHostingAuthScheduler, readGitHostingAuthSchedulerConfig } from "./git-hosting-auth-scheduler";
import type { GitLabInspectionResult, GitLabRotationOptions, GitLabRotationResult } from "./gitlab-token-rotation";
import type { GlabInstance } from "./glab-auth";

const NOW = Date.parse("2026-10-22T00:00:00.000Z");
const HOST: GlabInstance = { hostname: "gitlab.example.com", username: "alice", authenticated: true };
const GITHUB: GhStatusDetails = { validity: "valid", expiry: "unknown", expiry_unknown: true, reauthorization_guidance: null };
const INSPECTION: GitLabInspectionResult = {
  ok: true,
  metadata: { active: true, revoked: false, expiresAt: "2026-11-30", scopes: ["read_repository", "self_rotate"], impersonation: false },
};
const METADATA = INSPECTION.ok ? INSPECTION.metadata : { active: true, revoked: false, expiresAt: null, scopes: [], impersonation: false };

function healthyState(): GitHostingAuthState {
  return { gitlab: [], github: { validity: "unreachable", expiry: "unknown", expiry_known: false, expiry_unknown: true, checked_at: "" } };
}

function rotation(overrides: Partial<Extract<GitLabRotationResult, { readonly ok: true; readonly rotated: false }>> = {}): GitLabRotationResult {
  return { ok: true, rotated: false, metadata: METADATA, ...overrides };
}

function scheduler(overrides: ConstructorParameters<typeof GitHostingAuthScheduler>[0] = {}): GitHostingAuthScheduler {
  return new GitHostingAuthScheduler({
    listHosts: async () => [HOST],
    inspectHost: async () => INSPECTION,
    rotateHost: async () => rotation(),
    checkGitHub: async () => GITHUB,
    loadState: healthyState,
    saveState: () => undefined,
    now: () => NOW,
    ...overrides,
  });
}

describe("Git hosting auth scheduler", () => {
  test("runs immediately on startup and does not start twice", async () => {
    let evaluations = 0;
    const instance = scheduler({ listHosts: async () => { evaluations += 1; return []; } });
    instance.start();
    instance.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    instance.stop();
    expect(evaluations).toBe(1);
  });

  test("rotates a host within the configured threshold and persists a healthy summary", async () => {
    let rotateOptions: GitLabRotationOptions | undefined;
    let saved: GitHostingAuthState | undefined;
    const result = await scheduler({
      inspectHost: async () => ({ ...INSPECTION, metadata: { ...METADATA, expiresAt: "2026-10-25" } }),
      rotateHost: async (_hostname, options) => { rotateOptions = options; return { ok: true, rotated: true, expiresAt: "2026-11-21" }; },
      thresholdDays: 7,
      lifetimeDays: 30,
      saveState: (state) => { saved = state; },
    }).tick();
    expect(rotateOptions).toEqual({ thresholdDays: 7, lifetimeDays: 30 });
    expect(result.gitlab[0]?.rotation_done).toBe(true);
    expect(saved?.gitlab[0]?.expires_at).toBe("2026-11-21");
  });

  test("persists empty healthy GitLab state when no hosts are configured", async () => {
    const result = await scheduler({ listHosts: async () => [] }).tick();
    expect(result.gitlab).toEqual([]);
    expect(result.github.validity).toBe("valid");
  });

  test("captures host failures as stable codes without logging exception text", async () => {
    const messages: string[] = [];
    const originalError = console.error;
    console.error = (...parts: unknown[]): void => { messages.push(parts.join(" ")); };
    try {
      const result = await scheduler({ inspectHost: async () => { throw new Error("glpat-secret-token"); } }).tick();
      expect(result.gitlab[0]?.error_code).toBe("unreachable");
      expect(messages.join(" ")).not.toContain("glpat-secret-token");
    } finally {
      console.error = originalError;
    }
  });

  test("skips an overlapping tick", async () => {
    let release: (() => void) | undefined;
    let inspected = 0;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const instance = scheduler({ inspectHost: async () => { inspected += 1; await pending; return INSPECTION; } });
    const first = instance.tick();
    const second = await instance.tick();
    expect(second.skipped).toBe(true);
    release?.();
    await first;
    expect(inspected).toBe(1);
  });

  test("uses defaults for invalid environment numbers", () => {
    expect(readGitHostingAuthSchedulerConfig({
      GIT_HOSTING_AUTH_CHECK_INTERVAL_MS: "bad",
      GITLAB_TOKEN_ROTATION_THRESHOLD_DAYS: "0",
      GITLAB_TOKEN_ROTATION_LIFETIME_DAYS: "NaN",
    })).toEqual({ intervalMs: 86_400_000, thresholdDays: 7, lifetimeDays: 30 });
  });

  test.each(["0", "-1", "1.5", "not-a-number"])("fails closed for explicitly invalid lifetime %s and skips rotation", async (lifetime) => {
    let rotations = 0;
    const result = await scheduler({
      environment: { GITLAB_TOKEN_ROTATION_LIFETIME_DAYS: lifetime },
      inspectHost: async () => ({ ...INSPECTION, metadata: { ...METADATA, expiresAt: "2026-10-25" } }),
      rotateHost: async () => { rotations += 1; return rotation(); },
    }).tick();

    expect(rotations).toBe(0);
    expect(result.gitlab[0]?.error_code).toBe("configuration_invalid");
  });

  test("supports a temporary environment-selected state path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "git-hosting-auth-scheduler-"));
    const previous = process.env.GIT_HOSTING_AUTH_STATE_PATH;
    process.env.GIT_HOSTING_AUTH_STATE_PATH = join(directory, "state.json");
    try {
      const result = await new GitHostingAuthScheduler({
        listHosts: async () => [HOST],
        inspectHost: async () => INSPECTION,
        rotateHost: async () => rotation(),
        checkGitHub: async () => GITHUB,
        now: () => NOW,
      }).tick();
      expect(result.gitlab).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env.GIT_HOSTING_AUTH_STATE_PATH;
      else process.env.GIT_HOSTING_AUTH_STATE_PATH = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
