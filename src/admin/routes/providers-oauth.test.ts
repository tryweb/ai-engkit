import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { default: providersOAuth, __resetReconcileAgentModelsForTest, __setReconcileAgentModelsForTest } = await import("./providers-oauth");
const reconcileAgentModels = mock(async () => {});

interface OAuthFixture {
  binPath: string;
  execCallsPath: string;
  cleanup: () => Promise<void>;
}

async function fixture(restartFails: boolean): Promise<OAuthFixture> {
  const directory = await mkdtemp(join(tmpdir(), "providers-oauth-"));
  const binPath = join(directory, "bin");
  const execCallsPath = join(directory, "exec-calls");
  await mkdir(binPath);
  const dockerPath = join(binPath, "docker");
  const restartExit = restartFails ? 1 : 0;
  await writeFile(dockerPath, `#!/bin/sh
case "$1" in
  exec) printf '%s\n' "$FAKE_AUTH_JSON"; [ -z "$FAKE_EXEC_CALLS" ] || printf '%s\n' "$*" >> "$FAKE_EXEC_CALLS"; exit 0 ;;
  restart|compose) echo 'restart failed' >&2; exit ${restartExit} ;;
  inspect|ps) exit 0 ;;
  *) exit 1 ;;
esac
`);
  await chmod(dockerPath, 0o755);
  return { binPath, execCallsPath, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

async function readExecCommands(path: string): Promise<string[]> {
  const content = await readFile(path, "utf8").catch(() => "");
  return content.split("\n").filter(Boolean);
}

async function waitForExecCommand(path: string, pattern: string): Promise<string[]> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const commands = await readExecCommands(path);
    if (commands.some((command) => command.includes(pattern))) return commands;
    await Bun.sleep(0);
  }
  return readExecCommands(path);
}

const USERCODE_BODY = {
  device_auth_id: "da-1",
  user_code: "ABCD-EFGH",
  interval: "5",
  expires_in: 600,
  verification_uri: "https://auth.openai.com/codex/device",
};

