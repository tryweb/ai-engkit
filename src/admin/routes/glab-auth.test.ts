import { describe, expect, test } from "bun:test";
import type { GitHostingAuthState } from "../lib/git-hosting-auth-state";
import type { GitLabRotationOptions, GitLabRotationResult } from "../lib/gitlab-token-rotation";
import { createGlabAuth } from "./glab-auth";

const EMPTY_STATE: GitHostingAuthState = {
  gitlab: [],
  github: { validity: "unreachable", expiry: "unknown", expiry_known: false, expiry_unknown: true, checked_at: "" },
};

function route(result: GitLabRotationResult, overrides: {
  readonly loadState?: () => GitHostingAuthState;
  readonly saveState?: (state: GitHostingAuthState) => void;
} = {}) {
  return createGlabAuth({
    listInstances: async () => [],
    loginWithToken: async () => ({ ok: true }),
    logout: async () => undefined,
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    rotate: async (_hostname: string, _options: GitLabRotationOptions) => result,
    loadState: overrides.loadState ?? (() => EMPTY_STATE),
    saveState: overrides.saveState ?? (() => undefined),
    now: () => Date.parse("2026-10-22T00:00:00.000Z"),
  });
}

function responseResult(): Extract<GitLabRotationResult, { readonly ok: true; readonly rotated: true }> {
  return { ok: true, rotated: true, expiresAt: "2026-11-21" };
}

describe("POST /api/auth/glab/rotate", () => {
  test("Given a valid hostname, When rotation succeeds, Then it persists and returns only the redacted result", async () => {
    let saved: GitHostingAuthState | undefined;
    const app = route(responseResult(), { saveState: (state) => { saved = state; } });

    const response = await app.request("http://localhost/api/auth/glab/rotate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostname: "gitlab.example.com" }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ ok: true, hostname: "gitlab.example.com", rotated: true, errorCode: null });
    expect(JSON.stringify(body)).not.toContain("token");
    expect(saved?.gitlab[0]).toMatchObject({ hostname: "gitlab.example.com", rotation_done: true, expires_at: "2026-11-21", error_code: null });
  });

  test("Given a non-bare hostname, When rotation is requested, Then it rejects without invoking the service", async () => {
    let calls = 0;
    const app = createGlabAuth({
      listInstances: async () => [], loginWithToken: async () => ({ ok: true }), logout: async () => undefined,
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }), rotate: async () => { calls += 1; return responseResult(); },
      loadState: () => EMPTY_STATE, saveState: () => undefined, now: Date.now,
    });

    const response = await app.request("http://localhost/api/auth/glab/rotate", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hostname: "https://gitlab.example.com", token: "secret" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, hostname: "", rotated: false, errorCode: "invalid_hostname" });
    expect(calls).toBe(0);
  });

  test.each([
    ["invalid_expired", 200], ["insufficient_scope", 403], ["unsupported_version", 403],
    ["impersonation_unconfirmed", 403], ["ambiguous_rotation", 500], ["persistence_failed", 500], ["version_unknown", 502], ["configuration_invalid", 500], ["unreachable", 502],
  ] as const)("maps %s to HTTP %s and persists redacted state", async (code, status) => {
    const app = route({ ok: false, code });
    const response = await app.request("http://localhost/api/auth/glab/rotate", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hostname: "gitlab.example.com" }),
    });

    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body).toEqual({ ok: false, hostname: "gitlab.example.com", rotated: false, errorCode: code });
    expect(JSON.stringify(body)).not.toContain("token");
  });

  test("GET status includes persisted detail without exposing token material", async () => {
    const app = route(responseResult(), {
      loadState: () => ({
        ...EMPTY_STATE,
        gitlab: [{ hostname: "gitlab.example.com", validity: "healthy", expires_at: "2026-11-21", days_remaining: 30, rotation_needed: false, rotation_done: true, error_code: null, checked_at: "2026-10-22T00:00:00.000Z" }],
      }),
    });

    const response = await app.request("http://localhost/api/auth/glab/status");
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.detail.gitlab[0].hostname).toBe("gitlab.example.com");
    expect(JSON.stringify(body)).not.toContain("token");
  });
});
