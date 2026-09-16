import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { createAdminRoutes, type AdminRoutesDeps } from "./admin";
import type { ExecResult } from "../lib/docker";
import type { EffectiveCompose } from "../lib/compose-overlay";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const noOverlayEffective: EffectiveCompose = {
  overlayActive: false,
  files: ["/opt/ai-engkit/compose.yml"],
  overlayReference: null,
};

type DepsState = {
  project: string;
  envSource: string | null;
  baseSource: string | null;
  effective: EffectiveCompose;
  throwOnProject: Error | null;
  throwOnBind: Error | null;
  runCommandResults: ExecResult[];
  runCommandCalls: Array<{ args: string[]; timeout: number }>;
  scheduleCalls: Array<{ delay: number }>;
};

function createDeps(overrides: Partial<AdminRoutesDeps> = {}): { deps: AdminRoutesDeps; state: DepsState } {
  const state: DepsState = {
    project: "test-proj",
    envSource: "/host/.env",
    baseSource: "/host/compose.yml",
    effective: noOverlayEffective,
    throwOnProject: null,
    throwOnBind: null,
    runCommandResults: [],
    runCommandCalls: [],
    scheduleCalls: [],
  };

  const deps: AdminRoutesDeps = {
    getComposeProject: async () => {
      if (state.throwOnProject) throw state.throwOnProject;
      return state.project;
    },
    getSelfBindSource: async (dest: string) => {
      if (state.throwOnBind) throw state.throwOnBind;
      if (dest === "/opt/ai-engkit/.env") return state.envSource;
      if (dest === state.effective.files[0]) return state.baseSource;
      return null;
    },
    runCommand: async (args: string[], timeout: number) => {
      state.runCommandCalls.push({ args, timeout });
      const next = state.runCommandResults.shift();
      if (next !== undefined) return next;
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    schedule: (fn: () => void, delay: number) => {
      state.scheduleCalls.push({ delay });
      fn();
    },
    resolveEffectiveAiAdmin: () => state.effective,
    ...overrides,
  };

  return { deps, state };
}

describe("POST /api/admin/restart — bind-source preflight", () => {
  let originalError: typeof console.error;
  let capturedErrors: string[] = [];

  beforeEach(() => {
    originalError = console.error;
    capturedErrors = [];
    console.error = (...args: unknown[]) => {
      capturedErrors.push(args.map(String).join(" "));
    };
  });

  afterEach(() => {
    console.error = originalError;
  });

  test("Given bind sources resolve, When POST /api/admin/restart, Then returns 200 and schedules helper with correct argv", async () => {
    // Given: valid bind sources
    const { deps, state } = createDeps();
    const app = createAdminRoutes(deps);

    // When: POST restart
    const res = await app.request("http://localhost/api/admin/restart", { method: "POST" });

    // Then: 200 with ok:true
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(isRecord(body) && body["ok"] === true).toBe(true);

    // Then: schedule called once with 2000ms delay
    expect(state.scheduleCalls).toHaveLength(1);
    expect(state.scheduleCalls[0].delay).toBe(2000);

    // Then: runCommand called with helper image literal and compose --env-file
    expect(state.runCommandCalls).toHaveLength(1);
    const args = state.runCommandCalls[0].args;
    expect(args).toContain("ghcr.io/tryweb/ai-engkit:latest");
    expect(args).toContain("--env-file");
    const envFileIdx = args.indexOf("--env-file");
    expect(args[envFileIdx + 1]).toBe("/host/.env");
    expect(args).toContain("-f");
    const fIdx = args.indexOf("-f");
    expect(args[fIdx + 1]).toBe("/host/compose.yml");
    expect(args).toContain("ai-admin");
    expect(args).not.toContain("--project-directory");
    expect(state.runCommandCalls[0].timeout).toBe(120_000);
  });

  test("Given an active overlay and staged base, When POST, Then the helper recreates from the staged base with --project-directory", async () => {
    const { deps, state } = createDeps();
    state.effective = {
      overlayActive: true,
      files: ["/opt/ai-engkit/compose-upgrade-base.yml", "/opt/ai-engkit/extensions/ep-design.yml"],
      overlayReference: "ep-design.yml",
    };
    state.baseSource = "/host/admin-data/upgrade-base.yml";
    const app = createAdminRoutes(deps);

    const res = await app.request("http://localhost/api/admin/restart", { method: "POST" });

    expect(res.status).toBe(200);
    expect(state.runCommandCalls).toHaveLength(1);
    const args = state.runCommandCalls[0].args;
    const envFileIdx = args.indexOf("--env-file");
    expect(args[envFileIdx + 1]).toBe("/host/.env");
    const fIdx = args.indexOf("-f");
    expect(args[fIdx + 1]).toBe("/host/admin-data/upgrade-base.yml");
    const projectDirIdx = args.indexOf("--project-directory");
    expect(projectDirIdx).toBeGreaterThan(-1);
    expect(args[projectDirIdx + 1]).toBe("/host");
  });

  test("Given env bind source is null, When POST, Then returns 500 with ok:false and does not schedule helper", async () => {
    // Given: envSource null
    const { deps, state } = createDeps();
    state.envSource = null;
    const app = createAdminRoutes(deps);

    // When
    const res = await app.request("http://localhost/api/admin/restart", { method: "POST" });

    // Then
    expect(res.status).toBe(500);
    const body: unknown = await res.json();
    expect(body !== null && typeof body === "object").toBe(true);
    expect(isRecord(body)).toBe(true);
    if (!isRecord(body)) throw new Error("not record");
    expect(body["ok"]).toBe(false);
    expect(typeof body["error"] === "string").toBe(true);
    const err = body["error"];
    if (typeof err === "string") expect(err.length).toBeGreaterThan(0);
    expect(state.scheduleCalls).toHaveLength(0);
    expect(state.runCommandCalls).toHaveLength(0);
  });

  test("Given compose bind source is null, When POST, Then returns 500", async () => {
    // Given
    const { deps, state } = createDeps();
    state.baseSource = null;
    const app = createAdminRoutes(deps);

    // When
    const res = await app.request("http://localhost/api/admin/restart", { method: "POST" });

    // Then
    expect(res.status).toBe(500);
    const body: unknown = await res.json();
    expect(isRecord(body)).toBe(true);
    if (!isRecord(body)) throw new Error("not record");
    expect(body["ok"]).toBe(false);
    expect(state.scheduleCalls).toHaveLength(0);
  });

  test("Given getComposeProject throws, When POST, Then returns 500 with error message and does not schedule", async () => {
    // Given
    const { deps, state } = createDeps();
    state.throwOnProject = new Error("docker inspect failed");
    const app = createAdminRoutes(deps);

    // When
    const res = await app.request("http://localhost/api/admin/restart", { method: "POST" });

    // Then
    expect(res.status).toBe(500);
    const body: unknown = await res.json();
    expect(isRecord(body)).toBe(true);
    if (!isRecord(body)) throw new Error("not record");
    expect(body["ok"]).toBe(false);
    const err = body["error"];
    expect(typeof err === "string" && err.includes("docker inspect failed")).toBe(true);
    expect(state.scheduleCalls).toHaveLength(0);
  });

  test("Given getSelfBindSource throws, When POST, Then returns 500", async () => {
    // Given
    const { deps, state } = createDeps();
    state.throwOnBind = new Error("inspect error");
    const app = createAdminRoutes(deps);

    // When
    const res = await app.request("http://localhost/api/admin/restart", { method: "POST" });

    // Then
    expect(res.status).toBe(500);
    const body: unknown = await res.json();
    expect(isRecord(body)).toBe(true);
    if (!isRecord(body)) throw new Error("not record");
    expect(body["ok"]).toBe(false);
    expect(state.scheduleCalls).toHaveLength(0);
  });

  test("Given helper returns non-zero exit, When scheduled callback runs, Then logs one error at HTTP boundary", async () => {
    // Given: helper will return non-zero
    const inner = createDeps();
    inner.state.runCommandResults.push({ stdout: "fail", stderr: "compose error", exitCode: 1 });
    const app = createAdminRoutes(inner.deps);

    // When
    const res = await app.request("http://localhost/api/admin/restart", { method: "POST" });
    expect(res.status).toBe(200);

    // Then: console.error called once with failure details
    await new Promise((r) => setTimeout(r, 0));
    expect(capturedErrors.length).toBe(1);
    expect(capturedErrors[0].includes("ai-admin")).toBe(true);
  });

  test("Given helper rejects, When scheduled callback runs, Then rejection is handled and logged", async () => {
    // Given: runCommand rejects
    let runCalls = 0;
    const rejectingDeps: AdminRoutesDeps = {
      getComposeProject: async () => "test-proj",
      getSelfBindSource: async () => "/host/.env",
      runCommand: async () => {
        runCalls++;
        throw new Error("spawn failed");
      },
      schedule: (fn: () => void, _delay: number) => {
        fn();
      },
      resolveEffectiveAiAdmin: () => noOverlayEffective,
    };
    const app = createAdminRoutes(rejectingDeps);

    // When
    const res = await app.request("http://localhost/api/admin/restart", { method: "POST" });
    expect(res.status).toBe(200);

    // Then
    await new Promise((r) => setTimeout(r, 0));
    expect(capturedErrors.length).toBe(1);
    expect(capturedErrors[0].includes("spawn failed")).toBe(true);
  });

  test("Given preflight succeeds, When POST, Then response is returned immediately without awaiting helper completion", async () => {
    // Given: runCommand that would take time, but schedule does not invoke immediately
    let helperStarted = false;
    const state: DepsState = {
      project: "test-proj",
      envSource: "/host/.env",
      baseSource: "/host/compose.yml",
      effective: noOverlayEffective,
      throwOnProject: null,
      throwOnBind: null,
      runCommandResults: [],
      runCommandCalls: [],
      scheduleCalls: [],
    };
    const deps: AdminRoutesDeps = {
      getComposeProject: async () => state.project,
      getSelfBindSource: async (dest: string) => {
        if (dest === "/opt/ai-engkit/.env") return state.envSource;
        return state.baseSource;
      },
      runCommand: async (args: string[], timeout: number) => {
        helperStarted = true;
        state.runCommandCalls.push({ args, timeout });
        await new Promise((r) => setTimeout(r, 50));
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      schedule: (fn: () => void, delay: number) => {
        state.scheduleCalls.push({ delay });
        // Do NOT invoke fn — verify response returned before helper starts
        void fn;
      },
      resolveEffectiveAiAdmin: () => state.effective,
    };
    const app = createAdminRoutes(deps);

    // When
    const res = await app.request("http://localhost/api/admin/restart", { method: "POST" });

    // Then: response 200 even though helper not yet started
    expect(res.status).toBe(200);
    expect(helperStarted).toBe(false);
    expect(state.scheduleCalls.length).toBe(1);
    expect(state.scheduleCalls[0].delay).toBe(2000);
  });
});
