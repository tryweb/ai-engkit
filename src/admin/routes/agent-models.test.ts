import { beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { listHandlers, stubDeps } from "./agent-models-test-support";

const { createAgentModelsRoutes } = await import("./agent-models");

beforeEach(() => {
  rmSync(join(process.env.HOME ?? "", ".cache/openchamber/agent-model-reconcile.lock"), { recursive: true, force: true });
});

describe("createAgentModelsRoutes — PUT /api/agent-models/:agent", () => {
  test("clears an existing configured model", async () => {
    const { deps, cleanup } = stubDeps([
      { match: /jq -c '\.agents/, stdout: '{"librarian":{"model":"opencode/nemotron-3.5-lightning-free"}}' },
      { match: /connected-providers\.json/, stdout: '{"connected":["opencode-go"]}' },
      { match: /provider-models\.json/, stdout: "opencode-go/qwen3.7-plus\n" },
      { match: /\/agent\b/, stdout: JSON.stringify([
        { name: "librarian", mode: "subagent", model: { modelID: "qwen3.7-plus", providerID: "opencode-go" } },
      ]) },
      { match: /cat ~\/\.config\/opencode\/oh-my-opencode-slim\.json/, stdout: '{"agents":{}}' },
      { match: /del\(\.agents\[\$agent\]\.model/, stdout: "" },
    ]);
    const response = await createAgentModelsRoutes(deps).request("http://localhost/api/agent-models/librarian", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: [] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, status: "cleared" });
    cleanup();
  });

  test("rejects invalid entries with 400 and does not write", async () => {
    const { deps, calls, cleanup } = stubDeps([]);
    const app = createAgentModelsRoutes(deps);
    const res = await app.request("http://localhost/api/agent-models/plan", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: [{ model: 42 }] }),
    });
    expect(res.status).toBe(400);
    expect(calls.length).toBe(0);
    cleanup();
  });

  test("rejects multiple model entries with 400 before any write or restart", async () => {
    const { deps, calls, cleanup } = stubDeps([]);
    const app = createAgentModelsRoutes(deps);
    const res = await app.request("http://localhost/api/agent-models/plan", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: [{ model: "opencode/big-pickle" }, { model: "openai/gpt-5.6-sol" }] }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("at most one");
    expect(calls.some((call) => call.includes("jq "))).toBe(false);
    expect(calls.length).toBe(0);
    cleanup();
  });

  test("rejects an invalid agent name", async () => {
    const { deps, cleanup } = stubDeps([]);
    const app = createAgentModelsRoutes(deps);
    const res = await app.request("http://localhost/api/agent-models/BAD NAME", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: [{ model: "x" }] }),
    });
    expect(res.status).toBe(400);
    cleanup();
  });

  test("rejects with 409 when password is absent (degraded mode)", async () => {
    const { deps, calls, cleanup } = stubDeps([], null);
    const app = createAgentModelsRoutes(deps);
    const res = await app.request("http://localhost/api/agent-models/plan", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: [{ model: "openai/gpt-5.6-sol" }] }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("OPENCODE_SERVER_PASSWORD");
    expect(calls.length).toBe(0);
    cleanup();
  });

  test("rejects agents that are not live subagents", async () => {
    const { deps, calls, cleanup } = stubDeps([
      { match: /jq -c '\.agents/, stdout: '{"plan":{}}' },
      { match: /connected-providers\.json/, stdout: '{"connected":["opencode"]}' },
      { match: /provider-models\.json/, stdout: "opencode/big-pickle\n" },
      { match: /\/agent\b/, stdout: JSON.stringify([
        { name: "plan", mode: "primary", model: { modelID: "big-pickle", providerID: "opencode" } },
      ]) },
    ]);
    const app = createAgentModelsRoutes(deps);
    const res = await app.request("http://localhost/api/agent-models/plan", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: [{ model: "opencode/big-pickle" }] }),
    });
    expect(res.status).toBe(403);
    expect(calls.some((call) => call.includes(".agents[$agent].model = $model"))).toBe(false);
    cleanup();
  });

  test("rejects models outside the current environment catalog", async () => {
    const { deps, calls, cleanup } = stubDeps([
      { match: /jq -c '\.agents/, stdout: '{"plan":{}}' },
      { match: /connected-providers\.json/, stdout: '{"connected":["opencode"]}' },
      { match: /provider-models\.json/, stdout: "opencode/big-pickle\n" },
      { match: /\/agent\b/, stdout: JSON.stringify([
        { name: "plan", mode: "subagent", model: { modelID: "big-pickle", providerID: "opencode" } },
      ]) },
    ]);
    const app = createAgentModelsRoutes(deps);
    const res = await app.request("http://localhost/api/agent-models/plan", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: [{ model: "openai/gpt-5.6-sol" }] }),
    });
    expect(res.status).toBe(400);
    expect(calls.some((call) => call.includes(".agents[$agent].model = $model"))).toBe(false);
    cleanup();
  });

  test("returns verified when the resolved model matches", async () => {
    const { deps, cleanup } = stubDeps([
      { match: /jq -c '\.agents/, stdout: '{"plan":{}}' },
      { match: /connected-providers\.json/, stdout: '{"connected":["opencode"]}' },
      { match: /provider-models\.json/, stdout: "opencode/big-pickle\n" },
      { match: /cat ~\/\.config\/opencode\/oh-my-opencode-slim\.json/, stdout: '{"agents":{}}' },
      { match: /\.agents\[\$agent\]\.model = \$model/, stdout: "" },
      { match: /\/agent\b/, stdout: JSON.stringify([
        { name: "plan", mode: "subagent", model: { modelID: "big-pickle", providerID: "opencode" } },
      ]) },
    ]);
    const app = createAgentModelsRoutes(deps);
    const res = await app.request("http://localhost/api/agent-models/plan", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: [{ model: "opencode/big-pickle", variant: "medium" }] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      status: "verified",
      resolved: { modelID: "big-pickle", providerID: "opencode" },
    });
    cleanup();
  });

  test("returns write_failed when the jq write fails", async () => {
    const { deps, cleanup } = stubDeps([
      { match: /jq -c '\.agents/, stdout: '{"explore":{}}' },
      { match: /connected-providers\.json/, stdout: '{"connected":["opencode"]}' },
      { match: /provider-models\.json/, stdout: "opencode/big-pickle\n" },
      { match: /\/agent\b/, stdout: JSON.stringify([
        { name: "explore", mode: "subagent", model: { modelID: "big-pickle", providerID: "opencode" } },
      ]) },
      { match: /cat ~\/\.config\/opencode\/oh-my-opencode-slim\.json/, stdout: "/tmp/omo.jsonc.snapshot-test" },
      { match: /\.agents\[\$agent\]\.model = \$model/, stdout: "", exitCode: 1, stderr: "jq: parse error" },
      { match: /cat '\/tmp\/omo\.jsonc\.snapshot-test'/, stdout: "" },
    ]);
    const app = createAgentModelsRoutes(deps);
    const res = await app.request("http://localhost/api/agent-models/explore", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: [{ model: "opencode/big-pickle" }] }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.status).toBe("write_failed");
    expect(data.error).toContain("jq");
    cleanup();
  });
});

