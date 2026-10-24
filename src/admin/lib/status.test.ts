import { describe, expect, test } from "bun:test";
import { collectStatus, type StatusDeps } from "./status";
import type { ExecResult } from "./docker";
import {
  EMPTY_GIT_HOSTING_AUTH_STATE,
  type GitHostingAuthState,
} from "./git-hosting-auth-state";
import type { GainStats, LeanCtxSiteStats } from "./project-tool-status";

const ok = (stdout: string): ExecResult => ({ stdout, stderr: "", exitCode: 0 });

interface DepOverrides {
  adminDigest?: string;
  aiDevDigest?: string;
  running?: boolean;
  uptime?: number | null;
  leanctx?: LeanCtxSiteStats | null;
  gain?: GainStats | null;
  gitHostingAuth?: GitHostingAuthState;
  loadGitHostingAuthState?: () => GitHostingAuthState;
}

/** Full fake dep set: gh/glab authenticated, git user "u", 3 projects. */
function makeDeps(overrides: DepOverrides = {}): StatusDeps {
  const adminDigest = overrides.adminDigest ?? "sha256:aaa";
  const aiDevDigest = overrides.aiDevDigest ?? "sha256:aaa";
  return {
    isAiDevRunning: async () => overrides.running ?? true,
    getAiDevUptime: async () => (overrides.uptime === undefined ? 3600 : overrides.uptime),
    getAiDevContainerRef: async () => "aidev-ref",
    getSelfContainerRef: async () => "self-ref",
    dockerCommand: async (subcommand: string) => {
      if (subcommand.includes("State.StartedAt")) return ok(new Date(0).toISOString());
      return ok(subcommand.includes("self-ref") ? adminDigest : aiDevDigest);
    },
    execInAiDev: async (command: string) => {
      if (command.startsWith("gh auth")) return ok("Logged in to github.com");
      if (command.startsWith("glab auth")) return ok("Logged in to gitlab.com");
      if (command.startsWith("git config")) return ok("u");
      if (command.startsWith("ls ~/workspace/")) return ok("3");
      if (command.startsWith("cat /opt/ai-engkit/VERSION")) return ok("1.2.3");
      return ok("");
    },
    loadGitHostingAuthState: overrides.loadGitHostingAuthState ?? (() => overrides.gitHostingAuth ?? EMPTY_GIT_HOSTING_AUTH_STATE),
    probeLeanCtxSite: overrides.leanctx === undefined ? undefined : async () => overrides.leanctx ?? null,
    probeGain: overrides.gain === undefined ? undefined : async () => overrides.gain ?? null,
  };
}

