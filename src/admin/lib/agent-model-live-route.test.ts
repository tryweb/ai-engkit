import { describe, expect, test } from "bun:test";
import { createAgentModelLiveClient } from "./agent-model-live";

describe("buildRequestVerificationScript agent routing", () => {
  test("message POST body carries the agent so verification runs as the specified agent", async () => {
    const exec = async (command: string, _timeoutMs?: number) => {
      expect(command).toContain('jq -nc --arg agent "$AGENT"');
      expect(command).toContain('{agent:$agent,parts:[{type:"text",text:"Reply with exactly OK."}]}');
      expect(command).toContain("SESSION");
      return { exitCode: 0, stdout: JSON.stringify({ info: { role: "assistant", modelID: "mimo-v2.5-free", providerID: "opencode" } }), stderr: "" };
    };
    const lib = createAgentModelLiveClient({ exec });
    const result = await lib.fetchSuccessfulRequestModel("pass", "explore");
    expect(result).toEqual({ modelID: "mimo-v2.5-free", providerID: "opencode" });
  });
});

describe("fetchSubagentNames V2-first with V1 fallback", () => {
  test("V2 success: parses /api/agent wrapped response and returns subagent ids", async () => {
    const v2Payload = JSON.stringify({
      location: { directory: "/home/devuser" },
      data: [
        { id: "build", name: "Build", mode: "primary" },
        { id: "general", name: "General", mode: "subagent" },
        { id: "explore", name: "Explore", mode: "subagent" },
        { id: "plan", name: "Plan", mode: "primary" },
      ],
    });
    const calls: string[] = [];
    const exec = async (command: string, _timeoutMs?: number) => {
      calls.push(command);
      if (command.includes("/api/agent")) return { exitCode: 0, stdout: v2Payload, stderr: "" };
      return { exitCode: 0, stdout: "[]", stderr: "" };
    };
    const lib = createAgentModelLiveClient({ exec });
    const names = await lib.fetchSubagentNames("testpass");
    expect(names).toEqual(["general", "explore"]);
    expect(calls[0]).toContain("/api/agent");
    expect(calls).toHaveLength(1);
    const expectedAuth = Buffer.from("opencode:testpass").toString("base64");
    expect(calls[0]).toContain(`Authorization: Basic ${expectedAuth}`);
  });

  test("V2 fail fallback: V2 returns HTML (parse null) then falls back to V1 /agent array", async () => {
    const v1Payload = JSON.stringify([
      { name: "general", mode: "subagent" },
      { name: "explore", mode: "subagent" },
      { name: "build", mode: "primary" },
    ]);
    const calls: string[] = [];
    const exec = async (command: string, _timeoutMs?: number) => {
      calls.push(command);
      if (command.includes("/api/agent")) return { exitCode: 0, stdout: "<!doctype html>", stderr: "" };
      if (command.includes("\"/agent\"") || command.endsWith("/agent\"") || command.includes(" /agent")) return { exitCode: 0, stdout: v1Payload, stderr: "" };
      if (command.includes("/agent")) {
        return { exitCode: 0, stdout: v1Payload, stderr: "" };
      }
      return { exitCode: 0, stdout: v1Payload, stderr: "" };
    };
    const lib = createAgentModelLiveClient({ exec });
    const names = await lib.fetchSubagentNames("testpass");
    expect(names).toEqual(["general", "explore"]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("/api/agent");
    expect(calls[1]).toContain("/agent");
    expect(calls[1]).not.toContain("/api/agent");
  });

  test("V2 unreachable (exit 2): falls back to V1 and preserves byte-identical V1 behavior", async () => {
    const v1Payload = JSON.stringify([
      { name: "librarian", mode: "subagent" },
      { name: "oracle", mode: "subagent" },
    ]);
    const calls: string[] = [];
    const exec = async (command: string, _timeoutMs?: number) => {
      calls.push(command);
      if (command.includes("/api/agent")) return { exitCode: 2, stdout: "", stderr: "curl failed" };
      return { exitCode: 0, stdout: v1Payload, stderr: "" };
    };
    const lib = createAgentModelLiveClient({ exec });
    const names = await lib.fetchSubagentNames("testpass");
    expect(names).toEqual(["librarian", "oracle"]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("/api/agent");
    expect(calls[1]).toContain("/agent");
  });

  test("V1 unchanged: when both fail, returns empty array", async () => {
    const exec = async () => ({ exitCode: 2, stdout: "", stderr: "" });
    const lib = createAgentModelLiveClient({ exec });
    expect(await lib.fetchSubagentNames("pass")).toEqual([]);
  });
});

describe("fetchProviderSnapshot V2-first with split provider/model", () => {
  test("V2 success: merges /api/provider + /api/model into live catalog", async () => {
    const v2Providers = JSON.stringify({
      location: { directory: "/home/devuser" },
      data: [
        { id: "opencode-go", name: "OpenCode Go" },
        { id: "openrouter", name: "OpenRouter" },
      ],
    });
    const v2Models = JSON.stringify({
      location: { directory: "/home/devuser" },
      data: [
        { id: "longcat-2.5-preview-free", providerID: "opencode-go", enabled: true, status: "active" },
        { id: "mimo-v2.5-free", providerID: "opencode-go", enabled: true, status: "active" },
        { id: "qwen/qwen3-coder-free", providerID: "openrouter", enabled: true, status: "active" },
        { id: "beta-model", providerID: "openrouter", enabled: true, status: "beta" },
        { id: "disabled-model", providerID: "openrouter", enabled: false, status: "active" },
      ],
    });
    const calls: string[] = [];
    const exec = async (command: string, _timeoutMs?: number) => {
      calls.push(command);
      if (command.includes("/api/provider")) return { exitCode: 0, stdout: v2Providers, stderr: "" };
      if (command.includes("/api/model")) return { exitCode: 0, stdout: v2Models, stderr: "" };
      return { exitCode: 2, stdout: "", stderr: "" };
    };
    const lib = createAgentModelLiveClient({ exec });
    const snap = await lib.fetchProviderSnapshot("testpass");
    expect(snap.source).toBe("live");
    expect(snap.connectedProviders).toEqual(["opencode-go", "openrouter"]);
    expect(snap.catalog).toEqual([
      "opencode-go/longcat-2.5-preview-free",
      "opencode-go/mimo-v2.5-free",
      "openrouter/qwen/qwen3-coder-free",
    ]);
    expect(calls[0]).toContain("/api/provider");
    expect(calls[1]).toContain("/api/model");
    expect(calls).toHaveLength(2);
    const expectedAuth = Buffer.from("opencode:testpass").toString("base64");
    expect(calls[0]).toContain(`Authorization: Basic ${expectedAuth}`);
  });

  test("V2 fail fallback: V2 returns HTML then falls back to V1 /provider", async () => {
    const v1Payload = JSON.stringify({
      connected: ["opencode-go"],
      all: [{ id: "opencode-go", models: { "longcat-2.5-preview-free": {}, "mimo-v2.5-free": {} } }],
    });
    const calls: string[] = [];
    const exec = async (command: string, _timeoutMs?: number) => {
      calls.push(command);
      if (command.includes("/api/provider")) return { exitCode: 0, stdout: "<!doctype html>", stderr: "" };
      if (command.includes("/provider") && !command.includes("/api/")) return { exitCode: 0, stdout: v1Payload, stderr: "" };
      return { exitCode: 0, stdout: "<!doctype html>", stderr: "" };
    };
    const lib = createAgentModelLiveClient({ exec });
    const snap = await lib.fetchProviderSnapshot("testpass");
    expect(snap.source).toBe("live");
    expect(snap.connectedProviders).toEqual(["opencode-go"]);
    expect(snap.catalog).toEqual(["opencode-go/longcat-2.5-preview-free", "opencode-go/mimo-v2.5-free"]);
    expect(calls[0]).toContain("/api/provider");
    expect(calls[1]).toContain("/provider");
    expect(calls[1]).not.toContain("/api/provider");
  });

  test("V2 model unreachable (exit 2): falls back to V1", async () => {
    const v2Providers = JSON.stringify({
      location: { directory: "/home/devuser" },
      data: [{ id: "opencode-go" }],
    });
    const v1Payload = JSON.stringify({
      connected: ["opencode-go"],
      all: [{ id: "opencode-go", models: { "fallback-model": {} } }],
    });
    const calls: string[] = [];
    const exec = async (command: string, _timeoutMs?: number) => {
      calls.push(command);
      if (command.includes("/api/provider")) return { exitCode: 0, stdout: v2Providers, stderr: "" };
      if (command.includes("/api/model")) return { exitCode: 2, stdout: "", stderr: "curl failed" };
      if (command.includes("/provider") && !command.includes("/api/")) return { exitCode: 0, stdout: v1Payload, stderr: "" };
      return { exitCode: 2, stdout: "", stderr: "" };
    };
    const lib = createAgentModelLiveClient({ exec });
    const snap = await lib.fetchProviderSnapshot("testpass");
    expect(snap.source).toBe("live");
    expect(snap.catalog).toEqual(["opencode-go/fallback-model"]);
    expect(calls).toHaveLength(3);
  });

  test("both V2 and V1 fail: preserves unavailable with cache chain exhausted", async () => {
    const exec = async (command: string, _timeoutMs?: number) => {
      if (command.includes("/api/provider") || command.includes("/api/model") || command.includes("/provider")) {
        return { exitCode: 2, stdout: "", stderr: "" };
      }
      if (command.includes("connected-providers.json")) return { exitCode: 1, stdout: "", stderr: "" };
      if (command.includes("models.json")) return { exitCode: 1, stdout: "", stderr: "" };
      return { exitCode: 1, stdout: "", stderr: "" };
    };
    const lib = createAgentModelLiveClient({ exec });
    const snap = await lib.fetchProviderSnapshot("testpass");
    expect(snap).toEqual({ connectedProviders: [], catalog: [], source: "unavailable" });
  });

  test("password null skips live and returns unavailable when cache empty", async () => {
    const exec = async (command: string, _timeoutMs?: number) => {
      if (command.includes("connected-providers.json") || command.includes("models.json")) return { exitCode: 1, stdout: "", stderr: "" };
      throw new Error(`unexpected exec: ${command}`);
    };
    const lib = createAgentModelLiveClient({ exec });
    const snap = await lib.fetchProviderSnapshot(null);
    expect(snap.source).toBe("unavailable");
    expect(snap.catalog).toEqual([]);
  });
});
