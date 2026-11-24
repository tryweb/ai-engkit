import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { createAgentModelReconciler } from "./agent-model-reconciler";
import { createTestReconcileLock } from "./agent-model-reconciler-test-support";
import { clearModelMetadataCache } from "./model-metadata";
import { V2_SUBAGENT_AGENTS, type AgentModelsDeps, type RoutingConfig } from "./agent-model-types";

const originalFetch = globalThis.fetch;
beforeEach(() => {
  clearModelMetadataCache();
  globalThis.fetch = Object.assign(async () => Response.json({
    p: { models: {
      alpha: { cost: { input: 0, output: 0 }, limit: { context: 256000, output: 64000 }, reasoning: true, tool_call: true },
      beta: { cost: { input: 0, output: 0 }, limit: { context: 128000, output: 32000 }, reasoning: true, tool_call: true },
    } },
  }), { preconnect: originalFetch.preconnect });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelMetadataCache();
});

function fixture(options: { configured?: string; pinned?: boolean; failWrite?: boolean; password?: boolean; unhealthy?: boolean } = {}) {
  const calls: string[] = [];
  let restarts = 0;
  const routing: RoutingConfig = { version: 1, chains: Object.fromEntries(V2_SUBAGENT_AGENTS.map((name) => [name, { chain: [{ model: name === "general" ? options.configured ?? "p/alpha" : "p/alpha" }] }])) };
  const lock = createTestReconcileLock();
  const deps: AgentModelsDeps = {
    reconcileLockPath: lock,
    readEnv: () => options.password === false ? {} : { OPENCODE_SERVER_PASSWORD: "pw" },
    restart: async () => { restarts++; return { ok: true }; },
    exec: async (command) => {
      calls.push(command);
      const result = (data: unknown, exitCode = 0) => ({ stdout: typeof data === "string" ? data : JSON.stringify(data), stderr: exitCode ? "write failed" : "", exitCode });
      if (command.includes("snap_r=")) return result("/tmp/route-snap:/tmp/opencode-snap");
      if (command.includes("jq -c '.'")) return result(routing);
      if (command.includes(".chains[$agent]")) return result("", options.failWrite ? 1 : 0);
      if (command.includes("agent-model-policy.json")) return result({ mode: "free" });
      if (command.includes("agent-model-pinned.json")) return result({ version: 1, agents: options.pinned ? ["general"] : [] });
      if (command.includes('AGENT=')) {
        if (options.unhealthy) return result({});
        return result({ info: { role: "assistant", modelID: "alpha", providerID: "p" } });
      }
      if (command.includes("/api/model")) return result({ data: ["alpha", "beta"].map((id) => ({ id, providerID: "p", enabled: true, status: "active", capabilities: { reasoning: true, tools: true } })) });
      if (command.includes("/api/provider")) return result({ data: [{ id: "p" }] });
      if (command.includes("/api/agent")) return result({ data: V2_SUBAGENT_AGENTS.map((id) => ({ id, mode: "subagent", model: { id: "alpha", providerID: "p" } })) });
      return result("", 1);
    },
  };
  return { reconciler: createAgentModelReconciler(deps), calls, lock, routing, get restarts() { return restarts; } };
}

describe("native V2 model reconciliation", () => {
  test("keeps catalog-valid configured chains without probing or restarting", async () => {
    const ctx = fixture();
    expect(await ctx.reconciler.reconcileAll()).toMatchObject({ changed: 0, applied: 0, failed: 0 });
    expect(ctx.restarts).toBe(0);
    expect(ctx.calls.some((c) => c.includes('AGENT='))).toBe(false);
    expect(ctx.calls.some((c) => c.includes(".omo"))).toBe(false);
  });

  test.each(["missing/old", "p/retired", "invalid"])("replaces unusable unpinned config %s via native policy", async (configured) => {
    const ctx = fixture({ configured });
    const result = await ctx.reconciler.reconcileAll();
    expect(result).toMatchObject({ changed: 1, applied: 1, failed: 0, agents: ["general"] });
    expect(ctx.calls.some((c) => c.includes(".chains[$agent].chain"))).toBe(true);
    expect(ctx.restarts).toBe(1);
  });

  test("preserves pinned manual configuration even outside the current catalog", async () => {
    const ctx = fixture({ configured: "offline/manual", pinned: true });
    expect(await ctx.reconciler.reconcileAll()).toMatchObject({ changed: 0 });
    expect(ctx.restarts).toBe(0);
  });

  test("does not invent a replacement when metadata is unavailable", async () => {
    globalThis.fetch = Object.assign(async () => { throw new Error("offline"); }, { preconnect: originalFetch.preconnect });
    const ctx = fixture({ configured: "missing/old" });
    expect(await ctx.reconciler.reconcileAll()).toMatchObject({ changed: 0, failed: 0 });
    expect(ctx.restarts).toBe(0);
  });

  test("does not replace config when no free candidate responds successfully", async () => {
    const ctx = fixture({ configured: "missing/old", unhealthy: true });
    expect(await ctx.reconciler.reconcileAll()).toMatchObject({ changed: 0 });
    expect(ctx.restarts).toBe(0);
  });

  test("counts native routing write failures without restarting", async () => {
    const ctx = fixture({ configured: "missing/old", failWrite: true });
    expect(await ctx.reconciler.reconcileAll()).toMatchObject({ changed: 1, applied: 0, failed: 1 });
    expect(ctx.restarts).toBe(0);
  });

  test("without server credentials does not execute any commands", async () => {
    const ctx = fixture({ password: false });
    expect(await ctx.reconciler.reconcileAll()).toMatchObject({ changed: 0 });
    expect(ctx.calls).toHaveLength(0);
  });

  test("does not remove another owner's lock and resumes once it is released", async () => {
    const ctx = fixture({ configured: "missing/old" });
    mkdirSync(ctx.lock, { recursive: true });
    try {
      expect(await ctx.reconciler.reconcileAll()).toMatchObject({ changed: 0 });
      expect(ctx.calls).toHaveLength(0);
    } finally {
      rmSync(ctx.lock, { recursive: true, force: true });
    }
    expect(await ctx.reconciler.reconcileAll()).toMatchObject({ changed: 1 });
  });

  test("identical native chains are readiness no-ops", async () => {
    const ctx = fixture();
    expect(await ctx.reconciler.applyAgent("general", [{ model: "p/alpha" }])).toMatchObject({ ok: true, status: "configured" });
    expect(ctx.restarts).toBe(0);
  });

  test("inference on an identical chain verifies a request without writing", async () => {
    const ctx = fixture();
    expect(await ctx.reconciler.applyAgent("general", [{ model: "p/alpha" }], "inference")).toMatchObject({ ok: true, status: "verified" });
    expect(ctx.restarts).toBe(0);
    expect(ctx.calls.some((c) => c.includes(".chains[$agent].chain"))).toBe(false);
    expect(ctx.calls.some((c) => c.includes("/api/session"))).toBe(true);
  });

  test("suggestions respect provider scope", async () => {
    const ctx = fixture();
    expect((await ctx.reconciler.suggest(["missing"])).size).toBe(0);
    expect(ctx.restarts).toBe(0);
  });

  test("suggestions reuse a healthy candidate without probing once per agent", async () => {
    const ctx = fixture();
    const suggestions = await ctx.reconciler.suggest(["p"]);
    expect(suggestions.size).toBe(V2_SUBAGENT_AGENTS.length);
    expect(ctx.calls.filter((c) => c.includes('AGENT='))).toHaveLength(1);
    expect(ctx.restarts).toBe(0);
  });
});
