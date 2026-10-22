import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StatusResponse } from "../lib/status";
import {
  buildStatusReport,
  heartbeatIntervalMs,
  type HeartbeatDeps,
  type StatusReport,
} from "./heartbeat";

describe("heartbeat status report", () => {
  test("maps shared status and component versions into every report field", async () => {
    const status: StatusResponse = {
      container_status: "running",
      uptime_seconds: 3_600,
      containers: {
        "ai-dev": { status: "running", uptime_seconds: 3_600, version: "1.2.3" },
        "ai-admin": { status: "running", uptime_seconds: 8_450, version: "1.2.3" },
      },
      restart_count: 2,
      gh_auth: "authenticated",
      glab_auth: "not authenticated",
      git_user: "Agent User",
      project_count: 4,
      leanctx: null,
      gain: null,
      valueReport: null,
      proveReport: null,
      savingsReport: null,
      admin_version: "1.2.3",
      admin_version_mismatch: true,
    };
    const versions = {
      "AI-EngKit": "1.2.3",
      OpenCode: "1.0.0",
      OpenChamber: "2.0.0",
      Docker: "28.0.0",
    };
    const deps: HeartbeatDeps = {
      collectStatus: async () => status,
      getVersions: async () => versions,
      getUpdateCheck: async () => ({
        current: "1.2.3",
        latest: "latest",
        update_available: true,
        status: "update-available",
        configured: null,
        message: "New image available",
      }),
    };
    const expected: StatusReport = {
      container_status: "running",
      uptime_seconds: 3_600,
      containers: {
        "ai-dev": { status: "running", uptime_seconds: 3_600, version: "1.2.3" },
        "ai-admin": { status: "running", uptime_seconds: 8_450, version: "1.2.3" },
      },
      versions,
      gh_auth: "authenticated",
      glab_auth: "not authenticated",
      admin_version: "1.2.3",
      admin_version_mismatch: true,
      upgrade_state: "running",
      upgrade_available: true,
      latest_version: "latest",
      gitHostingAuth: {
        gitlab: [],
        github: {
          validity: "unreachable",
          expiry: "unknown",
          expiry_known: false,
          expiry_unknown: true,
          checked_at: "",
        },
      },
    };

    const report = await buildStatusReport(deps, "running");

    expect(report).toEqual(expected);
  });

  test("includes the redacted git-hosting auth state when present", async () => {
    const directory = mkdtempSync(join(tmpdir(), "heartbeat-auth-"));
    const statePath = join(directory, "auth-state.json");
    writeFileSync(statePath, JSON.stringify({
      gitlab: [{
        hostname: "gitlab.example.com",
        validity: "unhealthy",
        expires_at: null,
        days_remaining: null,
        rotation_needed: true,
        rotation_done: false,
        error_code: "unreachable",
        checked_at: "2026-10-22T00:00:00.000Z",
        token: "secret",
      }],
      github: {
        validity: "valid",
        expiry: "known-within-threshold",
        expiry_known: true,
        expiry_unknown: false,
        checked_at: "2026-10-22T00:00:00.000Z",
      },
    }));
    const previousPath = process.env.GIT_HOSTING_AUTH_STATE_PATH;
    process.env.GIT_HOSTING_AUTH_STATE_PATH = statePath;

    try {
      const report = await buildStatusReport(depsForHeartbeat(), "idle");

      expect(report.gitHostingAuth).toEqual({
        gitlab: [{
          hostname: "gitlab.example.com",
          validity: "unhealthy",
          expires_at: null,
          days_remaining: null,
          rotation_needed: true,
          rotation_done: false,
          error_code: "unreachable",
          checked_at: "2026-10-22T00:00:00.000Z",
        }],
        github: {
          validity: "valid",
          expiry: "known-within-threshold",
          expiry_known: true,
          expiry_unknown: false,
          checked_at: "2026-10-22T00:00:00.000Z",
        },
      });
    } finally {
      if (previousPath === undefined) delete process.env.GIT_HOSTING_AUTH_STATE_PATH;
      else process.env.GIT_HOSTING_AUTH_STATE_PATH = previousPath;
    }
  });

  test("uses an empty auth summary when the state file is missing", async () => {
    const previousPath = process.env.GIT_HOSTING_AUTH_STATE_PATH;
    process.env.GIT_HOSTING_AUTH_STATE_PATH = "/tmp/missing-heartbeat-auth-state.json";

    try {
      const report = await buildStatusReport(depsForHeartbeat(), "idle");

      expect(report.gitHostingAuth?.gitlab).toEqual([]);
      expect(report.gitHostingAuth?.github.validity).toBe("unreachable");
    } finally {
      if (previousPath === undefined) delete process.env.GIT_HOSTING_AUTH_STATE_PATH;
      else process.env.GIT_HOSTING_AUTH_STATE_PATH = previousPath;
    }
  });

  test("uses a 60-second heartbeat interval", () => {
    expect(heartbeatIntervalMs()).toBe(60_000);
  });
});

function depsForHeartbeat(): HeartbeatDeps {
  return {
    collectStatus: async () => ({
      container_status: "running",
      uptime_seconds: 1,
      containers: {
        "ai-dev": { status: "stopped", uptime_seconds: null, version: "" },
        "ai-admin": { status: "stopped", uptime_seconds: null, version: "" },
      },
      restart_count: 0,
      gh_auth: "authenticated",
      glab_auth: "authenticated",
      git_user: "Agent User",
      project_count: 0,
      leanctx: null,
      gain: null,
      valueReport: null,
      proveReport: null,
      savingsReport: null,
      admin_version: "1.2.3",
      admin_version_mismatch: false,
    }),
    getVersions: async () => ({}),
    getUpdateCheck: async () => ({
      current: "1.2.3",
      latest: "1.2.3",
      update_available: false,
      status: "up-to-date",
      configured: null,
      message: "",
    }),
  };
}
