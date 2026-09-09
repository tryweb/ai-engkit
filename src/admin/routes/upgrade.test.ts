import { describe, expect, test } from "bun:test";
import { createUpgradeRoutes, type UpgradeRoutesDeps } from "./upgrade";
import type { GhcrDiscoveryResult } from "../lib/ghcr-versions";
import type { UpgradeEvent } from "../lib/upgrade";

function depsWith(overrides: Partial<UpgradeRoutesDeps> = {}): { deps: UpgradeRoutesDeps; state: { version: string; env: Record<string, string>; discoveryResult: GhcrDiscoveryResult; discoveryError: Error | null; upgradeState: string; writeCalls: Array<Record<string, string>>; deleteCalls: string[]; runCalls: number } } {
  const state = {
    version: "v1.2.0",
    env: {} as Record<string, string>,
    discoveryResult: { versions: ["v1.2.0", "v1.1.0", "v1.0.1"], officialVersion: "v1.2.0", warning: null } as GhcrDiscoveryResult,
    discoveryError: null as Error | null,
    upgradeState: "idle",
    writeCalls: [] as Array<Record<string, string>>,
    deleteCalls: [] as string[],
    runCalls: 0,
  };

  const deps: UpgradeRoutesDeps = {
    readVersion: () => state.version,
    getState: () => state.upgradeState as ReturnType<UpgradeRoutesDeps["getState"]>,
    getStatus: () => ({ state: state.upgradeState, events: [], current_step: "", progress_pct: 0 }) as ReturnType<UpgradeRoutesDeps["getStatus"]>,
    getEventLog: () => [],
    subscribe: (_subscriber: (event: UpgradeEvent) => void) => () => undefined,
    runUpgrade: async () => {
      state.runCalls++;
      return true;
    },
    readEnvFile: () => ({ ...state.env }),
    writeEnvFile: (vars) => {
      state.writeCalls.push({ ...vars });
      state.env = { ...vars };
    },
    deleteEnvVar: (key: string) => {
      state.deleteCalls.push(key);
      const vars = { ...state.env };
      delete vars[key];
      state.env = vars;
    },
    discoverVersions: async () => {
      if (state.discoveryError) throw state.discoveryError;
      return state.discoveryResult;
    },
    ...overrides,
  };

  return { deps, state };
}

describe("GET /api/upgrade/versions", () => {
  test("returns normalized formal list, official_version, current_version, configured_version, warning", async () => {
    const { deps } = depsWith();
    const app = createUpgradeRoutes(deps);
    const res = await app.request("http://localhost/api/upgrade/versions");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["versions"]).toEqual(["v1.2.0", "v1.1.0", "v1.0.1"]);
    expect(body["official_version"]).toBe("v1.2.0");
    expect(body["current_version"]).toBe("v1.2.0");
    expect(body["configured_version"]).toBeNull();
    expect(body["warning"]).toBeNull();
    expect(body["error"]).toBeNull();
  });

  test("dev build returns dev marker without calling discovery", async () => {
    let called = false;
    const { deps } = depsWith({
      readVersion: () => "dev",
      discoverVersions: async () => {
        called = true;
        return { versions: [], officialVersion: null, warning: null };
      },
    });
    const app = createUpgradeRoutes(deps);
    const res = await app.request("http://localhost/api/upgrade/versions");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["versions"]).toEqual([]);
    expect(body["official_version"]).toBeNull();
    expect(called).toBe(false);
  });

  test("registry failure returns 500 with error", async () => {
    const { deps, state } = depsWith();
    state.discoveryError = new Error("GHCR token failed");
    const app = createUpgradeRoutes(deps);
    const res = await app.request("http://localhost/api/upgrade/versions");
    expect(res.status).toBe(500);
    const body = await res.json() as Record<string, unknown>;
    expect(body["error"]).toContain("GHCR");
    expect(body["versions"]).toEqual([]);
  });

  test("warning propagated when latest has no alias", async () => {
    const { deps, state } = depsWith();
    state.discoveryResult = { versions: ["v1.1.0"], officialVersion: null, warning: "latest does not match any formal release" };
    const app = createUpgradeRoutes(deps);
    const res = await app.request("http://localhost/api/upgrade/versions");
    const body = await res.json() as Record<string, unknown>;
    expect(body["official_version"]).toBeNull();
    expect(body["warning"]).toContain("latest");
  });

  test("empty formal set", async () => {
    const { deps, state } = depsWith();
    state.discoveryResult = { versions: [], officialVersion: null, warning: null };
    const app = createUpgradeRoutes(deps);
    const res = await app.request("http://localhost/api/upgrade/versions");
    const body = await res.json() as Record<string, unknown>;
    expect(body["versions"]).toEqual([]);
    expect(body["official_version"]).toBeNull();
  });
});

