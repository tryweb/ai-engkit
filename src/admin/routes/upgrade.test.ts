import { describe, expect, test } from "bun:test";
import { createUpgradeRoutes, type UpgradeRoutesDeps } from "./upgrade";
import type { GhcrDiscoveryResult } from "../lib/ghcr-versions";

function fixture(overrides: Partial<UpgradeRoutesDeps> = {}) {
  const state = {
    version: "v2.0.27",
    env: {} as Record<string, string>,
    discovery: { versions: ["v2.0.27", "v2.0.26", "v1.9.0"], officialVersion: "v2.0.27", warning: null } as GhcrDiscoveryResult,
    writes: [] as Record<string, string>[],
    deletes: [] as string[],
    runs: 0,
    running: false,
  };
  const deps: UpgradeRoutesDeps = {
    readVersion: () => state.version,
    getState: () => state.running ? "running" : "idle",
    getStatus: () => ({ state: state.running ? "running" : "idle", events: [], current_step: "", progress_pct: 0, overlay: { configured: false, active: false, reference: null, error: null } }),
    getEventLog: () => [],
    subscribe: () => () => {},
    runUpgrade: async () => { state.runs++; return true; },
    readEnvFile: () => ({ ...state.env }),
    writeEnvFile: (vars) => { state.writes.push({ ...vars }); state.env = { ...vars }; },
    deleteEnvVar: (key) => { state.deletes.push(key); delete state.env[key]; },
    discoverVersions: async () => state.discovery,
    ...overrides,
  };
  const app = createUpgradeRoutes(deps);
  const post = (body: unknown) => app.request("http://localhost/api/upgrade", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { app, post, state };
}

describe("V2 upgrade discovery", () => {
  test("filters other majors and returns current, configured and official versions", async () => {
    const { app, state } = fixture();
    state.env.AI_ENGKIT_VERSION = " v2.0.26 ";
    const response = await app.request("http://localhost/api/upgrade/versions");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ versions: ["v2.0.27", "v2.0.26"], current_version: "v2.0.27", configured_version: "v2.0.26", official_version: "v2.0.27" });
  });

  test("does not expose another major as the official target", async () => {
    const { app, state } = fixture();
    state.discovery = { ...state.discovery, officialVersion: "v1.9.0" };
    expect(await (await app.request("http://localhost/api/upgrade/versions")).json()).toMatchObject({ official_version: null });
  });

  test("propagates discovery warnings", async () => {
    const { app, state } = fixture();
    state.discovery = { ...state.discovery, warning: "alias missing" };
    expect(await (await app.request("http://localhost/api/upgrade/versions")).json()).toMatchObject({ warning: "alias missing" });
  });

  test("returns discovery failure with configured version", async () => {
    const { app, state } = fixture({ discoverVersions: async () => { throw new Error("registry unavailable"); } });
    state.env.AI_ENGKIT_VERSION = "v2.0.26";
    const response = await app.request("http://localhost/api/upgrade/versions");
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ configured_version: "v2.0.26", error: "registry unavailable" });
  });

  test("rolling installations expose v2-dev", async () => {
    const { app, state } = fixture();
    state.version = "v2-dev";
    expect(await (await app.request("http://localhost/api/upgrade/versions")).json()).toMatchObject({ versions: ["v2-dev", "v2.0.27", "v2.0.26"] });
  });
});

