import { describe, expect, test } from "bun:test";
import { createAgentModelsRoutes } from "./agent-models";
import type { AgentModelsDeps } from "../lib/agent-model-types";
import type { ExecResult } from "../lib/docker";

function stubDeps(cacheStdout: string): AgentModelsDeps {
  return {
    exec: async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes("agent-model-health.json")) return { stdout: cacheStdout, stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    restart: async () => ({ ok: true }),
    readEnv: () => ({ OPENCODE_SERVER_PASSWORD: "pw", OMO_ENABLED: "0" }),
  };
}

describe("unhealthy models route", () => {
  test("GET returns only unexpired terminal failures", async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const past = Math.floor(Date.now() / 1000) - 3600;
    const cache = {
      "p|f|p/dead": { providerID: "p", fingerprint: "f", status: "retired", reason: "gone", observedAt: new Date().toISOString(), retryAfter: future },
      "p|f|p/stale": { providerID: "p", fingerprint: "f", status: "retired", reason: "gone", observedAt: new Date().toISOString(), retryAfter: past },
      "p|f|p/quota": { providerID: "p", fingerprint: "f", status: "quota_exceeded", reason: "slow down", observedAt: new Date().toISOString(), retryAfter: future },
    };
    const app = createAgentModelsRoutes(stubDeps(JSON.stringify(cache)));
    const res = await app.request("http://localhost/api/agent-models/unhealthy");
    expect(res.status).toBe(200);
    const body = await res.json() as { unhealthy: Array<{ model: string; status: string }> };
    expect(body.unhealthy.map((u) => u.model)).toEqual(["p/dead"]);
  });

  test("GET returns empty list when cache is unavailable", async () => {
    const app = createAgentModelsRoutes(stubDeps(""));
    const res = await app.request("http://localhost/api/agent-models/unhealthy");
    expect(res.status).toBe(200);
    const body = await res.json() as { unhealthy: unknown[] };
    expect(body.unhealthy).toEqual([]);
  });
});