describe("POST /api/upgrade", () => {
  test("persists AI_ENGKIT_VERSION before calling runUpgrade with valid formal tag", async () => {
    const { deps, state } = depsWith();
    state.env = { OTHER: "keep" };
    const app = createUpgradeRoutes(deps);
    const res = await app.request("http://localhost/api/upgrade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: "v1.1.0" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["version"]).toBe("v1.1.0");
    expect(state.writeCalls.length).toBe(1);
    expect(state.writeCalls[0]["AI_ENGKIT_VERSION"]).toBe("v1.1.0");
    expect(state.writeCalls[0]["OTHER"]).toBe("keep");
    expect(state.runCalls).toBe(1);
  });

  test("official target is pinned reproducibly (uses resolved v1.x.y)", async () => {
    const { deps, state } = depsWith();
    const app = createUpgradeRoutes(deps);
    const res = await app.request("http://localhost/api/upgrade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: "v1.2.0" }),
    });
    expect(res.status).toBe(200);
    expect(state.env["AI_ENGKIT_VERSION"]).toBe("v1.2.0");
  });

  test("rejects malformed version", async () => {
    const { deps, state } = depsWith();
    const app = createUpgradeRoutes(deps);
    for (const bad of ["", "latest", "v1.0", "v2.0.0", "v1.0.0-rc1", "sha-abc"]) {
      const res = await app.request("http://localhost/api/upgrade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: bad }),
      });
      expect(res.status).toBe(400);
    }
    expect(state.writeCalls.length).toBe(0);
    expect(state.runCalls).toBe(0);
  });

  test("rejects unknown version not in discovery", async () => {
    const { deps, state } = depsWith();
    const app = createUpgradeRoutes(deps);
    const res = await app.request("http://localhost/api/upgrade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: "v1.9.9" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as Record<string, unknown>)["error"]).toContain("Unknown");
    expect(state.writeCalls.length).toBe(0);
  });

  test("re-validates against fresh discovery (fails if version not in fresh list)", async () => {
    const { deps, state } = depsWith({
      discoverVersions: async () => ({ versions: ["v1.1.0"], officialVersion: "v1.1.0", warning: null }),
    });
    const app = createUpgradeRoutes(deps);
    const res = await app.request("http://localhost/api/upgrade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: "v1.2.0" }),
    });
    expect(res.status).toBe(400);
    expect(state.writeCalls.length).toBe(0);
  });

  test("discovery failure returns 502 without changing env", async () => {
    const { deps, state } = depsWith();
    state.discoveryError = new Error("GHCR down");
    const app = createUpgradeRoutes(deps);
    const res = await app.request("http://localhost/api/upgrade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: "v1.1.0" }),
    });
    expect(res.status).toBe(502);
    expect(state.writeCalls.length).toBe(0);
    expect(state.runCalls).toBe(0);
  });

  test("empty formal set rejects with 400", async () => {
    const { deps, state } = depsWith();
    state.discoveryResult = { versions: [], officialVersion: null, warning: null };
    const app = createUpgradeRoutes(deps);
    const res = await app.request("http://localhost/api/upgrade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: "v1.1.0" }),
    });
    expect(res.status).toBe(400);
    expect(state.writeCalls.length).toBe(0);
  });

  test("preserves 409 when upgrade already running and does not change env", async () => {
    const { deps, state } = depsWith();
    state.upgradeState = "running";
    const app = createUpgradeRoutes(deps);
    const res = await app.request("http://localhost/api/upgrade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: "v1.1.0" }),
    });
    expect(res.status).toBe(409);
    expect(state.writeCalls.length).toBe(0);
    expect(state.runCalls).toBe(0);
  });

  test("serializes concurrent upgrade starts before changing env", async () => {
    let releaseUpgrade: (() => void) | undefined;
    const upgradeStarted = new Promise<void>((resolve) => {
      releaseUpgrade = resolve;
    });
    const { deps, state } = depsWith({
      runUpgrade: async () => {
        state.runCalls++;
        await upgradeStarted;
        return true;
      },
    });
    const app = createUpgradeRoutes(deps);
    const request = () => app.request("http://localhost/api/upgrade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: "v1.1.0" }),
    });

    const first = await request();
    const second = await request();
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(state.writeCalls.length).toBe(1);
    expect(state.runCalls).toBe(1);
    releaseUpgrade?.();
  });

  test("dev build restriction rejects POST", async () => {
    const { deps, state } = depsWith({ readVersion: () => "dev" });
    const app = createUpgradeRoutes(deps);
    const res = await app.request("http://localhost/api/upgrade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: "v1.1.0" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as Record<string, unknown>)["error"]).toContain("Dev build");
    expect(state.writeCalls.length).toBe(0);
  });

  test("invalid JSON body rejected", async () => {
    const { deps } = depsWith();
    const app = createUpgradeRoutes(deps);
    const res = await app.request("http://localhost/api/upgrade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });

  test("missing version field rejected", async () => {
    const { deps } = depsWith();
    const app = createUpgradeRoutes(deps);
    const res = await app.request("http://localhost/api/upgrade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("preserves SSE/status/log behavior (factory exposes log)", async () => {
    const { deps } = depsWith();
    const app = createUpgradeRoutes(deps);
    const res = await app.request("http://localhost/api/upgrade/status");
    expect(res.status).toBe(200);
  });
});

describe("GET /api/upgrade/versions configured_version", () => {
  test("returns null when AI_ENGKIT_VERSION not set", async () => {
    const { deps, state } = depsWith();
    state.env = {};
    const app = createUpgradeRoutes(deps);
    const res = await app.request("http://localhost/api/upgrade/versions");
    const body = await res.json() as Record<string, unknown>;
    expect(body["configured_version"]).toBeNull();
  });

  test("returns trimmed value when AI_ENGKIT_VERSION is set", async () => {
    const { deps, state } = depsWith();
    state.env = { AI_ENGKIT_VERSION: "v1.1.0" };
    const app = createUpgradeRoutes(deps);
    const res = await app.request("http://localhost/api/upgrade/versions");
    const body = await res.json() as Record<string, unknown>;
    expect(body["configured_version"]).toBe("v1.1.0");
  });

  test("treats whitespace-only AI_ENGKIT_VERSION as null", async () => {
    const { deps, state } = depsWith();
    state.env = { AI_ENGKIT_VERSION: "   " };
    const app = createUpgradeRoutes(deps);
    const res = await app.request("http://localhost/api/upgrade/versions");
    const body = await res.json() as Record<string, unknown>;
    expect(body["configured_version"]).toBeNull();
  });

  test("returns configured_version in dev build response", async () => {
    const { deps, state } = depsWith({ readVersion: () => "dev" });
    state.env = { AI_ENGKIT_VERSION: "v1.0.1" };
    const app = createUpgradeRoutes(deps);
    const res = await app.request("http://localhost/api/upgrade/versions");
    const body = await res.json() as Record<string, unknown>;
    expect(body["configured_version"]).toBe("v1.0.1");
    expect(body["current_version"]).toBe("dev");
  });

  test("returns configured_version in error response", async () => {
    const { deps, state } = depsWith();
    state.env = { AI_ENGKIT_VERSION: "v1.1.0" };
    state.discoveryError = new Error("GHCR down");
    const app = createUpgradeRoutes(deps);
    const res = await app.request("http://localhost/api/upgrade/versions");
    expect(res.status).toBe(500);
    const body = await res.json() as Record<string, unknown>;
    expect(body["configured_version"]).toBe("v1.1.0");
  });
});

describe("POST /api/upgrade target_type", () => {
  test("rejects an invalid target_type", async () => {
    const { deps, state } = depsWith();
    const app = createUpgradeRoutes(deps);
    const res = await app.request("http://localhost/api/upgrade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: "v1.2.0", target_type: "latest" }),
    });
    expect(res.status).toBe(400);
    expect(state.writeCalls.length).toBe(0);
    expect(state.deleteCalls.length).toBe(0);
    expect(state.runCalls).toBe(0);
  });

  test("official deletes AI_ENGKIT_VERSION and does not write", async () => {
    const { deps, state } = depsWith();
    state.env = { AI_ENGKIT_VERSION: "v1.0.1", OTHER: "keep" };
    const app = createUpgradeRoutes(deps);
    const res = await app.request("http://localhost/api/upgrade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: "v1.2.0", target_type: "official" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["version"]).toBe("v1.2.0");
    expect(state.deleteCalls).toEqual(["AI_ENGKIT_VERSION"]);
    expect(state.writeCalls.length).toBe(0);
    expect(state.env["OTHER"]).toBe("keep");
    expect(state.env["AI_ENGKIT_VERSION"]).toBeUndefined();
    expect(state.runCalls).toBe(1);
  });

  test("specified persists AI_ENGKIT_VERSION and does not delete", async () => {
    const { deps, state } = depsWith();
    state.env = { OTHER: "keep" };
    const app = createUpgradeRoutes(deps);
    const res = await app.request("http://localhost/api/upgrade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: "v1.1.0", target_type: "specified" }),
    });
    expect(res.status).toBe(200);
    expect(state.writeCalls.length).toBe(1);
    expect(state.writeCalls[0]["AI_ENGKIT_VERSION"]).toBe("v1.1.0");
    expect(state.writeCalls[0]["OTHER"]).toBe("keep");
    expect(state.deleteCalls.length).toBe(0);
    expect(state.runCalls).toBe(1);
  });

  test("official rejects when officialVersion is null", async () => {
    const { deps, state } = depsWith();
    state.discoveryResult = { versions: ["v1.1.0"], officialVersion: null, warning: "latest missing" };
    const app = createUpgradeRoutes(deps);
    const res = await app.request("http://localhost/api/upgrade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: "v1.1.0", target_type: "official" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body["error"]).toContain("Official version unavailable");
    expect(state.writeCalls.length).toBe(0);
    expect(state.deleteCalls.length).toBe(0);
  });

  test("official rejects when submitted version does not match officialVersion", async () => {
    const { deps, state } = depsWith();
    const app = createUpgradeRoutes(deps);
    const res = await app.request("http://localhost/api/upgrade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: "v1.1.0", target_type: "official" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body["error"]).toContain("Official target must be");
    expect(state.writeCalls.length).toBe(0);
    expect(state.deleteCalls.length).toBe(0);
  });

  test("backward compat: no target_type behaves as specified", async () => {
    const { deps, state } = depsWith();
    state.env = { OTHER: "keep" };
    const app = createUpgradeRoutes(deps);
    const res = await app.request("http://localhost/api/upgrade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: "v1.1.0" }),
    });
    expect(res.status).toBe(200);
    expect(state.writeCalls.length).toBe(1);
    expect(state.writeCalls[0]["AI_ENGKIT_VERSION"]).toBe("v1.1.0");
    expect(state.deleteCalls.length).toBe(0);
    expect(state.runCalls).toBe(1);
  });

  test("official removes existing AI_ENGKIT_VERSION env var before upgrade", async () => {
    const { deps, state } = depsWith();
    state.env = { AI_ENGKIT_VERSION: "v1.0.1" };
    const app = createUpgradeRoutes(deps);
    const res = await app.request("http://localhost/api/upgrade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: "v1.2.0", target_type: "official" }),
    });
    expect(res.status).toBe(200);
    expect(state.deleteCalls).toEqual(["AI_ENGKIT_VERSION"]);
    expect(state.env["AI_ENGKIT_VERSION"]).toBeUndefined();
  });

  test("specified overwrites existing AI_ENGKIT_VERSION with new target", async () => {
    const { deps, state } = depsWith();
    state.env = { AI_ENGKIT_VERSION: "v1.0.1" };
    const app = createUpgradeRoutes(deps);
    const res = await app.request("http://localhost/api/upgrade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: "v1.2.0", target_type: "specified" }),
    });
    expect(res.status).toBe(200);
    expect(state.writeCalls.length).toBe(1);
    expect(state.writeCalls[0]["AI_ENGKIT_VERSION"]).toBe("v1.2.0");
    expect(state.deleteCalls.length).toBe(0);
  });
});

describe("GET /upgrade shell-first", () => {
  test("renders immediately without blocking, shows component loading skeleton", async () => {
    const { deps } = depsWith();
    const app = createUpgradeRoutes(deps);
    const start = Date.now();
    const res = await app.request("http://localhost/upgrade");
    const elapsed = Date.now() - start;
    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(500);
    const html = await res.text();
    expect(html).toContain("Upgrade Engine");
    expect(html).toContain('id="component-versions-root"');
    expect(html).toContain('id="component-versions-loading"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('class="spinner"');
    expect(html).toContain('class="skeleton');
    expect(html).toContain('id="component-versions-retry"');
    expect(html).toContain('id="component-versions-skeletons"');
  });

  test("shell keeps version-selector loading state with spinner, elapsed, aria-busy and retry", async () => {
    const { deps } = depsWith();
    const app = createUpgradeRoutes(deps);
    const res = await app.request("http://localhost/upgrade");
    const html = await res.text();
    expect(html).toContain('id="versions-loading"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('role="status"');
    expect(html).toContain('id="versions-elapsed"');
    expect(html).toContain('id="versions-retry"');
    expect(html).toContain('aria-label="Retry loading versions"');
    expect(html).toContain('id="version-selector-card"');
    expect(html).toContain('id="current-version-display"');
  });

  test("shell hydrates via Promise.all and AbortController without altering POST/SSE shapes", async () => {
    const { deps } = depsWith();
    const app = createUpgradeRoutes(deps);
    const res = await app.request("http://localhost/upgrade");
    const html = await res.text();
    expect(html).toContain("loadComponentVersions");
    expect(html).toContain("Promise.all");
    expect(html).toContain("/api/versions");
    expect(html).toContain("/api/versions/image");
    expect(html).toContain("AbortController");
    const statusRes = await app.request("http://localhost/api/upgrade/status");
    expect(statusRes.status).toBe(200);
    const logRes = await app.request("http://localhost/api/upgrade/log?history=1");
    expect([200, 404].includes(logRes.status)).toBe(true);
  });

  test("dev build shell still shows not-available card and component skeleton", async () => {
    const { deps } = depsWith({ readVersion: () => "dev" });
    const app = createUpgradeRoutes(deps);
    const res = await app.request("http://localhost/upgrade");
    const html = await res.text();
    expect(html).toContain("Not Available in Dev Build");
    expect(html).toContain('id="component-versions-root"');
  });
});
