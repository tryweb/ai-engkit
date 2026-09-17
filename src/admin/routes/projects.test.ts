import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectRoutes, type ProjectCommand } from "./projects";
import type { LeanCtxProjectStatus } from "../lib/leanctx-project-status";

async function shellCommand(source: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const process = Bun.spawn(["sh", "-c", source], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** Runs the real settings/disabled-state merge shell locally; fakes every other ai-dev command. */
function createCommand(): ProjectCommand {
  return async (source) => source.includes("SETTINGS=") || source.includes("DISABLED=")
    ? shellCommand(source)
    : { exitCode: 0, stdout: "", stderr: "" };
}

interface Fixture {
  directory: string;
  settingsPath: string;
  disabledPath: string;
  workspaceRoot: string;
  cleanup: () => Promise<void>;
}

async function fixture(seed?: string): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "projects-routes-"));
  const settingsPath = join(directory, "settings.json");
  const disabledPath = join(directory, "disabled-projects.json");
  const workspaceRoot = join(directory, "workspace");
  if (seed !== undefined) await writeFile(settingsPath, seed);
  return {
    directory,
    settingsPath,
    disabledPath,
    workspaceRoot,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

function appFor(f: Fixture, command: ProjectCommand = createCommand()) {
  return createProjectRoutes({ command, settingsPath: f.settingsPath, disabledPath: f.disabledPath, workspaceRoot: f.workspaceRoot });
}

function createProject(app: ReturnType<typeof createProjectRoutes>, name: string) {
  return app.request("http://localhost/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, git_init: false }),
  });
}

function projectId(fullPath: string): string {
  return "path_" + Buffer.from(fullPath).toString("base64");
}

interface StoredProject {
  id: string;
  path: string;
  addedAt?: number;
  lastOpenedAt?: number;
  label?: string;
  icon?: string;
  color?: string;
  defaultModel?: string;
  iconImage?: string;
  sidebarCollapsed?: boolean;
}

interface StoredSettings {
  projects?: StoredProject[];
  [key: string]: unknown;
}

