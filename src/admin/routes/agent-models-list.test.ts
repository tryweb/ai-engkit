import { describe, expect, test } from "bun:test";
import { createAgentModelsRoutes } from "./agent-models";
import { nativeFixture } from "./agent-models-test-support";
import { V2_SUBAGENT_AGENTS } from "../lib/agent-model-types";

describe("native V2 agent-model list", () => {
  test("reads configured chains, request state and excludes primary/mechanism agents", async () => {
    const ctx = nativeFixture();
    const res = await createAgentModelsRoutes(ctx.deps).request("http://localhost/api/agent-models");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.agents.map((a: { name: string }) => a.name)).toEqual([...V2_SUBAGENT_AGENTS].sort());
    expect(data.agents.find((a: { name: string }) => a.name === "general")).toMatchObject({
      configured: [{ model: "opencode/big-pickle" }], source: "configured", effectiveness: "effective",
      resolved: { modelID: "big-pickle", providerID: "opencode" },
    });
    expect(data.catalog).toEqual(["opencode/big-pickle"]);
    expect(ctx.calls.some((c) => c.includes(".omo"))).toBe(false);
  });

  test.each([
    { requestModel: null, effectiveness: "awaiting_request" },
    { requestModel: "opencode/big-pickle", effectiveness: "effective" },
    { requestModel: "opencode/stale", effectiveness: "runtime_mismatch" },
  ])("request $requestModel produces $effectiveness", async ({ requestModel, effectiveness }) => {
    const ctx = nativeFixture({ requestModel });
    const data = await (await createAgentModelsRoutes(ctx.deps).request("http://localhost/api/agent-models")).json();
    expect(data.agents.find((a: { name: string }) => a.name === "general").effectiveness).toBe(effectiveness);
  });

  test("primary and hidden chains never become configurable subagent rows", async () => {
    const ctx = nativeFixture({ routing: { version: 1, chains: { build: { chain: [{ model: "opencode/big-pickle" }] }, plan: { chain: [{ model: "opencode/big-pickle" }] } } } });
    const data = await (await createAgentModelsRoutes(ctx.deps).request("http://localhost/api/agent-models")).json();
    expect(data.agents.some((a: { name: string }) => ["build", "plan"].includes(a.name))).toBe(false);
  });

  test("without credentials omits live assignment and request metadata", async () => {
    const ctx = nativeFixture({ password: null });
    const data = await (await createAgentModelsRoutes(ctx.deps).request("http://localhost/api/agent-models")).json();
    expect(data.hasPassword).toBe(false);
    expect(data.agents.every((a: { resolved: unknown }) => a.resolved === null)).toBe(true);
    expect(ctx.calls.some((c) => c.includes("/api/agent"))).toBe(false);
  });
});
