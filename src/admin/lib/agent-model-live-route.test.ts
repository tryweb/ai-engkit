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

  test("managed endpoint discovery uses $HOME form (tilde never expands after variable expansion)", async () => {
    const calls: string[] = [];
    const exec = async (command: string, _timeoutMs?: number) => {
      calls.push(command);
      return { exitCode: 2, stdout: "", stderr: "" };
    };
    const lib = createAgentModelLiveClient({ exec });
    await lib.fetchSubagentNames("pass").catch(() => {});
    const joined = calls.join("\n");
    expect(joined).toContain("$HOME/.config/openchamber/managed-opencode");
    expect(joined).not.toContain('"~/.config');
    expect(joined).not.toContain(" ~/.config");
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

describe("fetchSuccessfulRequestModel V2 gated on OMO_ENABLED=0", () => {
  test("V2: under OMO_ENABLED=0 creates session via /api/session, prompts via /api/session/{id}/prompt, deletes via /api/session/{id} with location scoping and jq-safe JSON", async () => {
    const prev = process.env.OMO_ENABLED;
    process.env.OMO_ENABLED = "0";
    try {
      const calls: string[] = [];
      const exec = async (command: string, _timeoutMs?: number) => {
        calls.push(command);
        expect(command).toContain("/api/session");
        expect(command).toContain("/api/session/${SESSION}/prompt");
        expect(command).toContain("/api/experimental/session/${SESSION}/wait");
        expect(command).toContain("/api/session/${SESSION}/message");
        expect(command).toContain("location");
        expect(command).toContain("/home/devuser/workspace");
        expect(command).toContain("jq -nc");
        expect(command).toContain("prompt");
        expect(command).toContain("'{agent:$agent,text:");
        expect(command).toContain('.agent==$agent');
        expect(command).toContain(".data.id");
        expect(command).toContain('DELETE "$BASE/api/session/${SESSION}"');
        expect(command).toContain('"$BASE/api/session"');
        return { exitCode: 0, stdout: JSON.stringify({ data: { type: "assistant", model: { id: "kimi-k3", providerID: "opencode-go" } } }), stderr: "" };
      };
      const lib = createAgentModelLiveClient({ exec });
      const result = await lib.fetchSuccessfulRequestModel("pass", "explore");
      expect(result).toEqual({ modelID: "kimi-k3", providerID: "opencode-go" });
      expect(calls).toHaveLength(1);
    } finally {
      if (prev === undefined) delete process.env.OMO_ENABLED;
      else process.env.OMO_ENABLED = prev;
    }
  });

  test("V2 request script pins the head model at session create when a model ref is provided", async () => {
    const prev = process.env.OMO_ENABLED;
    process.env.OMO_ENABLED = "0";
    try {
      const calls: string[] = [];
      const exec = async (command: string, _timeoutMs?: number) => {
        calls.push(command);
        return { exitCode: 0, stdout: JSON.stringify({ data: { type: "assistant", agent: "explore", model: { id: "kimi-k3", providerID: "opencode-go" }, error: null } }), stderr: "" };
      };
      const lib = createAgentModelLiveClient({ exec });
      const result = await lib.fetchSuccessfulRequestModel("pass", "explore", { providerID: "opencode-go", modelID: "kimi-k3" });
      expect(result).toEqual({ modelID: "kimi-k3", providerID: "opencode-go" });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain(Buffer.from("kimi-k3").toString("base64"));
      expect(calls[0]).toContain(Buffer.from("opencode-go").toString("base64"));
      expect(calls[0]).toContain("--argjson model");
      expect(calls[0]).toContain("/api/experimental/session/${SESSION}/wait");
    } finally {
      if (prev === undefined) delete process.env.OMO_ENABLED;
      else process.env.OMO_ENABLED = prev;
    }
  });

  test("V2 parser: handles wrapped {data,...} with model.id/providerID fields", async () => {
    const prev = process.env.OMO_ENABLED;
    process.env.OMO_ENABLED = "0";
    try {
      const wrapped = JSON.stringify({ data: { type: "assistant", model: { id: "longcat-2.5-preview-free", providerID: "opencode-go" } } });
      const exec = async () => ({ exitCode: 0, stdout: wrapped, stderr: "" });
      const lib = createAgentModelLiveClient({ exec });
      const result = await lib.fetchSuccessfulRequestModel("pass", "librarian");
      expect(result).toEqual({ modelID: "longcat-2.5-preview-free", providerID: "opencode-go" });
    } finally {
      if (prev === undefined) delete process.env.OMO_ENABLED;
      else process.env.OMO_ENABLED = prev;
    }
  });

  test("V2 parser: handles message list envelope {data:[...]} with last assistant model", async () => {
    const prev = process.env.OMO_ENABLED;
    process.env.OMO_ENABLED = "0";
    try {
      const listWrapped = JSON.stringify({
        data: [
          { type: "user", text: "hi" },
          { type: "assistant", model: { id: "gpt-4o", providerID: "openai" }, error: null },
        ],
        cursor: { next: null, previous: null },
      });
      const exec2 = async () => ({ exitCode: 0, stdout: listWrapped, stderr: "" });
      const lib = createAgentModelLiveClient({ exec: exec2 });
      const result = await lib.fetchSuccessfulRequestModel("pass", "explore");
      expect(result).toEqual({ modelID: "gpt-4o", providerID: "openai" });
    } finally {
      if (prev === undefined) delete process.env.OMO_ENABLED;
      else process.env.OMO_ENABLED = prev;
    }
  });

  test("V1 remains byte-behavior unchanged when OMO_ENABLED !=0", async () => {
    const prev = process.env.OMO_ENABLED;
    delete process.env.OMO_ENABLED;
    try {
      const exec = async (command: string, _timeoutMs?: number) => {
        expect(command).toContain('jq -nc --arg agent "$AGENT"');
        expect(command).toContain('{agent:$agent,parts:[{type:"text",text:"Reply with exactly OK."}]}');
        expect(command).toContain('"$BASE/session"');
        expect(command).not.toContain("/api/session");
        return { exitCode: 0, stdout: JSON.stringify({ info: { role: "assistant", modelID: "mimo-v2.5-free", providerID: "opencode" } }), stderr: "" };
      };
      const lib = createAgentModelLiveClient({ exec });
      const result = await lib.fetchSuccessfulRequestModel("pass", "explore");
      expect(result).toEqual({ modelID: "mimo-v2.5-free", providerID: "opencode" });
    } finally {
      if (prev === undefined) delete process.env.OMO_ENABLED;
      else process.env.OMO_ENABLED = prev;
    }
  });
});

describe("buildRecentRequestScript V2 wrapped envelopes", () => {
  test("V2 recent lookup uses wrapped V2 session/message responses with location scoping", async () => {
    const prev = process.env.OMO_ENABLED;
    process.env.OMO_ENABLED = "0";
    try {
      const calls: string[] = [];
      const exec = async (command: string, _timeoutMs?: number) => {
        calls.push(command);
        expect(command).toContain("/api/session");
        expect(command).toContain("location");
        expect(command).toContain(".data");
        expect(command).toContain('/api/session/${SESSION}/message');
        expect(command).toContain('.agent==$agent');
        expect(command).toContain("model.id");
        expect(command).toContain("providerID");
        return { exitCode: 0, stdout: JSON.stringify({ info: { role: "assistant", modelID: "kimi-k3", providerID: "opencode-go" } }), stderr: "" };
      };
      const lib = createAgentModelLiveClient({ exec });
      const result = await lib.fetchRecentSuccessfulRequestModel("pass", "explore");
      expect(calls[0]).toContain("/api/session");
      expect(result).not.toBeNull();
    } finally {
      if (prev === undefined) delete process.env.OMO_ENABLED;
      else process.env.OMO_ENABLED = prev;
    }
  });

  test("V1 recent lookup unchanged when OMO_ENABLED !=0 uses bare /session", async () => {
    const prev = process.env.OMO_ENABLED;
    delete process.env.OMO_ENABLED;
    try {
      const exec = async (command: string, _timeoutMs?: number) => {
        expect(command).toContain('"$BASE/session?limit=100"');
        expect(command).toContain('"$BASE/session/${SESSION}/message"');
        expect(command).not.toContain("/api/session");
        return { exitCode: 0, stdout: JSON.stringify({ info: { role: "assistant", modelID: "mimo-v2.5-free", providerID: "opencode" } }), stderr: "" };
      };
      const lib = createAgentModelLiveClient({ exec });
      const result = await lib.fetchRecentSuccessfulRequestModel("pass", "explore");
      expect(result).toEqual({ modelID: "mimo-v2.5-free", providerID: "opencode" });
    } finally {
      if (prev === undefined) delete process.env.OMO_ENABLED;
      else process.env.OMO_ENABLED = prev;
    }
  });
});
