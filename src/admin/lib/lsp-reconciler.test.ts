import { describe, expect, test } from "bun:test";
import {
  computeDrift,
  createLspReconciler,
  deriveBunPackages,
  parseInstalledVersions,
  splitBunToken,
  type LspReconcilerDeps,
  type ObservedLspServer,
} from "./lsp-reconciler";
import type { ExecResult } from "./docker";
import type { EnvVars } from "./env";

const EMPTY_OBSERVED = new Map<string, ObservedLspServer>();

function makeDeps(overrides: {
  exec?: (cmd: string, timeoutMs?: number) => Promise<ExecResult>;
  readEnv?: () => EnvVars;
    upsertEnvVar?: (key: string, value: string) => void;
    deleteEnvVar?: (key: string) => void;
  lspBlockFile?: string;
  lspVarsFile?: string;
}): LspReconcilerDeps {
  return {
    exec: overrides.exec ?? (async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    readEnv: overrides.readEnv ?? (() => ({})),
    upsertEnvVar: overrides.upsertEnvVar ?? ((_key, _value) => {}),
    deleteEnvVar: overrides.deleteEnvVar ?? (() => {}),
    lspBlockFile: overrides.lspBlockFile ?? "/opt/dev-config/opencode.json",
    lspVarsFile: overrides.lspVarsFile ?? "/opt/dev-config/lsp-managed.env",
  };
}

describe("computeDrift", () => {
  test("empty overrides: all servers disabled, all in sync", () => {
    const summary = computeDrift({}, EMPTY_OBSERVED);
    expect(summary.servers.length).toBe(8);
    expect(summary.inSync).toBe(8);
    expect(summary.drifted).toBe(0);
    for (const server of summary.servers) {
      expect(server.desiredEnabled).toBe(false);
      expect(server.drift).toBe(null);
    }
  });

  test("enabled + installed but absent from lsp block -> not_enabled_in_lsp", () => {
    const observed = new Map<string, ObservedLspServer>([
      ["typescript", { installedVersion: "6.0.0", inLspBlock: false }],
    ]);
    const summary = computeDrift({ typescript: { enabled: true, version: null } }, observed);
    const ts = summary.servers.find((s) => s.serverKey === "typescript")!;
    expect(ts.drift).toBe("not_enabled_in_lsp");
  });

  test("enabled + in lsp block + unpinned latest -> in sync", () => {
    const observed = new Map<string, ObservedLspServer>([
      ["yaml-ls", { installedVersion: "1.24.0", inLspBlock: true }],
    ]);
    const summary = computeDrift({ yaml: { enabled: true, version: null } }, observed);
    const yaml = summary.servers.find((s) => s.serverKey === "yaml-ls")!;
    expect(yaml.drift).toBe(null);
  });

  test("enabled + nothing installed -> missing_install", () => {
    const observed = new Map<string, ObservedLspServer>([
      ["dockerfile", { installedVersion: null, inLspBlock: false }],
    ]);
    const summary = computeDrift({ dockerfile: { enabled: true, version: null } }, observed);
    const df = summary.servers.find((s) => s.serverKey === "dockerfile")!;
    expect(df.drift).toBe("missing_install");
  });

  test("enabled + pinned to different installed version -> version_mismatch", () => {
    const observed = new Map<string, ObservedLspServer>([
      ["biome", { installedVersion: "2.0.0", inLspBlock: true }],
    ]);
    const summary = computeDrift({ biome: { enabled: true, version: "2.5.11" } }, observed);
    const biome = summary.servers.find((s) => s.serverKey === "biome")!;
    expect(biome.drift).toBe("version_mismatch");
  });

  test("enabled pinned to exact installed version -> in sync", () => {
    const observed = new Map<string, ObservedLspServer>([
      ["typescript", { installedVersion: "6.0.0", inLspBlock: true }],
    ]);
    const summary = computeDrift({ typescript: { enabled: true, version: "6.0.0" } }, observed);
    const ts = summary.servers.find((s) => s.serverKey === "typescript")!;
    expect(ts.drift).toBe(null);
  });

  test("observed missing entirely counts as not installed", () => {
    const summary = computeDrift({ css: { enabled: true, version: null } }, EMPTY_OBSERVED);
    const css = summary.servers.find((s) => s.serverKey === "css")!;
    expect(css.installedVersion).toBe(null);
    expect(css.drift).toBe("missing_install");
  });

  test("disabled server never drifts even when installed and in block", () => {
    const observed = new Map<string, ObservedLspServer>([
      ["css", { installedVersion: "4.10.0", inLspBlock: true }],
    ]);
    const summary = computeDrift({}, observed);
    const css = summary.servers.find((s) => s.serverKey === "css")!;
    expect(css.desiredEnabled).toBe(false);
    expect(css.drift).toBe(null);
  });

  test("summary counts drift across mixed state", () => {
    const observed = new Map<string, ObservedLspServer>([
      ["typescript", { installedVersion: "6.0.0", inLspBlock: true }],
      ["yaml-ls", { installedVersion: "1.24.0", inLspBlock: true }],
      ["css", { installedVersion: null, inLspBlock: false }],
    ]);
    const summary = computeDrift(
      {
        typescript: { enabled: true, version: null },
        "yaml-ls": { enabled: true, version: null },
        css: { enabled: true, version: "4.10.0" },
      },
      observed,
    );
    const byKey = new Map(summary.servers.map((s) => [s.serverKey, s]));
    expect(summary.drifted).toBe(1);
    expect(byKey.get("typescript")!.drift).toBe(null);
    expect(byKey.get("yaml-ls")!.drift).toBe(null);
    expect(byKey.get("css")!.drift).toBe("missing_install");
    // Disabled servers always count as in sync.
    expect(byKey.get("biome")!.desiredEnabled).toBe(false);
    expect(byKey.get("biome")!.drift).toBe(null);
  });
});

describe("parseInstalledVersions", () => {
  test("parses Bun's tree-form global package output", () => {
    const versions = parseInstalledVersions(
      "packages:\n├── @biomejs/biome@2.5.11\n├── typescript-language-server@6.0.0\n",
    );
    expect(versions.get("@biomejs/biome")).toBe("2.5.11");
    expect(versions.get("typescript-language-server")).toBe("6.0.0");
  });

  test("parses plain and scoped packages", () => {
    const stdout = [
      "packages:",
      "  typescript-language-server@6.0.0",
      "  @vue/language-server@3.3.11",
      "  vscode-langservers-extracted@4.10.0",
      "  yaml-language-server@1.24.0",
    ].join("\n");
    const map = parseInstalledVersions(stdout);
    expect(map.get("typescript-language-server")).toBe("6.0.0");
    expect(map.get("@vue/language-server")).toBe("3.3.11");
    expect(map.get("vscode-langservers-extracted")).toBe("4.10.0");
    expect(map.get("yaml-language-server")).toBe("1.24.0");
  });

  test("ignores lines without a version or empty output", () => {
    expect(parseInstalledVersions("").size).toBe(0);
    expect(parseInstalledVersions("packages:\n  (empty)\n").size).toBe(0);
  });
});

describe("createLspReconciler", () => {
  test("readObserved maps installed package versions onto catalog rows", async () => {
    const calls: string[] = [];
    const deps = makeDeps({
      exec: async (cmd) => {
        calls.push(cmd);
        if (cmd.includes("bun pm ls -g")) {
          return { stdout: "packages:\n  typescript-language-server@6.0.0\n  vscode-langservers-extracted@4.10.0\n", stderr: "", exitCode: 0 };
        }
        if (cmd.includes("jq -r '.lsp")) {
          return { stdout: "typescript\njson\ncss\nyaml-ls\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const reconciler = createLspReconciler(deps);
    const observed = await reconciler.readObserved();
    expect(observed.get("typescript")).toEqual({ installedVersion: "6.0.0", inLspBlock: true });
    expect(observed.get("json")).toEqual({ installedVersion: "4.10.0", inLspBlock: true });
    expect(observed.get("css")).toEqual({ installedVersion: "4.10.0", inLspBlock: true });
    expect(observed.get("html")).toEqual({ installedVersion: "4.10.0", inLspBlock: false });
    expect(observed.get("biome")).toEqual({ installedVersion: null, inLspBlock: false });
    expect(calls.length).toBe(2);
  });

  test("reconcile combines live observed with env overrides", async () => {
    const deps = makeDeps({
      exec: async (cmd) => {
        if (cmd.includes("bun pm ls -g")) {
          return { stdout: "packages:\n  yaml-language-server@1.24.0\n", stderr: "", exitCode: 0 };
        }
        if (cmd.includes("jq -r '.lsp")) {
          return { stdout: "yaml-ls\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      readEnv: () => ({ LSP_SERVERS: '{"yaml-ls":{"enabled":true,"version":null}}' }),
    });
    const reconciler = createLspReconciler(deps);
    const summary = await reconciler.reconcile();
    const yaml = summary.servers.find((s) => s.serverKey === "yaml-ls")!;
    expect(yaml.desiredEnabled).toBe(true);
    expect(yaml.installedVersion).toBe("1.24.0");
    expect(yaml.inLspBlock).toBe(true);
    expect(yaml.drift).toBe(null);
  });

  test("exec failure (registry/.env not reachable) degrades to empty observed", async () => {
    const deps = makeDeps({
      exec: async () => ({ stdout: "", stderr: "boom", exitCode: 1 }),
    });
    const reconciler = createLspReconciler(deps);
    const summary = await reconciler.reconcile();
    expect(summary.drifted).toBe(0);
    for (const server of summary.servers) {
      expect(server.installedVersion).toBe(null);
      expect(server.inLspBlock).toBe(false);
    }
  });
});

describe("splitBunToken", () => {
  test("plain and pinned packages", () => {
    expect(splitBunToken("typescript-language-server")).toEqual({ name: "typescript-language-server", version: null });
    expect(splitBunToken("yaml-language-server@1.24.0")).toEqual({ name: "yaml-language-server", version: "1.24.0" });
  });
  test("scoped packages", () => {
    expect(splitBunToken("@vue/language-server")).toEqual({ name: "@vue/language-server", version: null });
    expect(splitBunToken("@vue/language-server@3.3.11")).toEqual({ name: "@vue/language-server", version: "3.3.11" });
  });
});

describe("deriveBunPackages", () => {
  test("appends managed packages sorted by name", () => {
    const result = deriveBunPackages("", [
      { npmPackage: "yaml-language-server", version: null },
      { npmPackage: "typescript-language-server", version: "6.0.0" },
    ]);
    expect(result).toBe("typescript-language-server@6.0.0 yaml-language-server");
  });

  test("preserves unrelated user packages", () => {
    const result = deriveBunPackages("ripgrep eslint", [
      { npmPackage: "yaml-language-server", version: null },
    ]);
    expect(result).toBe("ripgrep eslint yaml-language-server");
  });

  test("drops managed tokens and replaces with current pin", () => {
    const result = deriveBunPackages("typescript-language-server@5.0.0 ripgrep", [
      { npmPackage: "typescript-language-server", version: "6.0.0" },
    ]);
    expect(result).toBe("ripgrep typescript-language-server@6.0.0");
  });

  test("dedupes by package name", () => {
    const result = deriveBunPackages("", [
      { npmPackage: "vscode-langservers-extracted", version: "4.10.0" },
      { npmPackage: "vscode-langservers-extracted", version: "4.10.0" },
    ]);
    expect(result).toBe("vscode-langservers-extracted@4.10.0");
  });
});

describe("createLspReconciler.apply", () => {
  const execFor = (installed: string, blockKeys: string[]) =>
    async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes("bun pm ls -g")) {
        return installed
          ? { stdout: `packages:\n${installed.split("\n").map((l) => `  ${l}`).join("\n")}\n`, stderr: "", exitCode: 0 }
          : { stdout: "", stderr: "", exitCode: 0 };
      }
      if (cmd.includes("jq -r '.lsp")) {
        return { stdout: blockKeys.join("\n"), stderr: "", exitCode: 0 };
      }
      if (cmd.startsWith("bun install -g")) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };

  test("install then persist on success", async () => {
    const upserts: Array<[string, string]> = [];
    const bunCalls: string[] = [];
    const updates: string[] = [];
    const deps = makeDeps({
      exec: async (cmd) => {
        if (cmd.includes("bun pm ls -g")) return { stdout: "", stderr: "", exitCode: 0 };
        if (cmd.includes("jq -r '.lsp")) return { stdout: "", stderr: "", exitCode: 0 };
        if (cmd.startsWith("bun install -g")) {
          bunCalls.push(cmd);
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (cmd.includes(".lsp = $lsp")) {
          updates.push(cmd);
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      readEnv: () => ({ LSP_SERVERS: '{"typescript":{"enabled":true,"version":"6.0.0"}}' }),
      upsertEnvVar: (k, v) => upserts.push([k, v]),
    });
    const reconciler = createLspReconciler(deps);
    const result = await reconciler.apply();
    expect(result.ok).toBe(true);
    expect(bunCalls).toEqual(["bun install -g typescript-language-server@6.0.0 yaml-language-server pyright"]);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain(".lsp = $lsp");
    const upserted = new Map(upserts);
    expect(upserted.get("BUN_PACKAGES")).toBe("pyright typescript-language-server@6.0.0 yaml-language-server");
    // Built-in-backed yaml-ls/pyright join typescript: LSP_SERVERS needs persisting.
    expect(upserted.get("LSP_SERVERS")).toBe(
      '{"pyright":{"enabled":true,"version":null},"typescript":{"enabled":true,"version":"6.0.0"},"yaml-ls":{"enabled":true,"version":null}}',
    );
  });

  test("apply pushes vars file for restart convergence", async () => {
    const pushes: string[] = [];
    const deps = makeDeps({
      exec: async (cmd) => {
        if (cmd.includes("bun pm ls -g")) return { stdout: "", stderr: "", exitCode: 0 };
        if (cmd.includes("jq -r '.lsp")) return { stdout: "", stderr: "", exitCode: 0 };
        if (cmd.includes("lsp-managed.env")) {
          pushes.push(cmd);
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      readEnv: () => ({ LSP_SERVERS: '{"typescript":{"enabled":true,"version":"6.0.0"}}' }),
      upsertEnvVar: () => {},
    });
    const reconciler = createLspReconciler(deps);
    const result = await reconciler.apply();
    expect(result.ok).toBe(true);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain("/opt/dev-config/lsp-managed.env");
    const b64 = pushes[0].match(/printf '%s' '([A-Za-z0-9+/=]+)'/)![1];
    const content = Buffer.from(b64, "base64").toString("utf8");
    expect(content).toContain("BUN_PACKAGES=pyright typescript-language-server@6.0.0 yaml-language-server");
    expect(content).toContain('"typescript":{"enabled":true,"version":"6.0.0"}');
    expect(content).toContain('"yaml-ls":{"enabled":true,"version":null}');
    expect(content).toContain('"pyright":{"enabled":true,"version":null}');
  });

  test("vars push failure fails apply without hiding the cause", async () => {
    const deps = makeDeps({
      exec: async (cmd) => {
        if (cmd.includes("bun pm ls -g")) return { stdout: "", stderr: "", exitCode: 0 };
        if (cmd.includes("jq -r '.lsp")) return { stdout: "", stderr: "", exitCode: 0 };
        if (cmd.includes("lsp-managed.env")) return { stdout: "", stderr: "disk full", exitCode: 1 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      readEnv: () => ({ LSP_SERVERS: '{"yaml-ls":{"enabled":true,"version":null}}' }),
      upsertEnvVar: () => {},
    });
    const reconciler = createLspReconciler(deps);
    const result = await reconciler.apply();
    expect(result.ok).toBe(false);
    if (!("error" in result)) throw new Error("expected vars push failure");
    expect(result.error).toContain("disk full");
  });

  test("failed install leaves persisted state unchanged", async () => {
    const upserts: Array<[string, string]> = [];
    const deps = makeDeps({
      exec: async (cmd) => {
        if (cmd.includes("bun pm ls -g")) return { stdout: "", stderr: "", exitCode: 0 };
        if (cmd.includes("jq -r '.lsp")) return { stdout: "", stderr: "", exitCode: 0 };
        if (cmd.startsWith("bun install -g")) return { stdout: "", stderr: "ETARGET", exitCode: 1 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      readEnv: () => ({ LSP_SERVERS: '{"yaml-ls":{"enabled":true,"version":null}}' }),
      upsertEnvVar: (k, v) => upserts.push([k, v]),
    });
    const reconciler = createLspReconciler(deps);
    const result = await reconciler.apply();
    expect(result.ok).toBe(false);
    if (!("error" in result)) throw new Error("expected install failure");
    expect(result.failed).toBe(3);
    expect(result.error).toContain("ETARGET");
    expect(upserts.length).toBe(0);
  });

  test("no-op apply reports zero changes and writes nothing", async () => {
    const upserts: Array<[string, string]> = [];
    const deps = makeDeps({
      exec: execFor("typescript-language-server@6.0.0\nyaml-language-server@1.24.0\npyright@1.1.413", [
        "typescript",
        "yaml-ls",
        "pyright",
      ]),
      readEnv: () => ({
        LSP_SERVERS:
          '{"pyright":{"enabled":true,"version":null},"typescript":{"enabled":true,"version":"6.0.0"},"yaml-ls":{"enabled":true,"version":null}}',
        BUN_PACKAGES: "pyright typescript-language-server@6.0.0 yaml-language-server",
      }),
      upsertEnvVar: (k, v) => upserts.push([k, v]),
    });
    const reconciler = createLspReconciler(deps);
    const result = await reconciler.apply();
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(0);
    expect(upserts.length).toBe(0);
  });

  test("regression: enabling installed server with env/package in sync but lsp block missing must count as changed", async () => {
    const lspPayloads: string[] = [];
    const bunInstalls: string[] = [];
    const expectedLspServers =
      '{"biome":{"enabled":true,"version":null},"pyright":{"enabled":true,"version":null},"typescript":{"enabled":true,"version":null},"yaml-ls":{"enabled":true,"version":null}}';
    const expectedBunPackages = "@biomejs/biome pyright typescript-language-server yaml-language-server";
    const deps = makeDeps({
      exec: async (cmd) => {
        if (cmd.includes("bun pm ls -g")) {
          return {
            stdout:
              "packages:\n  @biomejs/biome@2.5.11\n  pyright@1.1.413\n  typescript-language-server@6.0.0\n  yaml-language-server@1.24.0\n",
            stderr: "",
            exitCode: 0,
          };
        }
        if (cmd.includes("jq -r '.lsp")) {
          return { stdout: "pyright\ntypescript\nyaml-ls\n", stderr: "", exitCode: 0 };
        }
        if (cmd.startsWith("bun install -g")) {
          bunInstalls.push(cmd);
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (cmd.includes(".lsp = $lsp")) {
          lspPayloads.push(cmd);
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (cmd.includes("lsp-managed.env")) return { stdout: "", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      readEnv: () => ({
        LSP_SERVERS: expectedLspServers,
        BUN_PACKAGES: expectedBunPackages,
      }),
    });
    const reconciler = createLspReconciler(deps);
    const result = await reconciler.apply();
    expect(bunInstalls.length).toBe(0);
    expect(lspPayloads).toHaveLength(1);
    const raw = lspPayloads[0].match(/--argjson lsp '(.+)' '\.lsp/)?.[1];
    expect(raw).toBeDefined();
    const lspBlock = JSON.parse(raw!);
    expect(lspBlock["biome"]).toBeDefined();
    expect(lspBlock["biome"].command).toEqual(["biome", "lsp-proxy"]);
    // Block-only transition must be counted as a change
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.changed).toBe(1);
      expect(result.applied).toBe(1);
    }
  });

  test("regression: disabling server with env/package in sync but lsp block still contains it must count as changed", async () => {
    const lspPayloads: string[] = [];
    const bunInstalls: string[] = [];
    const expectedLspServers =
      '{"pyright":{"enabled":true,"version":null},"typescript":{"enabled":true,"version":null},"yaml-ls":{"enabled":true,"version":null}}';
    const expectedBunPackages = "pyright typescript-language-server yaml-language-server";
    const deps = makeDeps({
      exec: async (cmd) => {
        if (cmd.includes("bun pm ls -g")) {
          return {
            stdout:
              "packages:\n  @biomejs/biome@2.5.11\n  pyright@1.1.413\n  typescript-language-server@6.0.0\n  yaml-language-server@1.24.0\n",
            stderr: "",
            exitCode: 0,
          };
        }
        if (cmd.includes("jq -r '.lsp")) {
          return { stdout: "biome\npyright\ntypescript\nyaml-ls\n", stderr: "", exitCode: 0 };
        }
        if (cmd.startsWith("bun install -g")) {
          bunInstalls.push(cmd);
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (cmd.includes(".lsp = $lsp")) {
          lspPayloads.push(cmd);
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (cmd.includes("lsp-managed.env")) return { stdout: "", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      readEnv: () => ({
        LSP_SERVERS: expectedLspServers,
        BUN_PACKAGES: expectedBunPackages,
      }),
    });
    const reconciler = createLspReconciler(deps);
    const result = await reconciler.apply();
    expect(bunInstalls.length).toBe(0);
    expect(lspPayloads).toHaveLength(1);
    const raw = lspPayloads[0].match(/--argjson lsp '(.+)' '\.lsp/)?.[1];
    expect(raw).toBeDefined();
    const lspBlock = JSON.parse(raw!);
    expect(lspBlock["biome"]).toBeUndefined();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.changed).toBe(1);
      expect(result.applied).toBe(1);
    }
  });
});