describe("createAgentModelsRoutes — GET /agent-models page", () => {
  test("renders the page with agent rows", async () => {
    const { deps, cleanup } = stubDeps(listHandlers());
    const app = createAgentModelsRoutes(deps);
    const res = await app.request("http://localhost/agent-models");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Agent Models");
    expect(html).toContain("plan");
    expect(html).toContain("kimi-k3");
    expect(html).toContain("Use automatic model");
    expect(html).toContain("Suggestion providers");
    expect(html).toContain("All providers");
    expect(html).toContain("Generate suggestions");
    expect(html).toContain("Generating model suggestions");
    expect(html).toContain("Checking provider models and preparing pending changes");
    cleanup();
  });

  test("renders the prerequisite warning when password is absent", async () => {
    const { deps, cleanup } = stubDeps(listHandlers(), null);
    const app = createAgentModelsRoutes(deps);
    const res = await app.request("http://localhost/agent-models");
    const html = await res.text();
    expect(html).toContain("Prerequisite missing");
    cleanup();
  });
});

describe("createAgentModelsRoutes — POST /api/agent-models/suggestions", () => {
  test("returns suggestions restricted to the selected provider", async () => {
    const { deps, calls, cleanup } = stubDeps(listHandlers());
    const app = createAgentModelsRoutes(deps);
    const res = await app.request("http://localhost/api/agent-models/suggestions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providers: ["opencode-go"] }),
    });
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.providers).toEqual(["openai", "opencode-go"]);
    for (const entries of Object.values(data.suggestions) as Array<Array<{ model: string }>>) {
      expect(entries[0]?.model.startsWith("opencode-go/")).toBe(true);
    }
    expect(calls.some((call) => call.includes(".agents[$agent]"))).toBe(false);
    cleanup();
  });

  test("defaults to all connected providers", async () => {
    const { deps, cleanup } = stubDeps(listHandlers());
    const app = createAgentModelsRoutes(deps);
    const res = await app.request("http://localhost/api/agent-models/suggestions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    expect(res.status).toBe(200);
    for (const entries of Object.values(data.suggestions) as Array<Array<{ model: string }>>) {
      expect(["openai/gpt-5.6-sol", "opencode-go/kimi-k3"]).toContain(entries[0]?.model);
    }
    cleanup();
  });

  test("rejects an unknown provider without writing config", async () => {
    const { deps, calls, cleanup } = stubDeps(listHandlers());
    const app = createAgentModelsRoutes(deps);
    const res = await app.request("http://localhost/api/agent-models/suggestions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providers: ["missing"] }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("not connected");
    expect(calls.some((call) => call.includes(".agents[$agent]"))).toBe(false);
    cleanup();
  });

  test("rejects malformed provider selection", async () => {
    const { deps, cleanup } = stubDeps([]);
    const res = await createAgentModelsRoutes(deps).request("http://localhost/api/agent-models/suggestions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providers: [42] }),
    });
    expect(res.status).toBe(400);
    cleanup();
  });
});

