import { beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fixture, readExecCommands, readRegistry, waitForExecCommand, clearReconcileLock } from "./providers-test-support";

const { default: providers } = await import("./providers");

describe("provider API-key note endpoints", () => {
  beforeEach(() => {
    clearReconcileLock();
  });

  test("POST triggers reconciliation after the first key restart succeeds", async () => {
    const f = await fixture(JSON.stringify({ providers: {} }), false);
    const previousPath = Bun.env.PROVIDER_KEYS_PATH;
    const previousExecutablePath = Bun.env.PATH;
    const previousAuth = Bun.env.FAKE_AUTH_JSON;
    const previousExecCalls = Bun.env.FAKE_EXEC_CALLS;
    Bun.env.PROVIDER_KEYS_PATH = f.registryPath;
    Bun.env.PATH = `${f.binPath}:${previousExecutablePath ?? ""}`;
    Bun.env.FAKE_AUTH_JSON = "{}";
    Bun.env.FAKE_EXEC_CALLS = f.execCallsPath;
    try {
      const response = await providers.request("http://localhost/api/providers/opencode-go/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "sk-new" }),
      });

      expect(response.status).toBe(200);
      const commands = await waitForExecCommand(f.execCallsPath, "agent-model-health.json");
      expect(commands.some((command) => command.includes("agent-model-health.json"))).toBe(true);
      expect(commands.some((command) => command.includes("/provider"))).toBe(true);
    } finally {
      if (previousPath === undefined) delete Bun.env.PROVIDER_KEYS_PATH;
      else Bun.env.PROVIDER_KEYS_PATH = previousPath;
      if (previousExecutablePath === undefined) delete Bun.env.PATH;
      else Bun.env.PATH = previousExecutablePath;
      if (previousAuth === undefined) delete Bun.env.FAKE_AUTH_JSON;
      else Bun.env.FAKE_AUTH_JSON = previousAuth;
      if (previousExecCalls === undefined) delete Bun.env.FAKE_EXEC_CALLS;
      else Bun.env.FAKE_EXEC_CALLS = previousExecCalls;
      await f.cleanup();
    }
  });

  test("POST rolls back the first registry key when applying it cannot restart ai-dev", async () => {
    const f = await fixture(JSON.stringify({ providers: {} }));
    const previousPath = Bun.env.PROVIDER_KEYS_PATH;
    const previousExecutablePath = Bun.env.PATH;
    const previousAuth = Bun.env.FAKE_AUTH_JSON;
    const previousExecCalls = Bun.env.FAKE_EXEC_CALLS;
    Bun.env.PROVIDER_KEYS_PATH = f.registryPath;
    Bun.env.PATH = `${f.binPath}:${previousExecutablePath ?? ""}`;
    Bun.env.FAKE_AUTH_JSON = "{}";
    Bun.env.FAKE_EXEC_CALLS = f.execCallsPath;
    try {
      const response = await providers.request("http://localhost/api/providers/opencode-go/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "sk-new", note: "primary" }),
      });

      expect(response.status).toBe(500);
      expect(await readRegistry(f.registryPath)).toEqual({ providers: {} });
      const commands = await readExecCommands(f.execCallsPath);
      expect(commands.some((command) => command.includes("agent-model-health.json"))).toBe(false);
    } finally {
      if (previousPath === undefined) delete Bun.env.PROVIDER_KEYS_PATH;
      else Bun.env.PROVIDER_KEYS_PATH = previousPath;
      if (previousExecutablePath === undefined) delete Bun.env.PATH;
      else Bun.env.PATH = previousExecutablePath;
      if (previousAuth === undefined) delete Bun.env.FAKE_AUTH_JSON;
      else Bun.env.FAKE_AUTH_JSON = previousAuth;
      if (previousExecCalls === undefined) delete Bun.env.FAKE_EXEC_CALLS;
      else Bun.env.FAKE_EXEC_CALLS = previousExecCalls;
      await f.cleanup();
    }
  });

  test("DELETE triggers reconciliation after the active key restart succeeds", async () => {
    const f = await fixture(JSON.stringify({
      providers: {
        "opencode-go": {
          keys: [{ id: "legacy", value: "sk-legacy", createdAt: "2026-01-01T00:00:00.000Z" }],
          activeKeyId: "legacy",
        },
      },
    }), false);
    const previousPath = Bun.env.PROVIDER_KEYS_PATH;
    const previousExecutablePath = Bun.env.PATH;
    const previousAuth = Bun.env.FAKE_AUTH_JSON;
    const previousExecCalls = Bun.env.FAKE_EXEC_CALLS;
    Bun.env.PROVIDER_KEYS_PATH = f.registryPath;
    Bun.env.PATH = `${f.binPath}:${previousExecutablePath ?? ""}`;
    Bun.env.FAKE_AUTH_JSON = JSON.stringify({ "opencode-go": { type: "api", key: "sk-legacy" } });
    Bun.env.FAKE_EXEC_CALLS = f.execCallsPath;
    try {
      const response = await providers.request("http://localhost/api/providers/opencode-go/keys/legacy", { method: "DELETE" });

      expect(response.status).toBe(200);
      const commands = await waitForExecCommand(f.execCallsPath, "agent-model-health.json");
      expect(commands.some((command) => command.includes("agent-model-health.json"))).toBe(true);
      expect(commands.some((command) => command.includes("/provider"))).toBe(true);
    } finally {
      if (previousPath === undefined) delete Bun.env.PROVIDER_KEYS_PATH;
      else Bun.env.PROVIDER_KEYS_PATH = previousPath;
      if (previousExecutablePath === undefined) delete Bun.env.PATH;
      else Bun.env.PATH = previousExecutablePath;
      if (previousAuth === undefined) delete Bun.env.FAKE_AUTH_JSON;
      else Bun.env.FAKE_AUTH_JSON = previousAuth;
      if (previousExecCalls === undefined) delete Bun.env.FAKE_EXEC_CALLS;
      else Bun.env.FAKE_EXEC_CALLS = previousExecCalls;
      await f.cleanup();
    }
  });

  test("PUT active restores the previous registry selection when ai-dev restart fails", async () => {
    const f = await fixture(JSON.stringify({
      providers: {
        "opencode-go": {
          keys: [
            { id: "old", value: "sk-old", createdAt: "2026-01-01T00:00:00.000Z" },
            { id: "new", value: "sk-new", createdAt: "2026-01-02T00:00:00.000Z" },
          ],
          activeKeyId: "old",
        },
      },
    }));
    const previousPath = Bun.env.PROVIDER_KEYS_PATH;
    const previousExecutablePath = Bun.env.PATH;
    const previousAuth = Bun.env.FAKE_AUTH_JSON;
    Bun.env.PROVIDER_KEYS_PATH = f.registryPath;
    Bun.env.PATH = `${f.binPath}:${previousExecutablePath ?? ""}`;
    Bun.env.FAKE_AUTH_JSON = JSON.stringify({ "opencode-go": { type: "api", key: "sk-old" } });
    try {
      const response = await providers.request("http://localhost/api/providers/opencode-go/keys/new/active", {
        method: "PUT",
      });

      expect(response.status).toBe(500);
      const registry = await readFile(f.registryPath, "utf8").then((value) => JSON.parse(value));
      expect(registry.providers["opencode-go"].activeKeyId).toBe("old");
    } finally {
      if (previousPath === undefined) delete Bun.env.PROVIDER_KEYS_PATH;
      else Bun.env.PROVIDER_KEYS_PATH = previousPath;
      if (previousExecutablePath === undefined) delete Bun.env.PATH;
      else Bun.env.PATH = previousExecutablePath;
      if (previousAuth === undefined) delete Bun.env.FAKE_AUTH_JSON;
      else Bun.env.FAKE_AUTH_JSON = previousAuth;
      await f.cleanup();
    }
  });

  test("POST first key returns 409 when the auth store holds an OAuth connection", async () => {
    const f = await fixture(JSON.stringify({ providers: {} }));
    const previousPath = Bun.env.PROVIDER_KEYS_PATH;
    const previousExecutablePath = Bun.env.PATH;
    const previousAuth = Bun.env.FAKE_AUTH_JSON;
    Bun.env.PROVIDER_KEYS_PATH = f.registryPath;
    Bun.env.PATH = `${f.binPath}:${previousExecutablePath ?? ""}`;
    Bun.env.FAKE_AUTH_JSON = JSON.stringify({
      openai: { type: "oauth", access: "at", refresh: "rt", expires: 1 },
    });
    try {
      const response = await providers.request("http://localhost/api/providers/openai/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "sk-new", note: "primary" }),
      });

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error).toContain("Disconnect ChatGPT Pro/Plus");
      expect(await readRegistry(f.registryPath)).toEqual({ providers: {} });
    } finally {
      if (previousPath === undefined) delete Bun.env.PROVIDER_KEYS_PATH;
      else Bun.env.PROVIDER_KEYS_PATH = previousPath;
      if (previousExecutablePath === undefined) delete Bun.env.PATH;
      else Bun.env.PATH = previousExecutablePath;
      if (previousAuth === undefined) delete Bun.env.FAKE_AUTH_JSON;
      else Bun.env.FAKE_AUTH_JSON = previousAuth;
      await f.cleanup();
    }
  });
});
