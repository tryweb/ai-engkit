import { describe, expect, test } from "bun:test";
import { collectAgentModelState, createAgentModelsLib, type AgentModelStateSource } from "./agent-models";
import { V2_SUBAGENT_AGENTS, type AgentModelsDeps, type FallbackModelEntry, type RoutingConfig } from "./agent-model-types";

function fixture(options: {
  password?: string | null;
  routing?: RoutingConfig;
  requestModel?: string | null;
  connected?: string[];
  assigned?: string | null;
  fail?: "snapshot" | "write" | "restore" | "agents";
  restartFails?: boolean;
  providerDelayMs?: number;
} = {}) {
  const calls: string[] = [];
  let restarts = 0;
  const model = options.assigned === undefined ? "openai/assigned" : options.assigned;
  const deps: AgentModelsDeps = {
    exec: async (command) => {
      calls.push(command);
      const result = (stdout = "", exitCode = 0) => ({ stdout, stderr: exitCode ? `${options.fail} failed` : "", exitCode });
      if (command.includes("snap_r=")) return result("/tmp/routing-snap:/tmp/opencode-snap", options.fail === "snapshot" ? 1 : 0);
      if (command.includes("cat '/tmp/routing-snap'")) return result("", options.fail === "restore" ? 1 : 0);
      if (command.includes("jq -c '.'")) return result(JSON.stringify(options.routing ?? { version: 1, chains: {} }));
      if (command.includes("routing.json")) return result("", options.fail === "write" ? 1 : 0);
      if (command.includes("/api/provider")) {
        if (options.providerDelayMs) await Bun.sleep(options.providerDelayMs);
        return result(JSON.stringify({ data: (options.connected ?? ["openai"]).map((id) => ({ id })) }));
      }
      if (command.includes("/api/model")) return result(JSON.stringify({ data: [{ id: "primary", providerID: "openai", enabled: true, status: "active" }] }));
      if (command.includes("/api/agent")) {
        if (options.fail === "agents") return result("", 2);
        return result(JSON.stringify({ data: model === null ? [] : [{ id: "librarian", mode: "subagent", model: { providerID: model.split("/")[0], id: model.split("/").slice(1).join("/") } }] }));
      }
      if (command.includes("/api/session")) {
        const request = options.requestModel === undefined ? "openai/primary" : options.requestModel;
        return result(request === null ? "{}" : JSON.stringify({ data: { type: "assistant", model: { providerID: request.split("/")[0], id: request.split("/").slice(1).join("/") } } }));
      }
      return result("", 1);
    },
    restart: async () => {
      restarts++;
      return options.restartFails ? { ok: false, error: "restart failed" } : { ok: true };
    },
    readEnv: () => options.password === null ? {} : { OPENCODE_SERVER_PASSWORD: options.password ?? "testpass" },
  };
  return { lib: createAgentModelsLib(deps), calls, get restarts() { return restarts; } };
}

describe("native V2 model configuration", () => {
  test("reads routing chains without reading legacy agent config", async () => {
    const routing = { version: 1, chains: { librarian: { chain: [{ model: "openai/primary", variant: "high" }, { model: "other/fallback" }] } } };
    const ctx = fixture({ routing });
    expect(await ctx.lib.readRoutingConfig()).toMatchObject(routing);
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.calls[0]).toContain("routing.json");
    expect(ctx.calls[0]).not.toContain(".omo");
  });

  test.each([null, "  ", ""])("missing password %j is unavailable", (password) => {
    expect(fixture({ password }).lib.getServerPassword()).toBeNull();
  });

  test("trims the server password", () => {
    expect(fixture({ password: " testpass " }).lib.getServerPassword()).toBe("testpass");
  });

  test("fetches wrapped agent models with Basic authentication", async () => {
    const ctx = fixture();
    expect((await ctx.lib.fetchResolvedAgentModels("testpass"))?.get("librarian")).toEqual({ providerID: "openai", modelID: "assigned" });
    expect(ctx.calls[0]).toContain(Buffer.from("opencode:testpass").toString("base64"));
    expect(ctx.calls[0]).toContain("/api/agent");
  });

  test("agent fetch failure returns null", async () => {
    expect(await fixture({ fail: "agents" }).lib.fetchResolvedAgentModels("testpass")).toBeNull();
  });

  test("reads provider and model catalog from separate native endpoints", async () => {
    const ctx = fixture();
    expect(await ctx.lib.fetchProviderSnapshot("testpass")).toMatchObject({ connectedProviders: ["openai"], catalog: ["openai/primary"], source: "live" });
    expect(ctx.calls).toHaveLength(2);
  });
});

