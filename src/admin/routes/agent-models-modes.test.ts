import { describe, expect, test, beforeEach } from "bun:test";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { stubDeps, listHandlers } from "./agent-models-test-support";
import { clearModelMetadataCache } from "../lib/model-metadata";

const { createAgentModelsRoutes } = await import("./agent-models");

beforeEach(() => {
  rmSync(join(process.env.HOME ?? "", ".cache/openchamber/agent-model-reconcile.lock"), { recursive: true, force: true });
  clearModelMetadataCache();
});

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("suggestions mode validation", () => {
  test("rejects invalid mode", async () => {
    const { deps, cleanup } = stubDeps(listHandlers());
    const app = createAgentModelsRoutes(deps);
    const res = await app.request("http://localhost/api/agent-models/suggestions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "bad" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("mode must be one of");
    cleanup();
  });

  test("rejects non-object body", async () => {
    const { deps, cleanup } = stubDeps(listHandlers());
    const app = createAgentModelsRoutes(deps);
    const res = await app.request("http://localhost/api/agent-models/suggestions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([]),
    });
    expect(res.status).toBe(400);
    cleanup();
  });

  test("accepts free, economy, performance", async () => {
    for (const mode of ["free", "economy", "performance"] as const) {
      clearModelMetadataCache();
      const origFetch = globalThis.fetch;
      globalThis.fetch = (async () => jsonRes({ openai: { models: { "gpt-5.6-sol": { cost: { input: 0, output: 0 }, limit: { context: 100000, output: 4096 }, reasoning: true, tool_call: true } } } })) as unknown as typeof fetch;
      const { deps, cleanup } = stubDeps(listHandlers());
      const app = createAgentModelsRoutes(deps);
      const res = await app.request("http://localhost/api/agent-models/suggestions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      expect(res.status).toBe(200);
      const j = await res.json() as Record<string, unknown>;
      expect(j.mode).toBe(mode);
      globalThis.fetch = origFetch;
      cleanup();
      clearModelMetadataCache();
    }
  });
});

describe("legacy compatibility", () => {
  test("omitted mode preserves legacy shape", async () => {
    clearModelMetadataCache();
    const { deps, cleanup } = stubDeps(listHandlers());
    const app = createAgentModelsRoutes(deps);
    const res = await app.request("http://localhost/api/agent-models/suggestions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const j = await res.json() as Record<string, unknown>;
    expect(j).toHaveProperty("suggestions");
    expect(j).toHaveProperty("providers");
    expect(j).not.toHaveProperty("mode");
    expect(j).not.toHaveProperty("sourceStatus");
    expect(j).not.toHaveProperty("warnings");
    // legacy suggestions shape is map of agent -> array of {model}
    const sug = j.suggestions as Record<string, unknown>;
    for (const v of Object.values(sug)) {
      expect(Array.isArray(v)).toBe(true);
    }
    cleanup();
  });

  test("providers filter still works in legacy", async () => {
    const { deps, cleanup } = stubDeps(listHandlers());
    const app = createAgentModelsRoutes(deps);
    const res = await app.request("http://localhost/api/agent-models/suggestions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providers: ["openai"] }),
    });
    expect(res.status).toBe(200);
    const j = await res.json() as { suggestions: Record<string, Array<{ model: string }>> };
    for (const arr of Object.values(j.suggestions)) {
      for (const e of arr) expect(e.model.startsWith("openai/")).toBe(true);
    }
    cleanup();
  });
});

describe("explicit mode schema and provider scope", () => {
  test("explicit mode returns JSON-serializable schema with metadata, reason, heuristic", async () => {
    clearModelMetadataCache();
    const origFetch = globalThis.fetch;
    const providers = {
      openai: {
        models: {
          "free-model": {
            cost: { input: 0, output: 0 },
            limit: { context: 100000, output: 8192 },
            reasoning: true,
            tool_call: true,
            structured_output: true,
            deprecated: false,
          },
        },
      },
    };
    globalThis.fetch = (async () => jsonRes(providers)) as unknown as typeof fetch;
    // need provider capabilities to pass filter: tool_call true etc
    const handlers = [
      {
        match: /\/provider\b/,
        stdout: JSON.stringify({
          connected: ["openai", "opencode-go"],
          all: [
            { id: "openai", models: { "free-model": { capabilities: { reasoning: true, toolcall: true, attachment: false } } } },
            { id: "opencode-go", models: { "kimi-k3": { capabilities: { reasoning: true, toolcall: true } } } },
          ],
        }),
      },
      { match: /\/agent\b/, stdout: JSON.stringify([{ name: "general", mode: "subagent", model: { modelID: "free-model", providerID: "openai" } }]) },
      { match: /jq -c '\.agents/, stdout: "{}" },
      { match: /connected-providers\.json/, stdout: '{"connected":["openai","opencode-go"]}' },
      { match: /provider-models\.json/, stdout: "openai/free-model\nopencode-go/kimi-k3\n" },
    ];
    const { deps, cleanup } = stubDeps(handlers);
    const app = createAgentModelsRoutes(deps);
    const res = await app.request("http://localhost/api/agent-models/suggestions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "free", providers: ["openai"] }),
    });
    expect(res.status).toBe(200);
    const j = await res.json() as {
      mode: string;
      providers: string[];
      sourceStatus: string;
      sourceAgeMs: number | null;
      warnings: string[];
      suggestions: Record<string, { model: string; metadata: Record<string, unknown>; reason: string; heuristic: boolean }>;
    };
    expect(j.mode).toBe("free");
    expect(j.providers).toEqual(["openai"]);
    expect(["fresh", "stale", "unavailable"]).toContain(j.sourceStatus);
    expect(Array.isArray(j.warnings)).toBe(true);
    // suggestions should be object, not Map
    expect(j.suggestions).not.toBeInstanceOf(Map);
    for (const [, sug] of Object.entries(j.suggestions)) {
      expect(typeof sug.model).toBe("string");
      expect(sug.metadata).toBeDefined();
      expect(typeof sug.reason).toBe("string");
      expect(typeof sug.heuristic).toBe("boolean");
      expect(sug.metadata.inputPrice).toBeDefined();
    }
    globalThis.fetch = origFetch;
    cleanup();
    clearModelMetadataCache();
  });

  test("explicit mode provider scope limits candidates", async () => {
    clearModelMetadataCache();
    const origFetch = globalThis.fetch;
    const providersPayload = {
      openai: {
        models: {
          "a-model": {
            cost: { input: 0, output: 0 },
            limit: { context: 100000, output: 4096 },
            reasoning: true,
            tool_call: true,
            deprecated: false,
          },
        },
      },
      "opencode-go": {
        models: {
          "b-model": {
            cost: { input: 0, output: 0 },
            limit: { context: 100000, output: 4096 },
            reasoning: true,
            tool_call: true,
            deprecated: false,
          },
        },
      },
    };
    globalThis.fetch = (async () => jsonRes(providersPayload)) as unknown as typeof fetch;
    const handlers = [
      {
        match: /\/provider\b/,
        stdout: JSON.stringify({
          connected: ["openai", "opencode-go"],
          all: [
            { id: "openai", models: { "a-model": { capabilities: { reasoning: true, toolcall: true } } } },
            { id: "opencode-go", models: { "b-model": { capabilities: { reasoning: true, toolcall: true } } } },
          ],
        }),
      },
      { match: /\/agent\b/, stdout: JSON.stringify([{ name: "general", mode: "subagent", model: { modelID: "a-model", providerID: "openai" } }]) },
      { match: /jq -c '\.agents/, stdout: "{}" },
      { match: /connected-providers\.json/, stdout: '{"connected":["openai","opencode-go"]}' },
      { match: /provider-models\.json/, stdout: "openai/a-model\nopencode-go/b-model\n" },
    ];
    const { deps, cleanup } = stubDeps(handlers);
    const app = createAgentModelsRoutes(deps);
    const res = await app.request("http://localhost/api/agent-models/suggestions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "economy", providers: ["openai"] }),
    });
    expect(res.status).toBe(200);
    const j = await res.json() as { providers: string[]; suggestions: Record<string, { model: string }> };
    expect(j.providers).toEqual(["openai"]);
    for (const sug of Object.values(j.suggestions)) {
      expect(sug.model.startsWith("openai/")).toBe(true);
    }
    globalThis.fetch = origFetch;
    cleanup();
    clearModelMetadataCache();
  });

  test("effective provider list when omitted is all connected sorted", async () => {
    clearModelMetadataCache();
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => jsonRes({ openai: { models: {} } })) as unknown as typeof fetch;
    const handlers = listHandlers(); // connected openai, opencode-go
    const { deps, cleanup } = stubDeps(handlers);
    const app = createAgentModelsRoutes(deps);
    const res = await app.request("http://localhost/api/agent-models/suggestions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "economy" }),
    });
    expect(res.status).toBe(200);
    const j = await res.json() as { providers: string[] };
    expect(j.providers).toEqual(["openai", "opencode-go"]);
    globalThis.fetch = origFetch;
    cleanup();
    clearModelMetadataCache();
  });
});

