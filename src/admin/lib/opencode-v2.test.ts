import { beforeEach, describe, expect, mock, test } from "bun:test";
import { __resetExecForTest, __setExecForTest } from "./opencode-v2";
import type { ExecResult } from "./docker";

describe("opencode-v2 adapter", () => {
  beforeEach(() => {
    __resetExecForTest();
  });

  test("listIntegrations parses JSON and uses default directory", async () => {
    const calls: string[] = [];
    const execMock = mock(async (cmd: string): Promise<ExecResult> => {
      calls.push(cmd);
      return { stdout: JSON.stringify({ location: { directory: "/home/devuser" }, data: [{ id: "openai", name: "OpenAI", methods: [{ type: "key" }], connections: [] }] }), stderr: "", exitCode: 0 };
    });
    __setExecForTest(execMock);
    const { listIntegrations } = await import("./opencode-v2");
    const res = await listIntegrations();
    expect(res.data[0].id).toBe("openai");
    expect(calls[0]).toContain("integration.list");
    expect(calls[0]).toContain("location.directory");
    expect(calls[0]).toContain("/home/devuser");
  });

  test("listIntegrations propagates error when exec fails", async () => {
    const execMock = mock(async (): Promise<ExecResult> => ({ stdout: "", stderr: "fail", exitCode: 1 }));
    __setExecForTest(execMock);
    const { listIntegrations } = await import("./opencode-v2");
    await expect(listIntegrations()).rejects.toThrow();
  });

  test("connectKey builds payload with label and answer", async () => {
    const calls: string[] = [];
    const execMock = mock(async (cmd: string): Promise<ExecResult> => {
      calls.push(cmd);
      const m = cmd.match(/B64='([^']+)'/);
      if (m) {
        const decoded = Buffer.from(m[1], "base64").toString("utf-8");
        expect(decoded).toContain("my-res");
        expect(decoded).toContain("sk-azure");
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    __setExecForTest(execMock);
    const { connectKey } = await import("./opencode-v2");
    await connectKey("azure", "sk-azure", { label: "note", answer: { resourceName: "my-res" } });
    expect(calls[0]).toContain("integration.connect.key");
    expect(calls[0]).toContain("azure");
    expect(calls[0]).not.toContain("sk-azure");
    expect(calls[0]).toMatch(/B64='/);
  });

  test("connectKey without answer still succeeds", async () => {
    const execMock = mock(async (): Promise<ExecResult> => ({ stdout: "", stderr: "", exitCode: 0 }));
    __setExecForTest(execMock);
    const { connectKey } = await import("./opencode-v2");
    await connectKey("anthropic", "sk-123", { label: "lbl" });
  });

  test("credentialActivate and Remove and Update call correct ops", async () => {
    const ops: string[] = [];
    const execMock = mock(async (cmd: string): Promise<ExecResult> => {
      ops.push(cmd);
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    __setExecForTest(execMock);
    const { credentialActivate, credentialRemove, credentialUpdate } = await import("./opencode-v2");
    await credentialActivate("cred_123");
    await credentialRemove("cred_123");
    await credentialUpdate("cred_123", "new label");
    expect(ops[0]).toContain("credential.activate");
    expect(ops[0]).toContain("cred_123");
    expect(ops[1]).toContain("credential.remove");
    expect(ops[2]).toContain("credential.update");
    const m2 = ops[2].match(/B64='([^']+)'/);
    if (m2) expect(Buffer.from(m2[1], "base64").toString("utf-8")).toContain("new label");
    else expect(ops[2]).toContain("new label");
  });

  test("oauthConnect parses attempt and url", async () => {
    const execMock = mock(async (): Promise<ExecResult> => ({
      stdout: JSON.stringify({ location: {}, data: { attemptID: "con_123", url: "https://example.com/auth", instructions: "go" } }),
      stderr: "",
      exitCode: 0,
    }));
    __setExecForTest(execMock);
    const { oauthConnect } = await import("./opencode-v2");
    const r = await oauthConnect("openai", "chatgpt-browser");
    expect(r.attemptID).toBe("con_123");
    expect(r.url).toBe("https://example.com/auth");
  });

  test("oauthStatus and Cancel handle", async () => {
    const execMock = mock(async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes("integration.oauth.status")) {
        return { stdout: JSON.stringify({ location: {}, data: { status: "pending", time: { created: 1, expires: 2 } } }), stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    __setExecForTest(execMock);
    const { oauthStatus, oauthCancel } = await import("./opencode-v2");
    const s = await oauthStatus("openai", "con_123");
    expect(s.status).toBe("pending");
    await oauthCancel("openai", "con_123");
  });

  test("wellknownAdd forwards url", async () => {
    const seen: string[] = [];
    const execMock = mock(async (cmd: string): Promise<ExecResult> => {
      seen.push(cmd);
      const m = cmd.match(/B64='([^']+)'/);
      if (m) expect(Buffer.from(m[1], "base64").toString("utf-8")).toContain("example.com/provider.json");
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    __setExecForTest(execMock);
    const { wellknownAdd } = await import("./opencode-v2");
    await wellknownAdd("https://example.com/provider.json");
    expect(seen[0]).toContain("integration.wellknown.add");
  });

  test("isOpenCodeV2 detects version string", async () => {
    const execMock1 = mock(async (): Promise<ExecResult> => ({ stdout: "opencode v2.0.15", stderr: "", exitCode: 0 }));
    __setExecForTest(execMock1);
    const { isOpenCodeV2 } = await import("./opencode-v2");
    expect(await isOpenCodeV2()).toBe(true);
    const execMock2 = mock(async (): Promise<ExecResult> => ({ stdout: "1.18.32", stderr: "", exitCode: 0 }));
    __setExecForTest(execMock2);
    expect(await isOpenCodeV2()).toBe(false);
  });

  test("connectKey error is surfaced", async () => {
    const execMock = mock(async (): Promise<ExecResult> => ({ stdout: "", stderr: "auth failed", exitCode: 1 }));
    __setExecForTest(execMock);
    const { connectKey } = await import("./opencode-v2");
    await expect(connectKey("anthropic", "bad")).rejects.toThrow();
  });

  test("malicious integrationID cannot inject commands", async () => {
    const calls: string[] = [];
    const execMock = mock(async (cmd: string): Promise<ExecResult> => {
      calls.push(cmd);
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    __setExecForTest(execMock);
    const { connectKey } = await import("./opencode-v2");
    await expect(connectKey("anthropic; rm -rf /", "sk-123")).rejects.toThrow();
    await expect(connectKey("anthropic\"`; echo pwned`", "sk-123")).rejects.toThrow();
    expect(calls.length).toBe(0);
  });

  test("malformed JSON response throws", async () => {
    const execMock = mock(async (): Promise<ExecResult> => ({ stdout: "not-json", stderr: "", exitCode: 0 }));
    __setExecForTest(execMock);
    const { listIntegrations } = await import("./opencode-v2");
    await expect(listIntegrations()).rejects.toThrow();
  });

  test("unknown version fails closed", async () => {
    const execMock = mock(async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes("opencode --version")) return { stdout: "opencode v9.9.9", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    __setExecForTest(execMock);
    const { isOpenCodeV2 } = await import("./opencode-v2");
    await expect(isOpenCodeV2()).rejects.toThrow();
  });

  test("custom editor entries retain models and settings without exposing API keys", async () => {
    __setExecForTest(async () => ({
      stdout: JSON.stringify({ custom: { package: "@opencode/ai/providers/openai-compatible", models: { coder: { name: "Coder" } }, settings: { baseURL: "https://example.com/v1", apiKey: "private-fixture", timeout: 12000 } } }),
      stderr: "", exitCode: 0,
    }));
    const { readV2ProviderEntries } = await import("./opencode-v2");
    const entries = await readV2ProviderEntries();
    expect(entries.custom).toMatchObject({ npm: "@opencode/ai/providers/openai-compatible", models: { coder: { name: "Coder" } }, options: { timeout: 12000 } });
    expect(JSON.stringify(entries)).not.toContain("private-fixture");
  });
});
