import { describe, expect, test } from "bun:test";
import { createAgentModelsRoutes } from "./agent-models";
import type { AgentModelsDeps } from "../lib/agent-model-types";
import type { ExecResult } from "../lib/docker";

function stubDeps(policyStdout: string, writeOk = true): { deps: AgentModelsDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: AgentModelsDeps = {
    exec: async (cmd: string): Promise<ExecResult> => {
      calls.push(cmd);
      if (cmd.includes("agent-model-policy.json") && cmd.startsWith("cat")) return { stdout: policyStdout, stderr: "", exitCode: 0 };
      if (cmd.includes("agent-model-policy.json")) return { stdout: "", stderr: writeOk ? "" : "fail", exitCode: writeOk ? 0 : 1 };
      if (cmd.includes("jq -c")) return { stdout: '{"version":1,"chains":{}}', stderr: "", exitCode: 0 };
      if (cmd.includes("routing.json")) return { stdout: '{"version":1,"chains":{}}', stderr: "", exitCode: 0 };
      if (cmd.includes("/api/provider") || cmd.includes("/provider")) return { stdout: JSON.stringify({ data: [{ id: "openai" }] }), stderr: "", exitCode: 0 };
      if (cmd.includes("/api/model")) return { stdout: JSON.stringify({ data: [] }), stderr: "", exitCode: 0 };
      if (cmd.includes("/api/agent")) return { stdout: JSON.stringify({ data: [] }), stderr: "", exitCode: 0 };
      if (cmd.includes("/agent")) return { stdout: "[]", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    restart: async () => ({ ok: true }),
    readEnv: () => ({ OPENCODE_SERVER_PASSWORD: "pw", OMO_ENABLED: "0" }),
  };
  return { deps, calls };
}

describe("policy routes", () => {
  test("GET returns persisted mode, defaults to free", async () => {
    const { deps } = stubDeps('{"mode":"economy"}');
    const app = createAgentModelsRoutes(deps);
    const res = await app.request("http://localhost/api/agent-models/policy");
    expect(res.status).toBe(200);
    const body = await res.json() as { mode: string };
    expect(body.mode).toBe("economy");
  });

  test("PUT invalid mode 400", async () => {
    const { deps } = stubDeps('{"mode":"free"}');
    const app = createAgentModelsRoutes(deps);
    const res = await app.request("http://localhost/api/agent-models/policy", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "invalid" }) });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("mode must be");
  });

  test("PUT valid persists and GET reflects", async () => {
    let stored = '{"mode":"free"}';
    const deps: AgentModelsDeps = {
      exec: async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes("cat") && cmd.includes("agent-model-policy.json")) return { stdout: stored, stderr: "", exitCode: 0 };
        if (cmd.includes("agent-model-policy.json")) {
          const b64 = cmd.match(/'([A-Za-z0-9+/=]+)'/)?.[1];
          if (b64) stored = Buffer.from(b64, "base64").toString();
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (cmd.includes("jq -c")) return { stdout: '{"version":1,"chains":{}}', stderr: "", exitCode: 0 };
        if (cmd.includes("routing.json")) return { stdout: '{"version":1,"chains":{}}', stderr: "", exitCode: 0 };
        if (cmd.includes("/api/provider") || cmd.includes("/provider")) return { stdout: JSON.stringify({ data: [{ id: "openai" }] }), stderr: "", exitCode: 0 };
        if (cmd.includes("/api/model")) return { stdout: JSON.stringify({ data: [] }), stderr: "", exitCode: 0 };
        if (cmd.includes("/api/agent")) return { stdout: JSON.stringify({ data: [] }), stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      restart: async () => ({ ok: true }),
      readEnv: () => ({ OPENCODE_SERVER_PASSWORD: "pw", OMO_ENABLED: "0" }),
    };
    const app = createAgentModelsRoutes(deps);
    const put = await app.request("http://localhost/api/agent-models/policy", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "performance" }) });
    expect(put.status).toBe(200);
    const get = await app.request("http://localhost/api/agent-models/policy");
    const body = await get.json() as { mode: string };
    expect(body.mode).toBe("performance");
  });

  test("policy route not shadowed by :agent param", async () => {
    const { deps } = stubDeps('{"mode":"free"}');
    const app = createAgentModelsRoutes(deps);
    const res = await app.request("http://localhost/api/agent-models/policy");
    expect(res.status).toBe(200);
    const bad = await app.request("http://localhost/api/agent-models/policy", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    expect(bad.status).toBe(400);
  });
});
