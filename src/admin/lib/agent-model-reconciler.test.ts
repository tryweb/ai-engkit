import { describe, expect, test } from "bun:test";
import { createAgentModelReconciler } from "./agent-model-reconciler";
import type { AgentModelsDeps } from "./agent-model-types";
import type { ExecResult } from "./docker";

type Fixture = {
  readonly deps: AgentModelsDeps;
  readonly calls: string[];
  readonly applied: Array<readonly [string, readonly { readonly model: string }[]]>;
  readonly cleanup: () => void;
};

function fixture(config: string, provider: string, agents: string, probes: Record<string, string> = {}): Fixture {
  const calls: string[] = [];
  const applied: Array<readonly [string, readonly { readonly model: string }[]]> = [];
  const deps: AgentModelsDeps = {
    exec: async (command: string): Promise<ExecResult> => {
      calls.push(command);
      if (command.includes(".agents // {}")) return { stdout: config, stderr: "", exitCode: 0 };
      if (command.includes("/provider")) return { stdout: provider, stderr: "", exitCode: 0 };
      if (command.includes("/agent")) return { stdout: agents, stderr: "", exitCode: 0 };
      for (const [model, response] of Object.entries(probes)) {
        if (command.includes(model)) return { stdout: response, stderr: "", exitCode: 0 };
      }
      if (command.includes("title:\"model availability probe\"")) {
        return { stdout: healthy("p", "alpha"), stderr: "", exitCode: 0 };
      }
      if (command.includes("/session")) return { stdout: healthy("p", "alpha"), stderr: "", exitCode: 0 };
      return { stdout: "{}", stderr: "", exitCode: 0 };
    },
    restart: async () => ({ ok: true }),
    readEnv: () => ({ OPENCODE_SERVER_PASSWORD: "testpass" }),
  };
  return { deps, calls, applied, cleanup: () => {} };
}

function withPresetNames(base: Fixture, presetNames: readonly string[]): AgentModelsDeps {
  return {
    ...base.deps,
    exec: async (command: string, timeout?: number): Promise<ExecResult> => {
      if (command.includes(".presets[.preset]")) {
        return { stdout: presetNames.join("\n"), stderr: "", exitCode: 0 };
      }
      return base.deps.exec(command, timeout);
    },
  };
}

const liveAgents = JSON.stringify([
  { name: "general", mode: "subagent", model: { providerID: "missing", modelID: "default" } },
  { name: "plan", mode: "subagent", model: { providerID: "missing", modelID: "default" } },
]);

