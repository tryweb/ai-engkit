import { describe, expect, test } from "bun:test";
import { createAgentModelsLib, type AgentModelsDeps } from "./agent-models";
import type { ExecResult as DockerExecResult } from "./docker";

type ExecResponse = { match?: RegExp; stdout: string; stderr?: string; exitCode?: number };
const SNAPSHOT_FILE = "/tmp/omo.jsonc.snapshot-test";
type StubOptions = {
  readonly password?: string | null;
  readonly restart?: AgentModelsDeps["restart"];
};

function stubDeps(responses: ExecResponse[] = [], options: StubOptions = {}) {
  const calls: string[] = [];
  let restartCount = 0;
  const deps: AgentModelsDeps = {
    exec: async (command: string, _timeoutMs?: number): Promise<DockerExecResult> => {
      calls.push(command);
      if (command.includes(".native-agent-overrides.tmp")) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      const index = responses.findIndex((response) => response.match === undefined || response.match.test(command));
      const next = index >= 0 ? responses.splice(index, 1)[0] ?? { stdout: "", exitCode: 0 } : { stdout: "", exitCode: 0 };
      return { stdout: next.stdout, stderr: next.stderr ?? "", exitCode: next.exitCode ?? 0 };
    },
    restart: options.restart ?? (async () => { restartCount += 1; return { ok: true }; }),
    readEnv: (): Record<string, string> => options.password === null ? {} : { OPENCODE_SERVER_PASSWORD: options.password ?? "testpass" },
  };
  return {
    deps,
    calls,
    get restartCount() {
      return restartCount;
    },
    cleanup: () => {},
  };
}

describe("readAgentModelsConfig", () => {
  test("parses model primary plus fallback_models chain from stdout", async () => {
    const { deps } = stubDeps([
      {
        stdout:
          '{"plan":{"model":"opencode-go/kimi-k3","variant":"max","fallback_models":[{"model":"opencode-go/qwen3.7-plus"}]}}',
      },
    ]);
    const lib = createAgentModelsLib(deps);
    const config = await lib.readAgentModelsConfig();
    expect(config.plan?.models).toEqual([
      { model: "opencode-go/kimi-k3", variant: "max" },
      { model: "opencode-go/qwen3.7-plus" },
    ]);
    expect(config.plan?.invalid).toBe(false);
  });

  test("flags entries with unrecognized keys (e.g. legacy permission) as invalid", async () => {
    const { deps } = stubDeps([
      { stdout: '{"explore":{"permission":{"bash":"allow"},"model":"opencode-go/kimi-k3"}}' },
    ]);
    const lib = createAgentModelsLib(deps);
    const config = await lib.readAgentModelsConfig();
    expect(config.explore?.invalid).toBe(true);
    expect(config.explore?.models?.[0]).toEqual({ model: "opencode-go/kimi-k3" });
  });

  test("returns empty map when jq fails", async () => {
    const { deps } = stubDeps([{ stdout: "", exitCode: 1 }]);
    const lib = createAgentModelsLib(deps);
    expect(await lib.readAgentModelsConfig()).toEqual({});
  });
});

describe("snapshot / restore round-trip", () => {
  test("snapshot and restore execute entirely inside ai-dev", async () => {
    const { deps, calls } = stubDeps([{ stdout: `${SNAPSHOT_FILE}\n` }]);
    const lib = createAgentModelsLib(deps);
    const snapshot = await lib.snapshotAgentModelsConfig();
    expect(snapshot).toBe(SNAPSHOT_FILE);
    expect(calls[0]).toContain("mktemp");
    expect(calls[0]).toContain("~/.config/opencode/oh-my-opencode-slim.json");

    const restore = await lib.restoreAgentModelsConfig(SNAPSHOT_FILE);
    expect(restore.ok).toBe(true);
    const restoreCmd = calls[1];
    expect(restoreCmd).toBeDefined();
    if (restoreCmd === undefined) return;
    expect(restoreCmd).toContain(`cat '${SNAPSHOT_FILE}'`);
    expect(restoreCmd).not.toContain("base64");
    expect(restoreCmd).toContain("~/.config/opencode/oh-my-opencode-slim.json");
  });
});

