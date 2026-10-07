import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { clearModelMetadataCache } from "./model-metadata";
import type { NormalizedModelMetadata } from "./model-metadata";
import { createAgentModelReconciler, parseCapabilities } from "./agent-model-reconciler";
import type { AgentModelsDeps } from "./agent-model-types";
import type { ExecResult } from "./docker";
import type { PolicyCapabilityCatalog } from "./agent-model-suggestion-policy";

function jsonRes(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  rmSync(join(process.env.HOME ?? "", ".cache/openchamber/agent-model-reconcile.lock"), { recursive: true, force: true });
  clearModelMetadataCache();
});

function makeDeps(handlers: Array<{ match: RegExp; stdout?: string }>): { deps: AgentModelsDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: AgentModelsDeps = {
    exec: async (cmd: string): Promise<ExecResult> => {
      calls.push(cmd);
      for (const h of handlers) if (h.match.test(cmd)) return { stdout: h.stdout ?? "", stderr: "", exitCode: 0 };
      if (cmd.includes("dGl0bGU=")) return { stdout: JSON.stringify({ info: { role: "assistant", modelID: "free-model", providerID: "openai" } }), stderr: "", exitCode: 0 };
      if (cmd.includes("snap_r=") || cmd.includes("snapshot")) return { stdout: "/tmp/snap_r:/tmp/snap_o", stderr: "", exitCode: 0 };
      if (cmd.includes("cat") && cmd.includes("routing.json")) return { stdout: '{"version":1,"chains":{}}', stderr: "", exitCode: 0 };
      if (cmd.includes("agent-model-policy.json")) return { stdout: '{"mode":"free"}', stderr: "", exitCode: 0 };
      if (cmd.includes("routing.json")) return { stdout: "", stderr: "", exitCode: 0 };
      if (cmd.includes("opencode.json")) return { stdout: "{}", stderr: "", exitCode: 0 };
      if (cmd.includes("auth.json")) return { stdout: "", stderr: "", exitCode: 1 };
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    restart: async () => ({ ok: true }),
    readEnv: () => ({ OPENCODE_SERVER_PASSWORD: "pw", OMO_ENABLED: "0" }),
  };
  return { deps, calls };
}

describe("preserve full chain and variants", () => {
  test("keeps full fallback chain with variants when valid", async () => {
    const prev = process.env.OMO_ENABLED;
    process.env.OMO_ENABLED = "0";
    const payload = {
      openai: { models: {
        "free-model": { cost: { input: 0, output: 0 }, limit: { context: 32000, output: 4000 }, reasoning: false, tool_call: true },
        "fallback-model": { cost: { input: 0, output: 0 }, limit: { context: 32000, output: 4000 }, reasoning: false, tool_call: true },
      }},
    };
    const origFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async (): Promise<Response> => jsonRes(payload), { preconnect: Reflect.get(origFetch, "preconnect") });
    const routing = JSON.stringify({
      version: 1,
      chains: {
        explore: { chain: [{ model: "openai/free-model", variant: "low" }, { model: "openai/fallback-model", variant: "high" }] },
      },
    });
    const handlers = [
      { match: /agent-model-policy\.json/, stdout: '{"mode":"free"}' },
      { match: /routing\.json/, stdout: routing },
      { match: /\/api\/provider/, stdout: JSON.stringify({ data: [{ id: "openai" }] }) },
      { match: /\/api\/model/, stdout: JSON.stringify({ data: [{ id: "free-model", providerID: "openai" }, { id: "fallback-model", providerID: "openai" }] }) },
      { match: /\/provider\b/, stdout: JSON.stringify({ connected: ["openai"], all: [{ id: "openai", models: { "free-model": { capabilities: { toolcall: true } }, "fallback-model": { capabilities: { toolcall: true } } } }] }) },
      { match: /\/api\/agent/, stdout: JSON.stringify({ data: [{ id: "explore", mode: "subagent" }] }) },
    ];
    const { deps } = makeDeps(handlers);
    const rec = createAgentModelReconciler(deps);
    const summary = await rec.reconcileAll();
    expect(summary.agents.includes("explore")).toBe(false);
    globalThis.fetch = origFetch;
    process.env.OMO_ENABLED = prev;
    clearModelMetadataCache();
  }, 10000);
});