function healthy(providerID: string, modelID: string): string {
  return JSON.stringify({ info: { role: "assistant", providerID, modelID } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractProbedModelId(command: string): string | null {
  const match = command.match(/printf '%s' '([^']+)' \| base64 -d/);
  if (match === null) return null;
  const b64 = match[1] ?? "";
  let decoded: string;
  try {
    decoded = Buffer.from(b64, "base64").toString("utf8");
  } catch (error: unknown) {
    void error;
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch (error: unknown) {
    void error;
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.model)) return null;
  const model = parsed.model;
  if (typeof model.modelID !== "string") return null;
  return model.modelID;
}

function probedModelIds(calls: readonly string[]): string[] {
  return calls
    .filter((call) => call.includes('title:"model availability probe"'))
    .map(extractProbedModelId)
    .filter((modelID): modelID is string => modelID !== null);
}


describe("agent model reconciler", () => {
  test("keeps a healthy primary and does not write", async () => {
    const ctx = fixture(
      JSON.stringify({ general: { model: "p/keep" } }),
      JSON.stringify({ connected: ["p"], all: [{ id: "p", models: { keep: { capabilities: {} } } }] }),
      liveAgents,
      { keep: healthy("p", "keep") },
    );
    const reconciler = createAgentModelReconciler(ctx.deps);
    const summary = await reconciler.reconcileAll();
    expect(summary.changed).toBe(0);
    expect(ctx.calls.some((call) => call.includes(".agents[$agent]"))).toBe(false);
    ctx.cleanup();
  });

  test("keeps a healthy assigned model without creating a config override", async () => {
    const ctx = fixture(
      JSON.stringify({ "sisyphus-junior": {} }),
      JSON.stringify({ connected: ["opencode"], all: [{ id: "opencode", models: { "mimo-v2.5-free": { capabilities: {} } } }] }),
      JSON.stringify([
        { name: "Sisyphus-Junior", mode: "subagent", model: { providerID: "opencode", modelID: "mimo-v2.5-free" } },
      ]),
      { "mimo-v2.5-free": healthy("opencode", "mimo-v2.5-free") },
    );
    const logs: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      const result = await createAgentModelReconciler(ctx.deps).reconcileAll();
      expect(result.changed).toBe(0);
      expect(result.applied).toBe(0);
      expect(ctx.calls.some((call) => call.includes(".agents[$agent]"))).toBe(false);
      expect(logs.some((line) => line.includes('"decision":"keep_healthy_assigned"'))).toBe(true);
    } finally {
      console.error = originalError;
      ctx.cleanup();
    }
  });

  test("ranks capabilities deterministically and probes only until the first healthy candidate", async () => {
    const ctx = fixture(
      JSON.stringify({ general: {} }),
      JSON.stringify({ connected: ["p"], all: [{ id: "p", models: {
        zed: { capabilities: { toolcall: true } },
        alpha: { capabilities: { toolcall: true, attachment: true } },
      } }] }),
      liveAgents,
      { "alpha": healthy("p", "alpha") },
    );
    const reconciler = createAgentModelReconciler(ctx.deps);
    const result = await reconciler.reconcileAll();
    expect(result.changed).toBe(2);
    expect(probedModelIds(ctx.calls)).toEqual(["alpha"]);
    ctx.cleanup();
  });

  test("serializes concurrent runs and reruns once when a writer is pending", async () => {
    let release: (() => void) | undefined;
    let entered = 0;
    const ctx = fixture(JSON.stringify({ general: {} }), JSON.stringify({ connected: [], all: [] }), liveAgents);
    const original = ctx.deps.exec;
    const deps: AgentModelsDeps = { ...ctx.deps, exec: async (command, timeout) => {
      if (command.includes(".agents // {}")) {
        entered += 1;
        if (entered === 1) await new Promise<void>((resolve) => { release = resolve; });
      }
      return original(command, timeout);
    } };
    const reconciler = createAgentModelReconciler(deps);
    const first = reconciler.reconcileAll();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = reconciler.reconcileAll();
    release?.();
    await Promise.all([first, second]);
    expect(entered).toBe(2);
    ctx.cleanup();
  });

  test("keeps inconclusive primary probes fail-open", async () => {
    const ctx = fixture(
      JSON.stringify({ general: { model: "p/keep" } }),
      JSON.stringify({ connected: ["p"], all: [{ id: "p", models: { keep: { capabilities: {} }, other: { capabilities: {} } } }] }),
      liveAgents,
      { keep: JSON.stringify({ info: { role: "assistant", error: "temporary" } }) },
    );
    const result = await createAgentModelReconciler(ctx.deps).reconcileAll();
    expect(result.changed).toBe(0);
    ctx.cleanup();
  });

  test("keeps an invalid configured primary fail-open", async () => {
    const ctx = fixture(
      JSON.stringify({ general: { model: "invalid-primary" } }),
      JSON.stringify({ connected: ["p"], all: [{ id: "p", models: { other: { capabilities: {} } } }] }),
      liveAgents,
      { other: healthy("p", "other") },
    );
    const logs: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      const result = await createAgentModelReconciler(ctx.deps).reconcileAll();
      expect(result.changed).toBe(0);
      expect(logs.some((line) => line.includes('"probe":"mismatch"') && line.includes('"desired":"invalid-primary"'))).toBe(true);
    } finally {
      console.error = originalError;
      ctx.cleanup();
    }
  });

  test("counts probe_failed from applyAndVerify as a reconciliation failure", async () => {
    const ctx = fixture(
      JSON.stringify({ general: { model: "p/bad" } }),
      JSON.stringify({ connected: ["p"], all: [{ id: "p", models: { alpha: { capabilities: {} } } }] }),
      JSON.stringify([{ name: "general", mode: "subagent", model: { providerID: "p", modelID: "alpha" } }]),
    );
    let probeCount = 0;
    const originalExec = ctx.deps.exec;
    const deps: AgentModelsDeps = {
      ...ctx.deps,
      exec: async (command, timeout) => {
        if (command.includes("title:\"model availability probe\"")) {
          probeCount += 1;
          if (probeCount === 1 || probeCount === 3) return { stdout: JSON.stringify({ info: { role: "assistant", error: "404 unavailable" } }), stderr: "", exitCode: 0 };
        }
        return originalExec(command, timeout);
      },
    };
    const result = await createAgentModelReconciler(deps).reconcileAll();
    expect(result.changed).toBe(1);
    expect(result.applied).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.results).toEqual([{
      agent: "general",
      status: "probe_failed",
      error: '"404 unavailable"',
      resolved: null,
    }]);
    ctx.cleanup();
  });

  test("filters generated suggestions before probing by provider", async () => {
    const ctx = fixture(
      JSON.stringify({ general: {}, plan: {} }),
      JSON.stringify({ connected: ["p", "q"], all: [
        { id: "p", models: { alpha: { capabilities: { toolcall: true } } } },
        { id: "q", models: { beta: { capabilities: { toolcall: true } } } },
      ] }),
      liveAgents,
      { 'title:"model availability probe"': healthy("q", "beta") },
    );
    const suggestions = await createAgentModelReconciler(ctx.deps).suggest(["q"]);
    expect(suggestions.get("general")).toEqual([{ model: "q/beta" }]);
    expect(suggestions.get("plan")).toEqual([{ model: "q/beta" }]);
    expect(ctx.calls.some((call) => call.includes("p/alpha"))).toBe(false);
    expect(ctx.calls.some((call) => call.includes(".agents[$agent]"))).toBe(false);
    ctx.cleanup();
  });
  test("uses the first equal-score healthy candidate for each agent via suggest", async () => {
    const config = JSON.stringify({ general: {}, "sisyphus-junior": {} });
    const provider = JSON.stringify({
      connected: ["p", "q"],
      all: [
        { id: "p", models: { alpha: { capabilities: { toolcall: true } } } },
        { id: "q", models: { beta: { capabilities: { toolcall: true } } } },
      ],
    });
    const agents = JSON.stringify([
      { name: "general", mode: "subagent", model: { providerID: "missing", modelID: "default" } },
      { name: "Sisyphus-Junior", mode: "subagent", model: { providerID: "missing", modelID: "default" } },
    ]);
    const base = fixture(config, provider, agents, {});
    const deps: AgentModelsDeps = {
      ...base.deps,
      exec: async (command: string, timeout?: number): Promise<ExecResult> => {
        if (command.includes('title:"model availability probe"')) {
          const modelId = extractProbedModelId(command);
          if (modelId === "alpha") return { stdout: healthy("p", "alpha"), stderr: "", exitCode: 0 };
          if (modelId === "beta") return { stdout: healthy("q", "beta"), stderr: "", exitCode: 0 };
          return { stdout: healthy("p", "alpha"), stderr: "", exitCode: 0 };
        }
        return base.deps.exec(command, timeout);
      },
    };
    const suggestions = await createAgentModelReconciler(deps).suggest();
    expect(suggestions.get("general")).toEqual([{ model: "p/alpha" }]);
    expect(suggestions.get("sisyphus-junior")).toEqual([{ model: "p/alpha" }]);
    base.cleanup();
  });

  test("reuses single healthy candidate for multiple agents rather than no_usable_model via suggest", async () => {
    const config = JSON.stringify({ general: {}, "sisyphus-junior": {} });
    const provider = JSON.stringify({
      connected: ["p"],
      all: [{ id: "p", models: { alpha: { capabilities: { toolcall: true } } } }],
    });
    const agents = JSON.stringify([
      { name: "general", mode: "subagent", model: { providerID: "missing", modelID: "default" } },
      { name: "Sisyphus-Junior", mode: "subagent", model: { providerID: "missing", modelID: "default" } },
    ]);
    const ctx = fixture(config, provider, agents, { alpha: healthy("p", "alpha") });
    const suggestions = await createAgentModelReconciler(ctx.deps).suggest();
    expect(suggestions.get("general")).toEqual([{ model: "p/alpha" }]);
    expect(suggestions.get("sisyphus-junior")).toEqual([{ model: "p/alpha" }]);
    ctx.cleanup();
  });

  test("reuses single healthy candidate for multiple agents via reconcileAll", async () => {
    const config = JSON.stringify({ general: {}, "sisyphus-junior": {} });
    const provider = JSON.stringify({
      connected: ["p"],
      all: [{ id: "p", models: { alpha: { capabilities: { toolcall: true } } } }],
    });
    const agents = JSON.stringify([
      { name: "general", mode: "subagent", model: { providerID: "missing", modelID: "default" } },
      { name: "Sisyphus-Junior", mode: "subagent", model: { providerID: "missing", modelID: "default" } },
    ]);
    const ctx = fixture(config, provider, agents, { alpha: healthy("p", "alpha") });
    const result = await createAgentModelReconciler(ctx.deps).reconcileAll();
    expect(result.changed).toBe(2);
    expect([...result.agents].sort()).toEqual(["general", "sisyphus-junior"]);
    ctx.cleanup();
  });

  test("probes identical candidate refs only once per suggest invocation", async () => {
    const config = JSON.stringify({ general: {}, "sisyphus-junior": {} });
    const provider = JSON.stringify({
      connected: ["p"],
      all: [{ id: "p", models: { alpha: { capabilities: {} } } }],
    });
    const agents = JSON.stringify([
      { name: "general", mode: "subagent", model: { providerID: "missing", modelID: "default" } },
      { name: "Sisyphus-Junior", mode: "subagent", model: { providerID: "missing", modelID: "default" } },
    ]);
    let probeCount = 0;
    const base = fixture(config, provider, agents, {});
    const deps: AgentModelsDeps = {
      ...base.deps,
      exec: async (command: string, timeout?: number): Promise<ExecResult> => {
        if (command.includes('title:"model availability probe"')) probeCount += 1;
        if (command.includes('title:"model availability probe"')) {
          return { stdout: healthy("p", "alpha"), stderr: "", exitCode: 0 };
        }
        return base.deps.exec(command, timeout);
      },
    };
    const suggestions = await createAgentModelReconciler(deps).suggest();
    expect(suggestions.get("general")).toEqual([{ model: "p/alpha" }]);
    expect(suggestions.get("sisyphus-junior")).toEqual([{ model: "p/alpha" }]);
    expect(probeCount).toBe(1);
    base.cleanup();
  });

  test("probes identical candidate refs only once per reconcileAll invocation", async () => {
    const config = JSON.stringify({ general: {}, "sisyphus-junior": {} });
    const provider = JSON.stringify({
      connected: ["p"],
      all: [{ id: "p", models: { alpha: { capabilities: {} } } }],
    });
    const agents = JSON.stringify([
      { name: "general", mode: "subagent", model: { providerID: "missing", modelID: "default" } },
      { name: "Sisyphus-Junior", mode: "subagent", model: { providerID: "missing", modelID: "default" } },
    ]);
    let probeCount = 0;
    const base = fixture(config, provider, agents, {});
    const deps: AgentModelsDeps = {
      ...base.deps,
      exec: async (command: string, timeout?: number): Promise<ExecResult> => {
        if (command.includes('title:"model availability probe"')) probeCount += 1;
        if (command.includes('title:"model availability probe"')) {
          return { stdout: healthy("p", "alpha"), stderr: "", exitCode: 0 };
        }
        return base.deps.exec(command, timeout);
      },
    };
    const result = await createAgentModelReconciler(deps).reconcileAll();
    expect(result.changed).toBe(2);
    expect(probeCount).toBe(1);
    base.cleanup();
  });

  test("reuses a quota result for repeated candidate refs in one reconcile", async () => {
    const config = JSON.stringify({ general: {}, plan: {} });
    const provider = JSON.stringify({
      connected: ["p"],
      all: [{ id: "p", models: { alpha: { capabilities: {} } } }],
    });
    const agents = JSON.stringify([
      { name: "general", mode: "subagent", model: { providerID: "missing", modelID: "default" } },
      { name: "plan", mode: "subagent", model: { providerID: "missing", modelID: "default" } },
    ]);
    const base = fixture(config, provider, agents, {});
    const calls: string[] = [];
    const deps: AgentModelsDeps = {
      ...base.deps,
      exec: async (command: string, timeout?: number): Promise<ExecResult> => {
        calls.push(command);
        if (command.includes('title:"model availability probe"')) {
          return {
            stdout: JSON.stringify({ info: { role: "assistant", error: "FreeUsageLimitError: free usage exceeded" } }),
            stderr: "",
            exitCode: 0,
          };
        }
        return base.deps.exec(command, timeout);
      },
    };

    const result = await createAgentModelReconciler(deps).reconcileAll();

    expect(result.changed).toBe(0);
    expect(probedModelIds(calls)).toEqual(["alpha"]);
    base.cleanup();
  });

  test("keeps healthy pinned model untouched", async () => {
    const config = JSON.stringify({ general: { model: "p/keep" }, "sisyphus-junior": {} });
    const provider = JSON.stringify({
      connected: ["p", "q"],
      all: [
        { id: "p", models: { keep: { capabilities: {} }, other: { capabilities: { toolcall: true } } } },
        { id: "q", models: { better: { capabilities: { toolcall: true, attachment: true } } } },
      ],
    });
    const agents = JSON.stringify([
      { name: "general", mode: "subagent", model: { providerID: "missing", modelID: "default" } },
      { name: "Sisyphus-Junior", mode: "subagent", model: { providerID: "missing", modelID: "default" } },
    ]);
    const base = fixture(config, provider, agents, {});
    const keepHealthy = healthy("p", "keep");
    const betterHealthy = healthy("q", "better");
    const deps: AgentModelsDeps = {
      ...base.deps,
      exec: async (command: string, timeout?: number): Promise<ExecResult> => {
        if (command.includes('title:"model availability probe"')) {
          const modelId = extractProbedModelId(command);
          if (modelId === "keep") return { stdout: keepHealthy, stderr: "", exitCode: 0 };
          if (modelId === "better") return { stdout: betterHealthy, stderr: "", exitCode: 0 };
          if (modelId === "other") return { stdout: healthy("p", "other"), stderr: "", exitCode: 0 };
          return { stdout: keepHealthy, stderr: "", exitCode: 0 };
        }
        return base.deps.exec(command, timeout);
      },
    };
    const result = await createAgentModelReconciler(deps).reconcileAll();
    expect(result.agents.includes("general")).toBe(false);
    expect(result.changed).toBe(1);
    expect(result.agents).toEqual(["sisyphus-junior"]);
    base.cleanup();
  });

  test("falls back from unavailable pinned model", async () => {
    const config = JSON.stringify({ general: { model: "p/bad" } });
    const provider = JSON.stringify({
      connected: ["p", "q"],
      all: [
        { id: "p", models: { bad: { capabilities: {} }, alpha: { capabilities: {} } } },
        { id: "q", models: { good: { capabilities: {} } } },
      ],
    });
    const agents = JSON.stringify([
      { name: "general", mode: "subagent", model: { providerID: "missing", modelID: "default" } },
    ]);
    const badResponse = JSON.stringify({ info: { role: "assistant", error: "404 unavailable" } });
    const ctx = fixture(config, provider, agents, { bad: badResponse, good: healthy("q", "good") });
    const baseExec = ctx.deps.exec;
    const deps: AgentModelsDeps = {
      ...ctx.deps,
      exec: async (command: string, timeout?: number): Promise<ExecResult> => {
        if (command.includes('title:"model availability probe"')) {
          const modelId = extractProbedModelId(command);
          if (modelId === "bad") return { stdout: badResponse, stderr: "", exitCode: 0 };
          if (modelId === "good") return { stdout: healthy("q", "good"), stderr: "", exitCode: 0 };
          if (modelId === "alpha") return { stdout: healthy("p", "alpha"), stderr: "", exitCode: 0 };
          return { stdout: healthy("p", "alpha"), stderr: "", exitCode: 0 };
        }
        return baseExec(command, timeout);
      },
    };
    const result = await createAgentModelReconciler(deps).reconcileAll();
    expect(result.changed).toBe(1);
    expect(result.agents).toEqual(["general"]);
    ctx.cleanup();
  });

  test("falls back from retired pinned model", async () => {
    const config = JSON.stringify({ general: { model: "p/old" } });
    const provider = JSON.stringify({
      connected: ["p", "q"],
      all: [
        { id: "p", models: { old: { capabilities: {} } } },
        { id: "q", models: { fresh: { capabilities: {} } } },
      ],
    });
    const agents = JSON.stringify([
      { name: "general", mode: "subagent", model: { providerID: "missing", modelID: "default" } },
    ]);
    const retiredResponse = JSON.stringify({ info: { role: "assistant", error: "410 retired" } });
    const ctx = fixture(config, provider, agents, { old: retiredResponse, fresh: healthy("q", "fresh") });
    const baseExec = ctx.deps.exec;
    const deps: AgentModelsDeps = {
      ...ctx.deps,
      exec: async (command: string, timeout?: number): Promise<ExecResult> => {
        if (command.includes('title:"model availability probe"')) {
          const modelId = extractProbedModelId(command);
          if (modelId === "old") return { stdout: retiredResponse, stderr: "", exitCode: 0 };
          if (modelId === "fresh") return { stdout: healthy("q", "fresh"), stderr: "", exitCode: 0 };
          return { stdout: healthy("q", "fresh"), stderr: "", exitCode: 0 };
        }
        return baseExec(command, timeout);
      },
    };
    const result = await createAgentModelReconciler(deps).reconcileAll();
    expect(result.changed).toBe(1);
    expect(result.agents).toEqual(["general"]);
    ctx.cleanup();
  });

  test("falls back from a pinned model with a disconnected provider", async () => {
    const config = JSON.stringify({ general: { model: "missing/old" } });
    const provider = JSON.stringify({
      connected: ["p"],
      all: [{ id: "p", models: { alpha: { capabilities: {} } } }],
    });
    const agents = JSON.stringify([
      { name: "general", mode: "subagent", model: { providerID: "missing", modelID: "old" } },
    ]);
    const ctx = fixture(config, provider, agents);
    const baseExec = ctx.deps.exec;
    const probed: string[] = [];
    const deps: AgentModelsDeps = {
      ...ctx.deps,
      exec: async (command: string, timeout?: number): Promise<ExecResult> => {
        if (command.includes('title:"model availability probe"')) {
          const modelId = extractProbedModelId(command);
          if (modelId !== null) probed.push(modelId);
          if (modelId === "alpha") return { stdout: healthy("p", "alpha"), stderr: "", exitCode: 0 };
        }
        return baseExec(command, timeout);
      },
    };
    const result = await createAgentModelReconciler(deps).reconcileAll();
    expect(result.changed).toBe(1);
    expect(result.agents).toEqual(["general"]);
    expect(probed).toEqual(["alpha"]);
    ctx.cleanup();
  });

  test("uses the first equal-score healthy candidate for each agent via reconcileAll", async () => {
    const config = JSON.stringify({ general: {}, "sisyphus-junior": {} });
    const provider = JSON.stringify({
      connected: ["p", "q"],
      all: [
        { id: "p", models: { alpha: { capabilities: { toolcall: true } } } },
        { id: "q", models: { beta: { capabilities: { toolcall: true } } } },
      ],
    });
    const agents = JSON.stringify([
      { name: "general", mode: "subagent", model: { providerID: "missing", modelID: "default" } },
      { name: "Sisyphus-Junior", mode: "subagent", model: { providerID: "missing", modelID: "default" } },
    ]);
    const base = fixture(config, provider, agents, {});
    const deps: AgentModelsDeps = {
      ...base.deps,
      exec: async (command: string, timeout?: number): Promise<ExecResult> => {
        if (command.includes('title:"model availability probe"')) {
          const modelId = extractProbedModelId(command);
          if (modelId === "alpha") return { stdout: healthy("p", "alpha"), stderr: "", exitCode: 0 };
          if (modelId === "beta") return { stdout: healthy("q", "beta"), stderr: "", exitCode: 0 };
          return { stdout: healthy("p", "alpha"), stderr: "", exitCode: 0 };
        }
        return base.deps.exec(command, timeout);
      },
    };
    const result = await createAgentModelReconciler(deps).reconcileAll();
    expect(result.changed).toBe(2);
    const suggestions = await createAgentModelReconciler(deps).suggest();
    expect(suggestions.get("general")).toEqual([{ model: "p/alpha" }]);
    expect(suggestions.get("sisyphus-junior")).toEqual([{ model: "p/alpha" }]);
    base.cleanup();
  });

  test("does not select lower score merely to diversify providers", async () => {
    const config = JSON.stringify({ general: {}, "sisyphus-junior": {} });
    const provider = JSON.stringify({
      connected: ["p", "q"],
      all: [
        { id: "p", models: { high: { capabilities: { toolcall: true, attachment: true } } } },
        { id: "q", models: { low: { capabilities: { toolcall: true } } } },
      ],
    });
    const agents = JSON.stringify([
      { name: "general", mode: "subagent", model: { providerID: "missing", modelID: "default" } },
      { name: "Sisyphus-Junior", mode: "subagent", model: { providerID: "missing", modelID: "default" } },
    ]);
    const base = fixture(config, provider, agents, {});
    const deps: AgentModelsDeps = {
      ...base.deps,
      exec: async (command: string, timeout?: number): Promise<ExecResult> => {
        if (command.includes('title:"model availability probe"')) {
          const modelId = extractProbedModelId(command);
          if (modelId === "high") return { stdout: healthy("p", "high"), stderr: "", exitCode: 0 };
          if (modelId === "low") return { stdout: healthy("q", "low"), stderr: "", exitCode: 0 };
          return { stdout: healthy("p", "high"), stderr: "", exitCode: 0 };
        }
        return base.deps.exec(command, timeout);
      },
    };
    const suggestions = await createAgentModelReconciler(deps).suggest();
    expect(suggestions.get("general")).toEqual([{ model: "p/high" }]);
    expect(suggestions.get("sisyphus-junior")).toEqual([{ model: "p/high" }]);
    base.cleanup();
  });

  test("leaves later agents unchanged after the distinct probe budget is exhausted", async () => {
    const models = Object.fromEntries(Array.from({ length: 13 }, (_, index) => [`model-${String(index + 1).padStart(2, "0")}`, { capabilities: {} }]));
    const config = JSON.stringify({ general: {}, plan: {} });
    const provider = JSON.stringify({ connected: ["p"], all: [{ id: "p", models }] });
    const agents = JSON.stringify([
      { name: "general", mode: "subagent", model: { providerID: "missing", modelID: "default" } },
      { name: "plan", mode: "subagent", model: { providerID: "missing", modelID: "default" } },
    ]);
    const base = fixture(config, provider, agents, {});
    const calls: string[] = [];
    const deps: AgentModelsDeps = {
      ...base.deps,
      exec: async (command: string, timeout?: number): Promise<ExecResult> => {
        calls.push(command);
        if (command.includes('title:"model availability probe"')) {
          return { stdout: JSON.stringify({ info: { role: "assistant", error: "404 unavailable" } }), stderr: "", exitCode: 0 };
        }
        return base.deps.exec(command, timeout);
      },
    };

    const result = await createAgentModelReconciler(deps).reconcileAll();

    expect(result.changed).toBe(0);
    expect(probedModelIds(calls)).toHaveLength(12);
    expect(new Set(probedModelIds(calls)).size).toBe(12);
    base.cleanup();
  });

  test("observes a preset-only healthy assigned subagent via reconcile and suggest", async () => {
    const config = JSON.stringify({ general: {} });
    const provider = JSON.stringify({
      connected: ["p"],
      all: [{ id: "p", models: { alpha: { capabilities: { toolcall: true } } } }],
    });
    const agents = JSON.stringify([
      { name: "Preset-Only", mode: "subagent", model: { providerID: "p", modelID: "alpha" } },
    ]);
    const base = fixture(config, provider, agents, {});
    const deps = withPresetNames(base, ["preset-only"]);

    const suggestions = await createAgentModelReconciler(deps).suggest();
    expect(suggestions.get("preset-only")).toEqual([{ model: "p/alpha" }]);

    const logs: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      const result = await createAgentModelReconciler(deps).reconcileAll();
      expect(result.changed).toBe(0);
      expect(
        logs.some((line) => line.includes('"agent":"preset-only"') && line.includes('"decision":"keep_healthy_assigned"')),
      ).toBe(true);
    } finally {
      console.error = originalError;
      base.cleanup();
    }
  });

  test("excludes a live subagent absent from config and presets", async () => {
    const config = JSON.stringify({ general: {} });
    const provider = JSON.stringify({
      connected: ["p"],
      all: [{ id: "p", models: { alpha: { capabilities: { toolcall: true } } } }],
    });
    const agents = JSON.stringify([
      { name: "Mystery-Agent", mode: "subagent", model: { providerID: "p", modelID: "alpha" } },
    ]);
    const base = fixture(config, provider, agents, {});
    const deps = withPresetNames(base, ["preset-only"]);

    const suggestions = await createAgentModelReconciler(deps).suggest();
    expect(suggestions.has("mystery-agent")).toBe(false);
    base.cleanup();
  });

});