describe("getServerPassword", () => {
  test("returns the env value when present", () => {
    const { deps } = stubDeps();
    expect(createAgentModelsLib(deps).getServerPassword()).toBe("testpass");
  });

  test("returns null when absent", async () => {
    const { deps } = stubDeps([], { password: null });
    expect(createAgentModelsLib(deps).getServerPassword()).toBeNull();
  });
});

describe("fetchResolvedAgentModels", () => {
  test("builds Basic auth header and parses name → model", async () => {
    const agentsJson = JSON.stringify([
      { name: "Sisyphus - ultraworker", model: { modelID: "kimi-k3", providerID: "opencode-go" } },
      { name: "explore", model: { modelID: "gpt-5.6-luna-fast", providerID: "openai" } },
      { name: "build", model: null },
    ]);
    const { deps, calls } = stubDeps([{ stdout: agentsJson }]);
    const lib = createAgentModelsLib(deps);
    const map = await lib.fetchResolvedAgentModels("testpass");
    expect(map?.get("Sisyphus - ultraworker")).toEqual({ modelID: "kimi-k3", providerID: "opencode-go" });
    expect(map?.get("explore")?.modelID).toBe("gpt-5.6-luna-fast");
    expect(map?.has("build")).toBe(false);
    const script = calls[0];
    expect(script).toBeDefined();
    if (script === undefined) return;
    const expectedAuth = Buffer.from("opencode:testpass").toString("base64");
    expect(script).toContain(`Authorization: Basic ${expectedAuth}`);
    expect(script).toContain("/agent");
    expect(script).toContain("for attempt in");
    expect(script.indexOf("for attempt in")).toBeLessThan(script.indexOf("for f in ~/.config/openchamber/managed-opencode"));
    expect(script).not.toContain(`[ -n "$PORT" ] || exit 3`);
  });

  test("returns null on curl failure", async () => {
    const { deps } = stubDeps([{ stdout: "", exitCode: 2 }]);
    const lib = createAgentModelsLib(deps);
    expect(await lib.fetchResolvedAgentModels("testpass")).toBeNull();
  });
});

describe("fetchConnectedCatalog", () => {
  test("returns unique provider/model ids across connected providers", async () => {
    const { deps, calls } = stubDeps([
      {
        stdout: JSON.stringify({
          connected: ["opencode"],
          all: [{ id: "opencode", models: { "big-pickle": {}, "hy3-free": {} } }],
        }),
      },
    ]);
    const lib = createAgentModelsLib(deps);
    expect(await lib.fetchConnectedCatalog("testpass")).toEqual([
      "opencode/big-pickle",
      "opencode/hy3-free",
    ]);
    expect(calls).toHaveLength(1);
  });

  test("uses opencode models cache when live provider is unavailable", async () => {
    const { deps } = stubDeps([
      { match: /\/provider\b/, stdout: "", exitCode: 1 },
      { match: /connected-providers\.json/, stdout: JSON.stringify({ connected: ["opencode"] }) },
      {
        match: /models\.json/, stdout: JSON.stringify({
          opencode: { models: { "big-pickle": {} } },
          openai: { models: { "gpt-5.6-luna": {} } },
        }),
      },
    ]);
    const lib = createAgentModelsLib(deps);
    expect(await lib.fetchConnectedCatalog("testpass")).toEqual(["opencode/big-pickle"]);
  });

  test("returns no cached models when no provider is connected", async () => {
    const { deps } = stubDeps([
      { match: /\/provider\b/, stdout: "", exitCode: 1 },
      { match: /connected-providers\.json/, stdout: JSON.stringify({ connected: [] }) },
      { match: /models\.json/, stdout: JSON.stringify({ opencode: { models: { "big-pickle": {} } } }) },
    ]);
    const lib = createAgentModelsLib(deps);
    expect(await lib.fetchConnectedCatalog("testpass")).toEqual([]);
  });

  test("filters provider snapshot cache by connected providers", async () => {
    const { deps } = stubDeps([
      { match: /\/provider\b/, stdout: "", exitCode: 1 },
      { match: /connected-providers\.json/, stdout: JSON.stringify({ connected: ["opencode"] }) },
      {
        match: /models\.json/, stdout: JSON.stringify({
          opencode: { models: { "big-pickle": {} } },
          openai: { models: { "gpt-5.6-luna": {} } },
        }),
      },
    ]);
    const lib = createAgentModelsLib(deps);
    expect(await lib.fetchProviderSnapshot("testpass")).toEqual({
      connectedProviders: ["opencode"],
      catalog: ["opencode/big-pickle"],
      source: "cache",
    });
  });

  test("returns an empty catalog without falling back to resolved agents", async () => {
    const { deps } = stubDeps([
      { match: /\/provider\b/, stdout: "", exitCode: 1 },
      { match: /connected-providers\.json/, stdout: "", exitCode: 1 },
      { match: /models\.json/, stdout: "", exitCode: 1 },
    ]);
    const lib = createAgentModelsLib(deps);
    expect(await lib.fetchConnectedCatalog("testpass")).toEqual([]);
  });
});

