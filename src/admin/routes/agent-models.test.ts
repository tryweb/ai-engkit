import { describe, expect, test } from "bun:test";
import { createAgentModelsRoutes } from "./agent-models";
import { nativeFixture } from "./agent-models-test-support";

function request(ctx: ReturnType<typeof nativeFixture>, path: string, body: unknown, method = "PUT") {
  return createAgentModelsRoutes(ctx.deps).request(`http://localhost${path}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
const entries = [{ model: "opencode/big-pickle" }];

describe("native V2 agent model writes", () => {
  test("writes a native chain, reports configured and pins the agent", async () => {
    const ctx = nativeFixture({ routing: { version: 1, chains: {} } });
    const res = await request(ctx, "/api/agent-models/librarian", { entries });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "configured", requestVerified: null });
    expect(ctx.restarts).toBe(1);
    expect(ctx.calls.some((c) => c.includes(".chains[$agent].chain"))).toBe(true);
    expect(ctx.calls.some((c) => c.includes("agent-model-pinned.json.tmp"))).toBe(true);
    expect(ctx.calls.some((c) => c.includes(".omo"))).toBe(false);
  });

  test.each(["entries", "chain"])("accepts a fallback chain via %s", async (key) => {
    const ctx = nativeFixture({ routing: { version: 1, chains: {} } });
    const res = await request(ctx, "/api/agent-models/librarian", { [key]: [...entries, ...entries] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "configured" });
  });

  test("clears an existing native chain and removes its pin", async () => {
    const ctx = nativeFixture();
    const res = await request(ctx, "/api/agent-models/general", { entries: [] });
    expect(await res.json()).toMatchObject({ ok: true, status: "cleared" });
    expect(ctx.calls.some((c) => c.includes("del(.chains[$agent])"))).toBe(true);
    expect(ctx.calls.some((c) => c.includes("agent-model-pinned.json.tmp"))).toBe(true);
  });

  test.each([null, [], {}, { entries: "bad" }, { entries: [{ model: "bad" }] }, { entries: [{ model: "opencode/big-pickle", variant: 3 }] }, { entries: Array(11).fill(entries[0]) }, { entries, verification: "bad" }])("rejects invalid payload %j before writing", async (body) => {
    const ctx = nativeFixture();
    expect((await request(ctx, "/api/agent-models/general", body)).status).toBe(400);
    expect(ctx.restarts).toBe(0);
    expect(ctx.calls.some((c) => c.includes(".chains[$agent].chain"))).toBe(false);
  });

  test("rejects models outside the native catalog", async () => {
    const ctx = nativeFixture();
    expect((await request(ctx, "/api/agent-models/general", { entries: [{ model: "missing/model" }] })).status).toBe(400);
    expect(ctx.restarts).toBe(0);
  });

  test.each(["plan", "build", "unknown"])("rejects non-configurable agent %s", async (agent) => {
    const ctx = nativeFixture();
    expect((await request(ctx, `/api/agent-models/${agent}`, { entries })).status).toBe(403);
    expect(ctx.restarts).toBe(0);
  });

  test("rejects writes without credentials", async () => {
    const ctx = nativeFixture({ password: null });
    expect((await request(ctx, "/api/agent-models/general", { entries })).status).toBe(409);
  });

  test("write failures are reported and do not restart or pin", async () => {
    const ctx = nativeFixture({ routing: { version: 1, chains: {} }, failWrite: true });
    const res = await request(ctx, "/api/agent-models/librarian", { entries });
    expect(await res.json()).toMatchObject({ ok: false, status: "write_failed", error: "jq routing write failed" });
    expect(ctx.restarts).toBe(0);
    expect(ctx.calls.some((c) => c.includes("agent-model-pinned.json.tmp"))).toBe(false);
  });

  test("batch changes snapshot and restart once without inference by default", async () => {
    const ctx = nativeFixture({ routing: { version: 1, chains: {} } });
    const res = await request(ctx, "/api/agent-models", { changes: ["general", "explore"].map((agent) => ({ agent, entries })) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ results: { general: { status: "configured" }, explore: { status: "configured" } } });
    expect(ctx.restarts).toBe(1);
    expect(ctx.calls.filter((c) => c.includes("snap_r="))).toHaveLength(1);
    expect(ctx.calls.some((c) => c.includes('AGENT='))).toBe(false);
  });

  test.each([null, {}, { changes: [null] }, { changes: [{ agent: "invalid/name", entries }] }, { changes: [{ agent: "general", entries: "bad" }] }])("rejects invalid batch %j", async (body) => {
    const ctx = nativeFixture();
    expect((await request(ctx, "/api/agent-models", body)).status).toBe(400);
    expect(ctx.restarts).toBe(0);
  });

  test("empty batch is a no-op", async () => {
    const ctx = nativeFixture();
    expect(await (await request(ctx, "/api/agent-models", { changes: [] })).json()).toEqual({ results: {} });
    expect(ctx.calls).toHaveLength(0);
  });
});

describe("native V2 read-only verification", () => {
  test.each([undefined, "inference", "readiness"])("verification %j returns the appropriate state without writing or restarting", async (verification) => {
    const ctx = nativeFixture();
    const before = JSON.stringify(ctx.routing);
    const res = await request(ctx, "/api/agent-models/verify", { verification }, "POST");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Object.keys(data.results).sort()).toEqual(["explore", "general"]);
    const inference = verification !== "readiness";
    expect(data.summary).toMatchObject({ total: 2, healthy: inference ? 2 : 0, configured: inference ? 0 : 2, failed: 0 });
    expect(ctx.restarts).toBe(0);
    expect(ctx.calls.some((c) => c.includes("snap_r=") || c.includes(".chains[$agent].chain") || c.includes("agent-model-pinned.json.tmp"))).toBe(false);
    expect(ctx.calls.filter((c) => c.includes("AGENT="))).toHaveLength(inference ? 2 : 0);
    expect(JSON.stringify(ctx.routing)).toBe(before);
  });

  test("duplicate selected agents execute only one request, while different agents remain independently verified", async () => {
    const ctx = nativeFixture();
    const res = await request(ctx, "/api/agent-models/verify", { agents: ["general", "general"] }, "POST");
    expect(Object.keys((await res.json()).results)).toEqual(["general"]);
    expect(ctx.calls.filter((c) => c.includes("AGENT="))).toHaveLength(1);
  });

  test.each([null, "other/model"])("request result %j is not reported healthy", async (requestModel) => {
    const ctx = nativeFixture({ requestModel });
    const res = await request(ctx, "/api/agent-models/verify", { agents: ["general"] }, "POST");
    expect((await res.json()).summary.failed).toBe(1);
    expect(ctx.restarts).toBe(0);
  });

  test("unconfigured agents do not trigger inference", async () => {
    const ctx = nativeFixture({ routing: { version: 1, chains: {} } });
    const res = await request(ctx, "/api/agent-models/verify", { agents: ["general"] }, "POST");
    expect(await res.json()).toMatchObject({ results: { general: { status: "unconfigured", model: null } } });
    expect(ctx.calls.some((c) => c.includes("AGENT="))).toBe(false);
  });

  test.each([{ agents: "general" }, { agents: ["bad/name"] }, { agents: ["plan"] }, { verification: "bad" }, []].map((body) => ({ body })))("rejects invalid selection $body", async ({ body }) => {
    const ctx = nativeFixture();
    expect((await request(ctx, "/api/agent-models/verify", body, "POST")).status).toBe(400);
  });

  test("verification without credentials returns 409", async () => {
    const ctx = nativeFixture({ password: null });
    expect((await request(ctx, "/api/agent-models/verify", {}, "POST")).status).toBe(409);
  });
});

test("agent-models page renders native subagent rows", async () => {
  const ctx = nativeFixture();
  const response = await createAgentModelsRoutes(ctx.deps).request("http://localhost/agent-models");
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain("Agent Models");
  expect(html).toContain("general");
  expect(html).toContain("librarian");
});
