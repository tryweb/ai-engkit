import { readEnvFile } from "./env";
import { PROVIDER_ENV_KEY, parseProviders, getProviderApiKey } from "./providers";
import { readProviderKeys, maskKey, addProviderKey } from "./provider-keys";
import {
  KEY_MANAGED_PROVIDERS,
  isKeyProviderSupported,
  readProviderAuthKey,
  readProviderOAuthPresence,
} from "./opencode-auth";

export interface ProviderMeta {
  name: string;
  label: string;
  npm: string;
  baseURL: string;
  hasApiKey: boolean;
  keyManagement: boolean;
  authStoreKeyPresent: boolean;
  oauthManaged: boolean;
  oauthConnected: boolean;
  virtual: boolean;
  registry: {
    keyCount: number;
    activeKeyId: string | null;
    keys: Array<{ id: string; masked: string; note: string; active: boolean }>;
  };
}

const KEY_MANAGED_LABELS: Record<string, string> = {
  "opencode-go": "Opencode Go",
  openai: "OpenAI API",
  google: "Google",
  nvidia: "Nvidia API",
  openrouter: "OpenRouter",
};

/** Providers that also offer the ChatGPT Pro/Plus headless OAuth connection. */
export const OAUTH_MANAGED_PROVIDERS = ["openai"] as const;

export interface ProvidersMetaDeps {
  readonly readAuthKey: (provider: string) => Promise<string | null>;
  readonly readOAuthPresence: (provider: string) => Promise<boolean>;
}

const REAL_META_DEPS: ProvidersMetaDeps = {
  readAuthKey: readProviderAuthKey,
  readOAuthPresence: readProviderOAuthPresence,
};

export async function collectProvidersMeta(deps: ProvidersMetaDeps = REAL_META_DEPS): Promise<{
  invalid: boolean;
  error: string | null;
  providers: ProviderMeta[];
}> {
  const envVars = readEnvFile();
  const parsed = parseProviders(envVars[PROVIDER_ENV_KEY] ?? "");
  const keys = readProviderKeys();
  if ("error" in parsed) {
    return { invalid: true, error: parsed.error, providers: [] };
  }

  const keyManagedNames = Array.from(
    new Set([
      ...KEY_MANAGED_PROVIDERS,
      ...Object.keys(keys.providers),
      ...Object.keys(parsed.providers),
    ]),
  ).filter(isKeyProviderSupported);
  const authStoreKeys = new Map<string, string | null>();
  const authStoreOAuth = new Map<string, boolean>();
  await Promise.all(
    keyManagedNames.map(async (name) => {
      authStoreKeys.set(name, await deps.readAuthKey(name));
      authStoreOAuth.set(name, await deps.readOAuthPresence(name));
    }),
  );

  const out = Object.entries(parsed.providers).map(([name, entry]): ProviderMeta => {
    const keyEntry = keys.providers[name];
    const registry = keyEntry
      ? {
          keyCount: keyEntry.keys.length,
          activeKeyId: keyEntry.activeKeyId,
          keys: keyEntry.keys.map((k) => ({
            id: k.id,
            masked: maskKey(k.value),
            note: k.note ?? "",
            active: k.id === keyEntry.activeKeyId,
          })),
        }
      : { keyCount: 0, activeKeyId: null, keys: [] };
    const baseURL =
      typeof entry.options?.baseURL === "string" ? entry.options.baseURL : "";
    return {
      name,
      label: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : name,
      npm: typeof entry.npm === "string" ? entry.npm : "",
      baseURL,
      hasApiKey: getProviderApiKey(entry) !== null,
      keyManagement: isKeyProviderSupported(name),
      authStoreKeyPresent: isKeyProviderSupported(name) ? !!authStoreKeys.get(name) : false,
      oauthManaged: (OAUTH_MANAGED_PROVIDERS as readonly string[]).includes(name),
      oauthConnected: isKeyProviderSupported(name) ? !!authStoreOAuth.get(name) : false,
      virtual: false,
      registry,
    };
  });

  // Virtual cards for key-managed providers absent from OPENCODE_PROVIDER
  // (their credentials live in the opencode auth store, not the env var).
  for (const name of (KEY_MANAGED_PROVIDERS as readonly string[]) as string[]) {
    if (out.some((p) => p.name === name)) continue;
    const keyEntry = keys.providers[name];
    const registry = keyEntry
      ? {
          keyCount: keyEntry.keys.length,
          activeKeyId: keyEntry.activeKeyId,
          keys: keyEntry.keys.map((k) => ({
            id: k.id,
            masked: maskKey(k.value),
            note: k.note ?? "",
            active: k.id === keyEntry.activeKeyId,
          })),
        }
      : { keyCount: 0, activeKeyId: null, keys: [] };
    out.push({
      name,
      label: KEY_MANAGED_LABELS[name] ?? name,
      npm: "",
      baseURL: "",
      hasApiKey: false,
      keyManagement: true,
      authStoreKeyPresent: !!authStoreKeys.get(name),
      oauthManaged: (OAUTH_MANAGED_PROVIDERS as readonly string[]).includes(name),
      oauthConnected: !!authStoreOAuth.get(name),
      virtual: true,
      registry,
    });
  }

  // A credential that exists only in the opencode auth store is invisible on
  // the card (registry empty), so mirror it into the registry here — the
  // write-on-read is idempotent: addProviderKey dedupes by value and the
  // keyCount>0 guard skips cards that already surface keys.
  for (const meta of out) {
    if (!meta.keyManagement || meta.registry.keyCount > 0) continue;
    const authKey = authStoreKeys.get(meta.name);
    if (!authKey) continue;
    try {
      addProviderKey(meta.name, authKey, "imported from auth store");
    } catch {
      continue;
    }
    const fresh = readProviderKeys().providers[meta.name];
    if (fresh) {
      meta.registry = {
        keyCount: fresh.keys.length,
        activeKeyId: fresh.activeKeyId,
        keys: fresh.keys.map((k) => ({
          id: k.id,
          masked: maskKey(k.value),
          note: k.note ?? "",
          active: k.id === fresh.activeKeyId,
        })),
      };
    }
  }

  return { invalid: false, error: null, providers: out };
}
