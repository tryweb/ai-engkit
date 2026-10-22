import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  EMPTY_GIT_HOSTING_AUTH_STATE,
  loadGitHostingAuthState,
  saveGitHostingAuthState,
  withGitHostingAuthStateLock,
  type GitHostingAuthState,
} from "./git-hosting-auth-state";

const paths: string[] = [];

afterEach(() => {
  delete process.env.GIT_HOSTING_AUTH_STATE_PATH;
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(): GitHostingAuthState {
  return {
    gitlab: [{
      hostname: "gitlab.example.com",
      validity: "healthy",
      expires_at: "2026-11-01",
      days_remaining: 10,
      rotation_needed: false,
      rotation_done: true,
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
}

function useTempStatePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "git-hosting-auth-state-"));
  paths.push(directory);
  const path = join(directory, "state.json");
  process.env.GIT_HOSTING_AUTH_STATE_PATH = path;
  return path;
}

describe("git hosting auth state", () => {
  test("round-trips redacted state with restrictive permissions", () => {
    const path = useTempStatePath();
    const state = fixture();

    saveGitHostingAuthState(state);

    expect(loadGitHostingAuthState()).toEqual(state);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("writes through a temporary file and leaves no temporary file", () => {
    const path = useTempStatePath();

    saveGitHostingAuthState(fixture());

    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(existsSync(join(path, "../.git-hosting-auth-state.json.tmp"))).toBe(false);
  });

  test("uses empty healthy state when the file is corrupt", () => {
    const path = useTempStatePath();
    writeFileSync(path, "not json");

    expect(loadGitHostingAuthState()).toEqual(EMPTY_GIT_HOSTING_AUTH_STATE);
  });

  test("strips secret-bearing keys before persistence and warns", () => {
    const path = useTempStatePath();
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message: string): void => { warnings.push(message); };
    try {
      const unsafe = {
        ...fixture(),
        token: "glpat-secret",
        github: { ...fixture().github, "PRIVATE-TOKEN": "secret", body: "raw response" },
      };
      saveGitHostingAuthState(unsafe);
    } finally {
      console.warn = originalWarn;
    }

    const serialized = readFileSync(path, "utf8");
    expect(serialized).not.toContain("glpat-secret");
    expect(serialized).not.toContain("PRIVATE-TOKEN");
    expect(serialized).not.toContain("raw response");
    expect(warnings).toHaveLength(3);
    expect(loadGitHostingAuthState()).toEqual(fixture());
  });

  test("uses the environment override path", () => {
    const path = useTempStatePath();

    saveGitHostingAuthState(fixture());

    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("gitlab.example.com");
  });

  test("serializes concurrent state updates through the shared lock", async () => {
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const first = withGitHostingAuthStateLock(async () => {
      events.push("first-start");
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      events.push("first-end");
    });
    const second = withGitHostingAuthStateLock(async () => {
      events.push("second");
    });

    await Promise.resolve();
    expect(events).toEqual(["first-start"]);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(events).toEqual(["first-start", "first-end", "second"]);
  });
});
