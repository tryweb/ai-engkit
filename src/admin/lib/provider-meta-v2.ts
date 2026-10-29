import { readEnvFile } from "./env";
import { PROVIDER_ENV_KEY, parseProviders, type ProvidersMap } from "./providers";
import type { ProviderMeta } from "./provider-meta";
import { listIntegrations, listV2ProvidersRaw } from "./opencode-v2";

/**
 * OAuth methods that require a localhost-callback browser flow. The authorize
 * redirect targets 127.0.0.1/localhost inside ai-dev, so the flow can never
 * complete from a remotely-opened admin page (the common Docker case).
 * Currently only OpenAI's browser methods are confirmed broken (verified live:
 * `chatgpt-token-sharing` and `chatgpt-browser` return authorize URLs with
 * loopback redirect_uri and no user code; `chatgpt-headless` returns a short
 * device code). Other providers' oauth methods are left untouched until
 * verified the same way.
 */
const BROKEN_BROWSER_OAUTH_METHODS: Readonly<Record<string, readonly string[]>> = {
  openai: ["chatgpt-token-sharing", "chatgpt-browser"],
};

function isBrokenBrowserOAuthMethod(integrationID: string, methodID: string): boolean {
  return BROKEN_BROWSER_OAUTH_METHODS[integrationID]?.includes(methodID) ?? false;
}

/**
 * V2 provider metadata — credentials live in the Integrations API
 * (plus `providers` in opencode.json / `provider.list` runtime truth),
 * not in OPENCODE_PROVIDER / provider-keys.json.
 * Shared by /providers page and the Dashboard summary so both agree.
 */
export async function collectProvidersMetaV2(): Promise<{
  invalid: boolean;
  error: string | null;
  providers: ProviderMeta[];
}> {
  const integrations = await listIntegrations();
  // V2 custom providers are stored in plural `providers` in opencode.json, not OPENCODE_PROVIDER.
  // Fetch via provider.list for runtime truth, plus fallback to env for legacy.
  let v2ProvidersMap: Record<string, unknown> = {};
  try {
    const raw = (await listV2ProvidersRaw()) as { data?: unknown[] };
    if (Array.isArray(raw.data)) {
      for (const p of raw.data as Array<Record<string, unknown>>) {
        if (typeof p.id === "string") v2ProvidersMap[p.id] = p;
      }
    }
  } catch {}
  const envVars = readEnvFile();
  const parsedEnv = parseProviders(envVars[PROVIDER_ENV_KEY] ?? "");
  const customProvidersEnv: Record<string, ProvidersMap[string]> = parsedEnv.ok
    ? parsedEnv.providers
    : {};
  const providersMeta: ProviderMeta[] = integrations.data.map((integration) => {
    const hasKeyMethod = integration.methods.some((m) => m.type === "key");
    const oauthMethodsRaw = integration.methods.filter(
      (m) => m.type === "oauth",
    ) as Array<{ type: "oauth"; id: string; label: string }>;
    // Browser-callback OAuth methods (localhost/127.0.0.1 redirect) cannot
    // complete when the admin page is opened remotely — the authorize redirect
    // lands on the viewer's machine, never on ai-dev. Verified live against
    // OpenCode 2.x: only the device-code method returns a user code.
    // Hide the broken buttons instead of offering them.
    const oauthMethods = oauthMethodsRaw
      .filter((m) => !isBrokenBrowserOAuthMethod(integration.id, m.id))
      .map((m) => ({ id: m.id, label: m.label }));
    const credConnections = integration.connections.filter(
      (c) => c.type === "credential",
    ) as Array<{ type: "credential"; id: string; label: string; method: "key" | "oauth" }>;
    const keyCreds = credConnections.filter((c) => c.method === "key");
    const oauthCreds = credConnections.filter((c) => c.method === "oauth");
    const activeKeyId = keyCreds[0]?.id ?? null;
    const customEnv = customProvidersEnv[integration.id] as ProvidersMap[string] | undefined;
    const customV2 = v2ProvidersMap[integration.id] as Record<string, unknown> | undefined;
    const baseURL =
      ((customV2?.settings as Record<string, unknown> | undefined)?.baseURL as string | undefined) ??
      (typeof customEnv?.options?.baseURL === "string" ? (customEnv.options.baseURL as string) : "");
    const npm =
      ((customV2?.package as string | undefined) ??
      (typeof customEnv?.npm === "string" ? customEnv.npm : "")) as string;
    const label =
      ((customV2?.name as string | undefined) ??
      (typeof customEnv?.name === "string" && customEnv.name.length > 0
        ? customEnv.name
        : integration.name)) as string;
    return {
      name: integration.id,
      label,
      npm,
      baseURL: baseURL ?? "",
      hasApiKey: keyCreds.length > 0 || !!(customEnv?.options?.apiKey),
      keyManagement: hasKeyMethod,
      authStoreKeyPresent: keyCreds.length > 0,
      oauthManaged: oauthMethods.length > 0,
      oauthConnected: oauthCreds.length > 0,
      oauthMethods,
      virtual: false,
      registry: {
        keyCount: keyCreds.length,
        activeKeyId,
        keys: keyCreds.map((k) => ({
          id: k.id,
          masked: k.label ? `${k.label} (${k.id.slice(-4)})` : `cred-${k.id.slice(-4)}`,
          note: k.label,
          active: k.id === activeKeyId,
        })),
      },
    };
  });
  // Add custom providers that are not part of integrations (V2 file-only or legacy env)
  const allCustomNames = new Set([...Object.keys(v2ProvidersMap), ...Object.keys(customProvidersEnv)]);
  for (const name of allCustomNames) {
    if (providersMeta.some((p) => p.name === name)) continue;
    const v2p = v2ProvidersMap[name] as Record<string, unknown> | undefined;
    const envP = customProvidersEnv[name];
    if (v2p) {
      const baseURL =
        ((v2p.settings as Record<string, unknown> | undefined)?.baseURL as string | undefined) ?? "";
      providersMeta.push({
        name,
        label:
          typeof v2p.name === "string" && (v2p.name as string).length > 0 ? (v2p.name as string) : name,
        npm: typeof v2p.package === "string" ? (v2p.package as string) : "",
        baseURL,
        hasApiKey: false,
        keyManagement: false,
        authStoreKeyPresent: false,
        oauthManaged: false,
        oauthConnected: false,
        oauthMethods: [],
        virtual: false,
        registry: { keyCount: 0, activeKeyId: null, keys: [] },
      });
    } else if (envP) {
      const baseURL = typeof envP.options?.baseURL === "string" ? envP.options.baseURL : "";
      const hasApiKey =
        typeof envP.options?.apiKey === "string" && (envP.options.apiKey as string).length > 0;
      providersMeta.push({
        name,
        label: typeof envP.name === "string" && envP.name.length > 0 ? envP.name : name,
        npm: typeof envP.npm === "string" ? envP.npm : "",
        baseURL,
        hasApiKey,
        keyManagement: false,
        authStoreKeyPresent: false,
        oauthManaged: false,
        oauthConnected: false,
        virtual: false,
        registry: { keyCount: 0, activeKeyId: null, keys: [] },
      });
    }
  }
  return { invalid: false, error: null, providers: providersMeta };
}
