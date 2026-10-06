import { Hono } from "hono";
import { LSP_CATALOG, LSP_CATALOG_BY_KEY, type LspCatalogEntry } from "../lib/lsp-catalog";
import {
  parseLspServers,
  serializeLspServers,
  type LspServersOverrides,
} from "../lib/lsp-config";
import { createLspReconciler } from "../lib/lsp-reconciler";
import type { LspApplyResult, LspReconcileSummary } from "../lib/lsp-reconciler";
import { discoverNpmVersions, NpmRegistryError, type NpmVersionDiscoveryResult } from "../lib/npm-versions";
import { readEnvFile, upsertEnvVar, deleteEnvVar } from "../lib/env";
import { execInAiDev } from "../lib/docker";
import { isOpenCodeV2 } from "../lib/opencode-v2";
import { LspPage } from "../views/lsp";

export interface LspRoutesDeps {
  readonly reconcile: () => Promise<LspReconcileSummary>;
  readonly apply: () => Promise<LspApplyResult>;
  readonly discoverVersions: (npmPackage: string) => Promise<NpmVersionDiscoveryResult>;
  readonly readOverrides: () => LspServersOverrides;
  readonly saveOverrides: (overrides: LspServersOverrides) => { readonly ok: boolean; readonly error?: string };
  readonly readCatalog: () => readonly LspCatalogEntry[];
}

const REAL_DEPS: LspRoutesDeps = (() => {
  const reconciler = createLspReconciler({
    exec: execInAiDev,
    readEnv: readEnvFile,
    upsertEnvVar,
    deleteEnvVar,
    // Paths are ai-dev-side: the commands run inside ai-dev via exec, so they
    // must not follow this container's HOME.
    lspBlockFile: "/home/devuser/.config/opencode/opencode.json",
    lspVarsFile: "/home/devuser/.config/opencode/lsp-managed.env",
  });
  return {
    reconcile: () => reconciler.reconcile(),
    apply: () => reconciler.apply(),
    discoverVersions: (pkg) => discoverNpmVersions(pkg),
    readOverrides: () => {
      const env = readEnvFile();
      const raw = env["LSP_SERVERS"];
      return parseLspServers(typeof raw === "string" ? raw : null);
    },
    saveOverrides: (overrides) => {
      upsertEnvVar("LSP_SERVERS", serializeLspServers(overrides));
      return { ok: true };
    },
    readCatalog: () => LSP_CATALOG,
  };
})();

function parseOverride(raw: unknown): { enabled: boolean; version: string | null } | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const enabled = record["enabled"];
  const version = record["version"];
  if (typeof enabled !== "boolean") return null;
  if (version !== null && version !== undefined && typeof version !== "string") return null;
  return { enabled, version: typeof version === "string" ? version : null };
}

export function createLspRoutes(options: Partial<LspRoutesDeps> = {}): Hono {
  const deps: LspRoutesDeps = { ...REAL_DEPS, ...options };
  const lsp = new Hono();

  async function isV2(): Promise<boolean> {
    try {
      return await isOpenCodeV2();
    } catch {
      return false;
    }
  }

  function v2Blocked() {
    return {
      error:
        "LSP server management is unavailable on OpenCode v2: the runtime accepts lsp configuration but does not run language servers. Use each project's CLI check commands (tsc, pyright, biome) for diagnostics instead.",
    };
  }

  async function loadRows() {
    const [summary, overrides, catalog] = await Promise.all([
      deps.reconcile(),
      deps.readOverrides(),
      deps.readCatalog(),
    ]);
    const byKey = new Map(summary.servers.map((s) => [s.serverKey, s]));
    return catalog.map((entry) => {
      const state = byKey.get(entry.serverKey);
      const override = overrides[entry.serverKey];
      return {
        serverKey: entry.serverKey,
        npmPackage: entry.npmPackage,
        command: entry.command,
        extensions: entry.extensions,
        defaultEnabled: entry.defaultEnabled,
        builtinBacked: entry.builtinBacked,
        enabled: state?.desiredEnabled ?? override?.enabled ?? entry.defaultEnabled,
        pinnedVersion: state?.pinnedVersion ?? override?.version ?? null,
        installedVersion: state?.installedVersion ?? null,
        inLspBlock: state?.inLspBlock ?? false,
        drift: state?.drift ?? null,
      };
    });
  }

  lsp.get("/api/lsp", async (c) => c.json({ servers: await loadRows() }));

  lsp.get("/api/lsp/versions", async (c) => {
    const pkg = c.req.query("package") ?? "";
    const entry = LSP_CATALOG.find((e) => e.npmPackage === pkg);
    if (!entry) return c.json({ error: `Unknown package: ${pkg}` }, 400);

    let discovery: NpmVersionDiscoveryResult;
    try {
      discovery = await deps.discoverVersions(entry.npmPackage);
    } catch (error: unknown) {
      if (error instanceof NpmRegistryError) {
        return c.json({ error: error.message, code: error.code }, 502);
      }
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 502);
    }
    return c.json({ package: entry.npmPackage, ...discovery });
  });

  lsp.put("/api/lsp", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return c.json({ error: "Body must be an object" }, 400);
    }
    const record = body as Record<string, unknown>;
    const rawOverrides = record["overrides"];
    if (typeof rawOverrides !== "object" || rawOverrides === null || Array.isArray(rawOverrides)) {
      return c.json({ error: "overrides must be an object" }, 400);
    }

    if (await isV2()) {
      return c.json(v2Blocked(), 409);
    }

    const overrides: Record<string, { enabled: boolean; version: string | null }> = {};
    for (const [key, value] of Object.entries(rawOverrides as Record<string, unknown>)) {
      if (!LSP_CATALOG_BY_KEY.has(key)) {
        return c.json({ error: `Unknown server: ${key}` }, 400);
      }
      const parsed = parseOverride(value);
      if (parsed === null) {
        return c.json({ error: `Invalid override for ${key}` }, 400);
      }
      overrides[key] = parsed;
    }

    const result = deps.saveOverrides(overrides);
    if ("error" in result) {
      return c.json({ error: result.error ?? "Failed to save overrides" }, 500);
    }
    return c.json({ ok: true });
  });

  lsp.post("/api/lsp/apply", async (c) => {
    if (await isV2()) {
      return c.json(v2Blocked(), 409);
    }
    const result = await deps.apply();
    if ("error" in result) {
      return c.json(
        { ok: false, error: result.error, changed: result.changed, applied: result.applied, failed: result.failed, servers: result.servers },
        500,
      );
    }
    return c.json({ ok: true, changed: result.changed, applied: result.applied, failed: result.failed, servers: result.servers });
  });

  lsp.get("/lsp", async (c) => {
    return c.html(LspPage(await loadRows(), { isV2: await isV2() }));
  });

  return lsp;
}

export default createLspRoutes();