describe("V2 apply and verification", () => {
  const entries = [{ model: "openai/primary" }];

  test("readiness reports configured, not inference-verified, despite a different assigned model", async () => {
    const ctx = fixture();
    expect(await ctx.lib.applyAndVerify("librarian", entries)).toMatchObject({ ok: true, status: "configured", requestVerified: null });
    expect(ctx.restarts).toBe(1);
    expect(ctx.calls.some((c) => c.includes("/api/session"))).toBe(false);
    expect(ctx.calls.some((c) => c.includes(".omo"))).toBe(false);
  });

  test("native writes mirror the routing head into opencode.json", async () => {
    const ctx = fixture();
    await ctx.lib.applyAndVerify("librarian", entries);
    const write = ctx.calls.find((c) => c.includes(".chains[$agent].chain"));
    expect(write).toContain("opencode.json");
    expect(write).toContain(".agent[$agent].model");
  });

  test("a batch writes both agents with one snapshot and one restart", async () => {
    const ctx = fixture();
    const result = await ctx.lib.applyAndVerifyBatch(["librarian", "explore"].map((agent) => ({ agent, entries })));
    expect(result.size).toBe(2);
    expect(ctx.calls.filter((c) => c.includes("snap_r="))).toHaveLength(1);
    expect(ctx.calls.filter((c) => c.includes(".chains[$agent].chain"))).toHaveLength(2);
    expect(ctx.restarts).toBe(1);
  });

  test("empty batches do not execute commands or restart", async () => {
    const ctx = fixture();
    expect((await ctx.lib.applyAndVerifyBatch([])).size).toBe(0);
    expect(ctx.calls).toHaveLength(0);
    expect(ctx.restarts).toBe(0);
  });

  test("clearing removes routing and native head overrides", async () => {
    const ctx = fixture();
    expect(await ctx.lib.applyAndVerify("librarian", [])).toMatchObject({ ok: true, status: "cleared" });
    expect(ctx.calls[1]).toContain("del(.chains[$agent])");
    expect(ctx.calls[1]).toContain(".agent[$agent]");
  });

  test.each(["snapshot", "write"] as const)("%s failure prevents restart", async (fail) => {
    const ctx = fixture({ fail });
    expect(await ctx.lib.applyAndVerify("librarian", entries)).toMatchObject({ ok: false, status: "write_failed" });
    expect(ctx.restarts).toBe(0);
  });

  test.each([{ fail: undefined, status: "restart_failed" }, { fail: "restore" as const, status: "rollback_failed" }])("restart failure reports $status", async ({ fail, status }) => {
    const ctx = fixture({ fail, restartFails: true });
    expect(await ctx.lib.applyAndVerify("librarian", entries)).toMatchObject({ ok: false, status });
    expect(ctx.calls.some((c) => c.includes("cat '/tmp/routing-snap'"))).toBe(true);
    expect(ctx.restarts).toBe(1);
  });

  test("invalid model references fail before writing or restarting", async () => {
    const ctx = fixture();
    expect(await ctx.lib.applyAndVerify("librarian", [{ model: "invalid" }])).toMatchObject({ ok: false, status: "write_failed" });
    expect(ctx.restarts).toBe(0);
  });

  test.each([
    { requestModel: "openai/primary", status: "verified" },
    { requestModel: "other/fallback", status: "verified" },
    { requestModel: "openai/unexpected", status: "runtime_mismatch" },
    { requestModel: null, status: "unverified" },
  ])("inference with $requestModel returns $status", async ({ requestModel, status }) => {
    const ctx = fixture({ requestModel });
    expect(await ctx.lib.applyAndVerify("librarian", [...entries, { model: "other/fallback" }], "inference")).toMatchObject({ status });
    expect(ctx.restarts).toBe(1);
    expect(ctx.calls.some((c) => c.includes("cat '/tmp/routing-snap'"))).toBe(false);
  });

  test("a disconnected chain is unverified and issues no inference", async () => {
    const ctx = fixture({ connected: [] });
    expect(await ctx.lib.applyAndVerify("librarian", entries, "inference")).toMatchObject({ ok: false, status: "unverified" });
    expect(ctx.calls.some((c) => c.includes("/api/session"))).toBe(false);
  });

  test.each(["readiness", "inference"] as const)("%s timeout clears its timer and stops further verification", async (verification) => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let cleared = false;
    globalThis.setTimeout = ((callback: TimerHandler, ms?: number, ...args: unknown[]) =>
      originalSetTimeout(callback, ms === 180_000 || ms === 300_000 ? 5 : ms, ...args)) as typeof setTimeout;
    globalThis.clearTimeout = ((timer) => { cleared = true; originalClearTimeout(timer); }) as typeof clearTimeout;
    try {
      const ctx = fixture({ providerDelayMs: 30 });
      expect(await ctx.lib.applyAndVerify("librarian", entries, verification)).toMatchObject({ ok: false, status: "unverified", error: expect.stringContaining("timed out") });
      await Bun.sleep(50);
      expect(cleared).toBe(true);
      expect(ctx.calls.some((c) => c.includes("/api/agent") || c.includes("/api/session"))).toBe(false);
      expect(ctx.restarts).toBe(1);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });
});

