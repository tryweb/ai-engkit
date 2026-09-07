/**
 * Reconcile desired (catalog + LSP_SERVERS overrides) against live observed
 * state (installed npm versions + the generated opencode.json lsp block).
 * No applied snapshot is stored — observed state is re-read on every call.
 */
import { LSP_CATALOG } from "./lsp-catalog";
import { resolveEffectiveConfig, readLspServers, serializeLspServers, type LspServersOverrides } from "./lsp-config";
import { upsertEnvVar as realUpsertEnvVar, deleteEnvVar as realDeleteEnvVar, type EnvVars } from "./env";
import type { ExecResult } from "./docker";

export const BUN_PACKAGES_ENV_KEY = "BUN_PACKAGES";

export type LspDriftReason = "missing_install" | "version_mismatch" | "not_enabled_in_lsp";

export interface ObservedLspServer {
  readonly installedVersion: string | null;
  readonly inLspBlock: boolean;
}

export interface LspReconciledServer {
  readonly serverKey: string;
  readonly desiredEnabled: boolean;
  readonly pinnedVersion: string | null;
  readonly installedVersion: string | null;
  readonly inLspBlock: boolean;
  readonly drift: LspDriftReason | null;
}

export interface LspReconcileSummary {
  readonly servers: readonly LspReconciledServer[];
  readonly inSync: number;
  readonly drifted: number;
}

/**
 * Pure desired-vs-observed comparison. Drift is only material for enabled
 * servers: an enabled server with nothing installed is missing_install, an
 * enabled pinned server whose installed version differs is version_mismatch,
 * and an enabled server absent from the lsp block is not_enabled_in_lsp.
 * Disabled servers never drift regardless of what happens to be installed.
 */
export function computeDrift(
  overrides: LspServersOverrides,
  observed: ReadonlyMap<string, ObservedLspServer>,
): LspReconcileSummary {
  const effective = resolveEffectiveConfig(overrides);
  const servers = effective.map((entry): LspReconciledServer => {
    const obs = observed.get(entry.serverKey) ?? { installedVersion: null, inLspBlock: false };
    let drift: LspDriftReason | null = null;
    if (entry.enabled) {
      if (obs.installedVersion === null) {
        drift = "missing_install";
      } else if (entry.version !== null && entry.version !== obs.installedVersion) {
        drift = "version_mismatch";
      } else if (!obs.inLspBlock) {
        drift = "not_enabled_in_lsp";
      }
    }
    return {
      serverKey: entry.serverKey,
      desiredEnabled: entry.enabled,
      pinnedVersion: entry.version,
      installedVersion: obs.installedVersion,
      inLspBlock: obs.inLspBlock,
      drift,
    };
  });
  return {
    servers,
    inSync: servers.filter((s) => s.drift === null).length,
    drifted: servers.filter((s) => s.drift !== null).length,
  };
}

/**
 * Parse `bun pm ls -g`-style text into package -> installed version. Lines are
 * `pkg@version`; scoped packages appear as `@scope/pkg@version`.
 */
export function parseInstalledVersions(stdout: string): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const m = /^\s*(?:[├└]──\s+)?(@?[^\s@]+)@(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\s*$/.exec(line);
    if (m) map.set(m[1], m[2]);
  }
  return map;
}

export interface LspReconcilerDeps {
  /** Run a command (e.g. inside the ai-dev container via execInAiDev). */
  readonly exec: (cmd: string, timeoutMs?: number) => Promise<ExecResult>;
  readonly readEnv: () => EnvVars;
  /** Persist a single env var to the shared .env file. */
  readonly upsertEnvVar: (key: string, value: string) => void;
  /** Remove a single env var from the shared .env file. */
  readonly deleteEnvVar: (key: string) => void;
  /** Path to the generated opencode.json whose `.lsp` block is the product. */
  readonly lspBlockFile: string;
  /**
   * Path inside ai-dev (opencode-config volume) where Apply persists
   * BUN_PACKAGES/LSP_SERVERS so the entrypoint converges on restart.
   */
  readonly lspVarsFile: string;
}