describe("metadata unavailable", () => {
  test("explicit mode with unavailable metadata returns 200 empty suggestions and warning", async () => {
    clearModelMetadataCache();
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("network"); }) as unknown as typeof fetch;
    const { deps, cleanup } = stubDeps(listHandlers());
    const app = createAgentModelsRoutes(deps);
    const res = await app.request("http://localhost/api/agent-models/suggestions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "free" }),
    });
    expect(res.status).toBe(200);
    const j = await res.json() as { sourceStatus: string; warnings: string[]; suggestions: Record<string, unknown> };
    expect(j.sourceStatus).toBe("unavailable");
    expect(j.warnings).toContain("metadata_unavailable");
    expect(Object.keys(j.suggestions).length).toBe(0);
    globalThis.fetch = origFetch;
    cleanup();
    clearModelMetadataCache();
  });

  test("explicit free does not fallback to paid", async () => {
    clearModelMetadataCache();
    const origFetch = globalThis.fetch;
    const payload = {
      openai: {
        models: {
          "paid-model": {
            cost: { input: 1, output: 1 },
            limit: { context: 100000, output: 4096 },
            reasoning: true,
            tool_call: true,
            deprecated: false,
          },
        },
      },
    };
    globalThis.fetch = (async () => jsonRes(payload)) as unknown as typeof fetch;
    const handlers = [
      {
        match: /\/provider\b/,
        stdout: JSON.stringify({
          connected: ["openai"],
          all: [{ id: "openai", models: { "paid-model": { capabilities: { reasoning: true, toolcall: true } } } }],
        }),
      },
      { match: /\/agent\b/, stdout: JSON.stringify([{ name: "general", mode: "subagent", model: { modelID: "paid-model", providerID: "openai" } }]) },
      { match: /jq -c '\.agents/, stdout: "{}" },
      { match: /connected-providers\.json/, stdout: '{"connected":["openai"]}' },
      { match: /provider-models\.json/, stdout: "openai/paid-model\n" },
    ];
    const { deps, cleanup } = stubDeps(handlers);
    const app = createAgentModelsRoutes(deps);
    const res = await app.request("http://localhost/api/agent-models/suggestions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "free" }),
    });
    expect(res.status).toBe(200);
    const j = await res.json() as { suggestions: Record<string, unknown> };
    expect(Object.keys(j.suggestions).length).toBe(0);
    globalThis.fetch = origFetch;
    cleanup();
    clearModelMetadataCache();
  });
});

