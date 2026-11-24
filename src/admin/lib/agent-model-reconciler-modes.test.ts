import { describe, expect, test, beforeEach } from "bun:test";
import { createTestReconcileLock } from "./agent-model-reconciler-test-support";
import { clearModelMetadataCache } from "./model-metadata";
import { createAgentModelReconciler } from "./agent-model-reconciler";

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubDeps(handlers: Array<{ match: RegExp; stdout?: string }>) {
  const calls: string[] = [];
  const deps = {
    reconcileLockPath: createTestReconcileLock(),
    exec: async (cmd: string) => {
      calls.push(cmd);
      for (const h of handlers)
        if (h.match.test(cmd))
          return { stdout: h.stdout ?? "", stderr: "", exitCode: 0 };
      if (cmd.includes(".native-agent-overrides.tmp"))
        return { stdout: "", stderr: "", exitCode: 0 };
      if (cmd.includes("/provider"))
        return {
          stdout: JSON.stringify({
            connected: ["openai"],
            all: [{ id: "openai", models: {} }],
          }),
          stderr: "",
          exitCode: 0,
        };
      if (cmd.includes("/agent"))
        return {
          stdout: JSON.stringify([
            {
              name: "general",
              mode: "subagent",
              model: { modelID: "m", providerID: "openai" },
            },
          ]),
          stderr: "",
          exitCode: 0,
        };
      return { stdout: "", stderr: "", exitCode: 1 };
    },
    restart: async () => ({ ok: true as const }),
    readEnv: () => ({ OPENCODE_SERVER_PASSWORD: "pw" }),
  };
  return { deps, calls };
}

beforeEach(() => {
  clearModelMetadataCache();
});