/**
 * Split a bun install token into package name and optional version. Handles
 * scoped names: `@scope/pkg@1.2.3` -> name `@scope/pkg`, version `1.2.3`.
 */
export function splitBunToken(token: string): { readonly name: string; readonly version: string | null } {
  const t = token.trim();
  if (t.startsWith("@")) {
    const idx = t.lastIndexOf("@");
    if (idx > 1) return { name: t.slice(0, idx), version: t.slice(idx + 1) };
    return { name: t, version: null };
  }
  const idx = t.indexOf("@");
  if (idx > 0) return { name: t.slice(0, idx), version: t.slice(idx + 1) };
  return { name: t, version: null };
}

/**
 * Rebuild BUN_PACKAGES: drop any token naming an LSP-managed package (so the
 * feature owns those entries), keep every unrelated user package, and append
 * the managed packages (pinned at `name@version`, unpinned as `name`) sorted
 * by name. Dedupes by package name.
 */
export function deriveBunPackages(
  existing: string,
  enabledPackages: readonly { readonly npmPackage: string; readonly version: string | null }[],
): string {
  const managed = new Map<string, string | null>();
  for (const p of enabledPackages) managed.set(p.npmPackage, p.version);

  const kept: string[] = [];
  const seen = new Set<string>();
  for (const token of existing.split(/\s+/)) {
    if (!token) continue;
    const { name } = splitBunToken(token);
    if (managed.has(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    kept.push(token);
  }

  const managedTokens: string[] = [];
  for (const [name, version] of [...managed.entries()].sort()) {
    managedTokens.push(version && version.length > 0 ? `${name}@${version}` : name);
  }
  return [...kept, ...managedTokens].join(" ").trim();
}

export type LspApplyResult =
  | {
      readonly ok: true;
      readonly changed: number;
      readonly applied: number;
      readonly failed: 0;
      readonly servers: readonly LspReconciledServer[];
    }
  | {
      readonly ok: false;
      readonly changed: number;
      readonly applied: 0;
      readonly failed: number;
      readonly error: string;
      readonly servers: readonly LspReconciledServer[];
    };

export function createLspReconciler(deps: LspReconcilerDeps) {
  const observedLspKeys = async (): Promise<ReadonlySet<string>> => {
    const result = await deps.exec(
      `jq -r '.lsp // {} | keys[]' "${deps.lspBlockFile}" 2>/dev/null`,
      10_000,
    );
    return new Set(result.exitCode === 0 ? result.stdout.split("\n").filter((k) => k.length > 0) : []);
  };

  async function readObserved(): Promise<ReadonlyMap<string, ObservedLspServer>> {
    const [installed, blockKeys] = await Promise.all([
      deps.exec("bun pm ls -g 2>/dev/null", 15_000).then((r) => parseInstalledVersions(r.stdout)),
      observedLspKeys(),
    ]);
    const map = new Map<string, ObservedLspServer>();
    for (const entry of LSP_CATALOG) {
      map.set(entry.serverKey, {
        installedVersion: installed.get(entry.npmPackage) ?? null,
        inLspBlock: blockKeys.has(entry.serverKey),
      });
    }
    return map;
  }

  async function reconcile(): Promise<LspReconcileSummary> {
    const [observed, overrides] = await Promise.all([readObserved(), readLspServers(deps.readEnv())]);
    return computeDrift(overrides, observed);
  }

  async function apply(): Promise<LspApplyResult> {
    const [observed, overrides] = await Promise.all([readObserved(), readLspServers(deps.readEnv())]);
    const summary = computeDrift(overrides, observed);
    const env = deps.readEnv();

    const installTargets = new Map<string, string>();
    for (const server of summary.servers) {
      if (!server.desiredEnabled) continue;
      if (server.drift !== "missing_install" && server.drift !== "version_mismatch") continue;
      const entry = LSP_CATALOG.find((e) => e.serverKey === server.serverKey);
      if (!entry) continue;
      installTargets.set(entry.npmPackage, server.pinnedVersion ? `${entry.npmPackage}@${server.pinnedVersion}` : entry.npmPackage);
    }

    if (installTargets.size > 0) {
      const install = await deps.exec(`bun install -g ${[...installTargets.values()].join(" ")}`, 120_000);
      if (install.exitCode !== 0) {
        return {
          ok: false,
          changed: installTargets.size,
          applied: 0,
          failed: installTargets.size,
          error: install.stderr || install.stdout || "bun install failed",
          servers: summary.servers,
        };
      }
    }

    const lspBlock: Record<string, { readonly command: readonly string[]; readonly extensions: readonly string[] }> = {
      marksman: { command: ["marksman", "server"], extensions: [".md", ".markdown"] },
    };
    for (const server of summary.servers) {
      if (!server.desiredEnabled) continue;
      const entry = LSP_CATALOG.find((e) => e.serverKey === server.serverKey);
      if (!entry) continue;
      lspBlock[entry.serverKey] = { command: entry.command, extensions: entry.extensions };
    }
    const lspJson = JSON.stringify(lspBlock).replaceAll("'", "'\"'\"'");
    const lspUpdate = await deps.exec(
      `jq --argjson lsp '${lspJson}' '.lsp = $lsp' '${deps.lspBlockFile}' > '${deps.lspBlockFile}.tmp' && mv '${deps.lspBlockFile}.tmp' '${deps.lspBlockFile}'`,
      15_000,
    );
    if (lspUpdate.exitCode !== 0) {
      return {
        ok: false,
        changed: installTargets.size,
        applied: 0,
        failed: 1,
        error: lspUpdate.stderr || lspUpdate.stdout || "failed to update opencode.json lsp block",
        servers: summary.servers,
      };
    }

    const enabledPackages = summary.servers
      .filter((s) => s.desiredEnabled)
      .map((s) => {
        const entry = LSP_CATALOG.find((e) => e.serverKey === s.serverKey);
        return entry ? { npmPackage: entry.npmPackage, version: s.pinnedVersion } : null;
      })
      .flatMap((v) => (v ? [v] : []));

    const newLspServers = serializeLspServers(overrides);
    const newBunPackages = deriveBunPackages(env[BUN_PACKAGES_ENV_KEY] ?? "", enabledPackages);
    const lspChanged = (env["LSP_SERVERS"] ?? "") !== newLspServers;
    const bunChanged = (env[BUN_PACKAGES_ENV_KEY] ?? "") !== newBunPackages;
    // PUT persists env before POST apply, so env diffs alone cannot detect block-only changes;
    // compare desired enabled catalog keys against observed inLspBlock keys (marksman excluded).
    const desiredLspKeys = new Set(summary.servers.filter((s) => s.desiredEnabled).map((s) => s.serverKey));
    const observedLspKeys = new Set(summary.servers.filter((s) => s.inLspBlock).map((s) => s.serverKey));
    const lspBlockChanged =
      desiredLspKeys.size !== observedLspKeys.size || [...desiredLspKeys].some((k) => !observedLspKeys.has(k));

    if (lspChanged) deps.upsertEnvVar("LSP_SERVERS", newLspServers);
    if (bunChanged) {
      if (newBunPackages.length === 0) deps.deleteEnvVar(BUN_PACKAGES_ENV_KEY);
      else deps.upsertEnvVar(BUN_PACKAGES_ENV_KEY, newBunPackages);
    }

    const varsContent = `BUN_PACKAGES=${newBunPackages}\nLSP_SERVERS=${newLspServers}\n`;
    const varsB64 = Buffer.from(varsContent, "utf8").toString("base64");
    const push = await deps.exec(
      `printf '%s' '${varsB64}' | base64 -d > '${deps.lspVarsFile}'`,
      15_000,
    );
    if (push.exitCode !== 0) {
      return {
        ok: false,
        changed: installTargets.size + 1,
        applied: 0,
        failed: 1,
        error: push.stderr || push.stdout || "failed to persist LSP vars for restart",
        servers: summary.servers,
      };
    }

    const changed = installTargets.size + (lspChanged || bunChanged || lspBlockChanged ? 1 : 0);
    const refreshed = await reconcile();
    return { ok: true, changed, applied: changed, failed: 0, servers: refreshed.servers };
  }

  return { readObserved, reconcile, apply };
}
