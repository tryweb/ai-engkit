import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildLeanCtxProjectScanCommand,
  isScannableProjectRoot,
  LEANCTX_PROJECT_ROOTS_EOF,
  parseLeanCtxProjectScan,
  parseLeanCtxProjectStatusLine,
} from "./leanctx-project-status";

interface ScanRun {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runScan(projectRoots: string[], home: string): Promise<ScanRun> {
  const process = Bun.spawn(["sh", "-c", buildLeanCtxProjectScanCommand(projectRoots)], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process_env(), HOME: home },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function process_env(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(Bun.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

interface HomeFixture {
  home: string;
  knowledge: string;
  cleanup: () => Promise<void>;
}

async function homeFixture(): Promise<HomeFixture> {
  const home = await mkdtemp(join(tmpdir(), "leanctx-project-"));
  const knowledge = join(home, ".local", "share", "lean-ctx", "knowledge");
  await mkdir(knowledge, { recursive: true });
  return { home, knowledge, cleanup: () => rm(home, { recursive: true, force: true }) };
}

async function writeStore(knowledge: string, dir: string, contents: string): Promise<void> {
  await mkdir(join(knowledge, dir), { recursive: true });
  await writeFile(join(knowledge, dir, "knowledge.json"), contents);
}

function storeJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    project_root: "/ws/alpha",
    project_hash: "aaa111",
    updated_at: "2026-09-17T00:00:00Z",
    facts: [
      { value: "TOP_SECRET_FACT_VALUE", valid_until: null },
      { value: "second", valid_until: null },
      { value: "archived", valid_until: "2026-01-01T00:00:00Z" },
    ],
    patterns: [{ name: "p" }],
    history: [{ at: 1 }, { at: 2 }],
    ...overrides,
  });
}

describe("isScannableProjectRoot", () => {
  test("accepts ordinary and space-bearing roots", () => {
    expect(isScannableProjectRoot("/ws/alpha")).toBe(true);
    expect(isScannableProjectRoot("/ws/my project")).toBe(true);
  });

  test("rejects empty, delimiter, and record-separator roots", () => {
    expect(isScannableProjectRoot("")).toBe(false);
    expect(isScannableProjectRoot(LEANCTX_PROJECT_ROOTS_EOF)).toBe(false);
    expect(isScannableProjectRoot("/ws/a\nrm -rf /")).toBe(false);
    expect(isScannableProjectRoot("/ws/a\rb")).toBe(false);
    expect(isScannableProjectRoot("/ws/a\0b")).toBe(false);
  });
});

describe("buildLeanCtxProjectScanCommand", () => {
  test("never invokes the lean-ctx binary or a mutation subcommand", () => {
    const source = buildLeanCtxProjectScanCommand(["/ws/alpha"]);
    expect(source).not.toMatch(/\blean-ctx\s+[a-z-]/);
    expect(source).not.toMatch(/\b(remember|remove|restore|consolidate|import)\b/);
  });

  test("keeps crafted roots literal inside the quoted heredoc", () => {
    const crafted = "/ws/a; touch /tmp/leanctx-pwned $(echo injected) `echo injected`";
    const source = buildLeanCtxProjectScanCommand([crafted]);
    expect(source).toContain(`<<'${LEANCTX_PROJECT_ROOTS_EOF}'`);
    expect(source).toContain(crafted);
  });
});

describe("batched scan shell", () => {
  test("projects a matching store by exact project_root without leaking secrets or identity", async () => {
    const f = await homeFixture();
    try {
      await writeStore(f.knowledge, "aaa111", storeJson());
      const { stdout, stderr, exitCode } = await runScan(["/ws/alpha"], f.home);
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(JSON.parse(stdout.trim())).toEqual({
        state: "available",
        activeFacts: 2,
        archivedFacts: 1,
        patterns: 1,
        history: 2,
        lastUpdated: "2026-09-17T00:00:00Z",
      });
      expect(stdout).not.toContain("TOP_SECRET_FACT_VALUE");
      expect(stdout).not.toContain("project_root");
      expect(stdout).not.toContain("/ws/alpha");
      expect(stdout).not.toContain("aaa111");
    } finally {
      await f.cleanup();
    }
  });

  test("reports empty when no store matches the root", async () => {
    const f = await homeFixture();
    try {
      await writeStore(f.knowledge, "aaa111", storeJson({ project_root: "/ws/other" }));
      const { stdout, exitCode } = await runScan(["/ws/alpha"], f.home);
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.trim())).toEqual({ state: "empty" });
    } finally {
      await f.cleanup();
    }
  });

