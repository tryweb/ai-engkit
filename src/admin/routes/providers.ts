import { Hono } from "hono";
import { readEnvFile, upsertEnvVar, deleteEnvVar } from "../lib/env";
import {
  PROVIDER_ENV_KEY,
  parseProviders,
  isValidProviderEntry,
  serializeProviders,
  type ProvidersMap,
} from "../lib/providers";
import { collectProvidersMeta } from "../lib/provider-meta";
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
import { fetchGoUsage, toUsageItemWindows } from "../lib/opencode-go-usage";
import { ProvidersPage } from "../views/providers";
import providersOAuth from "./providers-oauth";

const providers = new Hono();
providers.route("/api/providers/openai/oauth", providersOAuth);

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
  return c.json(await collectProvidersMeta());
});

providers.get("/api/providers/opencode-go/usage", async (c) => {
  const keys = readProviderKeys().providers["opencode-go"]?.keys ?? [];
  const items = await Promise.all(keys.map(async (key) => {
    try {
      return toUsageItemWindows(key.id, maskKey(key.value), await fetchGoUsage(key.value));
    } catch {
      return toUsageItemWindows(key.id, maskKey(key.value), { ok: false, code: "http_error", cached: false });
    }
  }));
  return c.json({ ok: true, items });
});

providers.put("/api/providers/:name", async (c) => {
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

  // Merge so apiKey (never sent by the client) and other existing fields survive.
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

providers.delete("/api/providers/:name", (c) => {
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
  if (!value) return c.json({ error: "Key must be a non-empty string" }, 400);

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
  const meta = await collectProvidersMeta();
  const envVars = readEnvFile();
  const parsed = parseProviders(envVars[PROVIDER_ENV_KEY] ?? "");
  const entries: Record<string, unknown> = {};
  if (parsed.ok) {
    for (const [name, entry] of Object.entries(parsed.providers)) {
      const clean: Record<string, unknown> = { ...entry };
      if (clean.options && typeof clean.options === "object") {
        clean.options = { ...(clean.options as Record<string, unknown>) };
        delete (clean.options as Record<string, unknown>).apiKey;
      }
      entries[name] = clean;
    }
  }
  return c.html(ProvidersPage({ meta, entries }));
});

export default providers;