async function readSettings(f: Fixture): Promise<StoredSettings> {
  const parsed: unknown = JSON.parse(await readFile(f.settingsPath, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("settings file is not an object");
  }
  return parsed as StoredSettings;
}

describe("POST /api/projects OpenChamber registration", () => {
  test("registers the project when settings have no projects key", async () => {
    const f = await fixture('{"showOpenCodeUpdateNotifications":true}\n');
    try {
      const response = await createProject(appFor(f), "demo");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });

      const settings = await readSettings(f);
      expect(settings.showOpenCodeUpdateNotifications).toBe(true);
      const fullPath = `${f.workspaceRoot}/demo`;
      expect(settings.projects).toHaveLength(1);
      expect(settings.projects?.[0]?.id).toBe(projectId(fullPath));
      expect(settings.projects?.[0]?.path).toBe(fullPath);
      expect(typeof settings.projects?.[0]?.addedAt).toBe("number");
      expect(typeof settings.projects?.[0]?.lastOpenedAt).toBe("number");
    } finally {
      await f.cleanup();
    }
  });

  test("creates the settings file when it is missing", async () => {
    const f = await fixture();
    try {
      const response = await createProject(appFor(f), "demo");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });

      const settings = await readSettings(f);
      expect(settings.projects?.map((p) => p.path)).toEqual([`${f.workspaceRoot}/demo`]);
    } finally {
      await f.cleanup();
    }
  });

  test("preserves unrelated keys and existing projects", async () => {
    const existing: StoredProject = { id: "path_other", path: "/somewhere/else", addedAt: 1, lastOpenedAt: 2 };
    const f = await fixture(JSON.stringify({ theme: "dark", projects: [existing] }) + "\n");
    try {
      const response = await createProject(appFor(f), "demo");
      expect(response.status).toBe(200);

      const settings = await readSettings(f);
      expect(settings.theme).toBe("dark");
      expect(settings.projects).toHaveLength(2);
      expect(settings.projects?.[0]).toEqual(existing);
      expect(settings.projects?.[1]?.path).toBe(`${f.workspaceRoot}/demo`);
    } finally {
      await f.cleanup();
    }
  });

  test("does not duplicate an already registered project", async () => {
    const f = await fixture();
    try {
      const fullPath = `${f.workspaceRoot}/demo`;
      const seeded: StoredProject = { id: projectId(fullPath), path: fullPath, addedAt: 1, lastOpenedAt: 1 };
      await writeFile(f.settingsPath, JSON.stringify({ projects: [seeded] }) + "\n");

      const response = await createProject(appFor(f), "demo");
      expect(response.status).toBe(200);

      const settings = await readSettings(f);
      expect(settings.projects?.filter((p) => p.path === fullPath)).toHaveLength(1);
      expect(settings.projects?.filter((p) => p.id === projectId(fullPath))).toHaveLength(1);
    } finally {
      await f.cleanup();
    }
  });

  test("re-registering preserves existing metadata and collapses duplicates", async () => {
    const f = await fixture();
    try {
      const fullPath = `${f.workspaceRoot}/demo`;
      const seeded: StoredProject = {
        id: projectId(fullPath),
        path: fullPath,
        label: "Demo",
        icon: "rocket",
        color: "#ff0000",
        defaultModel: "gpt-5",
        iconImage: "data:image/png;base64,xyz",
        sidebarCollapsed: true,
        addedAt: 1,
        lastOpenedAt: 1,
      };
      const duplicate: StoredProject = { id: "path_stale", path: fullPath, addedAt: 2, lastOpenedAt: 2 };
      const other: StoredProject = { id: "path_other", path: "/somewhere/else", addedAt: 3, lastOpenedAt: 3 };
      await writeFile(f.settingsPath, JSON.stringify({ theme: "dark", projects: [seeded, duplicate, other] }) + "\n");

      const response = await createProject(appFor(f), "demo");
      expect(response.status).toBe(200);

      const settings = await readSettings(f);
      expect(settings.theme).toBe("dark");
      expect(settings.projects).toHaveLength(2);
      const matches = settings.projects?.filter((p) => p.path === fullPath || p.id === projectId(fullPath)) ?? [];
      expect(matches).toHaveLength(1);
      const survivor = matches[0];
      expect(survivor?.id).toBe(projectId(fullPath));
      expect(survivor?.label).toBe("Demo");
      expect(survivor?.icon).toBe("rocket");
      expect(survivor?.color).toBe("#ff0000");
      expect(survivor?.defaultModel).toBe("gpt-5");
      expect(survivor?.iconImage).toBe("data:image/png;base64,xyz");
      expect(survivor?.sidebarCollapsed).toBe(true);
      expect(survivor?.addedAt).toBe(1);
      expect(typeof survivor?.lastOpenedAt).toBe("number");
      expect(survivor?.lastOpenedAt).not.toBe(1);
      expect(settings.projects?.some((p) => p.id === "path_stale")).toBe(false);
      expect(settings.projects?.[1]).toEqual(other);
    } finally {
      await f.cleanup();
    }
  });

  test("registers via an atomic temp-file write", async () => {
    const f = await fixture();
    let invoked = "";
    const command: ProjectCommand = async (source) => {
      if (source.includes("SETTINGS=")) invoked = source;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    try {
      const response = await createProject(appFor(f, command), "demo");
      expect(response.status).toBe(200);
      expect(invoked).toContain("mktemp");
      expect(invoked).toContain("umask 077");
      expect(invoked).toContain("--arg path");
      expect(invoked).toContain(".projects // []");
      expect(invoked).not.toContain("/tmp/settings.json");
    } finally {
      await f.cleanup();
    }
  });
});

