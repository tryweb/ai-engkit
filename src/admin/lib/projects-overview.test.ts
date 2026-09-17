import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildFeatureStatsCommand,
  checkFeature,
  collectProjectOverviews,
  listProjects,
  parseFeatureStats,
  type ProjectCommand,
  type ProjectFeatures,
} from "./projects-overview";
import type { LeanCtxProjectStatus } from "./leanctx-project-status";

async function shellCommand(source: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const process = Bun.spawn(["sh", "-c", source], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/**
 * Runs the real find/test/jq shell against the tmp fixture; fakes the git
 * remote lookup (alpha has one, everything else does not).
 */
function createCommand(workspaceRoot: string): ProjectCommand {
  return async (source) => {
    if (source.includes("DISABLED=")) return shellCommand(source);
    if (source.startsWith("find ")) return shellCommand(source);
    if (source.includes("test -e")) return shellCommand(source);
    if (source.startsWith("P=")) return shellCommand(source);
    if (source.includes("git remote get-url")) {
      return source.includes(`${workspaceRoot}/alpha`)
        ? { exitCode: 0, stdout: "https://example.com/alpha.git", stderr: "" }
        : { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

interface Fixture {
  settingsPath: string;
  disabledPath: string;
  workspaceRoot: string;
  cleanup: () => Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "projects-overview-"));
  const settingsPath = join(directory, "settings.json");
  const disabledPath = join(directory, "disabled-projects.json");
  const workspaceRoot = join(directory, "workspace");

  // alpha: knowledge + openspec enabled, no maintenance, has a git remote.
  await mkdir(join(workspaceRoot, "alpha", "docs", "knowledge"), { recursive: true });
  await writeFile(join(workspaceRoot, "alpha", "docs", "knowledge", "README.md"), "# knowledge\n");
  await mkdir(join(workspaceRoot, "alpha", "docs", "knowledge", "patterns"), { recursive: true });
  await writeFile(join(workspaceRoot, "alpha", "docs", "knowledge", "patterns", "one.md"), "# one\n");
  await mkdir(join(workspaceRoot, "alpha", "docs", "knowledge", "architecture"), { recursive: true });
  await writeFile(join(workspaceRoot, "alpha", "docs", "knowledge", "architecture", "two.md"), "# two\n");
  await mkdir(join(workspaceRoot, "alpha", "openspec"), { recursive: true });
  await mkdir(join(workspaceRoot, "alpha", "openspec", "changes", "active-c"), { recursive: true });
  await mkdir(join(workspaceRoot, "alpha", "openspec", "changes", "archive", "old-a"), { recursive: true });
  await mkdir(join(workspaceRoot, "alpha", "openspec", "specs", "s1"), { recursive: true });
  await mkdir(join(workspaceRoot, "alpha", ".opencode", "superpowers"), { recursive: true });
  // beta: no features, disabled.
  await mkdir(join(workspaceRoot, "beta"), { recursive: true });
  await writeFile(disabledPath, JSON.stringify({ disabled: ["beta"] }) + "\n");

  return {
    settingsPath,
    disabledPath,
    workspaceRoot,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

describe("listProjects", () => {
  test("lists workspace directories by basename", async () => {
    const f = await fixture();
    try {
      const names = await listProjects(createCommand(f.workspaceRoot), f.workspaceRoot);
      expect([...names].sort()).toEqual(["alpha", "beta"]);
    } finally {
      await f.cleanup();
    }
  });
});

describe("checkFeature", () => {
  test("detects marker presence per project", async () => {
    const f = await fixture();
    try {
      const command = createCommand(f.workspaceRoot);
      expect(await checkFeature(command, f.workspaceRoot, "alpha", "docs/knowledge/README.md")).toBe(true);
      expect(await checkFeature(command, f.workspaceRoot, "alpha", "docs/knowledge/maintenance/README.md")).toBe(false);
      expect(await checkFeature(command, f.workspaceRoot, "beta", "openspec")).toBe(false);
    } finally {
      await f.cleanup();
    }
  });
});

describe("collectProjectOverviews", () => {
  test("returns features, remote, and disabled state per project", async () => {
    const f = await fixture();
    try {
      const overviews = await collectProjectOverviews(
        createCommand(f.workspaceRoot),
        f.workspaceRoot,
        f.settingsPath,
        f.disabledPath,
      );
      const byName = new Map(overviews.map((o) => [o.name, o]));

      expect(byName.get("alpha")).toEqual({
        name: "alpha",
        features: { knowledge: true, maintenance: false, openspec: true, superpowers: true },
        remote: "https://example.com/alpha.git",
        disabled: false,
      });
      expect(byName.get("beta")).toEqual({
        name: "beta",
        features: { knowledge: false, maintenance: false, openspec: false, superpowers: false },
        remote: null,
        disabled: true,
      });
    } finally {
      await f.cleanup();
    }
  });

  test("attaches tool status fields when a provider is supplied", async () => {
    const f = await fixture();
    try {
      const command = createCommand(f.workspaceRoot);
      const toolStatus = {
        probe: async () => ({
          codegraph: { initialized: false },
        }),
        probeSite: async () => null,
        probeGain: async () => null,
        probeValueReport: async () => null,
        probeProveReport: async () => null,
        probeSavingsReport: async () => null,
        invalidate: () => {},
      };

      const overviews = await collectProjectOverviews(command, f.workspaceRoot, f.settingsPath, f.disabledPath, toolStatus);
      const byName = new Map(overviews.map((o) => [o.name, o]));

      expect(byName.get("alpha")?.codegraph).toEqual({ initialized: false });
      expect(byName.get("beta")?.codegraph).toEqual({ initialized: false });
    } finally {
      await f.cleanup();
    }
  });

  test("attaches a batched LeanCTX projection once per overview", async () => {
    const f = await fixture();
    try {
      const command = createCommand(f.workspaceRoot);
      const calls: Array<readonly string[]> = [];
      const available: LeanCtxProjectStatus = {
        state: "available",
        activeFacts: 2,
        archivedFacts: 1,
        patterns: 0,
        history: 1,
        lastUpdated: "2026-09-17T00:00:00Z",
      };
      const empty: LeanCtxProjectStatus = {
        state: "empty",
        activeFacts: 0,
        archivedFacts: 0,
        patterns: 0,
        history: 0,
        lastUpdated: null,
      };
      const toolStatus = {
        probe: async () => ({ codegraph: { initialized: false } }),
        probeLeanCtx: async (projectRoots: readonly string[]) => {
          calls.push(projectRoots);
          return new Map<string, LeanCtxProjectStatus | null>([
            [`${f.workspaceRoot}/alpha`, available],
            [`${f.workspaceRoot}/beta`, empty],
          ]);
        },
        probeSite: async () => null,
        probeGain: async () => null,
        probeValueReport: async () => null,
        probeProveReport: async () => null,
        probeSavingsReport: async () => null,
        invalidate: () => {},
      };

      const overviews = await collectProjectOverviews(command, f.workspaceRoot, f.settingsPath, f.disabledPath, toolStatus);
      const byName = new Map(overviews.map((o) => [o.name, o]));

      expect(byName.get("alpha")?.leanctx).toEqual(available);
      expect(byName.get("beta")?.leanctx).toEqual(empty);
      expect(calls).toHaveLength(1);
      expect([...calls[0]].sort()).toEqual([`${f.workspaceRoot}/alpha`, `${f.workspaceRoot}/beta`]);
    } finally {
      await f.cleanup();
    }
  });

  test("reports null leanctx and keeps every project when the batched scan rejects", async () => {
    const f = await fixture();
    try {
      const command = createCommand(f.workspaceRoot);
      const toolStatus = {
        probe: async () => ({ codegraph: { initialized: false } }),
        probeLeanCtx: async () => { throw new Error("scan boom"); },
        probeSite: async () => null,
        probeGain: async () => null,
        probeValueReport: async () => null,
        probeProveReport: async () => null,
        probeSavingsReport: async () => null,
        invalidate: () => {},
      };

      const overviews = await collectProjectOverviews(command, f.workspaceRoot, f.settingsPath, f.disabledPath, toolStatus);
      const byName = new Map(overviews.map((o) => [o.name, o]));

      expect(byName.get("alpha")?.leanctx).toBeNull();
      expect(byName.get("beta")?.leanctx).toBeNull();
      expect(byName.get("alpha")?.features.knowledge).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  test("omits leanctx when the provider exposes no batched scan", async () => {
    const f = await fixture();
    try {
      const command = createCommand(f.workspaceRoot);
      const toolStatus = {
        probe: async () => ({ codegraph: { initialized: false } }),
        probeSite: async () => null,
        probeGain: async () => null,
        probeValueReport: async () => null,
        probeProveReport: async () => null,
        probeSavingsReport: async () => null,
        invalidate: () => {},
      };

      const overviews = await collectProjectOverviews(command, f.workspaceRoot, f.settingsPath, f.disabledPath, toolStatus);
      const alpha = overviews.find((o) => o.name === "alpha");

      expect(alpha?.leanctx).toBeUndefined();
      expect(alpha?.codegraph).toEqual({ initialized: false });
    } finally {
      await f.cleanup();
    }
  });

  test("collects feature stats from the filesystem when a provider is supplied", async () => {
    const f = await fixture();
    try {
      const command = createCommand(f.workspaceRoot);
      const toolStatus = {
        probe: async () => ({ codegraph: { initialized: false } }),
        probeSite: async () => null,
        probeGain: async () => null,
        probeValueReport: async () => null,
        probeProveReport: async () => null,
        probeSavingsReport: async () => null,
        invalidate: () => {},
      };

      const overviews = await collectProjectOverviews(command, f.workspaceRoot, f.settingsPath, f.disabledPath, toolStatus);
      const byName = new Map(overviews.map((o) => [o.name, o]));

      const alpha = byName.get("alpha");
      expect(alpha?.stats?.knowledge).toEqual({
        files: 2,
        patterns: 1,
        architecture: 1,
        tooling: 0,
        troubleshooting: 0,
        lastModified: expect.any(Number),
      });
      expect(alpha?.stats?.maintenance).toBeNull();
      expect(alpha?.stats?.openspec).toEqual({ active: 1, archived: 1, specs: 1 });
      expect(byName.get("beta")?.stats, "no enabled features -> no stats").toBeUndefined();
    } finally {
      await f.cleanup();
    }
  });

  test("omits tool status fields when no provider is supplied", async () => {
    const f = await fixture();
    try {
      const overviews = await collectProjectOverviews(
        createCommand(f.workspaceRoot),
        f.workspaceRoot,
        f.settingsPath,
        f.disabledPath,
      );
      const alpha = overviews.find((o) => o.name === "alpha");
      expect(alpha?.codegraph).toBeUndefined();
      expect(alpha?.features).toEqual({ knowledge: true, maintenance: false, openspec: true, superpowers: true });
    } finally {
      await f.cleanup();
    }
  });

  test("keeps the project listed when a probe rejects", async () => {
    const f = await fixture();
    try {
      const command = createCommand(f.workspaceRoot);
      const toolStatus = {
        probe: async () => { throw new Error("probe boom"); },
        probeSite: async () => null,
        probeGain: async () => null,
        probeValueReport: async () => null,
        probeProveReport: async () => null,
        probeSavingsReport: async () => null,
        invalidate: () => {},
      };

      const overviews = await collectProjectOverviews(command, f.workspaceRoot, f.settingsPath, f.disabledPath, toolStatus);
      const byName = new Map(overviews.map((o) => [o.name, o]));

      expect(byName.get("alpha")?.features).toEqual({ knowledge: true, maintenance: false, openspec: true, superpowers: true });
      expect(byName.get("alpha")?.codegraph).toBeUndefined();
    } finally {
      await f.cleanup();
    }
  });
});

describe("parseFeatureStats", () => {
  const features: ProjectFeatures = { knowledge: true, maintenance: true, openspec: true, superpowers: true };

  test("parses per-feature stats from command output", () => {
    const stats = parseFeatureStats(
      '{"knowledge":{"files":2,"patterns":1,"architecture":1,"tooling":0,"troubleshooting":0,"lastModified":1750000000000},'
      + '"maintenance":{"reports":3,"lastReportDate":"2026-08-10","months":2},'
      + '"openspec":{"active":1,"archived":4,"specs":9}}',
      features,
    );
    expect(stats.knowledge).toEqual({
      files: 2,
      patterns: 1,
      architecture: 1,
      tooling: 0,
      troubleshooting: 0,
      lastModified: 1750000000000,
    });
    expect(stats.maintenance).toEqual({ reports: 3, lastReportDate: "2026-08-10", months: 2 });
    expect(stats.openspec).toEqual({ active: 1, archived: 4, specs: 9 });
  });

  test("returns null for features that are not enabled", () => {
    const stats = parseFeatureStats(
      '{"knowledge":null,"maintenance":null,"openspec":{"active":2,"archived":0,"specs":3}}',
      { knowledge: true, maintenance: true, openspec: true, superpowers: true },
    );
    expect(stats.knowledge).toBeNull();
    expect(stats.maintenance).toBeNull();
    expect(stats.openspec).toEqual({ active: 2, archived: 0, specs: 3 });
  });

  test("handles malformed output as all-null", () => {
    expect(parseFeatureStats("not-json", features)).toEqual({
      knowledge: null,
      maintenance: null,
      openspec: null,
    });
    expect(parseFeatureStats("", features)).toEqual({
      knowledge: null,
      maintenance: null,
      openspec: null,
    });
  });

  test("does not parse a feature that is disabled in the feature set", () => {
    const stats = parseFeatureStats(
      '{"knowledge":null,"maintenance":{"reports":1,"lastReportDate":null,"months":0},"openspec":null}',
      { knowledge: false, maintenance: true, openspec: false, superpowers: false },
    );
    expect(stats).toEqual({
      knowledge: null,
      maintenance: { reports: 1, lastReportDate: null, months: 0 },
      openspec: null,
    });
  });
});

describe("buildFeatureStatsCommand", () => {
  test("emits a JSON object the shell can produce", async () => {
    const f = await fixture();
    try {
      const source = buildFeatureStatsCommand(`${f.workspaceRoot}/alpha`);
      const result = await shellCommand(source);
      expect(result.exitCode).toBe(0);
      const parsed: unknown = JSON.parse(result.stdout);
      expect(parsed).toEqual({
        knowledge: { files: 2, patterns: 1, architecture: 1, tooling: 0, troubleshooting: 0, lastModified: expect.any(Number) },
        maintenance: null,
        openspec: { active: 1, archived: 1, specs: 1 },
      });
    } finally {
      await f.cleanup();
    }
  });
});
