import { describe, expect, test } from "bun:test";
import { createLspRoutes, type LspRoutesDeps } from "./lsp";
import { LSP_CATALOG } from "../lib/lsp-catalog";
import type { LspReconcileSummary, LspApplyResult } from "../lib/lsp-reconciler";
import type { LspServersOverrides } from "../lib/lsp-config";

function summary(overrides: {
  readonly desiredEnabled?: boolean;
  readonly pinnedVersion?: string | null;
  readonly installedVersion?: string | null;
  readonly inLspBlock?: boolean;
  readonly drift?: LspReconcileSummary["servers"][number]["drift"];
}): LspReconcileSummary {
  return {
    servers: [
      {
        serverKey: LSP_CATALOG[0].serverKey,
        desiredEnabled: overrides.desiredEnabled ?? true,
        pinnedVersion: overrides.pinnedVersion ?? null,
        installedVersion: overrides.installedVersion ?? null,
        inLspBlock: overrides.inLspBlock ?? true,
        drift: overrides.drift ?? null,
      },
    ],
    inSync: overrides.drift ? 0 : 1,
    drifted: overrides.drift ? 1 : 0,
  };
}

function depsWith(overrides: Partial<LspRoutesDeps> = {}) {
  const state: { saved: LspServersOverrides | null } = { saved: null };
  const deps: LspRoutesDeps = {
    reconcile: async () => summary({}),
    apply: async (): Promise<LspApplyResult> => ({
      ok: true,
      changed: 0,
      applied: 0,
      failed: 0,
      servers: summary({}).servers,
    }),
    discoverVersions: async (pkg) => ({
      package: pkg, // ignored by the route; kept for clarity
      latest: "2.5.0",
      versions: ["2.5.0", "2.4.0", "2.3.0"],
    }),
    readOverrides: () => ({}),
    saveOverrides: (o) => {
      state.saved = o;
      return { ok: true };
    },
    readCatalog: () => LSP_CATALOG,
    ...overrides,
  };
  return { deps, state };
}

describe("GET /api/lsp", () => {
  test("returns merged catalog, override, and observed rows", async () => {
    const { deps } = depsWith({
      readOverrides: () => ({ [LSP_CATALOG[0].serverKey]: { enabled: false, version: "2.4.0" } }),
      reconcile: async () => summary({ desiredEnabled: false, pinnedVersion: "2.4.0", installedVersion: "2.4.0" }),
    });

    const response = await createLspRoutes(deps).request("http://localhost/api/lsp");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { servers: Array<{ serverKey: string; enabled: boolean; pinnedVersion: string | null; installedVersion: string | null; drift: unknown }> };
    expect(body.servers.length).toBe(LSP_CATALOG.length);
    const row = body.servers.find((s) => s.serverKey === LSP_CATALOG[0].serverKey);
    expect(row?.enabled).toBe(false);
    expect(row?.pinnedVersion).toBe("2.4.0");
    expect(row?.installedVersion).toBe("2.4.0");
    expect(row?.drift).toBeNull();
  });
});

describe("GET /api/lsp/versions", () => {
  test("returns discovered versions for a known package", async () => {
    const { deps } = depsWith();
    const pkg = LSP_CATALOG[0].npmPackage;
    const response = await createLspRoutes(deps).request(`http://localhost/api/lsp/versions?package=${encodeURIComponent(pkg)}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { versions: string[]; latest: string };
    expect(body.versions[0]).toBe("2.5.0");
    expect(body.latest).toBe("2.5.0");
  });

  test("rejects an unknown package with 400", async () => {
    const { deps } = depsWith();
    const response = await createLspRoutes(deps).request("http://localhost/api/lsp/versions?package=nope-pkg");
    expect(response.status).toBe(400);
  });

  test("surfaces a registry error as 502", async () => {
    const { deps } = depsWith({
      discoverVersions: async () => {
        throw new Error("registry unreachable");
      },
    });
    const pkg = LSP_CATALOG[0].npmPackage;
    const response = await createLspRoutes(deps).request(`http://localhost/api/lsp/versions?package=${encodeURIComponent(pkg)}`);
    expect(response.status).toBe(502);
  });
});

describe("PUT /api/lsp", () => {
  test("persists valid overrides", async () => {
    const { deps, state } = depsWith();
    const key = LSP_CATALOG[0].serverKey;
    const response = await createLspRoutes(deps).request("http://localhost/api/lsp", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ overrides: { [key]: { enabled: true, version: "2.4.0" } } }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(state.saved?.[key]).toEqual({ enabled: true, version: "2.4.0" });
  });

  test("rejects an unknown server key without persisting", async () => {
    const { deps, state } = depsWith();
    const response = await createLspRoutes(deps).request("http://localhost/api/lsp", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ overrides: { bogus: { enabled: true, version: null } } }),
    });
    expect(response.status).toBe(400);
    expect(state.saved).toBeNull();
  });

  test("rejects a malformed override without persisting", async () => {
    const { deps, state } = depsWith();
    const key = LSP_CATALOG[0].serverKey;
    const response = await createLspRoutes(deps).request("http://localhost/api/lsp", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ overrides: { [key]: { enabled: "yes", version: null } } }),
    });
    expect(response.status).toBe(400);
    expect(state.saved).toBeNull();
  });

  test("rejects invalid JSON body", async () => {
    const { deps, state } = depsWith();
    const response = await createLspRoutes(deps).request("http://localhost/api/lsp", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(response.status).toBe(400);
    expect(state.saved).toBeNull();
  });
});

