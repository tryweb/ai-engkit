import type { AgentModelsDeps } from "../lib/agent-models";
import type { ExecResult } from "../lib/docker";

export interface ExecHandler {
  readonly match: RegExp;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}

type StubOptions = {
  readonly password?: string | null;
  readonly routingEnabled?: boolean;
};

export function stubDeps(
  handlers: readonly ExecHandler[],
  passwordOrOptions: string | null | StubOptions = "testpass",
) {
  const calls: string[] = [];
  let password: string | null;
  let routingEnabled = false;
  if (typeof passwordOrOptions === "string") {
    password = passwordOrOptions;
  } else if (passwordOrOptions === null) {
    password = null;
  } else {
    password = passwordOrOptions.password ?? "testpass";
    routingEnabled = passwordOrOptions.routingEnabled === true;
  }
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
    readEnv: (): Record<string, string> => ({
      ...(password === null ? {} : { OPENCODE_SERVER_PASSWORD: password }),
      ...(routingEnabled ? { OMO_ENABLED: "0" } : {}),
    }),
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
