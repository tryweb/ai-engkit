import { beforeEach, describe, expect, test } from "bun:test";
import { clearReconcileLock, fixture, readRegistry } from "./providers-test-support";

const { default: providers } = await import("./providers");

describe("provider API-key note persistence", () => {
  beforeEach(() => {
    clearReconcileLock();
  });

  test("POST adds a note without changing legacy keys", async () => {
    const f = await fixture(JSON.stringify({
      providers: {
        "opencode-go": {
          keys: [{ id: "legacy", value: "sk-legacy", createdAt: "2026-01-01T00:00:00.000Z" }],
          activeKeyId: "legacy",
        },
      },
    }));
    const previousPath = Bun.env.PROVIDER_KEYS_PATH;
    Bun.env.PROVIDER_KEYS_PATH = f.registryPath;
    try {
      const response = await providers.request("http://localhost/api/providers/opencode-go/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "sk-new", note: "billing account" }),
      });

      expect(response.status).toBe(200);
      const registry = await readRegistry(f.registryPath);
      expect(registry.providers["opencode-go"]?.keys[0]).toEqual({
        id: "legacy",
        value: "sk-legacy",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      expect(registry.providers["opencode-go"]?.keys[1]?.note).toBe("billing account");
    } finally {
      if (previousPath === undefined) delete Bun.env.PROVIDER_KEYS_PATH;
      else Bun.env.PROVIDER_KEYS_PATH = previousPath;
      await f.cleanup();
    }
  });

  test("PUT updates a legacy key note and persists it", async () => {
    const f = await fixture(JSON.stringify({
      providers: {
        "opencode-go": {
          keys: [{ id: "legacy", value: "sk-legacy", createdAt: "2026-01-01T00:00:00.000Z" }],
          activeKeyId: "legacy",
        },
      },
    }));
    const previousPath = Bun.env.PROVIDER_KEYS_PATH;
    Bun.env.PROVIDER_KEYS_PATH = f.registryPath;
    try {
      const response = await providers.request("http://localhost/api/providers/opencode-go/keys/legacy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: "rotated in July" }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      const registry = await readRegistry(f.registryPath);
      expect(registry.providers["opencode-go"]?.keys[0]).toEqual({
        id: "legacy",
        value: "sk-legacy",
        note: "rotated in July",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
    } finally {
      if (previousPath === undefined) delete Bun.env.PROVIDER_KEYS_PATH;
      else Bun.env.PROVIDER_KEYS_PATH = previousPath;
      await f.cleanup();
    }
  });
});
