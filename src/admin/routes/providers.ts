import { Hono } from "hono";
import { readEnvFile, upsertEnvVar, deleteEnvVar } from "../lib/env";
import {
  PROVIDER_ENV_KEY,
  parseProviders,
  isValidProviderEntry,
  serializeProviders,
  type ProvidersMap,
} from "../lib/providers";
import { collectProvidersMeta, type ProviderMeta } from "../lib/provider-meta";
import {
  readProviderKeys,
  addProviderKey,
  deleteProviderKey,
  setActiveProviderKey,
  updateProviderKeyNote,
  deleteProviderKeys,
  maskKey,
} from "../lib/provider-keys";
import {
  isKeyProviderSupported,
  readProviderAuthKey,
  readProviderAuthSnapshot,
  readProviderOAuthPresence,
  applyActiveKey,
  removeAuthKey,
  clearProviderCache,
} from "../lib/opencode-auth";
import { restartAiDev } from "../lib/restart-ai-dev";
import { invalidateProbeCacheForProvider } from "../lib/model-probe";
import { createAgentModelReconciler } from "../lib/agent-model-reconciler";
import { REAL_DEPS } from "../lib/agent-models";
import { execInAiDev } from "../lib/docker";
import { ProvidersPage } from "../views/providers";
import providersOAuth from "./providers-oauth";
import {
  listIntegrations,
  connectKey as v2ConnectKey,
  credentialActivate as v2Activate,
  credentialRemove as v2Remove,
  credentialUpdate as v2Update,
  oauthConnect as v2OAuthConnect,
  oauthStatus as v2OAuthStatus,
  oauthComplete as v2OAuthComplete,
  oauthCancel as v2OAuthCancel,
  wellknownAdd as v2WellknownAdd,
  isOpenCodeV2 as v2IsOpenCodeV2,
  upsertV2Provider,
  deleteV2Provider,
  listV2ProvidersRaw,
  readV2ProviderEntries,
} from "../lib/opencode-v2";

const providers = new Hono();
providers.route("/api/providers/openai/oauth", providersOAuth);

async function isOpenCodeV2Cached(): Promise<boolean> {
  return await v2IsOpenCodeV2();
}