describe("collectStatus", () => {
  test("assembles the pinned status shape from injected deps", async () => {
    const status = await collectStatus(makeDeps());
    expect(Object.keys(status).sort()).toEqual([
      "admin_version",
      "admin_version_mismatch",
      "container_status",
      "containers",
      "gain",
      "gh_auth",
      "git_hosting_auth",
      "git_user",
      "glab_auth",
      "leanctx",
      "project_count",
      "proveReport",
      "restart_count",
      "savingsReport",
      "uptime_seconds",
      "valueReport",
    ]);
    expect(status).toMatchObject({
      container_status: "running",
      uptime_seconds: 3600,
      restart_count: 0,
      gh_auth: "authenticated",
      glab_auth: "authenticated",
      git_user: "u",
      project_count: 3,
      admin_version_mismatch: false,
      git_hosting_auth: { available: false },
    });
    expect(typeof status.admin_version).toBe("string");
  });

  test("reports per-container status, uptime, and version for ai-dev and ai-admin", async () => {
    const status = await collectStatus(makeDeps());
    expect(status.containers).toEqual({
      "ai-dev": {
        status: "running",
        uptime_seconds: 3600,
        version: "1.2.3",
      },
      "ai-admin": {
        status: "running",
        uptime_seconds: expect.any(Number),
        version: status.admin_version,
      },
    });
  });

  test("flags admin_version_mismatch when the image digests differ", async () => {
    const status = await collectStatus(makeDeps({ adminDigest: "sha256:aaa", aiDevDigest: "sha256:bbb" }));
    expect(status.admin_version_mismatch).toBe(true);
  });

  test("reports a stopped container and unauthenticated CLIs", async () => {
    const deps = makeDeps({ running: false, uptime: null });
    deps.execInAiDev = async (command: string) => {
      if (command.startsWith("gh auth") || command.startsWith("glab auth")) {
        return { stdout: "", stderr: "not logged in", exitCode: 1 };
      }
      if (command.startsWith("git config")) return ok("");
      if (command.startsWith("ls ~/workspace/")) return ok("0");
      return ok("");
    };
    const status = await collectStatus(deps);
    expect(status.container_status).toBe("stopped");
    expect(status.uptime_seconds).toBeNull();
    expect(status.gh_auth).toBe("not authenticated");
    expect(status.glab_auth).toBe("not authenticated");
    expect(status.project_count).toBe(0);
  });

  test("includes the redacted persisted git hosting auth state", async () => {
    const authState: GitHostingAuthState = {
      gitlab: [{
        hostname: "gitlab.example.com",
        validity: "healthy",
        expires_at: "2026-12-31T00:00:00.000Z",
        days_remaining: 70,
        rotation_needed: false,
        rotation_done: false,
        error_code: null,
        checked_at: "2026-10-22T00:00:00.000Z",
      }],
      github: {
        validity: "valid",
        expiry: "known-within-threshold",
        expiry_known: true,
        expiry_unknown: false,
        checked_at: "2026-10-22T00:00:00.000Z",
      },
    };

    const status = await collectStatus(makeDeps({ gitHostingAuth: authState }));

    expect(status.git_hosting_auth).toEqual({ available: true, ...authState });
    expect(status.gh_auth).toBe("authenticated");
    expect(status.glab_auth).toBe("authenticated");
  });

  test("reports unavailable auth state when the persisted file is missing", async () => {
    const status = await collectStatus(makeDeps({
      loadGitHostingAuthState: () => EMPTY_GIT_HOSTING_AUTH_STATE,
    }));

    expect(status.git_hosting_auth).toEqual({ available: false });
  });

  test("reports unavailable auth state when loading the persisted file fails", async () => {
    const status = await collectStatus(makeDeps({
      loadGitHostingAuthState: () => {
        throw new Error("corrupt state");
      },
    }));

    expect(status.git_hosting_auth).toEqual({ available: false });
    expect(status.gh_auth).toBe("authenticated");
    expect(status.glab_auth).toBe("authenticated");
  });

  test("includes site-level leanCTX statistics when a probe is wired", async () => {
    const leanctx: LeanCtxSiteStats = { projectsWithFacts: 3, totalMemoryFacts: 42, activeProjects24h: 2, healthCoverage: 1 };
    const status = await collectStatus(makeDeps({ leanctx }));
    expect(status.leanctx).toEqual(leanctx);
  });

  test("yields null leanctx when no probe is wired", async () => {
    const status = await collectStatus(makeDeps());
    expect(status.leanctx).toBeNull();
  });

  test("includes gain stats when a probe is wired", async () => {
    const gain: GainStats = {
      tokensSaved: 19469611,
      netTokensSaved: 19351773,
      compressionPct: 40.31,
      grossUsdSaved: 55.86,
      netUsdSaved: 51.21,
      overheadUsd: 4.65,
      bounceTokens: 1858165,
      ledgerVerified: true,
      ledgerEvents: 5812,
    };
    const status = await collectStatus(makeDeps({ gain }));
    expect(status.gain).toEqual(gain);
  });

  test("yields null gain when no probe is wired", async () => {
    const status = await collectStatus(makeDeps());
    expect(status.gain).toBeNull();
  });
});