describe("V2 upgrade validation and persistence", () => {
  test.each([null, [], {}, { version: 12 }, { version: "" }, { version: "latest" }, { version: "v1.9.0" }, { version: "v2.0" }, { version: "v2.0.28" }, { version: "v2.0.27-rc1" }, { version: "v2.0.27", target_type: "invalid" }])("rejects invalid or undiscovered target %j without mutation", async (body) => {
    const { post, state } = fixture();
    expect((await post(body)).status).toBe(400);
    expect(state.runs).toBe(0);
    expect(state.writes).toHaveLength(0);
    expect(state.deletes).toHaveLength(0);
  });

  test.each(["specified", undefined])("target type %j persists the pin before upgrading", async (target_type) => {
    const { post, state } = fixture({ runUpgrade: async () => {
      expect(state.env.AI_ENGKIT_VERSION).toBe("v2.0.26");
      state.runs++;
      return true;
    } });
    state.env.OTHER = "keep";
    expect((await post({ version: "v2.0.26", target_type })).status).toBe(200);
    expect(state.writes).toEqual([{ OTHER: "keep", AI_ENGKIT_VERSION: "v2.0.26" }]);
    expect(state.runs).toBe(1);
    expect(state.deletes).toHaveLength(0);
  });

  test("official target removes a prior pin and preserves unrelated env", async () => {
    const { post, state } = fixture();
    state.env = { AI_ENGKIT_VERSION: "v2.0.26", OTHER: "keep" };
    expect((await post({ version: "v2.0.27", target_type: "official" })).status).toBe(200);
    expect(state.deletes).toEqual(["AI_ENGKIT_VERSION"]);
    expect(state.writes).toHaveLength(0);
    expect(state.env).toEqual({ OTHER: "keep" });
    expect(state.runs).toBe(1);
  });

  test.each([null, "v1.9.0", "v2.0.26"])("rejects unmatched official alias %j", async (officialVersion) => {
    const { post, state } = fixture();
    state.discovery = { ...state.discovery, officialVersion };
    expect((await post({ version: "v2.0.27", target_type: "official" })).status).toBe(400);
    expect(state.runs).toBe(0);
  });

  test("rolling target is permitted only as specified", async () => {
    const { post, state } = fixture();
    expect((await post({ version: "v2-dev", target_type: "official" })).status).toBe(400);
    expect((await post({ version: "v2-dev" })).status).toBe(200);
    expect(state.env.AI_ENGKIT_VERSION).toBe("v2-dev");
  });

  test("discovery failure does not mutate the pin", async () => {
    const { post, state } = fixture({ discoverVersions: async () => { throw new Error("registry down"); } });
    expect((await post({ version: "v2.0.26" })).status).toBe(502);
    expect(state.writes).toHaveLength(0);
    expect(state.runs).toBe(0);
  });

  test("rejects malformed JSON", async () => {
    const { app } = fixture();
    expect((await app.request("http://localhost/api/upgrade", { method: "POST", body: "{" })).status).toBe(400);
  });

  test("rejects an upgrade already in progress", async () => {
    const { post, state } = fixture();
    state.running = true;
    expect((await post({ version: "v2.0.26" })).status).toBe(409);
    expect(state.writes).toHaveLength(0);
  });

  test("serializes concurrent starts before changing the pin", async () => {
    let release!: (value: GhcrDiscoveryResult) => void;
    const discovery = new Promise<GhcrDiscoveryResult>((resolve) => { release = resolve; });
    const { post, state } = fixture({ discoverVersions: () => discovery });
    const first = post({ version: "v2.0.26" });
    const second = post({ version: "v2.0.27" });
    release(state.discovery);
    const responses = await Promise.all([first, second]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(state.writes).toHaveLength(1);
    expect(state.runs).toBe(1);
  });
});

describe("V2 upgrade page and dev guard", () => {
  test.each(["dev", "v2dev"])("disables upgrades in %s", async (version) => {
    const { app, post, state } = fixture();
    state.version = version;
    expect((await post({ version: "v2.0.26" })).status).toBe(400);
    expect(await (await app.request("http://localhost/api/upgrade/versions")).json()).toMatchObject({ versions: [], current_version: version });
    expect(await (await app.request("http://localhost/upgrade")).text()).toContain("Not Available in Dev Build");
  });

  test("renders the production page without waiting on registry discovery", async () => {
    const { app } = fixture({ discoverVersions: async () => { throw new Error("should not query"); } });
    const response = await app.request("http://localhost/upgrade");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('id="component-versions-root"');
  });
});
