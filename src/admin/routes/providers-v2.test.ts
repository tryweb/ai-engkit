import { beforeEach, afterEach, describe, expect, mock, test } from "bun:test";
import { readFileSync, existsSync, unlinkSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { __resetExecForTest, __setExecForTest } from "../lib/opencode-v2";
import type { ExecResult } from "../lib/docker";

const ENV_PATH = "/opt/ai-engkit/.env";

function backupEnv(): string | null {
  if (!existsSync(ENV_PATH)) return null;
  return readFileSync(ENV_PATH, "utf-8");
}
function restoreEnv(content: string | null): void {
  if (content === null) {
    try { unlinkSync(ENV_PATH); } catch {}
  } else {
    writeFileSync(ENV_PATH, content, "utf-8");
  }
}

describe("providers V2 routes", () => {
  let originalEnv: string | null = null;
  let credStore: Map<string, Array<{ id: string; label: string; method: "key" | "oauth" }>>;
  let v2FileProviders: Map<string, Record<string, unknown>>;
  let tempKeysPath: string | null = null;

  beforeEach(() => {
    originalEnv = backupEnv();
    credStore = new Map();
    v2FileProviders = new Map();
    __resetExecForTest();
    const dir = join(tmpdir(), `pk-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    tempKeysPath = join(dir, "provider-keys.json");
    writeFileSync(tempKeysPath, JSON.stringify({ providers: {} }));
    Bun.env.PROVIDER_KEYS_PATH = tempKeysPath;
  });

  afterEach(() => {
    __resetExecForTest();
    restoreEnv(originalEnv);
    if (tempKeysPath) {
      try { unlinkSync(tempKeysPath); } catch {}
      try { rmSync(dirname(tempKeysPath), { recursive: true }); } catch {}
    }
    delete Bun.env.PROVIDER_KEYS_PATH;
  });

  function mockV2(): void {
    function extractParam(cmd: string, key: string): string | null {
      const re1 = new RegExp(key + "='([^']+)'");
      const m1 = cmd.match(re1);
      if (m1) return m1[1];
      const re2 = new RegExp(key + '="([^"]+)"');
      const m2 = cmd.match(re2);
      if (m2) return m2[1];
      const re3 = new RegExp(key + "=([^\\s'\"]+)");
      const m3 = cmd.match(re3);
      if (m3) return m3[1].replace(/^'|'$/g, "");
      return null;
    }
    function extractPayload(cmd: string): Record<string, unknown> | null {
      const b64m = cmd.match(/B64='([^']+)'/);
      if (b64m) {
        try { return JSON.parse(Buffer.from(b64m[1], "base64").toString("utf-8")) as Record<string, unknown>; } catch { return null; }
      }
      const dMatch = cmd.match(/-d '(.+)'$/);
      if (dMatch) { try { return JSON.parse(dMatch[1]) as Record<string, unknown>; } catch { return null; } }
      return null;
    }
    const execMock = mock(async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes("opencode --version")) {
        return { stdout: "opencode v2.0.15", stderr: "", exitCode: 0 };
      }
      if (cmd.includes("--arg name") && cmd.includes(".providers")) {
        const nameMatch = cmd.match(/--arg name '([^']+)'/);
        const name = nameMatch ? nameMatch[1] : null;
        const b64m = cmd.match(/B64='([^']+)'/);
        if (b64m && name) {
          try {
            const val = JSON.parse(Buffer.from(b64m[1], "base64").toString("utf-8")) as Record<string, unknown>;
            v2FileProviders.set(name, val);
          } catch {}
        } else if (cmd.includes("del(.providers")) {
          if (name) v2FileProviders.delete(name);
        }
        if (cmd.includes("opencode reload")) {
          return { stdout: "Configuration reloaded", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (cmd.includes("opencode reload")) {
        return { stdout: "Configuration reloaded", stderr: "", exitCode: 0 };
      }
      if (cmd.includes("provider.list")) {
        const data = Array.from(v2FileProviders.entries()).map(([id, ent]) => ({
          id,
          name: (ent.name as string) ?? id,
          package: (ent.package as string) ?? "",
          settings: (ent as Record<string, unknown>).settings ?? {},
          models: (ent as Record<string, unknown>).models ?? {},
        }));
        return { stdout: JSON.stringify({ location: { directory: "/home/devuser" }, data }), stderr: "", exitCode: 0 };
      }
      if (cmd.includes("integration.list")) {
        const data = [
          { id: "anthropic", name: "Anthropic", methods: [{ type: "key" }], connections: (credStore.get("anthropic") ?? []).map((c) => ({ type: "credential", id: c.id, label: c.label, method: c.method })) },
          { id: "openai", name: "OpenAI", methods: [{ type: "key" }, { type: "oauth", id: "chatgpt-browser", label: "ChatGPT" }], connections: (credStore.get("openai") ?? []).map((c) => ({ type: "credential", id: c.id, label: c.label, method: c.method })) },
          { id: "azure", name: "Azure", methods: [{ type: "key", label: "API key", form: [{ key: "resourceName" }] }], connections: (credStore.get("azure") ?? []).map((c) => ({ type: "credential", id: c.id, label: c.label, method: c.method })) },
          { id: "google", name: "Google", methods: [{ type: "key" }], connections: (credStore.get("google") ?? []).map((c) => ({ type: "credential", id: c.id, label: c.label, method: c.method })) },
        ];
        return { stdout: JSON.stringify({ location: { directory: "/home/devuser" }, data }), stderr: "", exitCode: 0 };
      }
      if (cmd.includes("integration.connect.key")) {
        const id = extractParam(cmd, "integrationID") ?? "unknown";
        const payload = extractPayload(cmd);
        let label = "test";
        let hasAnswer = false;
        if (payload) {
          label = (payload.label as string) ?? "test";
          hasAnswer = !!payload.answer;
        }
        if (id === "azure" && !hasAnswer) {
          return { stdout: "", stderr: "missing resourceName", exitCode: 1 };
        }
        const cred = { id: `cred_${Math.random().toString(36).slice(2, 8)}`, label, method: "key" as const };
        const arr = credStore.get(id) ?? [];
        arr.unshift(cred);
        credStore.set(id, arr);
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (cmd.includes("credential.activate")) {
        const cid = extractParam(cmd, "credentialID") ?? "";
        for (const [k, arr] of credStore.entries()) {
          const idx = arr.findIndex((c) => c.id === cid);
          if (idx > 0) {
            const [item] = arr.splice(idx, 1);
            if (item) { arr.unshift(item); }
            credStore.set(k, arr);
          }
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (cmd.includes("credential.remove")) {
        const cid = extractParam(cmd, "credentialID") ?? "";
        for (const [k, arr] of credStore.entries()) {
          credStore.set(k, arr.filter((c) => c.id !== cid));
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (cmd.includes("credential.update")) {
        const cid = extractParam(cmd, "credentialID") ?? "";
        const payload = extractPayload(cmd);
        let label = "";
        if (payload) label = (payload.label as string) ?? "";
        for (const arr of credStore.values()) {
          const c = arr.find((x) => x.id === cid);
          if (c) c.label = label;
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (cmd.includes("integration.oauth.connect")) {
        return { stdout: JSON.stringify({ location: { directory: "/home/devuser" }, data: { attemptID: "con_123", url: "https://auth.openai.com/oauth/authorize?x=1", instructions: "go auth" } }), stderr: "", exitCode: 0 };
      }
      if (cmd.includes("integration.oauth.status")) {
        return { stdout: JSON.stringify({ location: { directory: "/home/devuser" }, data: { status: "pending", time: { created: 1, expires: 2 } } }), stderr: "", exitCode: 0 };
      }
      if (cmd.includes("integration.oauth.cancel")) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (cmd.includes("integration.wellknown.add")) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    __setExecForTest(execMock);
  }

  test("V2 custom provider via env roundtrip", async () => {
    mockV2();
    const { default: providers } = await import("./providers");

    const put = await providers.request("http://localhost/api/providers/my-custom-v2", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: { npm: "@ai-sdk/openai-compatible", name: "My Custom", options: { baseURL: "https://api.example.com/v1" }, models: { "my-model": {} } } }),
    });
    expect(put.status).toBe(200);
    const putJson = await put.json() as { ok: boolean };
    expect(putJson.ok).toBe(true);

    const get = await providers.request("http://localhost/api/providers");
    const body = await get.json() as { providers: Array<{ name: string; npm: string; baseURL: string }> };
    const found = body.providers.find((p) => p.name === "my-custom-v2");
    expect(found).toBeDefined();
    expect(found?.npm).toBe("@opencode/ai/providers/openai-compatible");
    expect(found?.baseURL).toBe("https://api.example.com/v1");

    const del = await providers.request("http://localhost/api/providers/my-custom-v2", { method: "DELETE" });
    expect(del.status).toBe(200);
    const get2 = await providers.request("http://localhost/api/providers");
    const body2 = await get2.json() as { providers: Array<{ name: string }> };
    expect(body2.providers.some((p) => p.name === "my-custom-v2")).toBe(false);
  });

  test("V2 key CRUD with answer and activation", async () => {
    mockV2();
    const { default: providers } = await import("./providers");

    const addFail = await providers.request("http://localhost/api/providers/azure/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "sk-az", answer: { resourceName: "my-res" } }),
    });
    expect(addFail.status).toBe(200);

    const addOk = await providers.request("http://localhost/api/providers/azure/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "sk-az", answer: { resourceName: "my-res" }, note: "az-label" }),
    });
    expect(addOk.status).toBe(200);

    const list1 = await providers.request("http://localhost/api/providers");
    const j1 = await list1.json() as { providers: Array<{ name: string; registry: { keyCount: number; keys: Array<{ id: string; note: string }> } }> };
    const az1 = j1.providers.find((p) => p.name === "azure")!;
    expect(az1.registry.keyCount).toBe(2);

    await providers.request("http://localhost/api/providers/anthropic/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "sk-a1", note: "first" }),
    });
    await providers.request("http://localhost/api/providers/anthropic/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "sk-a2", note: "second" }),
    });
    const list2 = await (await providers.request("http://localhost/api/providers")).json() as { providers: Array<{ name: string; registry: { keys: Array<{ id: string; note: string; active: boolean }> } }> };
    const anth = list2.providers.find((p) => p.name === "anthropic")!;
    expect(anth.registry.keys.length).toBe(2);
    const secondId = anth.registry.keys.find((k) => k.note === "first")!.id;
    const upd = await providers.request(`http://localhost/api/providers/anthropic/keys/${secondId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "renamed" }),
    });
    expect(upd.status).toBe(200);
    const act = await providers.request(`http://localhost/api/providers/anthropic/keys/${secondId}/active`, { method: "PUT" });
    expect(act.status).toBe(200);
    const list3 = await (await providers.request("http://localhost/api/providers")).json() as { providers: Array<{ name: string; registry: { keys: Array<{ id: string; active: boolean }> } }> };
    const anth3 = list3.providers.find((p) => p.name === "anthropic")!;
    expect(anth3.registry.keys.find((k) => k.id === secondId)?.active).toBe(true);

    const firstId = az1.registry.keys[0].id;
    const del = await providers.request(`http://localhost/api/providers/azure/keys/${firstId}`, { method: "DELETE" });
    expect(del.status).toBe(200);
  });

  test("V2 OAuth start/status/cancel", async () => {
    mockV2();
    const { default: providers } = await import("./providers");

    const start = await providers.request("http://localhost/api/providers/openai/oauth/v2/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ methodID: "chatgpt-browser" }),
    });
    expect(start.status).toBe(200);
    const { attemptID, url } = await start.json() as { attemptID: string; url: string };
    expect(attemptID).toBe("con_123");
    expect(url).toContain("https://");

    const status = await providers.request(`http://localhost/api/providers/openai/oauth/v2/status/${attemptID}`);
    expect(status.status).toBe(200);
    const sj = await status.json() as { status: string };
    expect(sj.status).toBe("pending");

    const cancel = await providers.request(`http://localhost/api/providers/openai/oauth/v2/${attemptID}`, { method: "DELETE" });
    expect(cancel.status).toBe(200);
  });

  test("wellknown validation", async () => {
    mockV2();
    const { default: providers } = await import("./providers");

    const bad = await providers.request("http://localhost/api/providers/wellknown", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(bad.status).toBe(400);

    const ok = await providers.request("http://localhost/api/providers/wellknown", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/provider.json" }),
    });
    if (ok.status !== 200) console.log("wellknown valid body", await ok.clone().text());
    expect(ok.status).toBe(200);
  });

  test("invalid provider payload returns 400", async () => {
    mockV2();
    const { default: providers } = await import("./providers");
    const res = await providers.request("http://localhost/api/providers/bad", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: { npm: 123 } }),
    });
    expect(res.status).toBe(400);
    const err = await res.json() as { error: string };
    expect(err.error).toContain("Invalid provider");
  });

  test("missing key returns 400", async () => {
    mockV2();
    const { default: providers } = await import("./providers");
    const res = await providers.request("http://localhost/api/providers/anthropic/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "" }),
    });
    expect(res.status).toBe(400);
  });
});
