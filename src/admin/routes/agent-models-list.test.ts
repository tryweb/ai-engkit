import { describe, expect, test } from "bun:test";
import { createAgentModelsRoutes } from "./agent-models";
import { listHandlers, stubDeps } from "./agent-models-test-support";
import { CONFIGURABLE_NATIVE_AGENTS } from "../lib/agent-model-types";

describe("createAgentModelsRoutes — GET /api/agent-models", () => {
  test("keeps the GET response shape and exposes a native chain in configured", async () => {
    const routing = JSON.stringify({
      version: 1,
      chains: {
        plan: { chain: [{ model: "opencode-go/kimi-k3" }, { model: "opencode/big-pickle" }] },
      },
    });
    const handlers = [
      { match: /jq -c '\.'/, stdout: routing },
      ...listHandlers(),
      {
        match: /\/agent\b/,
        stdout: JSON.stringify([
          { name: "plan", mode: "subagent", model: { modelID: "kimi-k3", providerID: "opencode-go" } },
        ]),
      },
    ];
    const { deps, cleanup } = stubDeps(handlers, { routingEnabled: true });

    const response = await createAgentModelsRoutes(deps).request("http://localhost/api/agent-models");
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(Object.keys(data).sort()).toEqual(["agents", "catalog", "catalogAvailable", "hasPassword", "providers"]);
    expect(data.agents[0].configured).toEqual([
      { model: "opencode-go/kimi-k3" },
      { model: "opencode/big-pickle" },
    ]);
    expect(CONFIGURABLE_NATIVE_AGENTS).toHaveLength(13);
    expect(CONFIGURABLE_NATIVE_AGENTS).toContain("general");
    expect(CONFIGURABLE_NATIVE_AGENTS).toContain("multimodal-looker");
    expect(CONFIGURABLE_NATIVE_AGENTS).toContain("sisyphus-junior");
    cleanup();
  });

  test("returns configured live subagents and excludes primary agents", async () => {
    const { deps, cleanup } = stubDeps(listHandlers());
    const res = await createAgentModelsRoutes(deps).request("http://localhost/api/agent-models");
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.hasPassword).toBe(true);

    const plan = data.agents.find((agent: { name: string }) => agent.name === "plan");
    expect(plan.configured).toEqual([{ model: "opencode-go/kimi-k3", variant: "max" }]);
    expect(plan.resolved).toEqual({ modelID: "kimi-k3", providerID: "opencode-go" });
    expect(plan.source).toBe("configured");
    expect(plan.invalid).toBe(false);
    expect(plan.effectiveness).toBe("effective");
    expect(data.agents.find((agent: { name: string }) => agent.name === "oracle")).toBeUndefined();
    expect(data.catalog).toEqual(["openai/gpt-5.6-sol", "opencode-go/kimi-k3"]);
    cleanup();
  });

  test("flags agents whose config has unrecognized keys as invalid", async () => {
    const { deps, cleanup } = stubDeps([
      {
        match: /jq -c '\.agents/,
        stdout:
          '{"explore":{"permission":{"bash":"allow"},"model":"opencode-go/kimi-k3"},"plan":{"model":"opencode-go/kimi-k3"}}',
      },
      { match: /connected-providers\.json/, stdout: '{"connected":["opencode-go"]}' },
      { match: /provider-models\.json/, stdout: "opencode-go/kimi-k3\n" },
      {
        match: /\/agent\b/,
        stdout: JSON.stringify([
          { name: "explore", mode: "subagent", model: { modelID: "kimi-k3", providerID: "opencode-go" } },
          { name: "plan", mode: "subagent", model: { modelID: "kimi-k3", providerID: "opencode-go" } },
        ]),
      },
    ]);
    const res = await createAgentModelsRoutes(deps).request("http://localhost/api/agent-models");
    const data = await res.json();
    const explore = data.agents.find((agent: { name: string }) => agent.name === "explore");
    expect(explore.invalid).toBe(true);
    expect(explore.configured).toEqual([{ model: "opencode-go/kimi-k3" }]);
    expect(explore.effectiveness).toBe("invalid");
    expect(data.agents.find((agent: { name: string }) => agent.name === "plan").invalid).toBe(false);
    cleanup();
  });

  test("reports runtime mismatch when configured and live primary models differ", async () => {
    const { deps, calls, cleanup } = stubDeps([
      { match: /jq -c '\.agents/, stdout: '{"librarian":{"model":"opencode/nemotron-3.5-lightning-free"}}' },
      {
        match: /\/provider\b/,
        stdout: JSON.stringify({
          connected: ["opencode", "opencode-go"],
          all: [
            { id: "opencode", models: { "nemotron-3.5-lightning-free": {} } },
            { id: "opencode-go", models: { "qwen3.7-plus": {} } },
          ],
        }),
      },
      {
        match: /provider-models\.json/,
        stdout: "opencode/nemotron-3.5-lightning-free\nopencode-go/qwen3.7-plus\n",
      },
      {
        match: /\/agent\b/,
        stdout: JSON.stringify([
          { name: "librarian", mode: "subagent", model: { modelID: "qwen3.7-plus", providerID: "opencode-go" } },
        ]),
      },
      {
        match: /\/session/,
        stdout: JSON.stringify([{ agent: "librarian", modelID: "qwen3.7-plus", providerID: "opencode-go", completedAt: 1 }]),
      },
    ]);
    const res = await createAgentModelsRoutes(deps).request("http://localhost/api/agent-models");
    const data = await res.json();
    const librarian = data.agents.find((agent: { name: string }) => agent.name === "librarian");
    expect(librarian.effectiveness).toBe("runtime_mismatch");
    cleanup();
  });


  test("reports awaiting request when assignment matches but recent request metadata is stale", async () => {
    // Given: the runtime assignment matches config, while the latest retained request used an older model.
    const { deps, cleanup } = stubDeps([
      { match: /jq -c '\.agents/, stdout: '{"momus":{"model":"opencode/big-pickle"}}' },
      {
        match: /\/provider\b/,
        stdout: JSON.stringify({
          connected: ["opencode"],
          all: [{ id: "opencode", models: { "big-pickle": {} } }],
        }),
      },
      {
        match: /\/agent\b/,
        stdout: JSON.stringify([
          { name: "Momus - Plan Reviewer", mode: "subagent", model: { modelID: "big-pickle", providerID: "opencode" } },
        ]),
      },
      {
        match: /\/session/,
        stdout: JSON.stringify([{ agent: "momus", modelID: "nemotron-old", providerID: "nvidia", completedAt: 1 }]),
      },
    ]);

    // When: the list endpoint reconciles configured, assigned, and retained request state.
    const response = await createAgentModelsRoutes(deps).request("http://localhost/api/agent-models");
    const data = await response.json();
    const momus = data.agents.find((agent: { name: string }) => agent.name === "momus");

    // Then: stale history does not turn a confirmed assignment into a mismatch.
    expect(momus.effectiveness).toBe("awaiting_request");
    expect(momus.providerConnected).toBe(true);
    cleanup();
  });

  test("maps display names back to config keys", async () => {
    const { deps, cleanup } = stubDeps([
      { match: /jq -c '\.agents/, stdout: '{"sisyphus":{},"atlas":{}}' },
      { match: /connected-providers\.json/, stdout: '{"connected":["opencode-go"]}' },
      { match: /provider-models\.json/, stdout: "opencode-go/kimi-k3\n" },
      {
        match: /\/agent\b/,
        stdout: JSON.stringify([
          { name: "Sisyphus - ultraworker", mode: "subagent", model: { modelID: "kimi-k3", providerID: "opencode-go" } },
          { name: "Atlas - Plan Executor", mode: "subagent", model: { modelID: "claude-sonnet-5", providerID: "anthropic" } },
          { name: "build", mode: "primary", model: null },
        ]),
      },
    ]);
    const data = await (await createAgentModelsRoutes(deps).request("http://localhost/api/agent-models")).json();
    expect(data.agents.find((agent: { name: string }) => agent.name === "sisyphus").resolved).toEqual({
      modelID: "kimi-k3",
      providerID: "opencode-go",
    });
    expect(data.agents.find((agent: { name: string }) => agent.name === "atlas").resolved).toEqual({
      modelID: "claude-sonnet-5",
      providerID: "anthropic",
    });
    expect(data.agents.some((agent: { name: string }) => agent.name === "build")).toBe(false);
    cleanup();
  });

  test("includes configurable native subagents but excludes internal agents", async () => {
    const { deps, cleanup } = stubDeps([
      { match: /jq -c '\.agents/, stdout: '{"explore":{}}' },
      { match: /connected-providers\.json/, stdout: '{"connected":["openai"]}' },
      { match: /provider-models\.json/, stdout: "openai/gpt-5.6-luna-fast\n" },
      {
        match: /\/agent\b/,
        stdout: JSON.stringify([
          { name: "general", mode: "subagent", model: null },
          { name: "build", mode: "subagent", model: null },
          { name: "compaction", mode: "subagent", model: null },
          { name: "summary", mode: "subagent", model: null },
          { name: "title", mode: "subagent", model: null },
          { name: "explore", mode: "subagent", model: { modelID: "gpt-5.6-luna-fast", providerID: "openai" } },
        ]),
      },
      {
        match: /\/api\/session/,
        stdout: JSON.stringify([{ agent: "general", modelID: "big-pickle", providerID: "opencode", completedAt: 1 }]),
      },
    ]);
    const data = await (await createAgentModelsRoutes(deps).request("http://localhost/api/agent-models")).json();
    const names = data.agents.map((agent: { name: string }) => agent.name);
    expect(names).toContain("general");
    expect(names).toContain("explore");
    const general = data.agents.find((agent: { name: string }) => agent.name === "general");
    expect(general.configured).toEqual([]);
    expect(general.resolved).toBeNull();
    expect(general.requestVerified).toBeNull();
    expect(general.effectiveness).toBe("plugin");
    expect(names).not.toContain("build");
    expect(names).not.toContain("compaction");
    expect(names).not.toContain("summary");
    expect(names).not.toContain("title");
    cleanup();
  });

  test("degraded mode omits resolved models when password is absent", async () => {
    const { deps, calls, cleanup } = stubDeps(listHandlers(), null);
    const data = await (await createAgentModelsRoutes(deps).request("http://localhost/api/agent-models")).json();
    expect(data.hasPassword).toBe(false);
    for (const agent of data.agents) expect(agent.resolved).toBeNull();
    expect(calls.some((command) => command.includes("/agent"))).toBe(false);
    cleanup();
  });
});
