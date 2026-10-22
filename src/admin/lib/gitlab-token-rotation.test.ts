import { describe, expect, test } from "bun:test";
import type { ExecOptions, ExecResult } from "./docker";
import { GitLabTokenRotationService, type GitLabFetch, type GitLabRotationOptions } from "./gitlab-token-rotation";
import { loginGlabWithToken, type GlabCommand } from "./glab-auth";

const NOW = Date.parse("2026-01-01T00:00:00Z");
const HOST = "gitlab.example.com";
const OPTIONS: GitLabRotationOptions = { gitlabVersion: "17.9.1" };

function commandFake(token = "glpat-current"): (command: string, timeoutMs: number) => Promise<ExecResult> {
  return async (command) => ({
    stdout: command.includes("config.yml") ? `${token}\n` : "",
    stderr: "",
    exitCode: 0,
  });
}

function response(metadata: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(metadata), { status });
}

function service(
  metadata: Record<string, unknown>,
  overrides: {
    readonly fetchFn?: GitLabFetch;
    readonly command?: (command: string, timeoutMs: number) => Promise<ExecResult>;
    readonly login?: typeof loginGlabWithToken;
    readonly environment?: Readonly<Record<string, string | undefined>>;
  } = {},
): GitLabTokenRotationService {
  return new GitLabTokenRotationService({
    now: () => NOW,
    fetchFn: overrides.fetchFn ?? (async () => response(metadata)),
    command: overrides.command ?? commandFake(),
    login: overrides.login,
    environment: overrides.environment ?? {},
  });
}

function metadata(expiresAt: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    active: true,
    revoked: false,
    expires_at: expiresAt,
    scopes: ["read_repository", "self_rotate"],
    impersonation: false,
    ...extra,
  };
}