async function collectProvidersMetaV2(): Promise<{ invalid: boolean; error: string | null; providers: ProviderMeta[] }> {
  const integrations = await listIntegrations();
  // V2 custom providers are stored in plural `providers` in opencode.json, not OPENCODE_PROVIDER.
  // Fetch via provider.list for runtime truth, plus fallback to env for legacy.
  let v2ProvidersMap: Record<string, unknown> = {};
  try {
    const raw = await listV2ProvidersRaw() as { data?: unknown[] };
    if (Array.isArray(raw.data)) {
      for (const p of raw.data as Array<Record<string, unknown>>) {
        if (typeof p.id === "string") v2ProvidersMap[p.id] = p;
      }
    }
  } catch {}
  const envVars = readEnvFile();
  const parsedEnv = parseProviders(envVars[PROVIDER_ENV_KEY] ?? "");
  const customProvidersEnv: Record<string, ProvidersMap[string]> = parsedEnv.ok ? parsedEnv.providers : {};
  const providersMeta: ProviderMeta[] = integrations.data.map((integration) => {
    const hasKeyMethod = integration.methods.some((m) => m.type === "key");
    const oauthMethodsRaw = integration.methods.filter((m) => m.type === "oauth") as Array<{ type: "oauth"; id: string; label: string }>;
    const oauthMethods = oauthMethodsRaw.map((m) => ({ id: m.id, label: m.label }));
    const credConnections = integration.connections.filter((c) => c.type === "credential") as Array<{ type: "credential"; id: string; label: string; method: "key" | "oauth" }>;
    const keyCreds = credConnections.filter((c) => c.method === "key");
    const oauthCreds = credConnections.filter((c) => c.method === "oauth");
    const activeKeyId = keyCreds[0]?.id ?? null;
    const customEnv = customProvidersEnv[integration.id] as ProvidersMap[string] | undefined;
    const customV2 = v2ProvidersMap[integration.id] as Record<string, unknown> | undefined;
    const baseURL = (customV2?.settings as Record<string, unknown> | undefined)?.baseURL as string | undefined ?? (typeof customEnv?.options?.baseURL === "string" ? (customEnv.options.baseURL as string) : "");
    const npm = (customV2?.package as string | undefined) ?? (typeof customEnv?.npm === "string" ? customEnv.npm : "");
    const label = (customV2?.name as string | undefined) ?? (typeof customEnv?.name === "string" && customEnv.name.length > 0 ? customEnv.name : integration.name);
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
      const baseURL = (v2p.settings as Record<string, unknown> | undefined)?.baseURL as string | undefined ?? "";
      providersMeta.push({
        name,
        label: typeof v2p.name === "string" && (v2p.name as string).length > 0 ? (v2p.name as string) : name,
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
      const hasApiKey = typeof envP.options?.apiKey === "string" && (envP.options.apiKey as string).length > 0;
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

async function triggerAgentModelReconciliation(providerID: string): Promise<void> {
  try {
    await invalidateProbeCacheForProvider({ exec: execInAiDev }, providerID);
  } catch {
    return;
  }
  try {
    void createAgentModelReconciler(REAL_DEPS).reconcileAll().catch(() => {});
  } catch {
    return;
  }
}

async function restoreProviderAuth(name: string, previousAuthKey: string | null): Promise<string[]> {
  const failures: string[] = [];
  try {
    if (previousAuthKey === null) {
      await removeAuthKey(name);
      await clearProviderCache();
    } else {
      await applyActiveKey(name, previousAuthKey);
    }
  } catch {
    failures.push("runtime auth restore failed");
  }
  try {
    const restart = await restartAiDev();
    if ("error" in restart) failures.push("rollback restart failed");
  } catch {
    failures.push("rollback restart failed");
  }
  return failures;
}

function providerEntryFromBody(body: unknown): ProvidersMap[string] | null {
  const entry = (body as { provider?: unknown })?.provider;
  return isValidProviderEntry(entry) ? (entry as ProvidersMap[string]) : null;
}

providers.get("/api/providers", async (c) => {
  const v2 = await isOpenCodeV2Cached();
  if (v2) {
    try {
      return c.json(await collectProvidersMetaV2());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ invalid: true, error: msg, providers: [] }, 500);
    }
  }
  return c.json(await collectProvidersMeta());
});

providers.get("/api/providers/v2/list", async (c) => {
  try {
    const data = await listIntegrations();
    return c.json(data);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

providers.post("/api/providers/wellknown", async (c) => {
  const v2 = await isOpenCodeV2Cached();
  if (!v2) return c.json({ error: "Wellknown is only available on OpenCode v2" }, 400);
  const body = await c.req.json().catch(() => ({}));
  const url = typeof (body as Record<string, unknown>).url === "string" ? ((body as Record<string, unknown>).url as string).trim() : "";
  if (!url) return c.json({ error: "url required" }, 400);
  try {
    await v2WellknownAdd(url);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

providers.post("/api/providers/:name/oauth/v2/start", async (c) => {
  const name = c.req.param("name");
  const body = await c.req.json().catch(() => ({}));
  const methodID = typeof (body as Record<string, unknown>).methodID === "string" ? ((body as Record<string, unknown>).methodID as string) : "chatgpt-browser";
  const answer = (body as Record<string, unknown>).answer as Record<string, unknown> | undefined;
  const label = typeof (body as Record<string, unknown>).label === "string" ? ((body as Record<string, unknown>).label as string) : undefined;
  try {
    const res = await v2OAuthConnect(name, methodID, { answer: answer as Record<string, string | number | boolean | string[]>, label });
    return c.json({ ok: true, ...res });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

providers.get("/api/providers/:name/oauth/v2/status/:attemptID", async (c) => {
  const { name, attemptID } = c.req.param();
  try {
    const data = await v2OAuthStatus(name, attemptID);
    return c.json({ ok: true, ...data });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

providers.post("/api/providers/:name/oauth/v2/complete", async (c) => {
  const { name } = c.req.param();
  const body = await c.req.json().catch(() => ({}));
  // Support both param and body attemptID
  const attemptID = c.req.param("attemptID") ?? (typeof (body as Record<string, unknown>).attemptID === "string" ? ((body as Record<string, unknown>).attemptID as string) : "");
  const code = typeof (body as Record<string, unknown>).code === "string" ? ((body as Record<string, unknown>).code as string) : undefined;
  if (!attemptID) return c.json({ error: "attemptID required" }, 400);
  try {
    await v2OAuthComplete(name, attemptID, code);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

providers.delete("/api/providers/:name/oauth/v2/:attemptID", async (c) => {
  const { name, attemptID } = c.req.param();
  try {
    await v2OAuthCancel(name, attemptID);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

providers.post("/api/providers/:name/oauth/v2/disconnect", async (c) => {
  const name = c.req.param("name");
  const body = await c.req.json().catch(() => ({}));
  const credentialID = typeof (body as Record<string, unknown>).credentialID === "string" ? ((body as Record<string, unknown>).credentialID as string) : "";
  try {
    if (credentialID) {
      await v2Remove(credentialID);
      return c.json({ ok: true });
    }
    const list = await listIntegrations();
    const integration = list.data.find((i) => i.id === name);
    const oauthCred = integration?.connections.find((cc) => cc.type === "credential" && (cc as { method: string }).method === "oauth") as { id: string } | undefined;
    if (!oauthCred) return c.json({ error: "No OAuth credential found for this provider" }, 404);
    await v2Remove(oauthCred.id);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

providers.put("/api/providers/:name", async (c) => {
  const maybeV2 = await isOpenCodeV2Cached();
  if (maybeV2) {
    const bodyRaw = await c.req.json().catch(() => ({} as Record<string, unknown>));
    const body = bodyRaw as Record<string, unknown>;
    const url = typeof body.url === "string" ? (body.url as string).trim() : "";
    if (url) {
      try {
        await v2WellknownAdd(url);
        return c.json({ ok: true, via: "wellknown" });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }
    const entryFromWellknown = providerEntryFromBody(bodyRaw);
    if (entryFromWellknown && typeof (entryFromWellknown as Record<string, unknown>).url === "string") {
      try {
        await v2WellknownAdd((entryFromWellknown as Record<string, unknown>).url as string);
        return c.json({ ok: true, via: "wellknown" });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }
    const entry = providerEntryFromBody(bodyRaw);
    if (entry) {
      const v2Name = c.req.param("name").trim();
      if (!v2Name) return c.json({ error: "Provider name required" }, 400);
      try {
        await upsertV2Provider(v2Name, entry);
        const apiKey = entry.options?.apiKey;
        if (typeof apiKey === "string" && apiKey.trim().length > 0) {
          await v2ConnectKey(v2Name, apiKey.trim());
        }
        await triggerAgentModelReconciliation(v2Name);
        return c.json({ ok: true, activationStatus: "reloaded", via: "providers" });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }
    return c.json(
      {
        error: "Invalid provider payload. Provide { provider: { npm, name, options, models } } or { url } for wellknown.",
      },
      400,
    );
  }

  const name = c.req.param("name").trim();
  if (!name) return c.json({ error: "Provider name required" }, 400);

  const entry = providerEntryFromBody(await c.req.json());
  if (!entry) {
    return c.json(
      { error: "Provider must be an object with valid npm/options/models fields" },
      400,
    );
  }

  const envVars = readEnvFile();
  const parsed = parseProviders(envVars[PROVIDER_ENV_KEY] ?? "");
  if ("error" in parsed) {
    return c.json({ error: `OPENCODE_PROVIDER is not valid JSON: ${parsed.error}` }, 400);
  }

  const existing = parsed.providers[name];
  const merged: ProvidersMap[string] = {
    ...existing,
    ...entry,
    options: { ...(existing?.options ?? {}), ...(entry.options ?? {}) },
  };
  if (entry.options && "apiKey" in entry.options) {
    if (entry.options.apiKey === "") {
      delete merged.options?.apiKey;
    } else {
      merged.options!.apiKey = entry.options.apiKey;
    }
  }
  parsed.providers[name] = merged;
  upsertEnvVar(PROVIDER_ENV_KEY, serializeProviders(parsed.providers));
  return c.json({ ok: true, activationStatus: "restart_required" });
});

providers.delete("/api/providers/:name", async (c) => {
  const v2del = await isOpenCodeV2Cached();
  if (v2del) {
    const name = c.req.param("name");
    let removedCredentials = 0;
    let removedProvider = false;
    try {
      const list = await listIntegrations();
      const integration = list.data.find((i) => i.id === name);
      if (integration) {
        const creds = integration.connections.filter((cc) => cc.type === "credential") as Array<{ id: string }>;
        for (const cred of creds) {
          try {
            await v2Remove(cred.id);
          } catch {}
        }
        removedCredentials = creds.length;
      }
    } catch {}
    // Remove V2 file-based provider if present
    try {
      await deleteV2Provider(name);
      removedProvider = true;
    } catch {}
    // Also handle legacy env for backward compat
    try {
      const envVars = readEnvFile();
      const parsed = parseProviders(envVars[PROVIDER_ENV_KEY] ?? "");
      if (!("error" in parsed) && name in parsed.providers) {
        delete parsed.providers[name];
        if (Object.keys(parsed.providers).length === 0) {
          deleteEnvVar(PROVIDER_ENV_KEY);
        } else {
          upsertEnvVar(PROVIDER_ENV_KEY, serializeProviders(parsed.providers));
        }
        removedProvider = true;
      }
    } catch {}
    deleteProviderKeys(name);
    if (removedCredentials > 0 || removedProvider) {
      return c.json({ ok: true, removedCredentials, removedProvider });
    }
    // Check if still exists as integration or file provider
    try {
      const list2 = await listIntegrations();
      if (!list2.data.some((i) => i.id === name)) {
        const raw = await listV2ProvidersRaw() as { data?: unknown[] };
        const existsInFile = Array.isArray(raw.data) && (raw.data as Array<Record<string, unknown>>).some((p) => p.id === name);
        if (!existsInFile) {
          const envVars2 = readEnvFile();
          const parsed2 = parseProviders(envVars2[PROVIDER_ENV_KEY] ?? "");
          if ("error" in parsed2 || !(name in parsed2.providers)) {
            return c.json({ error: "Provider not found" }, 404);
          }
        }
      }
    } catch {}
    return c.json({ ok: true, removedCredentials });
  }

  const name = c.req.param("name");
  const envVars = readEnvFile();
  const parsed = parseProviders(envVars[PROVIDER_ENV_KEY] ?? "");
  if ("error" in parsed) {
    return c.json({ error: `OPENCODE_PROVIDER is not valid JSON: ${parsed.error}` }, 400);
  }
  if (!(name in parsed.providers)) return c.json({ error: "Provider not found" }, 404);

  delete parsed.providers[name];
  if (Object.keys(parsed.providers).length === 0) {
    deleteEnvVar(PROVIDER_ENV_KEY);
  } else {
    upsertEnvVar(PROVIDER_ENV_KEY, serializeProviders(parsed.providers));
  }
  deleteProviderKeys(name);
  return c.json({ ok: true });
});

providers.post("/api/providers/:name/keys", async (c) => {
  const name = c.req.param("name");
  const body = await c.req.json();
  const value = typeof body.value === "string" ? body.value.trim() : "";
  const note = typeof body.note === "string" ? body.note.trim() : "";
  const answer = body.answer as Record<string, string | number | boolean | string[]> | undefined;
  const label = note || undefined;
  if (!value) return c.json({ error: "Key must be a non-empty string" }, 400);

  const v2 = await isOpenCodeV2Cached();
  if (v2) {
    try {
      await v2ConnectKey(name, value, { label, answer });
      await triggerAgentModelReconciliation(name);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }

  const file = readProviderKeys();
  const wasFirstKey = !(file.providers[name]?.keys.length);

  if (wasFirstKey && isKeyProviderSupported(name)) {
    let existingAuthKey: string | null;
    try {
      existingAuthKey = await readProviderAuthSnapshot(name);
      if (!existingAuthKey && (await readProviderOAuthPresence(name))) {
        return c.json(
          {
            error: `auth store already holds a ChatGPT OAuth connection for ${name}. Disconnect ChatGPT Pro/Plus before managing API keys.`,
          },
          409,
        );
      }
    } catch {
      return c.json({ error: "Could not read the current auth-store key" }, 500);
    }
    if (existingAuthKey) {
      return c.json(
        {
          error: `auth store already holds a key for ${name} (${maskKey(existingAuthKey)}). Use "Import from auth store" to adopt it, or delete the auth-store key first to replace it.`,
        },
        409,
      );
    }
  }

  const key = addProviderKey(name, value, note);

  if (wasFirstKey && isKeyProviderSupported(name)) {
    try {
      await applyActiveKey(name, key.value);
      const restart = await restartAiDev();
      if ("error" in restart) throw new Error(restart.error);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to apply key";
      const failures = deleteProviderKey(name, key.id) ? [] : ["registry key removal failed"];
      failures.push(...await restoreProviderAuth(name, null));
      const rollback = failures.length === 0 ? "" : `; rollback incomplete: ${failures.join(", ")}`;
      return c.json({ error: `Apply failed; key not saved: ${message}${rollback}` }, 500);
    }
  }

  await triggerAgentModelReconciliation(name);
  return c.json({ ok: true, key: { id: key.id, masked: maskKey(key.value) } });
});

providers.put("/api/providers/:name/keys/:keyId", async (c) => {
  const { name, keyId } = c.req.param();
  const body = await c.req.json();
  const note = typeof body.note === "string" ? body.note.trim() : null;
  if (note === null) return c.json({ error: "Note must be a string" }, 400);
  const v2 = await isOpenCodeV2Cached();
  if (v2) {
    try {
      await v2Update(keyId, note);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }
  if (!updateProviderKeyNote(name, keyId, note)) {
    return c.json({ error: "Key not found" }, 404);
  }
  return c.json({ ok: true });
});

providers.get("/api/providers/:name/keys/:keyId/value", (c) => {
  const { name, keyId } = c.req.param();
  const file = readProviderKeys();
  const key = file.providers[name]?.keys.find((k) => k.id === keyId);
  if (!key) return c.json({ error: "Key not found" }, 404);
  return c.json({ ok: true, key: key.value });
});

providers.delete("/api/providers/:name/keys/:keyId", async (c) => {
  const { name, keyId } = c.req.param();
  const v2 = await isOpenCodeV2Cached();
  if (v2) {
    try {
      await v2Remove(keyId);
      await triggerAgentModelReconciliation(name);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }
  const file = readProviderKeys();
  const wasActive = file.providers[name]?.activeKeyId === keyId;
  if (!deleteProviderKey(name, keyId)) return c.json({ error: "Key not found" }, 404);

  if (wasActive && isKeyProviderSupported(name)) {
    try {
      const remaining = readProviderKeys().providers[name];
      if (remaining?.activeKeyId) {
        const promoted = remaining.keys.find((k) => k.id === remaining.activeKeyId);
        if (promoted) await applyActiveKey(name, promoted.value);
      } else {
        await removeAuthKey(name);
        await clearProviderCache();
      }
      const restart = await restartAiDev();
      if ("error" in restart) throw new Error(restart.error);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to sync auth store";
      return c.json({ error: `Key deleted but auth store sync failed: ${message}` }, 500);
    }
  }

  await triggerAgentModelReconciliation(name);
  return c.json({ ok: true });
});

providers.put("/api/providers/:name/keys/:keyId/active", async (c) => {
  const { name, keyId } = c.req.param();
  const v2 = await isOpenCodeV2Cached();
  if (v2) {
    try {
      await v2Activate(keyId);
      await triggerAgentModelReconciliation(name);
      return c.json({ ok: true, activationStatus: "connected" });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }
  const file = readProviderKeys();
  const entry = file.providers[name];
  const key = entry?.keys.find((k) => k.id === keyId);
  if (!key) return c.json({ error: "Key not found" }, 404);
  if (entry.activeKeyId === keyId) {
    return c.json({ ok: true, alreadyActive: true, activationStatus: "restart_required" });
  }

  const previousActive = entry.activeKeyId;
  let previousAuthKey: string | null = null;
  if (isKeyProviderSupported(name)) {
    try {
      previousAuthKey = await readProviderAuthSnapshot(name);
    } catch {
      return c.json({ error: "Could not read the current auth-store key" }, 500);
    }
  }
  if (!setActiveProviderKey(name, keyId)) {
    return c.json({ error: "Failed to set active key" }, 500);
  }

  if (isKeyProviderSupported(name)) {
    try {
      await applyActiveKey(name, key.value);
      const restart = await restartAiDev();
      if ("error" in restart) throw new Error(restart.error);
    } catch (err) {
      const failures: string[] = [];
      if (!setActiveProviderKey(name, previousActive)) failures.push("registry selection restore failed");
      failures.push(...await restoreProviderAuth(name, previousAuthKey));
      const message = err instanceof Error ? err.message : "Failed to apply key";
      const rollback = failures.length === 0 ? "" : `; rollback incomplete: ${failures.join(", ")}`;
      return c.json({ error: `Apply failed; selection reverted: ${message}${rollback}` }, 500);
    }
  }

  await triggerAgentModelReconciliation(name);
  return c.json({ ok: true, activationStatus: "restart_required" });
});

providers.get("/api/providers/:name/keys/import-candidate", async (c) => {
  const name = c.req.param("name");
  const v2 = await isOpenCodeV2Cached();
  if (v2) {
    return c.json({ candidate: false, reason: "v2_no_import" });
  }
  const file = readProviderKeys();
  if (file.providers[name]?.keys.length) {
    return c.json({ candidate: false, reason: "registry_not_empty" });
  }
  if (!isKeyProviderSupported(name)) {
    return c.json({ candidate: false, reason: "unsupported_provider" });
  }
  const existing = await readProviderAuthKey(name);
  if (!existing) return c.json({ candidate: false, reason: "no_auth_store_key" });
  return c.json({ candidate: true, masked: maskKey(existing) });
});

providers.post("/api/providers/:name/keys/import", async (c) => {
  const name = c.req.param("name");
  const v2 = await isOpenCodeV2Cached();
  if (v2) return c.json({ error: "Import not applicable on OpenCode v2" }, 400);
  const file = readProviderKeys();
  if (file.providers[name]?.keys.length) {
    return c.json({ error: "Registry already has keys for this provider" }, 409);
  }
  if (!isKeyProviderSupported(name)) {
    return c.json({ error: "Key management not supported for this provider" }, 400);
  }
  const existing = await readProviderAuthKey(name);
  if (!existing) return c.json({ error: "No existing key in auth store" }, 404);

  const key = addProviderKey(name, existing);
  return c.json({ ok: true, key: { id: key.id, masked: maskKey(key.value) } });
});

providers.get("/providers", async (c) => {
  const v2 = await isOpenCodeV2Cached();
  let meta: { invalid: boolean; error: string | null; providers: ProviderMeta[] } = { invalid: false, error: null, providers: [] };
  if (v2) {
    try {
      meta = await collectProvidersMetaV2();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      meta = { invalid: true, error: msg, providers: [] as ProviderMeta[] };
    }
  } else {
    meta = await collectProvidersMeta();
  }
  const envVars = readEnvFile();
  const parsed = parseProviders(envVars[PROVIDER_ENV_KEY] ?? "");
  const entries: Record<string, unknown> = v2 ? await readV2ProviderEntries() : {};
  if (!v2 && parsed.ok) {
    for (const [name, entry] of Object.entries(parsed.providers)) {
      const clean: Record<string, unknown> = { ...entry };
      if (clean.options && typeof clean.options === "object") {
        clean.options = { ...(clean.options as Record<string, unknown>) };
        delete (clean.options as Record<string, unknown>).apiKey;
      }
      entries[name] = clean;
    }
  }
  return c.html(ProvidersPage({ meta, entries, isOpenCodeV2: false, v2Mode: v2 }));
});

export default providers;