describe("createAgentModelsRoutes — verification mode", () => {
  test("rejects invalid verification with 400 for single-agent Apply", async () => {
    const { deps, cleanup } = stubDeps([
      { match: /jq -c '\.agents/, stdout: '{"plan":{}}' },
      { match: /connected-providers\.json/, stdout: '{"connected":["opencode"]}' },
      { match: /provider-models\.json/, stdout: "opencode/big-pickle\n" },
      { match: /\/agent\b/, stdout: JSON.stringify([{ name: "plan", mode: "subagent", model: { modelID: "big-pickle", providerID: "opencode" } }]) },
    ]);
    const app = createAgentModelsRoutes(deps);
    const res = await app.request("http://localhost/api/agent-models/plan", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: [{ model: "opencode/big-pickle" }], verification: "bad" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("verification");
    cleanup();
  });

  test("rejects invalid verification with 400 for batch Apply", async () => {
    const { deps, cleanup } = stubDeps([
      { match: /jq -c '\.agents/, stdout: '{"plan":{}}' },
      { match: /connected-providers\.json/, stdout: '{"connected":["opencode"]}' },
      { match: /provider-models\.json/, stdout: "opencode/big-pickle\n" },
      { match: /\/agent\b/, stdout: JSON.stringify([{ name: "plan", mode: "subagent", model: { modelID: "big-pickle", providerID: "opencode" } }]) },
    ]);
    const app = createAgentModelsRoutes(deps);
    const res = await app.request("http://localhost/api/agent-models", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ changes: [{ agent: "plan", entries: [{ model: "opencode/big-pickle" }] }], verification: "invalid" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("verification");
    cleanup();
  });

  test("readiness batch Apply issues zero model-message calls", async () => {
    const { deps, calls, cleanup } = stubDeps([
      { match: /jq -c '\.agents/, stdout: '{"plan":{}}' },
      { match: /connected-providers\.json/, stdout: '{"connected":["opencode"]}' },
      { match: /provider-models\.json/, stdout: "opencode/big-pickle\n" },
      { match: /cat ~\/\.config\/opencode\/oh-my-opencode-slim\.json/, stdout: '{"agents":{}}' },
      { match: /\.agents\[\$agent\]\.model = \$model/, stdout: "" },
      { match: /\/agent\b/, stdout: JSON.stringify([{ name: "plan", mode: "subagent", model: { modelID: "big-pickle", providerID: "opencode" } }]) },
    ]);
    const app = createAgentModelsRoutes(deps);
    const res = await app.request("http://localhost/api/agent-models", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ changes: [{ agent: "plan", entries: [{ model: "opencode/big-pickle" }] }] }),
    });
    expect(res.status).toBe(200);
    expect(calls.some((c) => c.includes("POST") && c.includes("/session/") && c.includes("message"))).toBe(false);
    expect(calls.some((c) => c.includes("title:\"model availability probe\""))).toBe(false);
    expect(calls.some((c) => c.includes("POST") && c.includes("/session/") && c.includes("/message"))).toBe(false);
    cleanup();
  });

  test("empty batch Apply is a no-op without execution", async () => {
    const { deps, calls, cleanup } = stubDeps([], null);
    const res = await createAgentModelsRoutes(deps).request("http://localhost/api/agent-models", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ changes: [] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: {} });
    expect(calls).toEqual([]);
    cleanup();
  });
});

describe("createAgentModelsRoutes — POST /api/agent-models/verify", () => {
  test("verifies all configured agents by default and returns shape with summary", async () => {
    const { deps, calls, cleanup } = stubDeps([
      { match: /jq -c '\.agents/, stdout: '{"plan":{"model":"opencode/big-pickle"},"explore":{"model":"opencode/big-pickle"}}' },
      { match: /connected-providers\.json/, stdout: '{"connected":["opencode"]}' },
      { match: /provider-models\.json/, stdout: "opencode/big-pickle\n" },
      {
        match: /\/agent\b/,
        stdout: JSON.stringify([
          { name: "plan", mode: "subagent", model: { modelID: "big-pickle", providerID: "opencode" } },
          { name: "explore", mode: "subagent", model: { modelID: "big-pickle", providerID: "opencode" } },
        ]),
      },
      { match: /\$BASE\/session/, stdout: JSON.stringify({ info: { role: "assistant", modelID: "big-pickle", providerID: "opencode", parts: [{ type: "text", text: "OK" }] } }) },
    ]);
    const app = createAgentModelsRoutes(deps);
    const res = await app.request("http://localhost/api/agent-models/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { verification: string; results: Record<string, { model: string | null; status: string; reason?: string; verification: string }>; summary: { total: number; healthy: number; unconfigured: number; failed: number; verification: string } };
    expect(data.verification).toBe("inference");
    expect(Object.keys(data.results).sort()).toEqual(["explore", "plan"]);
    for (const entry of Object.values(data.results)) {
      expect(entry.model).toBe("opencode/big-pickle");
      expect(entry.status).toBe("healthy");
      expect(entry.verification).toBe("inference");
    }
    expect(data.summary).toEqual({ total: 2, healthy: 2, unconfigured: 0, failed: 0, verification: "inference" });
    expect(calls.some((c) => c.includes(".agents[$agent].model = $model"))).toBe(false);
    expect(calls.some((c) => c.includes("native-agent-overrides"))).toBe(false);
    cleanup();
  });

  test("verifies selected single agent without touching others", async () => {
    const { deps, calls, cleanup } = stubDeps([
      { match: /jq -c '\.agents/, stdout: '{"plan":{"model":"opencode/big-pickle"},"explore":{"model":"opencode/big-pickle"}}' },
      { match: /connected-providers\.json/, stdout: '{"connected":["opencode"]}' },
      { match: /provider-models\.json/, stdout: "opencode/big-pickle\n" },
      {
        match: /\/agent\b/,
        stdout: JSON.stringify([
          { name: "plan", mode: "subagent", model: { modelID: "big-pickle", providerID: "opencode" } },
          { name: "explore", mode: "subagent", model: { modelID: "big-pickle", providerID: "opencode" } },
        ]),
      },
      { match: /\$BASE\/session/, stdout: JSON.stringify({ info: { role: "assistant", modelID: "big-pickle", providerID: "opencode", parts: [{ type: "text", text: "OK" }] } }) },
    ]);
    const app = createAgentModelsRoutes(deps);
    const res = await app.request("http://localhost/api/agent-models/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agents: ["plan"] }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { results: Record<string, unknown> };
    expect(Object.keys(data.results)).toEqual(["plan"]);
    expect((data.results["plan"] as { model: string }).model).toBe("opencode/big-pickle");
    const probeCalls = calls.filter((c) => c.includes("model availability probe"));
    expect(probeCalls.length).toBeGreaterThan(0);
    cleanup();
  });

  test("returns unconfigured without probing for agent without primary model", async () => {
    const { deps, calls, cleanup } = stubDeps([
      { match: /jq -c '\.agents/, stdout: '{"plan":{"model":"opencode/big-pickle"},"general":{}}' },
      { match: /connected-providers\.json/, stdout: '{"connected":["opencode"]}' },
      { match: /provider-models\.json/, stdout: "opencode/big-pickle\n" },
      {
        match: /\/agent\b/,
        stdout: JSON.stringify([
          { name: "plan", mode: "subagent", model: { modelID: "big-pickle", providerID: "opencode" } },
          { name: "general", mode: "subagent", model: null },
        ]),
      },
    ]);
    const app = createAgentModelsRoutes(deps);
    const res = await app.request("http://localhost/api/agent-models/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agents: ["general"] }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { results: Record<string, { model: string | null; status: string; reason?: string }>; summary: { unconfigured: number } };
    expect(data.results["general"].model).toBeNull();
    expect(data.results["general"].status).toBe("unconfigured");
    expect(data.results["general"].reason).toContain("no configured");
    expect(data.summary.unconfigured).toBe(1);
    expect(calls.some((c) => c.includes("model availability probe"))).toBe(false);
    cleanup();
  });

  test("deduplicates probe for agents sharing the same model", async () => {
    const probeMarker = "$BASE/session";
    const { deps, calls, cleanup } = stubDeps([
      { match: /jq -c '\.agents/, stdout: '{"plan":{"model":"opencode/big-pickle"},"explore":{"model":"opencode/big-pickle"}}' },
      { match: /connected-providers\.json/, stdout: '{"connected":["opencode"]}' },
      { match: /provider-models\.json/, stdout: "opencode/big-pickle\n" },
      {
        match: /\/agent\b/,
        stdout: JSON.stringify([
          { name: "plan", mode: "subagent", model: { modelID: "big-pickle", providerID: "opencode" } },
          { name: "explore", mode: "subagent", model: { modelID: "big-pickle", providerID: "opencode" } },
        ]),
      },
      { match: /\$BASE\/session/, stdout: JSON.stringify({ info: { role: "assistant", modelID: "big-pickle", providerID: "opencode", parts: [{ type: "text", text: "OK" }] } }) },
    ]);
    const app = createAgentModelsRoutes(deps);
    const res = await app.request("http://localhost/api/agent-models/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agents: ["plan", "explore"] }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { results: Record<string, { status: string }> };
    expect(data.results["plan"].status).toBe("healthy");
    expect(data.results["explore"].status).toBe("healthy");
    const sessionCalls = calls.filter((c) => c.includes(probeMarker));
    const healthCacheReads = calls.filter((c) => c.includes("agent-model-health.json"));
    expect(sessionCalls.length).toBeGreaterThan(0);
    const distinctProbeBuilds = calls.filter((c) => c.includes("model availability probe")).length;
    expect(distinctProbeBuilds).toBe(1);
    expect(healthCacheReads.length).toBeGreaterThan(0);
    cleanup();
  });

  test("is read-only: does not write config or restart and oh-my-opencode-slim.json is byte-identical before and after", async () => {
    const beforeSnapshot = '{"plan":{"model":"opencode/big-pickle"}}';
    const { deps, calls, cleanup } = stubDeps([
      { match: /jq -c '\.agents/, stdout: beforeSnapshot },
      { match: /connected-providers\.json/, stdout: '{"connected":["opencode"]}' },
      { match: /provider-models\.json/, stdout: "opencode/big-pickle\n" },
      {
        match: /\/agent\b/,
        stdout: JSON.stringify([{ name: "plan", mode: "subagent", model: { modelID: "big-pickle", providerID: "opencode" } }]),
      },
      { match: /\$BASE\/session/, stdout: JSON.stringify({ info: { role: "assistant", modelID: "big-pickle", providerID: "opencode", parts: [{ type: "text", text: "OK" }] } }) },
      { match: /cat ~\/\.config\/opencode\/oh-my-opencode-slim\.json/, stdout: beforeSnapshot },
    ]);
    let restarted = false;
    const guardedDeps = { ...deps, restart: async () => { restarted = true; return { ok: true as const }; } };
    const app = createAgentModelsRoutes(guardedDeps);
    const beforeCalls = calls.length;
    const res = await app.request("http://localhost/api/agent-models/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agents: ["plan"] }),
    });
    expect(res.status).toBe(200);
    expect(restarted).toBe(false);
    expect(calls.some((c) => c.includes(".agents[$agent].model = $model"))).toBe(false);
    expect(calls.some((c) => c.includes("native-agent-overrides"))).toBe(false);
    expect(calls.some((c) => c.includes("mktemp /tmp/omo.jsonc.snapshot"))).toBe(false);
    const afterConfigCalls = calls.filter((c) => c.includes("jq -c '.agents"));
    expect(afterConfigCalls.length).toBeGreaterThan(0);
    for (const call of afterConfigCalls) {
      expect(call).not.toContain("write");
    }
    const secondRead = await guardedDeps.exec("jq -c '.agents // {}' ~/.config/opencode/oh-my-opencode-slim.json 2>/dev/null || echo '{}'", 10_000);
    expect(secondRead.stdout).toBe(beforeSnapshot);
    void beforeCalls;
    cleanup();
  });

  test("rejects invalid agents selection with 400", async () => {
    const { deps, calls, cleanup } = stubDeps([
      { match: /jq -c '\.agents/, stdout: '{"plan":{"model":"opencode/big-pickle"}}' },
      { match: /connected-providers\.json/, stdout: '{"connected":["opencode"]}' },
      { match: /provider-models\.json/, stdout: "opencode/big-pickle\n" },
      { match: /\/agent\b/, stdout: JSON.stringify([{ name: "plan", mode: "subagent", model: { modelID: "big-pickle", providerID: "opencode" } }]) },
    ]);
    const app = createAgentModelsRoutes(deps);
    const res = await app.request("http://localhost/api/agent-models/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agents: ["unknown-agent"] }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("configurable live subagent");
    expect(calls.some((c) => c.includes("model availability probe"))).toBe(false);
    cleanup();
  });

  test("rejects malformed agents array and invalid verification with 400", async () => {
    const { deps, cleanup } = stubDeps([]);
    const app = createAgentModelsRoutes(deps);
    const badAgents = await app.request("http://localhost/api/agent-models/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agents: "plan" }),
    });
    expect(badAgents.status).toBe(400);
    expect((await badAgents.json()).error).toContain("agents must be");
    const badVerification = await app.request("http://localhost/api/agent-models/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verification: "bad" }),
    });
    expect(badVerification.status).toBe(400);
    expect((await badVerification.json()).error).toContain("verification");
    const badName = await app.request("http://localhost/api/agent-models/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agents: ["BAD NAME"] }),
    });
    expect(badName.status).toBe(400);
    cleanup();
  });

  test("enforces bounded target count with 400 when exceeding probe budget", async () => {
    const manyAgents = Array.from({ length: 13 }, (_, i) => `agent${i}`);
    const config: Record<string, { model: string }> = {};
    const liveAgents: Array<{ name: string; mode: string; model: { modelID: string; providerID: string } }> = [];
    for (const agent of manyAgents) {
      config[agent] = { model: `opencode/model-${agent}` };
      liveAgents.push({ name: agent, mode: "subagent", model: { modelID: `model-${agent}`, providerID: "opencode" } });
    }
    const { deps, cleanup } = stubDeps([
      { match: /jq -c '\.agents/, stdout: JSON.stringify(config) },
      { match: /connected-providers\.json/, stdout: '{"connected":["opencode"]}' },
      { match: /provider-models\.json/, stdout: manyAgents.map((a) => `opencode/model-${a}`).join("\n") + "\n" },
      { match: /\/agent\b/, stdout: JSON.stringify(liveAgents) },
    ]);
    const app = createAgentModelsRoutes(deps);
    const res = await app.request("http://localhost/api/agent-models/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agents: manyAgents }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("exceeds limit");
    cleanup();
  });

  test("readiness verification does not issue inference probes", async () => {
    const { deps, calls, cleanup } = stubDeps([
      { match: /jq -c '\.agents/, stdout: '{"plan":{"model":"opencode/big-pickle"}}' },
      { match: /connected-providers\.json/, stdout: '{"connected":["opencode"]}' },
      { match: /provider-models\.json/, stdout: "opencode/big-pickle\n" },
      { match: /\/agent\b/, stdout: JSON.stringify([{ name: "plan", mode: "subagent", model: { modelID: "big-pickle", providerID: "opencode" } }]) },
    ]);
    const app = createAgentModelsRoutes(deps);
    const res = await app.request("http://localhost/api/agent-models/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agents: ["plan"], verification: "readiness" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { verification: string; results: Record<string, { verification: string }> };
    expect(data.verification).toBe("readiness");
    expect(data.results["plan"].verification).toBe("readiness");
    expect(calls.some((c) => c.includes("model availability probe"))).toBe(false);
    cleanup();
  });

  test("defaults to inference when body is empty and handles explicit inference", async () => {
    const { deps, cleanup } = stubDeps([
      { match: /jq -c '\.agents/, stdout: '{"plan":{"model":"opencode/big-pickle"}}' },
      { match: /connected-providers\.json/, stdout: '{"connected":["opencode"]}' },
      { match: /provider-models\.json/, stdout: "opencode/big-pickle\n" },
      { match: /\/agent\b/, stdout: JSON.stringify([{ name: "plan", mode: "subagent", model: { modelID: "big-pickle", providerID: "opencode" } }]) },
      { match: /\$BASE\/session/, stdout: JSON.stringify({ info: { role: "assistant", modelID: "big-pickle", providerID: "opencode", parts: [{ type: "text", text: "OK" }] } }) },
    ]);
    const app = createAgentModelsRoutes(deps);
    const empty = await app.request("http://localhost/api/agent-models/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(200);
    expect((await empty.json() as { verification: string }).verification).toBe("inference");
    const explicit = await app.request("http://localhost/api/agent-models/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agents: ["plan"], verification: "inference" }),
    });
    expect(explicit.status).toBe(200);
    expect((await explicit.json() as { verification: string }).verification).toBe("inference");
    cleanup();
  });
});