describe("reconciler suggestExplicit", () => {
  test("unavailable metadata returns empty with warning", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("fail");
    }) as unknown as typeof fetch;
    const { deps } = stubDeps([
      { match: /jq -c '\.agents/, stdout: "{}" },
      {
        match: /\/provider\b/,
        stdout: JSON.stringify({
          connected: ["openai"],
          all: [
            {
              id: "openai",
              models: {
                a: { capabilities: { reasoning: true, toolcall: true } },
              },
            },
          ],
        }),
      },
      {
        match: /\/agent\b/,
        stdout: JSON.stringify([
          {
            name: "general",
            mode: "subagent",
            model: { modelID: "a", providerID: "openai" },
          },
        ]),
      },
    ]);
    const rec = createAgentModelReconciler(deps);
    const out = await rec.suggestExplicit("free", null);
    expect(out.sourceStatus).toBe("unavailable");
    expect(out.warnings).toContain("metadata_unavailable");
    expect(out.suggestions.size).toBe(0);
    globalThis.fetch = origFetch;
  });

  test("free mode uses only fresh zero-cost candidates", async () => {
    const origFetch = globalThis.fetch;
    const payload = {
      openai: {
        models: {
          "free-a": {
            cost: { input: 0, output: 0 },
            limit: { context: 100000, output: 8192 },
            reasoning: true,
            tool_call: true,
            deprecated: false,
          },
          "paid-a": {
            cost: { input: 1, output: 1 },
            limit: { context: 100000, output: 8192 },
            reasoning: true,
            tool_call: true,
            deprecated: false,
          },
        },
      },
    };
    globalThis.fetch = (async () =>
      jsonRes(payload)) as unknown as typeof fetch;
    const { deps } = stubDeps([
      { match: /\/api\/provider\b/, stdout: '{"data":[{"id":"openai"}]}' },
      { match: /\/api\/model\b/, stdout: '{"data":[{"id":"free-a","providerID":"openai","enabled":true,"status":"active","capabilities":{"reasoning":true,"tools":true}},{"id":"paid-a","providerID":"openai","enabled":true,"status":"active","capabilities":{"reasoning":true,"tools":true}}]}' },
      { match: /jq -c '\.agents/, stdout: "{}" },
      {
        match: /\/provider\b/,
        stdout: JSON.stringify({
          connected: ["openai"],
          all: [
            {
              id: "openai",
              models: {
                "free-a": { capabilities: { reasoning: true, toolcall: true } },
                "paid-a": { capabilities: { reasoning: true, toolcall: true } },
              },
            },
          ],
        }),
      },
      {
        match: /\/agent\b/,
        stdout: JSON.stringify([
          {
            name: "general",
            mode: "subagent",
            model: { modelID: "free-a", providerID: "openai" },
          },
        ]),
      },
      {
        match: /connected-providers\.json/,
        stdout: '{"connected":["openai"]}',
      },
      {
        match: /provider-models\.json/,
        stdout: "openai/free-a\nopenai/paid-a\n",
      },
    ]);
    const rec = createAgentModelReconciler(deps);
    const out = await rec.suggestExplicit("free", null);
    expect(out.suggestions.get("general")?.model).toBe("openai/free-a");
    globalThis.fetch = origFetch;
  });

  test("provider scope limits explicit suggestions", async () => {
    const origFetch = globalThis.fetch;
    const payload = {
      openai: {
        models: {
          a: {
            cost: { input: 0, output: 0 },
            limit: { context: 100000, output: 8192 },
            reasoning: true,
            tool_call: true,
          },
        },
      },
      "opencode-go": {
        models: {
          b: {
            cost: { input: 0, output: 0 },
            limit: { context: 100000, output: 8192 },
            reasoning: true,
            tool_call: true,
          },
        },
      },
    };
    globalThis.fetch = (async () =>
      jsonRes(payload)) as unknown as typeof fetch;
    const handlers = [
      {
        match: /\/provider\b/,
        stdout: JSON.stringify({
          connected: ["openai", "opencode-go"],
          all: [
            {
              id: "openai",
              models: {
                a: { capabilities: { reasoning: true, toolcall: true } },
              },
            },
            {
              id: "opencode-go",
              models: {
                b: { capabilities: { reasoning: true, toolcall: true } },
              },
            },
          ],
        }),
      },
      { match: /jq -c '\.agents/, stdout: "{}" },
      {
        match: /\/agent\b/,
        stdout: JSON.stringify([
          {
            name: "general",
            mode: "subagent",
            model: { modelID: "a", providerID: "openai" },
          },
        ]),
      },
      {
        match: /connected-providers\.json/,
        stdout: '{"connected":["openai","opencode-go"]}',
      },
      { match: /provider-models\.json/, stdout: "openai/a\nopencode-go/b\n" },
    ];
    const { deps } = stubDeps(handlers);
    const rec = createAgentModelReconciler(deps);
    const out = await rec.suggestExplicit("economy", ["openai"]);
    expect(out.providers).toEqual(["openai"]);
    for (const sug of out.suggestions.values())
      expect(sug.model.startsWith("openai/")).toBe(true);
    globalThis.fetch = origFetch;
  });

  test("no probe/write/restart in explicit", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      jsonRes({ openai: { models: {} } })) as unknown as typeof fetch;
    const { deps, calls } = stubDeps([
      { match: /jq -c '\.agents/, stdout: "{}" },
      {
        match: /\/provider\b/,
        stdout: JSON.stringify({
          connected: ["openai"],
          all: [{ id: "openai", models: {} }],
        }),
      },
      {
        match: /\/agent\b/,
        stdout: JSON.stringify([
          {
            name: "general",
            mode: "subagent",
            model: { modelID: "m", providerID: "openai" },
          },
        ]),
      },
    ]);
    let restarted = false;
    deps.restart = async () => {
      restarted = true;
      return { ok: true };
    };
    const rec = createAgentModelReconciler(deps);
    await rec.suggestExplicit("performance", null);
    expect(restarted).toBe(false);
    expect(
      calls.some((c: string) => c.includes("native-agent-overrides")),
    ).toBe(false);
    globalThis.fetch = origFetch;
  });

  test("suggestions map is JSON-serializable via record conversion", async () => {
    const origFetch = globalThis.fetch;
    const payload = {
      openai: {
        models: {
          m1: {
            cost: { input: 0.5, output: 1 },
            limit: { context: 100000, output: 8192 },
            reasoning: true,
            tool_call: true,
          },
        },
      },
    };
    globalThis.fetch = (async () =>
      jsonRes(payload)) as unknown as typeof fetch;
    const { deps } = stubDeps([
      { match: /\/api\/provider\b/, stdout: '{"data":[{"id":"openai"}]}' },
      { match: /\/api\/model\b/, stdout: '{"data":[{"id":"m1","providerID":"openai","enabled":true,"status":"active","capabilities":{"reasoning":true,"tools":true}}]}' },
      { match: /jq -c '\.agents/, stdout: "{}" },
      {
        match: /\/provider\b/,
        stdout: JSON.stringify({
          connected: ["openai"],
          all: [
            {
              id: "openai",
              models: {
                m1: { capabilities: { reasoning: true, toolcall: true } },
              },
            },
          ],
        }),
      },
      {
        match: /\/agent\b/,
        stdout: JSON.stringify([
          {
            name: "general",
            mode: "subagent",
            model: { modelID: "m1", providerID: "openai" },
          },
        ]),
      },
    ]);
    const rec = createAgentModelReconciler(deps);
    const out = await rec.suggestExplicit("economy", null);
    // ensure map can be converted to record without ReadonlyMap artifacts
    const record: Record<string, unknown> = {};
    for (const [k, v] of out.suggestions) record[k] = v;
    const json = JSON.stringify(record);
    expect(JSON.parse(json).general.model).toBe("openai/m1");
    globalThis.fetch = origFetch;
  });
});
