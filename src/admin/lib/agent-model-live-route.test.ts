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