describe("applyAndVerify", () => {
  test("writes a batch and restarts managed OpenCode once", async () => {
    const agentsJson = JSON.stringify([
      { name: "explore", model: { modelID: "mimo-v2.5-free", providerID: "opencode" } },
      { name: "librarian", model: { modelID: "mimo-v2.5-free", providerID: "opencode" } },
    ]);
    const ctx = stubDeps([
      { stdout: SNAPSHOT_FILE },
      { stdout: "" },
      { stdout: agentsJson },
      { stdout: agentsJson },
    ]);
    const result = await createAgentModelsLib(ctx.deps).applyAndVerifyBatch([
      { agent: "explore", entries: [] },
      { agent: "librarian", entries: [] },
    ]);
    expect(ctx.restartCount).toBe(1);
    expect(ctx.calls.filter((command) => command.includes(".agents[$agent]")).length).toBe(1);
    expect(result.get("explore")).toMatchObject({ ok: true, status: "cleared" });
    expect(result.get("librarian")).toMatchObject({ ok: true, status: "cleared" });
  });

  test("does not log successful request response bodies", async () => {
    const { deps } = stubDeps([
      {
        stdout: JSON.stringify({ info: { role: "assistant", modelID: "kimi-k3", providerID: "opencode-go" } }),
      },
    ]);
    const originalError = console.error;
    const calls: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      calls.push(args);
    };
    try {
      const result = await createAgentModelsLib(deps).fetchSuccessfulRequestModel("testpass", "librarian");
      expect(result).toEqual({ modelID: "kimi-k3", providerID: "opencode-go" });
      expect(calls).toEqual([]);
    } finally {
      console.error = originalError;
    }
  });

  test("refuses to apply when the config snapshot cannot be created", async () => {
    const ctx = stubDeps([{ stdout: "", exitCode: 1 }]);
    const result = await createAgentModelsLib(ctx.deps).applyAndVerify("librarian", []);
    expect(result).toMatchObject({ ok: false, status: "write_failed" });
    expect(ctx.restartCount).toBe(0);
    ctx.cleanup();
  });

  test("reports remote snapshot failure as write_failed", async () => {
    const ctx = stubDeps([{ stdout: "", exitCode: 1, stderr: "snapshot failed" }]);
    const result = await createAgentModelsLib(ctx.deps).applyAndVerify("librarian", []);
    expect(result).toMatchObject({ ok: false, status: "write_failed" });
    expect(ctx.restartCount).toBe(0);
    ctx.cleanup();
  });

  test("clears the configured model and verifies automatic resolution", async () => {
    const agentsJson = JSON.stringify([
      { name: "librarian", model: { modelID: "qwen3.7-plus", providerID: "opencode-go" } },
    ]);
    const ctx = stubDeps([
      { stdout: '{"agents":{"librarian":{"model":"opencode/nemotron-3.5-lightning-free"}}}' },
      { stdout: "" },
      { stdout: agentsJson },
    ]);
    const result = await createAgentModelsLib(ctx.deps).applyAndVerify("librarian", []);
    expect(result).toEqual({
      ok: true,
      status: "cleared",
      resolved: { modelID: "qwen3.7-plus", providerID: "opencode-go" },
      requestVerified: null,
    });
    expect(ctx.calls[1]).toContain("del(.agents[$agent].model");
    expect(ctx.calls.some((command) => command.includes("model availability probe"))).toBe(false);
    ctx.cleanup();
  });

  test("resolves decorated live names while clearing a config key", async () => {
    const ctx = stubDeps([
      { stdout: '{"agents":{"librarian":{"model":"opencode/nemotron-3.5-lightning-free"}}}' },
      { stdout: "" },
      { stdout: JSON.stringify([
        { name: "Librarian - research assistant", model: { modelID: "qwen3.7-plus", providerID: "opencode-go" } },
      ]) },
    ]);
    const result = await createAgentModelsLib(ctx.deps).applyAndVerify("librarian", []);
    expect(result).toMatchObject({ ok: true, status: "cleared", resolved: { modelID: "qwen3.7-plus", providerID: "opencode-go" } });
    ctx.cleanup();
  });

  test("reports rollback_failed when restart failure cannot restore the snapshot", async () => {
    const ctx = stubDeps([
      { stdout: SNAPSHOT_FILE },
      { stdout: "" },
      { stdout: "", exitCode: 1, stderr: "restore failed" },
    ], { restart: async () => ({ ok: false, error: "restart failed" }) });
    const result = await createAgentModelsLib(ctx.deps).applyAndVerify("librarian", []);
    expect(result).toEqual({ ok: false, status: "rollback_failed", error: "restart failed; restore failed" });
    ctx.cleanup();
  });

  test("success: verified when write, restart and /agent reachability succeed", async () => {
    const agentsJson = JSON.stringify([
      { name: "explore", model: { modelID: "gpt-5.6-luna-fast", providerID: "openai" } },
    ]);
    const { deps, calls, cleanup } = stubDeps([
      { stdout: SNAPSHOT_FILE },
      { stdout: "" }, // write: jq ok
      { stdout: agentsJson }, // fetch
      {
        match: /\/provider\b/,
        stdout: JSON.stringify({ connected: ["openai"], all: [{ id: "openai", models: { "gpt-5.6-luna-fast": {} } }] }),
      },
      {
        match: /\/session/,
        stdout: JSON.stringify({ info: { role: "assistant", modelID: "gpt-5.6-luna-fast", providerID: "openai" } }),
      },
      {
        match: /title:\"model availability probe\"/,
        stdout: JSON.stringify({ info: { role: "assistant", modelID: "gpt-5.6-luna-fast", providerID: "openai" } }),
      },
    ]);
    const lib = createAgentModelsLib(deps);
    const result = await lib.applyAndVerify("explore", [{ model: "openai/gpt-5.6-luna-fast" }], "inference");
    expect(result).toMatchObject({
      ok: true,
      status: "verified",
      resolved: { modelID: "gpt-5.6-luna-fast", providerID: "openai" },
    });
    expect(calls.some((command) => command.includes("docker") || command.includes("compose"))).toBe(false);
    cleanup();
  });

  test("probe unavailable restores the snapshot and performs a recovery restart", async () => {
    const ctx = stubDeps([
      { stdout: SNAPSHOT_FILE },
      { stdout: "" },
      { stdout: JSON.stringify([{ name: "explore", model: { modelID: "gpt-5.6-luna-fast", providerID: "openai" } }]) },
      { match: /\/provider\b/, stdout: JSON.stringify({ connected: ["openai"], all: [] }) },
      { match: /\/session\b/, stdout: JSON.stringify({ info: { role: "assistant", modelID: "gpt-5.6-luna-fast", providerID: "openai" } }) },
      { match: /title:\"model availability probe\"/, stdout: JSON.stringify({ info: { role: "assistant", error: "404 unavailable" } }) },
    ]);
    const result = await createAgentModelsLib(ctx.deps).applyAndVerify("explore", [{ model: "openai/gpt-5.6-luna-fast" }], "inference");
    expect(result).toMatchObject({ ok: false, status: "probe_failed" });
    expect(ctx.restartCount).toBe(2);
    expect(ctx.calls.some((command) => command.includes(`cat '${SNAPSHOT_FILE}'`))).toBe(true);
    ctx.cleanup();
  });

  test("probe retryable keeps the applied config and reports unverified", async () => {
    const ctx = stubDeps([
      { stdout: SNAPSHOT_FILE },
      { stdout: "" },
      { stdout: JSON.stringify([{ name: "explore", model: { modelID: "gpt-5.6-luna-fast", providerID: "openai" } }]) },
      { match: /\/provider\b/, stdout: JSON.stringify({ connected: ["openai"], all: [] }) },
      { match: /\/session\b/, stdout: JSON.stringify({ info: { role: "assistant", modelID: "gpt-5.6-luna-fast", providerID: "openai" } }) },
      { match: /title:\"model availability probe\"/, stdout: JSON.stringify({ info: { role: "assistant", error: "temporary" } }) },
    ]);
    const result = await createAgentModelsLib(ctx.deps).applyAndVerify("explore", [{ model: "openai/gpt-5.6-luna-fast" }], "inference");
    expect(result).toMatchObject({ ok: false, status: "unverified" });
    expect(ctx.restartCount).toBe(1);
    expect(ctx.calls.some((command) => command.includes(`cat '${SNAPSHOT_FILE}'`))).toBe(false);
    ctx.cleanup();
  });

  test("probe retired restores the snapshot and reports probe_failed", async () => {
    const ctx = stubDeps([
      { stdout: SNAPSHOT_FILE },
      { stdout: "" },
      { stdout: JSON.stringify([{ name: "explore", model: { modelID: "gpt-5.6-luna-fast", providerID: "openai" } }]) },
      { match: /\/provider\b/, stdout: JSON.stringify({ connected: ["openai"], all: [] }) },
      { match: /\/session\b/, stdout: JSON.stringify({ info: { role: "assistant", modelID: "gpt-5.6-luna-fast", providerID: "openai" } }) },
      { match: /title:\"model availability probe\"/, stdout: JSON.stringify({ info: { role: "assistant", error: "410 retired" } }) },
    ]);
    const result = await createAgentModelsLib(ctx.deps).applyAndVerify("explore", [{ model: "openai/gpt-5.6-luna-fast" }], "inference");
    expect(result).toMatchObject({ ok: false, status: "probe_failed" });
    expect(ctx.restartCount).toBe(2);
    expect(ctx.calls.some((command) => command.includes(`cat '${SNAPSHOT_FILE}'`))).toBe(true);
    ctx.cleanup();
  });

  test("probe mismatch keeps the applied config and reports runtime_mismatch", async () => {
    const ctx = stubDeps([
      { stdout: SNAPSHOT_FILE },
      { stdout: "" },
      { stdout: JSON.stringify([{ name: "explore", model: { modelID: "gpt-5.6-luna-fast", providerID: "openai" } }]) },
      { match: /\/provider\b/, stdout: JSON.stringify({ connected: ["openai"], all: [] }) },
      { match: /\/session\b/, stdout: JSON.stringify({ info: { role: "assistant", modelID: "gpt-5.6-luna-fast", providerID: "openai" } }) },
      { match: /title:\"model availability probe\"/, stdout: JSON.stringify({ info: { role: "assistant", modelID: "other", providerID: "openai" } }) },
    ]);
    const result = await createAgentModelsLib(ctx.deps).applyAndVerify("explore", [{ model: "openai/gpt-5.6-luna-fast" }], "inference");
    expect(result).toMatchObject({ ok: false, status: "runtime_mismatch" });
    expect(ctx.restartCount).toBe(1);
    expect(ctx.calls.some((command) => command.includes(`cat '${SNAPSHOT_FILE}'`))).toBe(false);
    ctx.cleanup();
  });

  test("probe rollback reports rollback_failed when recovery restart fails", async () => {
    let restartCount = 0;
    const ctx = stubDeps([
      { stdout: SNAPSHOT_FILE },
      { stdout: "" },
      { stdout: JSON.stringify([{ name: "explore", model: { modelID: "gpt-5.6-luna-fast", providerID: "openai" } }]) },
      { match: /\/provider\b/, stdout: JSON.stringify({ connected: ["openai"], all: [] }) },
      { match: /\/session\b/, stdout: JSON.stringify({ info: { role: "assistant", modelID: "gpt-5.6-luna-fast", providerID: "openai" } }) },
      { match: /title:\"model availability probe\"/, stdout: JSON.stringify({ info: { role: "assistant", error: "410 retired" } }) },
    ], { restart: async () => {
      restartCount += 1;
      return restartCount === 1 ? { ok: true } : { ok: false, error: "recovery failed" };
    } });
    const result = await createAgentModelsLib(ctx.deps).applyAndVerify("explore", [{ model: "openai/gpt-5.6-luna-fast" }], "inference");
    expect(result).toMatchObject({ ok: false, status: "rollback_failed" });
    expect(ctx.calls.some((command) => command.includes(`cat '${SNAPSHOT_FILE}'`))).toBe(true);
    ctx.cleanup();
  });

  test("probe rollback reports rollback_failed when snapshot restore fails", async () => {
    const ctx = stubDeps([
      { stdout: SNAPSHOT_FILE },
      { stdout: "" },
      { stdout: JSON.stringify([{ name: "explore", model: { modelID: "gpt-5.6-luna-fast", providerID: "openai" } }]) },
      { match: /\/provider\b/, stdout: JSON.stringify({ connected: ["openai"], all: [] }) },
      { match: /\/session\b/, stdout: JSON.stringify({ info: { role: "assistant", modelID: "gpt-5.6-luna-fast", providerID: "openai" } }) },
      { match: /title:\"model availability probe\"/, stdout: JSON.stringify({ info: { role: "assistant", error: "404 unavailable" } }) },
      { match: /cat.*omo\.jsonc/, stdout: "", stderr: "restore failed", exitCode: 1 },
    ]);
    const result = await createAgentModelsLib(ctx.deps).applyAndVerify("explore", [{ model: "openai/gpt-5.6-luna-fast" }], "inference");
    expect(result).toMatchObject({ ok: false, status: "rollback_failed" });
    expect(ctx.restartCount).toBe(1);
    ctx.cleanup();
  });

  test("write failure reports write_failed without restarting", async () => {
    const { deps, restartCount, cleanup } = stubDeps([
      { stdout: SNAPSHOT_FILE },
      { stdout: "", exitCode: 1, stderr: "jq: parse error" }, // write fails
    ]);
    const lib = createAgentModelsLib(deps);
    const result = await lib.applyAndVerify("explore", [{ model: "claude-opus-5" }], "inference");
    expect(result).toMatchObject({ ok: false, status: "write_failed", error: "jq: parse error" });
    expect(restartCount).toBe(0);
    cleanup();
  });

  test("restart failure rolls back the snapshot without a second restart", async () => {
    const { deps, calls, restartCount, cleanup } = stubDeps(
      [
        { stdout: SNAPSHOT_FILE },
        { stdout: "" }, // write
      ],
      { restart: async () => ({ ok: false, error: "compose failed" }) },
    );
    const lib = createAgentModelsLib(deps);
    const result = await lib.applyAndVerify("explore", [{ model: "claude-opus-5" }], "inference");
    expect(result).toMatchObject({ ok: false, status: "restart_failed", error: "compose failed" });
    expect(restartCount).toBe(0);
    // snapshot restored back into the container
    expect(calls.some((c) => c.includes(`cat '${SNAPSHOT_FILE}'`))).toBe(true);
    cleanup();
  });

  test("fetch failure does not roll back: reports unverified", async () => {
    const ctx = stubDeps([
      { stdout: SNAPSHOT_FILE },
      { stdout: "" }, // write
      { stdout: "", exitCode: 2 }, // fetch fails
    ]);
    const lib = createAgentModelsLib(ctx.deps);
    const result = await lib.applyAndVerify("explore", [{ model: "claude-opus-5" }], "inference");
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ status: "unverified" });
    expect(ctx.restartCount).toBe(1); // no rollback restart
    expect(ctx.calls.some((c) => c.includes(`cat '${SNAPSHOT_FILE}'`))).toBe(false);
    ctx.cleanup();
  });

  test("reports runtime_mismatch without restoring the applied model", async () => {
    const agentsJson = JSON.stringify([
      { name: "librarian", model: { modelID: "qwen3.7-plus", providerID: "opencode-go" } },
    ]);
    const ctx = stubDeps([
      { stdout: SNAPSHOT_FILE },
      { stdout: "" },
      { stdout: agentsJson },
      {
        match: /\/provider\b/,
        stdout: JSON.stringify({ connected: ["opencode-go"], all: [{ id: "opencode-go", models: { "qwen3.7-plus": {} } }] }),
      },
      {
        match: /\/session/,
        stdout: JSON.stringify({ info: { role: "assistant", modelID: "qwen3.7-plus", providerID: "opencode-go" } }),
      },
    ]);
    const lib = createAgentModelsLib(ctx.deps);
    const result = await lib.applyAndVerify("librarian", [
      { model: "opencode/nemotron-3.5-lightning-free" },
    ], "inference");
    expect(result).toMatchObject({
      ok: false,
      status: "runtime_mismatch",
      configured: "opencode/nemotron-3.5-lightning-free",
      resolved: { modelID: "qwen3.7-plus", providerID: "opencode-go" },
      requestVerified: { modelID: "qwen3.7-plus", providerID: "opencode-go" },
      error: "Configured model opencode/nemotron-3.5-lightning-free did not match assigned opencode-go/qwen3.7-plus and request-verified opencode-go/qwen3.7-plus",
    });
    expect(ctx.calls.some((command) => command.includes(`cat '${SNAPSHOT_FILE}'`))).toBe(false);
    ctx.cleanup();
  });

  test("retries request verification with the runtime display name", async () => {
    const runtimeAgents = JSON.stringify([
      { name: "Metis - Plan Consultant", model: { modelID: "big-pickle", providerID: "opencode" } },
    ]);
    const requestResult = JSON.stringify({ info: { role: "assistant", modelID: "big-pickle", providerID: "opencode" } });
    const ctx = stubDeps([
      { stdout: "" },
      { stdout: runtimeAgents },
      { stdout: requestResult },
    ]);

    const result = await createAgentModelsLib(ctx.deps).fetchSuccessfulRequestModel("testpass", "metis");

    expect(result).toEqual({ modelID: "big-pickle", providerID: "opencode" });
    expect(ctx.calls).toHaveLength(3);
    expect(ctx.calls[0]).toContain(Buffer.from("metis").toString("base64"));
    expect(ctx.calls[2]).toContain(Buffer.from("Metis - Plan Consultant").toString("base64"));
  });

  test("syncs native overrides before restarting managed OpenCode", async () => {
    const calls: string[] = [];
    const deps: AgentModelsDeps = {
      exec: async (command) => {
        calls.push(command);
        if (command.includes("mktemp")) return { stdout: SNAPSHOT_FILE, stderr: "", exitCode: 0 };
        if (command.includes(".agents[$agent]")) return { stdout: "", stderr: "", exitCode: 0 };
        if (command.includes(".native-agent-overrides.tmp")) return { stdout: "", stderr: "", exitCode: 0 };
        return { stdout: JSON.stringify([{ name: "explore", model: { modelID: "mimo-v2.5-free", providerID: "opencode" } }]), stderr: "", exitCode: 0 };
      },
      restart: async () => { calls.push("RESTART"); return { ok: true }; },
      readEnv: () => ({ OPENCODE_SERVER_PASSWORD: "testpass" }),
    };
    await createAgentModelsLib(deps).applyAndVerifyBatch([{ agent: "explore", entries: [] }]);
    const restartIndex = calls.indexOf("RESTART");
    const syncIndex = calls.findIndex((command) => command.includes(".native-agent-overrides.tmp"));
    expect(syncIndex).toBeGreaterThanOrEqual(0);
    expect(calls[syncIndex]).toContain('"$HOME/.config/opencode/oh-my-opencode-slim.json"');
    expect(calls[syncIndex]).not.toContain('"~/.config/opencode/oh-my-opencode-slim.json"');
    expect(calls[syncIndex]).toContain('code=$?; rm -f "$tmp"; exit "$code"');
    expect(calls[syncIndex]).toContain('^[^/[:space:]]+/[^[:space:]]+$');
    expect(restartIndex).toBeGreaterThan(syncIndex);
  });

  test("does not report Apply success when native override synchronization fails", async () => {
    const calls: string[] = [];
    let restartCount = 0;
    const deps: AgentModelsDeps = {
      exec: async (command) => {
        calls.push(command);
        if (command.includes("mktemp")) return { stdout: SNAPSHOT_FILE, stderr: "", exitCode: 0 };
        if (command.includes(".agents[$agent]")) return { stdout: "", stderr: "", exitCode: 0 };
        if (command.includes(".native-agent-overrides.tmp")) return { stdout: "", stderr: "native sync failed", exitCode: 1 };
        if (command.includes(`cat '${SNAPSHOT_FILE}'`)) return { stdout: "", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      restart: async () => { restartCount += 1; return { ok: true }; },
      readEnv: () => ({ OPENCODE_SERVER_PASSWORD: "testpass" }),
    };

    const result = await createAgentModelsLib(deps).applyAndVerify("general", [{ model: "opencode/mimo-v2.5-free" }]);

    expect(result).toEqual({ ok: false, status: "write_failed", error: "native sync failed" });
    expect(restartCount).toBe(0);
    expect(calls.some((command) => command.includes(`cat '${SNAPSHOT_FILE}'`))).toBe(true);
  });

  test("readiness verification issues zero model-message calls", async () => {
    const agentsJson = JSON.stringify([{ name: "explore", model: { modelID: "gpt-5.6-luna-fast", providerID: "openai" } }]);
    const { deps, calls } = stubDeps([
      { stdout: "/tmp/snap" },
      { stdout: "" },
      { stdout: agentsJson },
      { match: /\/provider\b/, stdout: JSON.stringify({ connected: ["openai"], all: [] }) },
    ]);
    const lib = createAgentModelsLib(deps);
    const result = await lib.applyAndVerify("explore", [{ model: "openai/gpt-5.6-luna-fast" }], "readiness");
    expect(result.ok).toBe(true);
    expect(result.status).toBe("verified");
    expect(calls.some((c) => c.includes("/session/") && c.includes("message"))).toBe(false);
    expect(calls.some((c) => c.includes("title:\"model availability probe\""))).toBe(false);
  });

  test("full-operation timeout returns unverified, clears timer, and does not continue probe", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let clearCalled = false;
    let timeoutFired = false;
    const mockSetTimeout = (cb: () => void, ms: number): ReturnType<typeof originalSetTimeout> => {
      if (ms === 180000 || ms === 300000) {
        timeoutFired = true;
        return originalSetTimeout(cb, 10);
      }
      return originalSetTimeout(cb, ms);
    }
    const mockClearTimeout = (id: ReturnType<typeof originalSetTimeout>): void => {
      clearCalled = true;
      originalClearTimeout(id);
    }
    Object.defineProperty(globalThis, "setTimeout", { value: mockSetTimeout, writable: true, configurable: true });
    Object.defineProperty(globalThis, "clearTimeout", { value: mockClearTimeout, writable: true, configurable: true });
    try {
      const fixture = stubDeps([
        { stdout: "/tmp/snap" },
        { stdout: "" },
        { stdout: JSON.stringify([{ name: "explore", model: { modelID: "gpt-5.6-luna-fast", providerID: "openai" } }]), },
        { match: /\/provider\b/, stdout: JSON.stringify({ connected: ["openai"], all: [] }) },
      ]);
      const execOriginal = fixture.deps.exec;
      const callsRef = fixture.calls;
      const trackingExec: AgentModelsDeps["exec"] = async (command, timeoutMs) => {
        if (command.includes("/agent") || command.includes("/provider")) {
          await Bun.sleep(50);
          return execOriginal(command, timeoutMs);
        }
        return execOriginal(command, timeoutMs);
      };
      const deps2 = { exec: trackingExec, restart: fixture.deps.restart, readEnv: fixture.deps.readEnv };
      const lib = createAgentModelsLib(deps2);
      const result = await lib.applyAndVerify("explore", [{ model: "openai/gpt-5.6-luna-fast" }], "readiness");
      expect(timeoutFired).toBe(true);
      expect(result.status).toBe("unverified");
      if (!("error" in result)) throw new Error("expected timeout result");
      expect(result.error).toContain("timed out");
      expect(clearCalled).toBe(true);
      expect(callsRef.some((c) => c.includes("title:\"model availability probe\""))).toBe(false);
    } finally {
      Object.defineProperty(globalThis, "setTimeout", { value: originalSetTimeout, writable: true, configurable: true });
      Object.defineProperty(globalThis, "clearTimeout", { value: originalClearTimeout, writable: true, configurable: true });
    }
  });
});