describe("unknown metadata preserves user config", () => {
  test("preserves paid choice when metadata unavailable (conservative)", async () => {
    const prev = process.env.OMO_ENABLED;
    process.env.OMO_ENABLED = "0";
    const origFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async (): Promise<Response> => { throw new Error("network"); }, { preconnect: Reflect.get(origFetch, "preconnect") });
    const routing = JSON.stringify({
      version: 1,
      chains: { oracle: { chain: [{ model: "openai/paid-model" }] } },
    });
    const handlers = [
      { match: /agent-model-policy\.json/, stdout: '{"mode":"free"}' },
      { match: /routing\.json/, stdout: routing },
      { match: /\/api\/provider/, stdout: JSON.stringify({ data: [{ id: "openai" }] }) },
      { match: /\/api\/model/, stdout: JSON.stringify({ data: [{ id: "paid-model", providerID: "openai" }] }) },
      { match: /\/provider\b/, stdout: JSON.stringify({ connected: ["openai"], all: [{ id: "openai", models: { "paid-model": { capabilities: { reasoning: true, toolcall: true } } } }] }) },
      { match: /\/api\/agent/, stdout: JSON.stringify({ data: [{ id: "oracle", mode: "subagent" }] }) },
    ];
    const { deps } = makeDeps(handlers);
    const rec = createAgentModelReconciler(deps);
    const summary = await rec.reconcileAll();
    expect(summary.agents.includes("oracle")).toBe(false);
    globalThis.fetch = origFetch;
    process.env.OMO_ENABLED = prev;
    clearModelMetadataCache();
  }, 10000);
});

describe("multimodal via V2 capabilities", () => {
  test("multimodal gets suggestion when V2 model has attachment capability", async () => {
    const v2Models = JSON.stringify({
      data: [
        { id: "vision-model", providerID: "openai", capabilities: { reasoning: false, toolcall: true, attachment: true, input: { image: true } }, enabled: true, status: "active" },
      ],
    });
    const parsed = parseCapabilities(v2Models);
    expect(parsed.get("openai/vision-model")?.attachment).toBe(true);
  });

  test("multimodal not eligible without attachment", async () => {
    const v2Models = JSON.stringify({
      data: [
        { id: "text-model", providerID: "openai", capabilities: { reasoning: false, toolcall: true, attachment: false }, enabled: true, status: "active" },
      ],
    });
    const parsed = parseCapabilities(v2Models);
    expect(parsed.get("openai/text-model")?.attachment).toBe(false);
  });

  test("V2 model caps fixture {tools:true,input:['text','image']} parses to attachment and toolcall true", async () => {
    const v2Fixture = JSON.stringify({
      data: [
        {
          id: "multimodal-v2",
          providerID: "openai",
          capabilities: { tools: true, input: ["text", "image"] },
          enabled: true,
          status: "active",
        },
      ],
    });
    const parsed = parseCapabilities(v2Fixture);
    const caps = parsed.get("openai/multimodal-v2");
    expect(caps?.toolcall).toBe(true);
    expect(caps?.attachment).toBe(true);
    expect(caps?.input).toEqual(expect.objectContaining({ image: true, text: true }));
  });
});

describe("free/economy/performance policy differences", () => {
  test("free picks only zero-cost, economy picks cheapest, performance picks highest score", async () => {
    const { suggestForMode } = await import("./agent-model-suggestion-policy");
    const catalog: readonly string[] = ["openai/free-a", "openai/cheap-b", "openai/strong-c"];
    const now = Date.now();
    const metadata: ReadonlyMap<string, NormalizedModelMetadata> = new Map<string, NormalizedModelMetadata>([
      ["openai/free-a", { providerId: "openai", modelId: "free-a", reference: "openai/free-a", inputPrice: 0, outputPrice: 0, contextLimit: 256000, outputLimit: 64000, reasoning: true, toolCall: true, structuredOutput: true, deprecated: false, benchmarkScore: 0.5, fetchedAt: now }],
      ["openai/cheap-b", { providerId: "openai", modelId: "cheap-b", reference: "openai/cheap-b", inputPrice: 0.1, outputPrice: 0.1, contextLimit: 256000, outputLimit: 64000, reasoning: true, toolCall: true, structuredOutput: true, deprecated: false, benchmarkScore: 0.6, fetchedAt: now }],
      ["openai/strong-c", { providerId: "openai", modelId: "strong-c", reference: "openai/strong-c", inputPrice: 10, outputPrice: 10, contextLimit: 256000, outputLimit: 64000, reasoning: true, toolCall: true, structuredOutput: true, deprecated: false, benchmarkScore: 0.95, fetchedAt: now }],
    ]);
    const caps: PolicyCapabilityCatalog = new Map([
      ["openai/free-a", {}],
      ["openai/cheap-b", {}],
      ["openai/strong-c", {}],
    ]);
    const agents: readonly string[] = ["oracle"];
    const freeOut = suggestForMode({ mode: "free", providers: ["openai"], catalog, metadata, sourceStatus: "fresh", sourceAgeMs: 0, warnings: [], capabilities: caps, agents });
    const econOut = suggestForMode({ mode: "economy", providers: ["openai"], catalog, metadata, sourceStatus: "fresh", sourceAgeMs: 0, warnings: [], capabilities: caps, agents });
    const perfOut = suggestForMode({ mode: "performance", providers: ["openai"], catalog, metadata, sourceStatus: "fresh", sourceAgeMs: 0, warnings: [], capabilities: caps, agents });
    expect(freeOut.suggestions.get("oracle")?.model).toBe("openai/free-a");
    expect(econOut.suggestions.get("oracle")?.model).toBe("openai/free-a");
    expect(perfOut.suggestions.get("oracle")?.model).toBe("openai/strong-c");
  });
});

