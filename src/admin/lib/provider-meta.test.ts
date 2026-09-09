import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectProvidersMeta, type ProvidersMetaDeps } from "./provider-meta";
import { maskKey } from "./provider-keys";

const authStoreKeys = new Map<string, string | null>();
const authStoreOAuth = new Map<string, boolean>();
const stubDeps: ProvidersMetaDeps = {
  readAuthKey: (provider) => Promise.resolve(authStoreKeys.get(provider) ?? null),
  readOAuthPresence: (provider) => Promise.resolve(authStoreOAuth.get(provider) ?? false),
};

interface RegistryFixture {
  registryPath: string;
  cleanup: () => Promise<void>;
}

/** Point PROVIDER_KEYS_PATH at a tmp registry (seeded or absent) for one test. */
async function withRegistry(seed: string | null, run: (f: RegistryFixture) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "provider-meta-"));
  const registryPath = join(directory, "provider-keys.json");
  if (seed !== null) await writeFile(registryPath, seed);
  const previousPath = Bun.env.PROVIDER_KEYS_PATH;
  Bun.env.PROVIDER_KEYS_PATH = registryPath;
  try {
    await run({ registryPath, cleanup: () => rm(directory, { recursive: true, force: true }) });
  } finally {
    if (previousPath === undefined) delete Bun.env.PROVIDER_KEYS_PATH;
    else Bun.env.PROVIDER_KEYS_PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
}

describe("collectProvidersMeta", () => {
  test("returns invalid:false with no configured providers when the registry file is missing", async () => {
    // CI has no /opt/ai-engkit/.env, so readEnvFile() yields {} and
    // OPENCODE_PROVIDER is empty. Key-managed providers still surface as
    // virtual cards, so the assertion pins: nothing configured, nothing from
    // a registry that does not exist.
    await withRegistry(null, async () => {
      const meta = await collectProvidersMeta(stubDeps);
      expect(meta.invalid).toBe(false);
      expect(meta.error).toBeNull();
      expect(meta.providers.filter((p) => !p.virtual)).toEqual([]);
      for (const provider of meta.providers) {
        expect(provider.registry.keyCount).toBe(0);
        expect(provider.registry.keys).toEqual([]);
      }
    });
  });

  test("masks a seeded registry key and never exposes the raw value", async () => {
    const rawKey = "sk-live-1234567890abcdef";
    const seed = JSON.stringify({
      providers: {
        "opencode-go": {
          keys: [{ id: "k1", value: rawKey, createdAt: "2026-01-01T00:00:00.000Z" }],
          activeKeyId: "k1",
        },
      },
    });
    await withRegistry(seed, async () => {
      const meta = await collectProvidersMeta(stubDeps);
      const provider = meta.providers.find((p) => p.name === "opencode-go");
      expect(provider).toBeDefined();
      expect(provider?.registry.keyCount).toBe(1);
      expect(provider?.registry.activeKeyId).toBe("k1");
      const key = provider?.registry.keys[0];
      expect(key?.masked).toBe(maskKey(rawKey));
      expect(key?.active).toBe(true);
      expect(JSON.stringify(meta)).not.toContain(rawKey);
    });
  });

  test("surfaces openai as a key-managed virtual card with OAuth metadata", async () => {
    const seed = JSON.stringify({
      providers: {
        openai: {
          keys: [{ id: "k1", value: "sk-openai-1", createdAt: "2026-01-01T00:00:00.000Z" }],
          activeKeyId: "k1",
        },
      },
    });
    await withRegistry(seed, async () => {
      const meta = await collectProvidersMeta(stubDeps);
      const openai = meta.providers.find((p) => p.name === "openai");
      expect(openai).toBeDefined();
      expect(openai?.label).toBe("OpenAI API");
      expect(openai?.virtual).toBe(true);
      expect(openai?.keyManagement).toBe(true);
      expect(openai?.oauthManaged).toBe(true);
      expect(typeof openai?.oauthConnected).toBe("boolean");
      expect(openai?.registry.keyCount).toBe(1);
      expect(openai?.registry.activeKeyId).toBe("k1");
    });
  });

  test("surfaces openrouter as a key-managed virtual card", async () => {
    const seed = JSON.stringify({
      providers: {
        openrouter: {
          keys: [{ id: "k1", value: "sk-or-1", createdAt: "2026-01-01T00:00:00.000Z" }],
          activeKeyId: "k1",
        },
      },
    });
    await withRegistry(seed, async () => {
      const meta = await collectProvidersMeta(stubDeps);
      const openrouter = meta.providers.find((p) => p.name === "openrouter");
      expect(openrouter).toBeDefined();
      expect(openrouter?.label).toBe("OpenRouter");
      expect(openrouter?.virtual).toBe(true);
      expect(openrouter?.keyManagement).toBe(true);
      expect(openrouter?.oauthManaged).toBe(false);
      expect(openrouter?.registry.keyCount).toBe(1);
      expect(openrouter?.registry.activeKeyId).toBe("k1");
      expect(JSON.stringify(meta)).not.toContain("sk-or-1");
    });
  });

  test("surfaces google as a key-managed virtual card", async () => {
    const seed = JSON.stringify({
      providers: {
        google: {
          keys: [{ id: "k1", value: "AIzaSyTest123456789", createdAt: "2026-01-01T00:00:00.000Z" }],
          activeKeyId: "k1",
        },
      },
    });
    await withRegistry(seed, async () => {
      const meta = await collectProvidersMeta(stubDeps);
      const google = meta.providers.find((p) => p.name === "google");
      expect(google).toBeDefined();
      expect(google?.label).toBe("Google");
      expect(google?.virtual).toBe(true);
      expect(google?.keyManagement).toBe(true);
      expect(google?.oauthManaged).toBe(false);
      expect(google?.registry.keyCount).toBe(1);
      expect(google?.registry.activeKeyId).toBe("k1");
      expect(JSON.stringify(meta)).not.toContain("AIzaSyTest123456789");
    });
  });

  test("auto-imports an auth-store key into an empty registry and masks it", async () => {
    const rawKey = "nvapi-sk-autoimport-1234567890";
    authStoreKeys.set("nvidia", rawKey);
    try {
      await withRegistry(null, async (fixture) => {
        const meta = await collectProvidersMeta(stubDeps);
        const nvidia = meta.providers.find((p) => p.name === "nvidia");
        expect(nvidia).toBeDefined();
        expect(nvidia?.registry.keyCount).toBe(1);
        expect(nvidia?.registry.keys[0]?.masked).toBe(maskKey(rawKey));
        expect(nvidia?.registry.keys[0]?.note).toBe("imported from auth store");
        expect(nvidia?.registry.keys[0]?.active).toBe(true);
        expect(JSON.stringify(meta)).not.toContain(rawKey);
        const persisted = JSON.parse(await Bun.file(fixture.registryPath).text());
        expect(persisted.providers.nvidia.keys).toHaveLength(1);
        expect(persisted.providers.nvidia.keys[0].value).toBe(rawKey);
      });
    } finally {
      authStoreKeys.delete("nvidia");
    }
  });

  test("re-collecting does not duplicate the imported key", async () => {
    const rawKey = "nvapi-sk-idempotent-1234567890";
    authStoreKeys.set("nvidia", rawKey);
    try {
      await withRegistry(null, async () => {
        await collectProvidersMeta(stubDeps);
        const second = await collectProvidersMeta(stubDeps);
        const nvidia = second.providers.find((p) => p.name === "nvidia");
        expect(nvidia?.registry.keyCount).toBe(1);
      });
    } finally {
      authStoreKeys.delete("nvidia");
    }
  });
});