describe("no probe/write/restart in explicit mode", () => {
  test("explicit suggestions does not call restart, probe write paths", async () => {
    clearModelMetadataCache();
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => jsonRes({ openai: { models: {} } })) as unknown as typeof fetch;
    const { deps, calls, cleanup } = stubDeps(listHandlers());
    let restarted = false;
    const testDeps = { ...deps, restart: async () => { restarted = true; return { ok: true as const }; } };
    const app = createAgentModelsRoutes(testDeps);
    const res = await app.request("http://localhost/api/agent-models/suggestions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "economy", providers: ["openai"] }),
    });
    expect(res.status).toBe(200);
    expect(restarted).toBe(false);
    // probe writes would contain health cache or jq write
    expect(calls.some((c: string) => c.includes("models.json") && c.includes("probe"))).toBe(false);
    expect(calls.some((c: string) => c.includes(".agents[$agent].model = $model"))).toBe(false);
    expect(calls.some((c: string) => c.includes("native-agent-overrides"))).toBe(false);
    globalThis.fetch = origFetch;
    cleanup();
    clearModelMetadataCache();
  });
});

describe("agent verification semantics", () => {
  test("readiness does not report an unprobed agent as healthy", async () => {
    const { deps, cleanup } = stubDeps(listHandlers());
    const app = createAgentModelsRoutes(deps);
    const response = await app.request("http://localhost/api/agent-models/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agents: ["plan"], verification: "readiness" }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.results.plan.status).toBe("configured");
    expect(body.results.plan.reason).toContain("no SubAgent request was sent");
    expect(body.summary.configured).toBe(1);
    expect(body.summary.healthy).toBe(0);
    cleanup();
  });

  test("V2 inference verifies the configured SubAgent route, not a model pinned to title", async () => {
    const previous = process.env.OMO_ENABLED;
    process.env.OMO_ENABLED = "0";
    try {
      const routing = JSON.stringify({
        version: 1,
        chains: { plan: { chain: [{ model: "nvidia/z-ai/glm-5.3" }] } },
      });
      const agents = JSON.stringify({
        data: [{ id: "plan", name: "plan", mode: "subagent", model: { id: "kimi-k3", providerID: "opencode-go" } }],
      });
      const request = JSON.stringify({
        data: [{ type: "assistant", agent: "plan", model: { id: "z-ai/glm-5.3", providerID: "nvidia" }, error: null }],
      });
      const { deps, calls, cleanup } = stubDeps([
        { match: /jq -c '\.' ~\/\.config\/opencode\/routing\.json/, stdout: routing },
        { match: /\/api\/agent\?location/, stdout: agents },
        { match: /\/api\/provider/, stdout: JSON.stringify({ data: [{ id: "nvidia" }] }) },
        { match: /\/api\/model/, stdout: JSON.stringify({ data: [{ id: "z-ai/glm-5.3", providerID: "nvidia", enabled: true, status: "active" }] }) },
        { match: /\/api\/session\?limit=100/, stdout: JSON.stringify({ models: [], truncated: false }) },
        { match: /\/api\/session/, stdout: request },
      ]);
      const app = createAgentModelsRoutes(deps);
      const response = await app.request("http://localhost/api/agent-models/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agents: ["plan"], verification: "inference" }),
      });

      expect(response.status).toBe(200);
      const body = await response.json() as {
        results: Record<string, { status: string; requestModel?: string }>;
        summary: { total: number; healthy: number; configured: number; unconfigured: number; failed: number; verification: string };
      };
      expect(body.results.plan.status).toBe("healthy");
      expect(body.results.plan.requestModel).toBe("nvidia/z-ai/glm-5.3");
      expect(body.summary).toEqual({ total: 1, healthy: 1, configured: 0, unconfigured: 0, failed: 0, verification: "inference" });
      const requestCall = calls.find((command) => command.includes("/api/session/${SESSION}/prompt"));
      expect(requestCall).toBeDefined();
      expect(requestCall).not.toContain(Buffer.from("z-ai/glm-5.3").toString("base64"));
      expect(requestCall).toContain("{agent:$agent,text:");
      cleanup();
    } finally {
      if (previous === undefined) delete process.env.OMO_ENABLED;
      else process.env.OMO_ENABLED = previous;
    }
  });
});
