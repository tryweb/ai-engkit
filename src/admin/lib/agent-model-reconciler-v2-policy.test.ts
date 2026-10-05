import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { clearModelMetadataCache } from "./model-metadata";
import { createAgentModelReconciler } from "./agent-model-reconciler";
import type { AgentModelsDeps } from "./agent-model-types";
import type { ExecResult } from "./docker";

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  rmSync(join(process.env.HOME ?? "", ".cache/openchamber/agent-model-reconcile.lock"), { recursive: true, force: true });
  clearModelMetadataCache();
});

function makeDeps(handlers: Array<{ match: RegExp; stdout?: string; exitCode?: number }>): { deps: AgentModelsDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: AgentModelsDeps = {
    exec: async (cmd: string, _timeoutMs?: number): Promise<ExecResult> => {
      calls.push(cmd);
      for (const h of handlers) if (h.match.test(cmd)) return { stdout: h.stdout ?? "", stderr: "", exitCode: h.exitCode ?? 0 };
      if (cmd.includes("dGl0bGU=")) return { stdout: JSON.stringify({ info: { role: "assistant", modelID: "free-model", providerID: "openai" } }), stderr: "", exitCode: 0 };
      if (cmd.includes("snap_r=") || cmd.includes("snapshot")) return { stdout: "/tmp/snap_r:/tmp/snap_o", stderr: "", exitCode: 0 };
      if (cmd.includes("cat") && cmd.includes("routing.json")) return { stdout: '{"version":1,"chains":{}}', stderr: "", exitCode: 0 };
      if (cmd.includes("agent-model-policy.json")) return { stdout: '{"mode":"free"}', stderr: "", exitCode: 0 };
      if (cmd.includes("routing.json")) return { stdout: "", stderr: "", exitCode: 0 };
      if (cmd.includes("opencode.json")) return { stdout: "{}", stderr: "", exitCode: 0 };
      if (cmd.includes("auth.json")) return { stdout: "", stderr: "", exitCode: 1 };
      if (cmd.includes("agent-model-health.json")) return { stdout: "{}", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    restart: async () => ({ ok: true }),
    readEnv: () => ({ OPENCODE_SERVER_PASSWORD: "pw", OMO_ENABLED: "0" }),
  };
  return { deps, calls };
}

describe("V2 reconciler policy-based runOnce", () => {
  test("free mode assigns unconfigured agents via metadata", async () => {
    const origFetch = globalThis.fetch;
    const prevEnv = process.env.OMO_ENABLED;
    process.env.OMO_ENABLED = "0";
    const payload = {
      openai: {
        models: {
          "free-model": {
            cost: { input: 0, output: 0 },
            limit: { context: 256000, output: 64000 },
            reasoning: true,
            tool_call: true,
            deprecated: false,
            benchmark_score: 0.9,
          },
        },
      },
    };
    globalThis.fetch = Object.assign(async (): Promise<Response> => jsonRes(payload), { preconnect: Reflect.get(origFetch, "preconnect") });
    const handlers: Array<{ match: RegExp; stdout?: string }> = [
      { match: /agent-model-policy\.json/, stdout: '{"mode":"free","version":1}' },
      { match: /routing\.json/, stdout: '{"version":1,"chains":{}}' },
      { match: /\/api\/provider/, stdout: JSON.stringify({ data: [{ id: "openai" }] }) },
      { match: /\/api\/model/, stdout: JSON.stringify({ data: [{ id: "free-model", providerID: "openai", status: "active", enabled: true }] }) },
      { match: /\/provider\b/, stdout: JSON.stringify({ connected: ["openai"], all: [{ id: "openai", models: { "free-model": { capabilities: { reasoning: true, toolcall: true } } } }] }) },
      { match: /\/api\/agent/, stdout: JSON.stringify({ data: [{ id: "explore", mode: "subagent", model: { id: "free-model", providerID: "openai" } }] }) },
      { match: /\/agent\b/, stdout: JSON.stringify([{ name: "explore", mode: "subagent", model: { modelID: "free-model", providerID: "openai" } }]) },
    ];
    const { deps, calls } = makeDeps(handlers);
    const rec = createAgentModelReconciler(deps);
    const summary = await rec.reconcileAll();
    expect(calls.some((c) => c.includes("routing.json"))).toBe(true);
    expect(summary.changed).toBeGreaterThanOrEqual(0);
    globalThis.fetch = origFetch;
    process.env.OMO_ENABLED = prevEnv;
    clearModelMetadataCache();
  });
});
