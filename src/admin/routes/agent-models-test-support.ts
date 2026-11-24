import type { AgentModelsDeps } from "../lib/agent-models";
import type { ExecResult } from "../lib/docker";
import { createTestReconcileLock } from "../lib/agent-model-reconciler-test-support";
import type { RoutingConfig } from "../lib/agent-model-types";

/** Native V2 wire-format fixture; deliberately provides no OMO config or cache. */
export function nativeFixture(options: {
  routing?: RoutingConfig;
  requestModel?: string | null;
  password?: string | null;
  failWrite?: boolean;
  connected?: string[];
} = {}) {
  const routing = options.routing ?? { version: 1, chains: {
    general: { chain: [{ model: "opencode/big-pickle" }] },
    explore: { chain: [{ model: "opencode/big-pickle" }] },
  } };
  const calls: string[] = [];
  let restarts = 0;
  const deps: AgentModelsDeps = {
    reconcileLockPath: createTestReconcileLock(),
    readEnv: () => options.password === null ? {} : { OPENCODE_SERVER_PASSWORD: options.password ?? "pw" },
    restart: async () => { restarts++; return { ok: true }; },
    exec: async (command) => {
      calls.push(command);
      const out = (value: unknown, exitCode = 0) => ({ stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: exitCode ? "jq routing write failed" : "", exitCode });
      if (command.includes("snap_r=")) return out("/tmp/routing-snap:/tmp/opencode-snap");
      if (command.includes("jq -c '.'")) return out(routing);
      if (command.includes(".chains[$agent]")) return out("", options.failWrite ? 1 : 0);
      if (command.includes("agent-model-pinned.json")) return out({ version: 1, agents: [] });
      if (command.includes("/api/provider")) return out({ data: (options.connected ?? ["opencode"]).map((id) => ({ id })) });
      if (command.includes("/api/model")) return out({ data: [{ id: "big-pickle", providerID: "opencode", enabled: true, status: "active" }] });
      if (command.includes("/api/agent")) return out({ data: ["general", "explore", "librarian", "build"].map((id) => ({ id, mode: id === "build" ? "primary" : "subagent", model: { id: "big-pickle", providerID: "opencode" } })) });
      if (command.includes("/api/session")) {
        const model = options.requestModel === undefined ? "opencode/big-pickle" : options.requestModel;
        if (!model) return out({});
        const info = { type: "assistant", model: { id: model.split("/").slice(1).join("/"), providerID: model.split("/")[0] } };
        if (command.includes('AGENT=')) return out({ data: info });
        return out({ models: Object.keys(routing.chains).map((agent) => ({ agent, modelID: info.model.id, providerID: info.model.providerID, completedAt: 100 })), truncated: false });
      }
      return out("");
    },
  };
  return { deps, calls, routing, get restarts() { return restarts; } };
}

export interface ExecHandler {
  readonly match: RegExp;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}

export function stubDeps(handlers: readonly ExecHandler[], password: string | null = "testpass") {
  const calls: string[] = [];
  const deps: AgentModelsDeps = {
    exec: async (command: string, _timeoutMs?: number): Promise<ExecResult> => {
      calls.push(command);
      for (const handler of handlers) {
        if (handler.match.test(command)) {
          return {
            stdout: handler.stdout ?? "",
            stderr: handler.stderr ?? "",
            exitCode: handler.exitCode ?? 0,
          };
        }
      }
      if (command.includes(".native-agent-overrides.tmp")) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (command.includes("/provider")) {
        return {
          stdout: JSON.stringify({
            connected: ["opencode"],
            all: [{ id: "opencode", models: { "big-pickle": {} } }],
          }),
          stderr: "",
          exitCode: 0,
        };
      }
      if (command.includes("/api/session")) {
        return {
          stdout: JSON.stringify([
            { agent: "plan", modelID: "kimi-k3", providerID: "opencode-go", completedAt: 1 },
            { agent: "general", modelID: "big-pickle", providerID: "opencode", completedAt: 1 },
          ]),
          stderr: "",
          exitCode: 0,
        };
      }
      if (command.includes("$BASE/session")) {
        return {
          stdout: JSON.stringify({ info: { role: "assistant", modelID: "big-pickle", providerID: "opencode" } }),
          stderr: "",
          exitCode: 0,
        };
      }
      if (command.includes("~/.cache/opencode/models.json")) {
        return {
          stdout: JSON.stringify({ opencode: { models: { "big-pickle": {} } } }),
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "", exitCode: 1 };
    },
    restart: async () => ({ ok: true }),
    readEnv: (): Record<string, string> => password === null ? {} : { OPENCODE_SERVER_PASSWORD: password },
    reconcileLockPath: createTestReconcileLock(),
  };
  return {
    deps,
    calls,
    cleanup: () => {},
  };
}

export const CONFIG_JSON =
  '{"plan":{"model":"opencode-go/kimi-k3","variant":"max","fallback_models":[{"model":"opencode-go/qwen3.7-plus"}]},"prometheus":{"model":"opencode-go/kimi-k3"}}';

export const AGENTS_JSON = JSON.stringify([
  { name: "plan", mode: "subagent", model: { modelID: "kimi-k3", providerID: "opencode-go" } },
  { name: "oracle", mode: "primary", model: { modelID: "gpt-5.6-sol", providerID: "openai" } },
]);

export function listHandlers(): readonly ExecHandler[] {
  return [
    { match: /\/api\/provider\b/, stdout: '{"data":[{"id":"openai"},{"id":"opencode-go"}]}' },
    { match: /\/api\/model\b/, stdout: '{"data":[{"id":"gpt-5.6-sol","providerID":"openai","status":"active","enabled":true},{"id":"kimi-k3","providerID":"opencode-go","status":"active","enabled":true}]}' },
    { match: /jq -c '\.agents/, stdout: CONFIG_JSON },
    {
      match: /\/provider\b/,
      stdout: JSON.stringify({
        connected: ["openai", "opencode-go"],
        all: [
          { id: "openai", models: { "gpt-5.6-sol": {} } },
          { id: "opencode-go", models: { "kimi-k3": {} } },
        ],
      }),
    },
    {
      match: /\/api\/session/,
      stdout: JSON.stringify([{ agent: "plan", modelID: "kimi-k3", providerID: "opencode-go", completedAt: 1 }]),
    },
    {
      match: /\$BASE\/session/,
      stdout: JSON.stringify({ info: { role: "assistant", modelID: "kimi-k3", providerID: "opencode-go" } }),
    },
    { match: /connected-providers\.json/, stdout: '{"connected":["openai","opencode-go"]}' },
    { match: /provider-models\.json/, stdout: "openai/gpt-5.6-sol\nopencode-go/kimi-k3\n" },
    { match: /\/agent\b/, stdout: AGENTS_JSON },
  ];
}