async function readDisabled(f: Fixture): Promise<string[]> {
  const parsed: unknown = JSON.parse(await readFile(f.disabledPath, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
  const disabled = (parsed as Record<string, unknown>).disabled;
  if (!Array.isArray(disabled)) return [];
  return disabled.filter((n): n is string => typeof n === "string");
}

describe("POST /api/projects/:name/disable and enable", () => {
  /** Runs real shell for directory checks, project listing, and both state files. */
  function realCommand(): ProjectCommand {
    return async (source) => source.includes("jq") || source.includes("find ") || source.includes("test -d")
      ? shellCommand(source)
      : { exitCode: 0, stdout: "", stderr: "" };
  }

  function requestDisable(app: ReturnType<typeof createProjectRoutes>, name: string) {
    return app.request(`http://localhost/api/projects/${encodeURIComponent(name)}/disable`, { method: "POST" });
  }

  function requestEnable(app: ReturnType<typeof createProjectRoutes>, name: string) {
    return app.request(`http://localhost/api/projects/${encodeURIComponent(name)}/enable`, { method: "POST" });
  }

  test("disable removes the OpenChamber registration and marks the project", async () => {
    const f = await fixture();
    try {
      await mkdir(join(f.workspaceRoot, "demo"), { recursive: true });
      const fullPath = `${f.workspaceRoot}/demo`;
      await writeFile(f.settingsPath, JSON.stringify({
        projects: [{ id: projectId(fullPath), path: fullPath, addedAt: 1, lastOpenedAt: 1 }],
      }) + "\n");

      const response = await requestDisable(appFor(f, realCommand()), "demo");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });

      expect((await readSettings(f)).projects).toEqual([]);
      expect(await readDisabled(f)).toEqual(["demo"]);
    } finally {
      await f.cleanup();
    }
  });

  test("enable re-registers the project and unmarks it", async () => {
    const f = await fixture();
    try {
      await mkdir(join(f.workspaceRoot, "demo"), { recursive: true });
      await writeFile(f.disabledPath, JSON.stringify({ disabled: ["demo"] }) + "\n");

      const response = await requestEnable(appFor(f, realCommand()), "demo");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });

      expect((await readSettings(f)).projects?.map((p) => p.path)).toEqual([`${f.workspaceRoot}/demo`]);
      expect(await readDisabled(f)).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  test("disable rolls back the disabled mark when unregistration fails", async () => {
    const f = await fixture();
    const command: ProjectCommand = async (source) => {
      if (source.includes("jq") && source.includes("DISABLED=")) return shellCommand(source);
      if (source.includes("SETTINGS=")) return { exitCode: 1, stdout: "", stderr: "settings boom" };
      if (source.includes("test -d")) return shellCommand(source);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    try {
      await mkdir(join(f.workspaceRoot, "demo"), { recursive: true });

      const response = await requestDisable(appFor(f, command), "demo");
      expect(response.status).toBe(500);
      const body = await response.json() as Record<string, unknown>;
      expect(String(body.error)).toContain("settings boom");
      expect(await readDisabled(f)).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  test("disable requires an existing project directory", async () => {
    const f = await fixture();
    try {
      const response = await requestDisable(appFor(f, realCommand()), "ghost");
      expect(response.status).toBe(404);
    } finally {
      await f.cleanup();
    }
  });
});

describe("GET /api/projects/overview tool status", () => {
  /** Runs real shell for listing, feature checks, and state files; fakes probes and git. */
  function overviewCommand(): ProjectCommand {
    return async (source) => source.includes("jq") || source.includes("find ") || source.includes("test -e") || source.includes("test -d")
      ? shellCommand(source)
      : { exitCode: 0, stdout: "", stderr: "" };
  }

  test("passes codegraph through from the shared provider", async () => {
    const f = await fixture();
    const toolStatus = {
      probe: async () => ({
        codegraph: { initialized: true, nodeCount: 42 },
      }),
      probeSite: async () => null,
      probeGain: async () => null,
      probeValueReport: async () => null,
      probeProveReport: async () => null,
      probeSavingsReport: async () => null,
      invalidate: () => {},
    };
    try {
      await mkdir(join(f.workspaceRoot, "demo"), { recursive: true });
      const app = createProjectRoutes({
        command: overviewCommand(),
        settingsPath: f.settingsPath,
        disabledPath: f.disabledPath,
        workspaceRoot: f.workspaceRoot,
        toolStatus,
      });

      const res = await app.request("http://localhost/api/projects/overview");
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      const demo = body["demo"] as Record<string, unknown>;
      expect(demo.codegraph).toEqual({ initialized: true, nodeCount: 42 });
      expect(demo.features).toEqual({ knowledge: false, maintenance: false, openspec: false, superpowers: false });
      expect(demo.disabled).toBe(false);
      expect(demo.remote).toBeNull();
    } finally {
      await f.cleanup();
    }
  });

  test("passes the batched leanctx projection through with the exact wire shape", async () => {
    const f = await fixture();
    const available: LeanCtxProjectStatus = {
      state: "available",
      activeFacts: 3,
      archivedFacts: 1,
      patterns: 0,
      history: 2,
      lastUpdated: "2026-09-17T00:00:00Z",
    };
    const toolStatus = {
      probe: async () => ({ codegraph: null }),
      probeLeanCtx: async (projectRoots: readonly string[]) =>
        new Map<string, LeanCtxProjectStatus | null>(projectRoots.map((root) => [root, available])),
      probeSite: async () => null,
      probeGain: async () => null,
      probeValueReport: async () => null,
      probeProveReport: async () => null,
      probeSavingsReport: async () => null,
      invalidate: () => {},
    };
    try {
      await mkdir(join(f.workspaceRoot, "demo"), { recursive: true });
      const app = createProjectRoutes({
        command: overviewCommand(),
        settingsPath: f.settingsPath,
        disabledPath: f.disabledPath,
        workspaceRoot: f.workspaceRoot,
        toolStatus,
      });

      const res = await app.request("http://localhost/api/projects/overview");
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, Record<string, unknown>>;
      expect(body["demo"]?.leanctx).toEqual(available);
      expect(Object.keys(body["demo"]?.leanctx as object).sort()).toEqual([
        "activeFacts",
        "archivedFacts",
        "history",
        "lastUpdated",
        "patterns",
        "state",
      ]);
    } finally {
      await f.cleanup();
    }
  });

  test("passes an empty leanctx projection and a null unknown projection through", async () => {
    const f = await fixture();
    const states: Record<string, LeanCtxProjectStatus | null> = {
      alpha: { state: "empty", activeFacts: 0, archivedFacts: 0, patterns: 0, history: 0, lastUpdated: null },
      beta: null,
    };
    const toolStatus = {
      probe: async () => ({ codegraph: null }),
      probeLeanCtx: async (projectRoots: readonly string[]) =>
        new Map<string, LeanCtxProjectStatus | null>(projectRoots.map((root) => [root, states[root.slice(root.lastIndexOf("/") + 1)] ?? null])),
      probeSite: async () => null,
      probeGain: async () => null,
      probeValueReport: async () => null,
      probeProveReport: async () => null,
      probeSavingsReport: async () => null,
      invalidate: () => {},
    };
    try {
      await mkdir(join(f.workspaceRoot, "alpha"), { recursive: true });
      await mkdir(join(f.workspaceRoot, "beta"), { recursive: true });
      const app = createProjectRoutes({
        command: overviewCommand(),
        settingsPath: f.settingsPath,
        disabledPath: f.disabledPath,
        workspaceRoot: f.workspaceRoot,
        toolStatus,
      });

      const res = await app.request("http://localhost/api/projects/overview");
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, Record<string, unknown>>;
      expect(body["alpha"]?.leanctx).toEqual(states["alpha"]);
      expect(body["beta"]?.leanctx).toBeNull();
    } finally {
      await f.cleanup();
    }
  });

  test("never falls back to the site-level leanCTX aggregate for an unknown project", async () => {
    const f = await fixture();
    const toolStatus = {
      probe: async () => ({ codegraph: null }),
      probeLeanCtx: async (projectRoots: readonly string[]) =>
        new Map<string, LeanCtxProjectStatus | null>(projectRoots.map((root) => [root, null])),
      probeSite: async () => ({ projectsWithFacts: 9, totalMemoryFacts: 99, activeProjects24h: 8, healthCoverage: 3 }),
      probeGain: async () => null,
      probeValueReport: async () => null,
      probeProveReport: async () => null,
      probeSavingsReport: async () => null,
      invalidate: () => {},
    };
    try {
      await mkdir(join(f.workspaceRoot, "demo"), { recursive: true });
      const app = createProjectRoutes({
        command: overviewCommand(),
        settingsPath: f.settingsPath,
        disabledPath: f.disabledPath,
        workspaceRoot: f.workspaceRoot,
        toolStatus,
      });

      const res = await app.request("http://localhost/api/projects/overview");
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, Record<string, unknown>>;
      expect(body["demo"]?.leanctx).toBeNull();
      expect(JSON.stringify(body["demo"])).not.toContain("totalMemoryFacts");
    } finally {
      await f.cleanup();
    }
  });

  test("handles a crafted project name without failing the overview", async () => {
    const f = await fixture();
    const name = "evil; touch pwned (x)";
    let seenRoots: readonly string[] = [];
    const toolStatus = {
      probe: async () => ({ codegraph: null }),
      probeLeanCtx: async (projectRoots: readonly string[]) => {
        seenRoots = projectRoots;
        return new Map<string, LeanCtxProjectStatus | null>(projectRoots.map((root) => [root, null]));
      },
      probeSite: async () => null,
      probeGain: async () => null,
      probeValueReport: async () => null,
      probeProveReport: async () => null,
      probeSavingsReport: async () => null,
      invalidate: () => {},
    };
    try {
      await mkdir(join(f.workspaceRoot, name), { recursive: true });
      const app = createProjectRoutes({
        command: overviewCommand(),
        settingsPath: f.settingsPath,
        disabledPath: f.disabledPath,
        workspaceRoot: f.workspaceRoot,
        toolStatus,
      });

      const res = await app.request("http://localhost/api/projects/overview");
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, Record<string, unknown>>;
      expect(body[name]?.leanctx).toBeNull();
      expect(seenRoots).toContain(`${f.workspaceRoot}/${name}`);
    } finally {
      await f.cleanup();
    }
  });

  test("passes feature stats through when features are enabled", async () => {
    const f = await fixture();
    const toolStatus = {
      probe: async () => ({ codegraph: null }),
      probeSite: async () => null,
      probeGain: async () => null,
      probeValueReport: async () => null,
      probeProveReport: async () => null,
      probeSavingsReport: async () => null,
      invalidate: () => {},
    };
    const command: ProjectCommand = async (source) => {
      if (source.startsWith("P=")) {
        return {
          exitCode: 0,
          stdout: '{"knowledge":{"files":1,"patterns":1,"architecture":0,"tooling":0,"troubleshooting":0,"lastModified":1750000000000},"maintenance":null,"openspec":{"active":2,"archived":1,"specs":5}}',
          stderr: "",
        };
      }
      if (source.includes("jq") || source.includes("find ") || source.includes("test -e") || source.includes("test -d")) {
        return shellCommand(source);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    try {
      await mkdir(join(f.workspaceRoot, "demo", "docs", "knowledge"), { recursive: true });
      await writeFile(join(f.workspaceRoot, "demo", "docs", "knowledge", "README.md"), "# k\n");
      const app = createProjectRoutes({
        command,
        settingsPath: f.settingsPath,
        disabledPath: f.disabledPath,
        workspaceRoot: f.workspaceRoot,
        toolStatus,
      });

      const res = await app.request("http://localhost/api/projects/overview");
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      const demo = body["demo"] as Record<string, unknown>;
      expect(demo.stats).toEqual({
        knowledge: { files: 1, patterns: 1, architecture: 0, tooling: 0, troubleshooting: 0, lastModified: 1750000000000 },
        maintenance: null,
        openspec: null,
      });
    } finally {
      await f.cleanup();
    }
  });

  test("yields null codegraph when default probes find nothing", async () => {
    const f = await fixture();
    try {
      await mkdir(join(f.workspaceRoot, "demo"), { recursive: true });
      const app = createProjectRoutes({
        command: overviewCommand(),
        settingsPath: f.settingsPath,
        disabledPath: f.disabledPath,
        workspaceRoot: f.workspaceRoot,
      });

      const res = await app.request("http://localhost/api/projects/overview");
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      const demo = body["demo"] as Record<string, unknown>;
      expect(demo.codegraph).toBeNull();
      expect(demo.features).toEqual({ knowledge: false, maintenance: false, openspec: false, superpowers: false });
    } finally {
      await f.cleanup();
    }
  });

  test("POST /api/projects/tool-status/refresh invalidates the shared provider cache", async () => {
    const f = await fixture();
    let invalidations = 0;
    const toolStatus = {
      probe: async () => ({ codegraph: null }),
      probeSite: async () => null,
      probeGain: async () => null,
      probeValueReport: async () => null,
      probeProveReport: async () => null,
      probeSavingsReport: async () => null,
      invalidate: () => { invalidations += 1; },
    };
    try {
      await mkdir(join(f.workspaceRoot, "demo"), { recursive: true });
      const app = createProjectRoutes({
        command: overviewCommand(),
        settingsPath: f.settingsPath,
        disabledPath: f.disabledPath,
        workspaceRoot: f.workspaceRoot,
        toolStatus,
      });

      const res = await app.request("http://localhost/api/projects/tool-status/refresh", { method: "POST" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
       expect(invalidations).toBe(1);
    } finally {
      await f.cleanup();
    }
  });
});

describe("POST /api/projects/:name/delete", () => {
  function realCommand(): ProjectCommand {
    return async (source) => source.includes("jq") || source.includes("find ") || source.includes("test -d") || source.includes("rm ")
      ? shellCommand(source)
      : { exitCode: 0, stdout: "", stderr: "" };
  }

  function requestDelete(app: ReturnType<typeof createProjectRoutes>, name: string, confirmationName: string) {
    return app.request(`http://localhost/api/projects/${encodeURIComponent(name)}/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation_name: confirmationName }),
    });
  }

  test("deletes the project directory and unregisters from OpenChamber", async () => {
    const f = await fixture();
    try {
      await mkdir(join(f.workspaceRoot, "demo"), { recursive: true });
      await writeFile(join(f.workspaceRoot, "demo", "file.txt"), "hello");
      const fullPath = `${f.workspaceRoot}/demo`;
      await writeFile(f.settingsPath, JSON.stringify({
        projects: [{ id: projectId(fullPath), path: fullPath, addedAt: 1, lastOpenedAt: 1 }],
      }) + "\n");

      const response = await requestDelete(appFor(f, realCommand()), "demo", "demo");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });

      const lsResult = await shellCommand(`test -d ${JSON.stringify(f.workspaceRoot + "/demo")} && echo exists || echo gone`);
      expect(lsResult.stdout.trim()).toBe("gone");
      expect((await readSettings(f)).projects).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  test("removes the project from the disabled list if it was disabled", async () => {
    const f = await fixture();
    try {
      await mkdir(join(f.workspaceRoot, "demo"), { recursive: true });
      await writeFile(f.disabledPath, JSON.stringify({ disabled: ["demo", "other"] }) + "\n");

      const response = await requestDelete(appFor(f, realCommand()), "demo", "demo");
      expect(response.status).toBe(200);
      expect(await readDisabled(f)).toEqual(["other"]);
    } finally {
      await f.cleanup();
    }
  });

  test("returns 400 when confirmation_name does not match", async () => {
    const f = await fixture();
    try {
      await mkdir(join(f.workspaceRoot, "demo"), { recursive: true });

      const response = await requestDelete(appFor(f, realCommand()), "demo", "wrong-name");
      expect(response.status).toBe(400);
      const body = await response.json() as Record<string, unknown>;
      expect(String(body.error)).toContain("confirmation");
    } finally {
      await f.cleanup();
    }
  });

  test("returns 400 when confirmation_name is missing", async () => {
    const f = await fixture();
    try {
      await mkdir(join(f.workspaceRoot, "demo"), { recursive: true });

      const response = await appFor(f, realCommand()).request(
        `http://localhost/api/projects/demo/delete`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      );
      expect(response.status).toBe(400);
    } finally {
      await f.cleanup();
    }
  });

  test("returns 404 when project directory does not exist", async () => {
    const f = await fixture();
    try {
      const response = await requestDelete(appFor(f, realCommand()), "ghost", "ghost");
      expect(response.status).toBe(404);
    } finally {
      await f.cleanup();
    }
  });

  test("returns 400 for invalid project names", async () => {
    const f = await fixture();
    try {
      const response = await requestDelete(appFor(f, realCommand()), "../etc/passwd", "../etc/passwd");
      expect(response.status).toBe(400);
    } finally {
      await f.cleanup();
    }
  });

  test("preserves other projects when deleting one", async () => {
    const f = await fixture();
    try {
      await mkdir(join(f.workspaceRoot, "demo"), { recursive: true });
      await mkdir(join(f.workspaceRoot, "other"), { recursive: true });
      const demoPath = `${f.workspaceRoot}/demo`;
      const otherPath = `${f.workspaceRoot}/other`;
      await writeFile(f.settingsPath, JSON.stringify({
        projects: [
          { id: projectId(demoPath), path: demoPath, addedAt: 1, lastOpenedAt: 1 },
          { id: projectId(otherPath), path: otherPath, addedAt: 2, lastOpenedAt: 2 },
        ],
      }) + "\n");

      const response = await requestDelete(appFor(f, realCommand()), "demo", "demo");
      expect(response.status).toBe(200);

      const settings = await readSettings(f);
      expect(settings.projects).toHaveLength(1);
      expect(settings.projects?.[0]?.path).toBe(otherPath);

      const lsResult = await shellCommand(`test -d ${JSON.stringify(f.workspaceRoot + "/other")} && echo exists || echo gone`);
      expect(lsResult.stdout.trim()).toBe("exists");
    } finally {
      await f.cleanup();
    }
  });
});

describe("DELETE /api/projects/:name/features/:feature", () => {
  function realCommand(): ProjectCommand {
    const cmd = async (source: string) => {
      if (source.includes("mkdir -p") || source.includes("git init") || source.includes("git add") || source.includes("git commit")) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return shellCommand(source);
    };
    return cmd as ProjectCommand;
  }

  function requestDelete(app: ReturnType<typeof createProjectRoutes>, name: string, feature: string) {
    return app.request(`http://localhost/api/projects/${encodeURIComponent(name)}/features/${feature}`, { method: "DELETE" });
  }

  function requestPost(app: ReturnType<typeof createProjectRoutes>, name: string, feature: string) {
    return app.request(`http://localhost/api/projects/${encodeURIComponent(name)}/features/${feature}`, { method: "POST" });
  }

  test("returns 400 for unknown feature", async () => {
    const f = await fixture();
    try {
      await mkdir(join(f.workspaceRoot, "demo"), { recursive: true });
      const app = appFor(f, realCommand());
      const res = await requestDelete(app, "demo", "unknown-feature");
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Unknown feature");
    } finally {
      await f.cleanup();
    }
  });

  test("disable superpowers removes marker dir and symlinks", async () => {
    const f = await fixture();
    try {
      const projectPath = join(f.workspaceRoot, "demo");
      await mkdir(join(projectPath, ".opencode", "superpowers"), { recursive: true });
      await mkdir(join(projectPath, ".opencode", "skills"), { recursive: true });
      const symlinkTarget = "/opt/opencode/baked-plugins/superpowers/skills/test-skill";
      const otherSymlinkTarget = "/opt/opencode/baked-plugins/other/skills/other-skill";
      await shellCommand(`ln -sfn "${symlinkTarget}" "${join(projectPath, ".opencode", "skills", "test-skill")}"`);
      await shellCommand(`ln -sfn "${otherSymlinkTarget}" "${join(projectPath, ".opencode", "skills", "other-skill")}"`);

      const app = appFor(f, realCommand());
      const res = await requestDelete(app, "demo", "superpowers");
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true });

      const spDir = await shellCommand(`test -d "${join(projectPath, ".opencode", "superpowers")}" && echo exists || echo gone`);
      expect(spDir.stdout.trim()).toBe("gone");

      const spLink = await shellCommand(`test -L "${join(projectPath, ".opencode", "skills", "test-skill")}" && echo exists || echo gone`);
      expect(spLink.stdout.trim()).toBe("gone");

      const otherLink = await shellCommand(`test -L "${join(projectPath, ".opencode", "skills", "other-skill")}" && echo exists || echo gone`);
      expect(otherLink.stdout.trim()).toBe("exists");
    } finally {
      await f.cleanup();
    }
  });

  test("disable non-superpowers feature returns ok", async () => {
    const f = await fixture();
    try {
      await mkdir(join(f.workspaceRoot, "demo"), { recursive: true });
      const app = appFor(f, realCommand());
      const res = await requestDelete(app, "demo", "knowledge");
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true });
    } finally {
      await f.cleanup();
    }
  });

  test("disable then enable superpowers returns ok", async () => {
    const f = await fixture();
    try {
      const projectPath = join(f.workspaceRoot, "demo");
      await mkdir(join(projectPath, ".opencode", "superpowers"), { recursive: true });
      await mkdir(join(projectPath, ".opencode", "skills"), { recursive: true });

      const app = appFor(f);

      const delRes = await requestDelete(app, "demo", "superpowers");
      expect(delRes.status).toBe(200);
      expect(await delRes.json()).toMatchObject({ ok: true });

      const postRes = await requestPost(app, "demo", "superpowers");
      expect(postRes.status).toBe(200);
      expect(await postRes.json()).toMatchObject({ ok: true });
    } finally {
      await f.cleanup();
    }
  });
});