describe("pinned manual configuration", () => {
  test("keeps pinned chain even when policy would replace it", async () => {
    const prev = process.env.OMO_ENABLED;
    process.env.OMO_ENABLED = "0";
    const payload = {
      openai: { models: {
        "free-model": { cost: { input: 0, output: 0 }, limit: { context: 32000, output: 4000 }, reasoning: false, tool_call: true },
      }},
    };
    const origFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async (): Promise<Response> => jsonRes(payload), { preconnect: Reflect.get(origFetch, "preconnect") });
    try {
      const routing = JSON.stringify({
        version: 1,
        chains: {
          explore: { chain: [{ model: "custom/old-model" }] },
        },
      });
      const handlers = [
        { match: /agent-model-pinned\.json/, stdout: JSON.stringify({ version: 1, agents: ["explore"] }) },
        { match: /agent-model-policy\.json/, stdout: '{"mode":"free"}' },
        { match: /routing\.json/, stdout: routing },
        { match: /\/api\/provider/, stdout: JSON.stringify({ data: [{ id: "openai" }] }) },
        { match: /\/api\/model/, stdout: JSON.stringify({ data: [{ id: "free-model", providerID: "openai" }] }) },
        { match: /\/provider\b/, stdout: JSON.stringify({ connected: ["openai"], all: [{ id: "openai", models: { "free-model": { capabilities: { toolcall: true } } } }] }) },
        { match: /\/api\/agent/, stdout: JSON.stringify({ data: [{ id: "explore", mode: "subagent", model: { id: "free-model", providerID: "openai" } }] }) },
      ];
      const { deps, calls } = makeDeps(handlers);
      const rec = createAgentModelReconciler(deps);
      const summary = await rec.reconcileAll();
      expect(summary.agents.includes("explore")).toBe(false);
      expect(summary.failed).toBe(0);
      expect(calls.some((c) => c.includes("del(.chains") || c.includes(".chains[$agent].chain ="))).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
      if (prev === undefined) delete process.env.OMO_ENABLED;
      else process.env.OMO_ENABLED = prev;
    }
  });

  test("unpinned agent with same setup gets policy replacement", async () => {
    const prev = process.env.OMO_ENABLED;
    process.env.OMO_ENABLED = "0";
    const payload = {
      openai: { models: {
        "free-model": { cost: { input: 0, output: 0 }, limit: { context: 32000, output: 4000 }, reasoning: false, tool_call: true },
      }},
    };
    const origFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async (): Promise<Response> => jsonRes(payload), { preconnect: Reflect.get(origFetch, "preconnect") });
    try {
      const routing = JSON.stringify({
        version: 1,
        chains: {
          explore: { chain: [{ model: "custom/old-model" }] },
        },
      });
      const handlers = [
        { match: /agent-model-pinned\.json/, stdout: JSON.stringify({ version: 1, agents: [] }) },
        { match: /agent-model-policy\.json/, stdout: '{"mode":"free"}' },
        { match: /routing\.json/, stdout: routing },
        { match: /\/api\/provider/, stdout: JSON.stringify({ data: [{ id: "openai" }] }) },
        { match: /\/api\/model/, stdout: JSON.stringify({ data: [{ id: "free-model", providerID: "openai" }] }) },
        { match: /\/provider\b/, stdout: JSON.stringify({ connected: ["openai"], all: [{ id: "openai", models: { "free-model": { capabilities: { toolcall: true } } } }] }) },
        { match: /\/api\/agent/, stdout: JSON.stringify({ data: [{ id: "explore", mode: "subagent", model: { id: "free-model", providerID: "openai" } }] }) },
      ];
      const { deps } = makeDeps(handlers);
      const rec = createAgentModelReconciler(deps);
      const summary = await rec.reconcileAll();
      expect(summary.agents.includes("explore")).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
      if (prev === undefined) delete process.env.OMO_ENABLED;
      else process.env.OMO_ENABLED = prev;
    }
  });
});