function oauthFetchStub(): typeof fetch {
  const stub = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/api/accounts/deviceauth/usercode")) {
      return new Response(JSON.stringify(USERCODE_BODY), { status: 200 });
    }
    if (url.includes("/api/accounts/deviceauth/token")) {
      return new Response(JSON.stringify({ authorization_code: "ac-1", code_verifier: "cv-1" }), { status: 200 });
    }
    if (url.includes("/oauth/token")) {
      return new Response(
        JSON.stringify({
          id_token: "h.eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY2MtMSJ9.s",
          access_token: "at-1",
          refresh_token: "rt-1",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({}), { status: 500 });
  };
  return Object.assign(stub, { preconnect: fetch.preconnect });
}

async function startFlow(): Promise<string> {
  const response = await providersOAuth.request("http://localhost/start", { method: "POST" });
  expect(response.status).toBe(200);
  const body = await response.json();
  return body.flowId as string;
}

describe("providers OAuth routes", () => {
  beforeEach(() => {
    reconcileAgentModels.mockClear();
    __setReconcileAgentModelsForTest(reconcileAgentModels);
    rmSync(join(process.env.HOME ?? "", ".cache/openchamber/agent-model-reconcile.lock"), { recursive: true, force: true });
  });

  afterEach(() => {
    __resetReconcileAgentModelsForTest();
  });

  test("POST /start returns a non-sensitive flow payload", async () => {
    const f = await fixture(false);
    const previousPath = Bun.env.PATH;
    const originalFetch = globalThis.fetch;
    Bun.env.PATH = `${f.binPath}:${previousPath ?? ""}`;
    globalThis.fetch = oauthFetchStub();
    try {
      const response = await providersOAuth.request("http://localhost/start", { method: "POST" });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.flowId).toContain("oauth-");
      expect(body.userCode).toBe("ABCD-EFGH");
      expect(body.verificationUri).toBe("https://auth.openai.com/codex/device");
      expect(body.intervalSec).toBe(5);
      expect(body.expiresInSec).toBe(600);
      expect(body.deviceAuthId).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain("da-1");
    } finally {
      globalThis.fetch = originalFetch;
      if (previousPath === undefined) delete Bun.env.PATH;
      else Bun.env.PATH = previousPath;
      await f.cleanup();
    }
  });

  test("POST /poll reports pending then ready", async () => {
    const f = await fixture(false);
    const previousPath = Bun.env.PATH;
    const originalFetch = globalThis.fetch;
    Bun.env.PATH = `${f.binPath}:${previousPath ?? ""}`;
    let pollCount = 0;
    const pollFetchStub = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/api/accounts/deviceauth/usercode")) {
        return new Response(JSON.stringify(USERCODE_BODY), { status: 200 });
      }
      if (url.includes("/api/accounts/deviceauth/token")) {
        pollCount += 1;
        if (pollCount === 1) return new Response(JSON.stringify({}), { status: 403 });
        return new Response(JSON.stringify({ authorization_code: "ac-1", code_verifier: "cv-1" }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 500 });
    };
    globalThis.fetch = Object.assign(pollFetchStub, { preconnect: originalFetch.preconnect });
    try {
      const flowId = await startFlow();
      const pending = await providersOAuth.request("http://localhost/poll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flowId }),
      });
      expect((await pending.json()).status).toBe("pending");
      const ready = await providersOAuth.request("http://localhost/poll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flowId }),
      });
      expect((await ready.json()).status).toBe("ready");
    } finally {
      globalThis.fetch = originalFetch;
      if (previousPath === undefined) delete Bun.env.PATH;
      else Bun.env.PATH = previousPath;
      await f.cleanup();
    }
  });

  test("POST /apply writes the credential and reports connected", async () => {
    const f = await fixture(false);
    const previousPath = Bun.env.PATH;
    const previousAuth = Bun.env.FAKE_AUTH_JSON;
    const previousExecCalls = Bun.env.FAKE_EXEC_CALLS;
    const originalFetch = globalThis.fetch;
    Bun.env.PATH = `${f.binPath}:${previousPath ?? ""}`;
    Bun.env.FAKE_AUTH_JSON = "{}";
    Bun.env.FAKE_EXEC_CALLS = f.execCallsPath;
    globalThis.fetch = oauthFetchStub();
    try {
      const flowId = await startFlow();
      await providersOAuth.request("http://localhost/poll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flowId }),
      });
      const apply = await providersOAuth.request("http://localhost/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flowId }),
      });
      expect(apply.status).toBe(200);
      expect(await apply.json()).toEqual({ ok: true, connected: true });
      expect(reconcileAgentModels).toHaveBeenCalledTimes(1);
      const commands = await waitForExecCommand(f.execCallsPath, "agent-model-health.json");
      expect(commands.some((command) => command.includes("agent-model-health.json"))).toBe(true);
      expect(commands.some((command) => command.includes("/provider"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousPath === undefined) delete Bun.env.PATH;
      else Bun.env.PATH = previousPath;
      if (previousAuth === undefined) delete Bun.env.FAKE_AUTH_JSON;
      else Bun.env.FAKE_AUTH_JSON = previousAuth;
      if (previousExecCalls === undefined) delete Bun.env.FAKE_EXEC_CALLS;
      else Bun.env.FAKE_EXEC_CALLS = previousExecCalls;
      await f.cleanup();
    }
  });

  test("POST /apply reverts the credential when ai-dev restart fails", async () => {
    const f = await fixture(true);
    const previousPath = Bun.env.PATH;
    const previousAuth = Bun.env.FAKE_AUTH_JSON;
    const previousExecCalls = Bun.env.FAKE_EXEC_CALLS;
    const originalFetch = globalThis.fetch;
    Bun.env.PATH = `${f.binPath}:${previousPath ?? ""}`;
    Bun.env.FAKE_AUTH_JSON = "{}";
    Bun.env.FAKE_EXEC_CALLS = f.execCallsPath;
    globalThis.fetch = oauthFetchStub();
    try {
      const flowId = await startFlow();
      await providersOAuth.request("http://localhost/poll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flowId }),
      });
      const apply = await providersOAuth.request("http://localhost/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flowId }),
      });
      expect(apply.status).toBe(500);
      const body = await apply.json();
      expect(body.error).toContain("ai-dev restart failed");
      expect(body.error).toContain("connection reverted");
      expect(body.error).toContain("rollback incomplete");
      expect(reconcileAgentModels).not.toHaveBeenCalled();
      const commands = await readExecCommands(f.execCallsPath);
      expect(commands.some((command) => command.includes("agent-model-health.json"))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousPath === undefined) delete Bun.env.PATH;
      else Bun.env.PATH = previousPath;
      if (previousAuth === undefined) delete Bun.env.FAKE_AUTH_JSON;
      else Bun.env.FAKE_AUTH_JSON = previousAuth;
      if (previousExecCalls === undefined) delete Bun.env.FAKE_EXEC_CALLS;
      else Bun.env.FAKE_EXEC_CALLS = previousExecCalls;
      await f.cleanup();
    }
  });

  test("POST /disconnect triggers reconciliation after restart succeeds", async () => {
    const f = await fixture(false);
    const previousPath = Bun.env.PATH;
    const previousExecCalls = Bun.env.FAKE_EXEC_CALLS;
    const originalFetch = globalThis.fetch;
    Bun.env.PATH = `${f.binPath}:${previousPath ?? ""}`;
    Bun.env.FAKE_EXEC_CALLS = f.execCallsPath;
    globalThis.fetch = oauthFetchStub();
    try {
      const response = await providersOAuth.request("http://localhost/disconnect", { method: "POST" });

      expect(response.status).toBe(200);
      expect(reconcileAgentModels).toHaveBeenCalledTimes(1);
      const commands = await waitForExecCommand(f.execCallsPath, "agent-model-health.json");
      expect(commands.some((command) => command.includes("agent-model-health.json"))).toBe(true);
      expect(commands.some((command) => command.includes("/provider"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousPath === undefined) delete Bun.env.PATH;
      else Bun.env.PATH = previousPath;
      if (previousExecCalls === undefined) delete Bun.env.FAKE_EXEC_CALLS;
      else Bun.env.FAKE_EXEC_CALLS = previousExecCalls;
      await f.cleanup();
    }
  });

  test("POST /apply rejects an unknown or expired flow", async () => {
    const f = await fixture(false);
    const previousPath = Bun.env.PATH;
    Bun.env.PATH = `${f.binPath}:${previousPath ?? ""}`;
    try {
      const response = await providersOAuth.request("http://localhost/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flowId: "oauth-missing" }),
      });
      expect(response.status).toBe(409);
    } finally {
      if (previousPath === undefined) delete Bun.env.PATH;
      else Bun.env.PATH = previousPath;
      await f.cleanup();
    }
  });
});
