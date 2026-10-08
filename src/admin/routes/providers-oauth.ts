import { Hono } from "hono";
import {
  applyOAuthEntry,
  clearProviderCache,
  readAuthEntryRaw,
  removeAuthKey,
  restoreAuthEntry,
} from "../lib/opencode-auth";
import {
  buildOAuthEntry,
  clearPendingFlow,
  exchangeAuthorizationCode,
  getPendingFlow,
  markPendingFlowReady,
  pollDeviceToken,
  requestDeviceUserCode,
  startPendingFlow,
  type DeviceUserCode,
  type OAuthAuthEntry,
} from "../lib/openai-oauth";
import { restartAiDev } from "../lib/restart-ai-dev";
import { invalidateProbeCacheForProvider } from "../lib/model-probe";
import { createAgentModelReconciler } from "../lib/agent-model-reconciler";
import { REAL_DEPS } from "../lib/agent-models";
import { execInAiDev } from "../lib/docker";

/** Only the OpenAI provider offers the ChatGPT Pro/Plus OAuth connection today. */
const OAUTH_PROVIDER = "openai";

const providersOAuth = new Hono();
type OAuthReconcile = () => Promise<unknown>;

const reconcileAgentModels: OAuthReconcile = () => createAgentModelReconciler(REAL_DEPS).reconcileAll();
let runReconcileAgentModels: OAuthReconcile = reconcileAgentModels;

export function __setReconcileAgentModelsForTest(reconcile: OAuthReconcile): void {
  runReconcileAgentModels = reconcile;
}

export function __resetReconcileAgentModelsForTest(): void {
  runReconcileAgentModels = reconcileAgentModels;
}

async function triggerAgentModelReconciliation(providerID: string): Promise<void> {
  try {
    await invalidateProbeCacheForProvider({ exec: execInAiDev }, providerID);
  } catch {
    return;
  }
  try {
    void runReconcileAgentModels().catch(() => {});
  } catch {
    return;
  }
}

function parseFlowId(body: unknown): string {
  if (typeof body !== "object" || body === null) return "";
  const flowId = (body as Record<string, unknown>)["flowId"];
  return typeof flowId === "string" ? flowId : "";
}

/**
 * Restore the pre-apply auth-store entry, clear the provider cache, and
 * restart ai-dev so the container settles into the previous credential state.
 * Mirrors restoreProviderAuth's rollback shape.
 */
async function rollbackOAuthApply(previousRaw: string | null): Promise<string[]> {
  const failures: string[] = [];
  try {
    await restoreAuthEntry(OAUTH_PROVIDER, previousRaw);
  } catch {
    failures.push("auth store restore failed");
  }
  try {
    await clearProviderCache();
  } catch {
    failures.push("provider cache clear failed");
  }
  try {
    const restart = await restartAiDev();
    if (!restart.ok) failures.push("rollback restart failed");
  } catch {
    failures.push("rollback restart failed");
  }
  return failures;
}

function rollbackMessage(base: string, failures: string[]): string {
  return failures.length === 0 ? base : `${base}; rollback incomplete: ${failures.join(", ")}`;
}

providersOAuth.post("/start", async (c) => {
  let info: DeviceUserCode;
  try {
    info = await requestDeviceUserCode();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to start device authorization";
    return c.json({ error: message }, 502);
  }
  const flowId = startPendingFlow(info);
  return c.json({
    ok: true,
    flowId,
    verificationUri: info.verificationUri,
    userCode: info.userCode,
    intervalSec: info.intervalSec,
    expiresInSec: info.expiresInSec,
  });
});

providersOAuth.post("/poll", async (c) => {
  const flowId = parseFlowId(await c.req.json());
  if (!flowId) return c.json({ error: "flowId required" }, 400);
  const flow = getPendingFlow(flowId);
  if (!flow) return c.json({ status: "expired" });

  const result = await pollDeviceToken(flow.deviceAuthId, flow.userCode);
  if (result.status === "ready") {
    markPendingFlowReady(flowId, result.authorizationCode, result.codeVerifier);
    return c.json({ status: "ready" });
  }
  if (result.status === "failed") {
    clearPendingFlow(flowId);
    return c.json({ status: "failed" });
  }
  return c.json({ status: "pending", intervalSec: flow.intervalSec });
});

providersOAuth.post("/apply", async (c) => {
  const flowId = parseFlowId(await c.req.json());
  if (!flowId) return c.json({ error: "flowId required" }, 400);
  const flow = getPendingFlow(flowId);
  if (!flow) {
    return c.json({ error: "Connection flow expired or not found; start a new connection" }, 409);
  }
  if (!flow.authorizationCode || !flow.codeVerifier) {
    return c.json({ error: "Authorization is not complete yet" }, 409);
  }

  let previousRaw: string | null = null;
  try {
    previousRaw = await readAuthEntryRaw(OAUTH_PROVIDER);
  } catch {
    // Unreadable snapshot: proceed; rollback degrades to removing the entry.
    previousRaw = null;
  }

  let entry: OAuthAuthEntry;
  try {
    const tokens = await exchangeAuthorizationCode(flow.authorizationCode, flow.codeVerifier);
    entry = buildOAuthEntry(tokens);
  } catch (error: unknown) {
    clearPendingFlow(flowId);
    const message = error instanceof Error ? error.message : "Token exchange failed";
    return c.json({ error: message }, 502);
  }

  try {
    await applyOAuthEntry(OAUTH_PROVIDER, entry);
    await clearProviderCache();
  } catch (error: unknown) {
    const failures = await rollbackOAuthApply(previousRaw);
    clearPendingFlow(flowId);
    const message = error instanceof Error ? error.message : "Failed to write ChatGPT credential";
    return c.json({ error: rollbackMessage(`Connection reverted: ${message}`, failures) }, 500);
  }

  const restart = await restartAiDev();
  if ("error" in restart) {
    const failures = await rollbackOAuthApply(previousRaw);
    clearPendingFlow(flowId);
    return c.json(
      { error: rollbackMessage(`ai-dev restart failed; connection reverted: ${restart.error ?? "unknown error"}`, failures) },
      500,
    );
  }

  await triggerAgentModelReconciliation(OAUTH_PROVIDER);
  clearPendingFlow(flowId);
  return c.json({ ok: true, connected: true });
});

providersOAuth.post("/disconnect", async (c) => {
  try {
    await removeAuthKey(OAUTH_PROVIDER);
    await clearProviderCache();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to remove ChatGPT credential";
    return c.json({ error: `Disconnect failed: ${message}` }, 500);
  }
  const restart = await restartAiDev();
  if ("error" in restart) {
    return c.json(
      { error: `ChatGPT disconnected but ai-dev restart failed: ${restart.error ?? "unknown error"}` },
      500,
    );
  }
  await triggerAgentModelReconciliation(OAUTH_PROVIDER);
  return c.json({ ok: true });
});

export default providersOAuth;