describe("POST /api/lsp/apply", () => {
  test("returns the apply result", async () => {
    const { deps } = depsWith({
      apply: async () => ({ ok: true, changed: 2, applied: 2, failed: 0, servers: summary({}).servers }),
    });
    const response = await createLspRoutes(deps).request("http://localhost/api/lsp/apply", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, changed: 2, applied: 2, failed: 0 });
  });

  test("returns 500 when apply fails", async () => {
    const { deps } = depsWith({
      apply: async () => ({ ok: false, changed: 1, applied: 0, failed: 1, error: "bun install failed", servers: summary({}).servers }),
    });
    const response = await createLspRoutes(deps).request("http://localhost/api/lsp/apply", { method: "POST" });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ ok: false, error: "bun install failed" });
  });
});

describe("GET /lsp", () => {
  test("renders the management page", async () => {
    const { deps } = depsWith();
    const response = await createLspRoutes(deps).request("http://localhost/lsp");
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("LSP Server Management");
    expect(text).toContain("LSP Servers");
  });

  test("renders status as an accessible icon with tooltip and labeled cells", async () => {
    const { deps } = depsWith();
    const response = await createLspRoutes(deps).request("http://localhost/lsp");
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('id="lsp-table"');
    expect(text).toContain('aria-label="In sync');
    expect(text).toContain('class="visually-hidden"');
    expect(text).toContain('data-label="Status"');
    expect(text).toContain('data-label="Enabled"');
  });
});

describe("OpenCode v2 gate", () => {
  test("PUT rejects writes on v2 without persisting", async () => {
    const { __setExecForTest, __resetExecForTest } = await import("../lib/opencode-v2");
    __setExecForTest((async () => ({ stdout: "opencode v2.0.15", stderr: "", exitCode: 0 })) as never);
    try {
      const { deps, state } = depsWith();
      const key = LSP_CATALOG[0].serverKey;
      const response = await createLspRoutes(deps).request("http://localhost/api/lsp", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overrides: { [key]: { enabled: true, version: null } } }),
      });
      expect(response.status).toBe(409);
      expect(state.saved).toBeNull();
    } finally {
      __resetExecForTest();
    }
  });

  test("POST /api/lsp/apply is blocked on v2 without applying", async () => {
    const { __setExecForTest, __resetExecForTest } = await import("../lib/opencode-v2");
    let applied = false;
    __setExecForTest((async () => ({ stdout: "opencode v2.0.15", stderr: "", exitCode: 0 })) as never);
    try {
      const { deps } = depsWith({
        apply: async () => {
          applied = true;
          return { ok: true, changed: 0, applied: 0, failed: 0, servers: summary({}).servers };
        },
      });
      const response = await createLspRoutes(deps).request("http://localhost/api/lsp/apply", { method: "POST" });
      expect(response.status).toBe(409);
      expect(applied).toBe(false);
    } finally {
      __resetExecForTest();
    }
  });

  test("GET /lsp renders v2 banner with disabled controls", async () => {
    const { __setExecForTest, __resetExecForTest } = await import("../lib/opencode-v2");
    __setExecForTest((async () => ({ stdout: "opencode v2.0.15", stderr: "", exitCode: 0 })) as never);
    try {
      const { deps } = depsWith();
      const response = await createLspRoutes(deps).request("http://localhost/lsp");
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("lsp-v2-notice");
      expect(text).toContain("Apply Changes");
    } finally {
      __resetExecForTest();
    }
  });

  test("V1 behavior is unchanged when version detection fails", async () => {
    const { __setExecForTest, __resetExecForTest } = await import("../lib/opencode-v2");
    __setExecForTest((async () => ({ stdout: "", stderr: "no docker", exitCode: 1 })) as never);
    try {
      const { deps, state } = depsWith();
      const key = LSP_CATALOG[0].serverKey;
      const response = await createLspRoutes(deps).request("http://localhost/api/lsp", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overrides: { [key]: { enabled: true, version: null } } }),
      });
      expect(response.status).toBe(200);
      expect(state.saved?.[key]).toEqual({ enabled: true, version: null });
    } finally {
      __resetExecForTest();
    }
  });
});

describe("server.ts mount", () => {
  test("lspRoutes default export is a Hono instance", async () => {
    const routes = (await import("./lsp")).default;
    expect(typeof routes.fetch).toBe("function");
  });
});