  test("reports unknown for a malformed candidate and never echoes its content", async () => {
    const f = await homeFixture();
    try {
      await writeStore(f.knowledge, "aaa111", '{"project_root":"/ws/alpha","facts":[{"value":"LEAKED"');
      const { stdout, exitCode } = await runScan(["/ws/alpha"], f.home);
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.trim())).toEqual({ state: "unknown" });
      expect(stdout).not.toContain("LEAKED");
      expect(stdout).not.toContain("/ws/alpha");
    } finally {
      await f.cleanup();
    }
  });

  test("reports unknown when project_hash does not equal the store directory basename", async () => {
    const f = await homeFixture();
    try {
      await writeStore(f.knowledge, "aaa111", storeJson({ project_hash: "bbb222" }));
      const { stdout } = await runScan(["/ws/alpha"], f.home);
      expect(JSON.parse(stdout.trim())).toEqual({ state: "unknown" });
    } finally {
      await f.cleanup();
    }
  });

  test("reports unknown for an empty project_hash", async () => {
    const f = await homeFixture();
    try {
      await writeStore(f.knowledge, "aaa111", storeJson({ project_hash: "" }));
      const { stdout } = await runScan(["/ws/alpha"], f.home);
      expect(JSON.parse(stdout.trim())).toEqual({ state: "unknown" });
    } finally {
      await f.cleanup();
    }
  });

  test("reports unknown when a required count field is missing", async () => {
    const f = await homeFixture();
    try {
      await writeStore(f.knowledge, "aaa111", storeJson({ patterns: "not-an-array" }));
      const { stdout } = await runScan(["/ws/alpha"], f.home);
      expect(JSON.parse(stdout.trim())).toEqual({ state: "unknown" });
    } finally {
      await f.cleanup();
    }
  });

  test("reports unknown when more than one store matches the same root", async () => {
    const f = await homeFixture();
    try {
      await writeStore(f.knowledge, "aaa111", storeJson());
      await writeStore(f.knowledge, "bbb222", storeJson({ project_hash: "bbb222" }));
      const { stdout } = await runScan(["/ws/alpha"], f.home);
      expect(JSON.parse(stdout.trim())).toEqual({ state: "unknown" });
    } finally {
      await f.cleanup();
    }
  });

  test("maps one output line per requested root in order", async () => {
    const f = await homeFixture();
    try {
      await writeStore(f.knowledge, "aaa111", storeJson());
      const { stdout } = await runScan(["/ws/beta", "/ws/alpha", "/ws/none"], f.home);
      const lines = stdout.trim().split("\n");
      expect(lines).toHaveLength(3);
      expect(JSON.parse(lines[0]).state).toBe("empty");
      expect(JSON.parse(lines[1]).state).toBe("available");
      expect(JSON.parse(lines[2]).state).toBe("empty");
    } finally {
      await f.cleanup();
    }
  });

  test("does not execute crafted roots embedded in the heredoc", async () => {
    const f = await homeFixture();
    try {
      const payload = `$(echo injected) \`echo injected\` ; touch /tmp/leanctx-pwned-${process.pid}`;
      const target = `/tmp/leanctx-pwned-${process.pid}`;
      await rm(target, { force: true });
      const root = `/ws/${payload}`;
      const { stdout, exitCode } = await runScan([root], f.home);
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.trim())).toEqual({ state: "empty" });
      expect(stdout).not.toContain("injected");
      expect(await Bun.file(target).exists()).toBe(false);
    } finally {
      await f.cleanup();
    }
  });

  test("reports unknown for every unmatched root when any candidate is unreadable", async () => {
    const f = await homeFixture();
    try {
      await writeStore(f.knowledge, "aaa111", "not json");
      await writeStore(f.knowledge, "bbb222", storeJson({ project_root: "/ws/other", project_hash: "bbb222" }));
      const { stdout } = await runScan(["/ws/alpha"], f.home);
      expect(JSON.parse(stdout.trim())).toEqual({ state: "unknown" });
    } finally {
      await f.cleanup();
    }
  });
});

describe("parseLeanCtxProjectStatusLine", () => {
  test("parses an available projection", () => {
    expect(
      parseLeanCtxProjectStatusLine(
        '{"state":"available","activeFacts":3,"archivedFacts":1,"patterns":2,"history":4,"lastUpdated":"2026-09-17T00:00:00Z"}',
      ),
    ).toEqual({ state: "available", activeFacts: 3, archivedFacts: 1, patterns: 2, history: 4, lastUpdated: "2026-09-17T00:00:00Z" });
  });

  test("parses an available projection with a null timestamp", () => {
    expect(
      parseLeanCtxProjectStatusLine('{"state":"available","activeFacts":0,"archivedFacts":0,"patterns":0,"history":0,"lastUpdated":null}'),
    ).toEqual({ state: "available", activeFacts: 0, archivedFacts: 0, patterns: 0, history: 0, lastUpdated: null });
  });

  test("maps empty to a zeroed projection", () => {
    expect(parseLeanCtxProjectStatusLine('{"state":"empty"}')).toEqual({
      state: "empty",
      activeFacts: 0,
      archivedFacts: 0,
      patterns: 0,
      history: 0,
      lastUpdated: null,
    });
  });

  test("rejects unknown, malformed, and invalid counts", () => {
    expect(parseLeanCtxProjectStatusLine('{"state":"unknown"}')).toBeNull();
    expect(parseLeanCtxProjectStatusLine("not json")).toBeNull();
    expect(parseLeanCtxProjectStatusLine('{"state":"available","activeFacts":-1,"archivedFacts":0,"patterns":0,"history":0}')).toBeNull();
    expect(parseLeanCtxProjectStatusLine('{"state":"available","activeFacts":1.5,"archivedFacts":0,"patterns":0,"history":0}')).toBeNull();
    expect(parseLeanCtxProjectStatusLine('{"state":"available","activeFacts":1,"archivedFacts":0,"patterns":0}')).toBeNull();
  });
});

describe("parseLeanCtxProjectScan", () => {
  test("keys parsed values by root in order", () => {
    const parsed = parseLeanCtxProjectScan('{"state":"empty"}\n{"state":"unknown"}\n', ["/a", "/b"]);
    expect(parsed).not.toBeNull();
    expect(parsed?.get("/a")).toEqual({ state: "empty", activeFacts: 0, archivedFacts: 0, patterns: 0, history: 0, lastUpdated: null });
    expect(parsed?.get("/b")).toBeNull();
  });

  test("returns null when the line count does not match the requested roots", () => {
    expect(parseLeanCtxProjectScan('{"state":"empty"}', ["/a", "/b"])).toBeNull();
    expect(parseLeanCtxProjectScan('{"state":"empty"}\n{"state":"empty"}', ["/a"])).toBeNull();
  });
});