describe("native V2 model state", () => {
  function stateSource(chain: FallbackModelEntry[], requestModel: string | null = null): AgentModelStateSource {
    return {
      readRoutingConfig: async () => ({ version: 1, chains: { librarian: { chain }, build: { chain: [{ model: "openai/internal" }] } } }),
      fetchResolvedAgentModels: async () => new Map([["librarian", { providerID: "openai", modelID: "markdown-default" }]]),
      fetchProviderSnapshot: async () => ({ connectedProviders: ["openai"], catalog: ["openai/primary"] }),
      fetchSubagentNames: async () => ["librarian", "build"],
      fetchRecentRequestModels: async () => ({ models: requestModel === null ? [] : [{ agent: "librarian", providerID: requestModel.split("/")[0]!, modelID: requestModel.split("/").slice(1).join("/"), completedAt: 123 }], truncated: false }),
      readPinnedAgents: async () => new Set(["librarian"]),
    };
  }

  test.each([
    { request: null, effectiveness: "awaiting_request" },
    { request: "openai/primary", effectiveness: "effective" },
    { request: "openai/fallback", effectiveness: "effective" },
    { request: "openai/old", effectiveness: "runtime_mismatch" },
  ])("request $request yields $effectiveness without comparing the Markdown default", async ({ request, effectiveness }) => {
    const source = stateSource([{ model: "openai/primary" }, { model: "openai/fallback" }], request);
    const state = await collectAgentModelState(source, "pw");
    expect(state.agents.map((a) => a.name)).toEqual([...V2_SUBAGENT_AGENTS].sort());
    expect(state.agents.find((a) => a.name === "librarian")).toMatchObject({ effectiveness, pinned: true, providerConnected: true });
    expect(state.agents.some((a) => a.name === "build")).toBe(false);
  });

  test("without a password state does not call authenticated endpoints", async () => {
    const source = stateSource([{ model: "openai/primary" }]);
    const forbidden = async (): Promise<never> => { throw new Error("authenticated call"); };
    const state = await collectAgentModelState({ ...source, fetchResolvedAgentModels: forbidden, fetchSubagentNames: forbidden, fetchRecentRequestModels: forbidden, readPinnedAgents: forbidden }, null);
    expect(state.hasPassword).toBe(false);
    expect(state.agents.every((a) => a.resolved === null && a.requestVerified === null)).toBe(true);
  });
});