describe("GitLab token rotation", () => {
  test("returns metadata without rotating a healthy token", async () => {
    const calls: string[] = [];
    const result = await service(metadata("2026-02-01"), {
      fetchFn: async (input) => {
        calls.push(String(input));
        return response(metadata("2026-02-01"));
      },
    }).rotateIfNeeded(HOST, OPTIONS);

    expect(result).toEqual({
      ok: true,
      rotated: false,
      metadata: {
        active: true,
        revoked: false,
        expiresAt: "2026-02-01",
        scopes: ["read_repository", "self_rotate"],
        impersonation: false,
      },
    });
    expect(calls).toHaveLength(1);
  });

  test("rotates a token within the threshold and verifies the helper", async () => {
    const calls: string[] = [];
    const commandCalls: Array<{ readonly command: string; readonly options?: ExecOptions }> = [];
    const command: GlabCommand = async (commandText, _timeoutMs, options) => {
      commandCalls.push({ command: commandText, options });
      return {
        stdout: commandText.includes("config.yml") ? "glpat-current\n" : "",
        stderr: "",
        exitCode: 0,
      };
    };
    const result = await service(metadata("2026-01-05"), {
      command,
      fetchFn: async (input, init) => {
        calls.push(`${String(input)} ${init?.method ?? "GET"}`);
        return init?.method === "POST"
          ? response({ token: "glpat-replacement", expires_at: "2026-01-31" })
          : response(metadata("2026-01-05"));
      },
      login: (hostname, token, loginCommand) => loginGlabWithToken(hostname, token, loginCommand),
    }).rotateIfNeeded(HOST, OPTIONS);

    expect(result).toEqual({ ok: true, rotated: true, expiresAt: "2026-01-31" });
    expect(calls).toEqual([
      `https://${HOST}/api/v4/personal_access_tokens/self GET`,
      `https://${HOST}/api/v4/personal_access_tokens/self/rotate POST`,
    ]);
    const loginCall = commandCalls.find(({ command: commandText }) => commandText.startsWith("glab auth login"));
    expect(loginCall?.command).toContain(`glab auth login --hostname "${HOST}" --stdin`);
    expect(loginCall?.command).not.toContain("glpat-replacement");
    expect(loginCall?.options?.stdin).toBe("glpat-replacement\n");
  });

  test("does not rotate an expired token", async () => {
    const result = await service(metadata("2025-12-31")).rotateIfNeeded(HOST, OPTIONS);

    expect(result).toEqual({ ok: false, code: "invalid_expired" });
  });

  test("accepts metadata without an impersonation field as a regular PAT", async () => {
    const { impersonation: _omit, ...noFlag } = metadata("2026-02-01");
    const result = await service(noFlag).rotateIfNeeded(HOST, OPTIONS);

    expect(result).toEqual({
      ok: true,
      rotated: false,
      metadata: {
        active: true,
        revoked: false,
        expiresAt: "2026-02-01",
        scopes: ["read_repository", "self_rotate"],
        impersonation: false,
      },
    });
  });

  test("treats a token without expiry as healthy without rotation", async () => {
    const result = await service(metadata("2026-02-01", { expires_at: null })).rotateIfNeeded(HOST, OPTIONS);

    expect(result).toEqual({
      ok: true,
      rotated: false,
      metadata: {
        active: true,
        revoked: false,
        expiresAt: null,
        scopes: ["read_repository", "self_rotate"],
        impersonation: false,
      },
    });
  });

  test("rejects a token missing self_rotate scope", async () => {
    const result = await service(metadata("2026-01-05", { scopes: ["read_repository"] })).rotateIfNeeded(HOST, OPTIONS);

    expect(result).toEqual({ ok: false, code: "insufficient_scope" });
  });

  test("fails closed for GitLab versions below 17.9", async () => {
    const result = await service(metadata("2026-01-05")).rotateIfNeeded(HOST, { gitlabVersion: "17.8.6" });

    expect(result).toEqual({ ok: false, code: "unsupported_version" });
  });

  test("fetches the per-host version before rotating when no version is supplied", async () => {
    const calls: Array<{ readonly url: string; readonly method: string }> = [];
    const result = await service(metadata("2026-01-05"), {
      fetchFn: async (input, init) => {
        calls.push({ url: String(input), method: init?.method ?? "GET" });
        if (String(input).endsWith("/version")) return response({ version: "17.9.2" });
        return init?.method === "POST"
          ? response({ token: "glpat-replacement", expires_at: "2026-01-31" })
          : response(metadata("2026-01-05"));
      },
      login: async () => ({ ok: true }),
    }).rotateIfNeeded(HOST);

    expect(result).toEqual({ ok: true, rotated: true, expiresAt: "2026-01-31" });
    expect(calls.map(({ url, method }) => `${url} ${method}`)).toEqual([
      `https://${HOST}/api/v4/personal_access_tokens/self GET`,
      `https://${HOST}/api/v4/version GET`,
      `https://${HOST}/api/v4/personal_access_tokens/self/rotate POST`,
    ]);
  });

  test("does not rotate when the per-host version is unknown", async () => {
    let postCalls = 0;
    const result = await service(metadata("2026-01-05"), {
      fetchFn: async (input, init) => {
        if (init?.method === "POST") postCalls += 1;
        return String(input).endsWith("/version") ? response({ version: "not-semver" }) : response(metadata("2026-01-05"));
      },
    }).rotateIfNeeded(HOST);

    expect(result).toEqual({ ok: false, code: "version_unknown" });
    expect(postCalls).toBe(0);
  });

  test("requires explicit confirmation for impersonation rotation", async () => {
    const result = await service(metadata("2026-01-05", { impersonation: true })).rotateIfNeeded(HOST, OPTIONS);

    expect(result).toEqual({ ok: false, code: "impersonation_unconfirmed" });
  });

  test("reports ambiguous rotation without retrying", async () => {
    let postCalls = 0;
    const result = await service(metadata("2026-01-05"), {
      fetchFn: async (_input, init) => {
        if (init?.method === "POST") {
          postCalls += 1;
          throw new TypeError("network timeout");
        }
        return response(metadata("2026-01-05"));
      },
    }).rotateIfNeeded(HOST, OPTIONS);

    expect(result).toEqual({ ok: false, code: "ambiguous_rotation" });
    expect(postCalls).toBe(1);
  });

  test("reports persistence failure when helper verification fails", async () => {
    let loginCalls = 0;
    const result = await service(metadata("2026-01-05"), {
      command: async (command) => ({
        stdout: command.includes("config.yml") ? "glpat-current\n" : "",
        stderr: "",
        exitCode: command.includes("git credential fill") ? 1 : 0,
      }),
      fetchFn: async (_input, init) => init?.method === "POST"
        ? response({ token: "glpat-replacement", expires_at: "2026-01-31" })
        : response(metadata("2026-01-05")),
      login: async () => {
        loginCalls += 1;
        return { ok: true };
      },
    }).rotateIfNeeded(HOST, OPTIONS);

    expect(result).toEqual({ ok: false, code: "persistence_failed" });
    expect(loginCalls).toBe(1);
  });
});
