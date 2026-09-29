// @ts-ignore - resolved via .opencode/plugins/node_modules symlink in-container and bundled external
import { Plugin } from "@opencode/plugin";
import { existsSync, watchFile, unwatchFile } from "node:fs";
import { join } from "node:path";
import { loadRoutingConfigFromPaths, parseModelString, getMaxFallbackAttempts } from "./routing-config";
import type { RoutingConfig, ChainEntry } from "./routing-config";
import { createRoutingStateStore } from "./routing-state";
import { isTokenLimitError, isUnrecoverableRequestError, isRetryableModelError, toErrorInfo, getStatusCode } from "./error-classifier";

const PLUGIN_ID = "b1-routing";
const HOLD_MS = 5000;

function log(...args: unknown[]): void {
  const line = `[${PLUGIN_ID}] ${new Date().toISOString()} ${args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ")}`;
  try {
    // eslint-disable-next-line no-console
    console.log(line);
  } catch {}
  try {
    const { appendFileSync } = require("node:fs");
    appendFileSync("/tmp/b1-routing.log", line + "\n");
  } catch {}
  try {
    const { appendFileSync: af2 } = require("node:fs");
    af2("/home/devuser/.local/share/opencode/log/b1-routing.log", line + "\n");
  } catch {}
}

function extractSessionID(data: Record<string, unknown>): string | undefined {
  for (const k of ["sessionID", "id", "sessionId"]) {
    const v = data[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  const info = data["info"] as Record<string, unknown> | undefined;
  if (info && typeof info["id"] === "string") return info["id"] as string;
  return undefined;
}

function extractError(data: Record<string, unknown>): unknown {
  if (data["error"] !== undefined) return data["error"];
  if (data["data"] !== undefined) {
    const d = data["data"] as Record<string, unknown>;
    if (d && d["error"] !== undefined) return d["error"];
  }
  return data;
}

function normalizeAgentKey(a: string): string { return a.toLowerCase().trim(); }

// @ts-ignore - Plugin.define resolved via external @opencode/plugin bundle
export const plugin = Plugin.define({
  id: PLUGIN_ID,
  setup: async (ctx: Plugin.Context) => {
    log("setup start");

    // --- config loading (no sibling asset reads at import time; all inside setup) ---
    const globalPath = "/home/devuser/.config/opencode/routing.json";
    const projectPath = join((ctx as unknown as { directory?: string }).directory ?? "/home/devuser/workspace", ".opencode", "routing.json");
    const altProjectPath = "/home/devuser/workspace/.opencode/routing.json";
    const configPaths = [globalPath, projectPath, altProjectPath];

    let routingConfig: RoutingConfig | undefined;
    let configErrors: string[] = [];

    function reload(): void {
      const res = loadRoutingConfigFromPaths(configPaths);
      routingConfig = res.config;
      configErrors = res.errors;
      if (routingConfig) {
        log(`config loaded from ${res.path ?? "merged"} chains=${Object.keys(routingConfig.chains).join(",")} errors=${configErrors.length}`);
        for (const e of configErrors) log(`config warn: ${e}`);
      } else {
        log(`config absent or invalid: ${configErrors.join("; ")}`);
      }
    }

    reload();

    // watch files via watchFile polling (simple, no native watcher dependency)
    for (const p of configPaths) {
      try {
        if (existsSync(p)) {
          watchFile(p, { interval: 2000 }, () => { log(`config file changed ${p}, reloading`); reload(); });
        }
      } catch {}
    }
    // also poll for new file creation (global may be created later)
    const pollNew = setInterval(() => {
      for (const p of configPaths) {
        if (existsSync(p)) {
          // if not yet watched, watch it
          try { watchFile(p, { interval: 2000 }, () => { log(`config file changed ${p}, reloading`); reload(); }); } catch {}
        }
      }
      // try reload if we have no config but file appeared
      if (!routingConfig) {
        const hasAny = configPaths.some((p) => existsSync(p));
        if (hasAny) reload();
      }
    }, 3000);
    // @ts-ignore
    if (typeof (pollNew as unknown as { unref?: () => void }).unref === "function") (pollNew as unknown as { unref: () => void }).unref();

    const store = createRoutingStateStore();
    store.startPrune();

    const lastPrompt = {} as Record<string, string>;
    const lastPromptAgent = {} as Record<string, string>;

    // capture prompt text for replay
    try {
      await ctx.session.hook("prompt", async (input: unknown) => {
        const rec = input as Record<string, unknown>;
        const sid = typeof rec["sessionID"] === "string" ? (rec["sessionID"] as string) : undefined;
        if (!sid) return;
        // prompt shape: {sessionID, messageID, prompt: PromptInput, delivery}
        const promptObj = rec["prompt"] as Record<string, unknown> | string | undefined;
        let text = "";
        if (typeof promptObj === "string") text = promptObj;
        else if (promptObj && typeof promptObj === "object") {
          // PromptInput may have text field or content
          const t = (promptObj as Record<string, unknown>)["text"];
          if (typeof t === "string") text = t;
          else {
            // try parts array
            const parts = (promptObj as Record<string, unknown>)["parts"];
            if (Array.isArray(parts)) {
              for (const part of parts as Record<string, unknown>[]) {
                if (part && part["type"] === "text" && typeof part["text"] === "string") text += part["text"] as string + "\n";
              }
            }
          }
        } else if (typeof rec["text"] === "string") text = rec["text"] as string;
        if (text) {
          lastPrompt[sid] = text;
          // also try to capture agent if present in promptObj or rec
          const ag = (promptObj as Record<string, unknown> | undefined)?.["agent"] ?? rec["agent"];
          if (typeof ag === "string" && ag.length > 0) lastPromptAgent[sid] = ag;
          log(`captured prompt for ${sid.slice(0,8)} len=${text.length} agent=${String(ag ?? "-")}`);
        }
      });
      log("prompt hook registered");
    } catch (e) {
      log(`prompt hook failed: ${String(e)}`);
    }

    // also hook retry to observe fallback attempts if available (V2 SessionRetry)
    try {
      // @ts-ignore - retry hook may not exist on some versions
      await ctx.session.hook("retry" as unknown as string, async (input: unknown) => {
        const rec = input as Record<string, unknown>;
        log(`retry hook fired sid=${String(rec["sessionID"] ?? "").slice(0,8)} agent=${String(rec["agent"] ?? "-")} attempt=${String(rec["attempt"] ?? "-")}`);
        // don't interfere, just observe
      });
      log("retry hook registered");
    } catch {
      log("retry hook not available");
    }

    const ac = new AbortController();

    async function handleFailure(rawData: Record<string, unknown>): Promise<void> {
      const sessionID = extractSessionID(rawData);
      if (!sessionID) {
        log(`failure event without sessionID: ${JSON.stringify(rawData).slice(0,200)}`);
        return;
      }
      const errorRaw = extractError(rawData);
      const errInfo = toErrorInfo(errorRaw);
      const statusCode = getStatusCode(errorRaw);

      log(`failure sid=${sessionID.slice(0,8)} name=${String(errInfo.name ?? "-")} status=${String(statusCode ?? "-")} msg=${(errInfo.message ?? "").slice(0,180)}`);

      // classifications
      if (isTokenLimitError(errInfo)) {
        log(`skip token-limit sid=${sessionID.slice(0,8)}`);
        return;
      }
      if (isUnrecoverableRequestError(errorRaw)) {
        log(`skip unrecoverable sid=${sessionID.slice(0,8)}`);
        return;
      }
      if (!isRetryableModelError({ ...errInfo, statusCode })) {
        log(`skip non-retryable sid=${sessionID.slice(0,8)}`);
        return;
      }

      // hold guard 5s
      const st = store.get(sessionID);
      const now = Date.now();
      if (st && now < st.holdUntil) {
        log(`skip hold guard sid=${sessionID.slice(0,8)} until=${st.holdUntil - now}ms left`);
        return;
      }

      // resolve agent
      let agent = lastPromptAgent[sessionID] || "";
      if (!agent) {
        try {
          const info = await (ctx.session as unknown as { get: (arg: unknown) => Promise<unknown> }).get({ sessionID } as unknown as Record<string, unknown>) as Record<string, unknown>;
          // unwrap data field if needed
          const unwrapped = (info as Record<string, unknown>)["data"] as Record<string, unknown> | undefined;
          const src = unwrapped ?? info;
          if (src && typeof src["agent"] === "string") agent = src["agent"] as string;
          else if (src && typeof (src as Record<string, unknown>)["id"] === "string") {
            // fallback: try context to infer agent
          }
        } catch {}
      }
      if (!agent) agent = "build";
      const normAgent = normalizeAgentKey(agent);

      // lookup chain
      let chain: ChainEntry[] | undefined;
      let chainKey = normAgent;
      if (routingConfig) {
        chain = routingConfig.chains[normAgent]?.chain;
        if (!chain) {
          // try verbatim hyphenated? already normalized handles hyphen
          // fallback to build if not found
          if (normAgent !== "build") {
            chain = routingConfig.chains["build"]?.chain;
            if (chain) chainKey = "build";
          }
        }
      }
      if (!chain || chain.length === 0) {
        log(`no chain for agent=${agent} norm=${normAgent} sid=${sessionID.slice(0,8)}`);
        return;
      }

      const attemptCount = st?.attemptCount ?? 0;
      const maxAttempts = routingConfig ? getMaxFallbackAttempts(routingConfig, chainKey) : 3;
      if (attemptCount >= maxAttempts) {
        log(`max attempts reached sid=${sessionID.slice(0,8)} attempt=${attemptCount} max=${maxAttempts}`);
        return;
      }
      const nextIdx = attemptCount + 1;
      if (nextIdx >= chain.length) {
        log(`exhausted chain sid=${sessionID.slice(0,8)} nextIdx=${nextIdx} len=${chain.length}`);
        return;
      }
      const next = chain[nextIdx];
      const parsed = parseModelString(next.model);
      if (!parsed) {
        log(`invalid model string ${next.model}`);
        return;
      }



      store.set(sessionID, { chain, cursor: nextIdx, attemptCount: nextIdx, holdUntil: now + HOLD_MS, lastError: errorRaw });
      log(`fallback sid=${sessionID.slice(0,8)} agent=${chainKey} ${attemptCount}->${nextIdx} model=${parsed.providerID}/${parsed.modelID} variant=${next.variant ?? "-"}`);

      // switchModel: verify signature {sessionID, model:{id,providerID,variant?}}
      try {
        const modelPayload: Record<string, string> = { id: parsed.modelID, providerID: parsed.providerID };
        if (next.variant) modelPayload["variant"] = next.variant;
        await (ctx.session as unknown as { switchModel: (arg: unknown) => Promise<void> }).switchModel({ sessionID, model: modelPayload });
        log(`switchModel ok sid=${sessionID.slice(0,8)} -> ${parsed.providerID}/${parsed.modelID}`);
      } catch (e) {
        log(`switchModel failed sid=${sessionID.slice(0,8)} err=${String(e)}`);
        return;
      }

      // replay prompt via delivery queue
      const replayText = lastPrompt[sessionID] || "Reply with exactly this word: ok";
      try {
        // Plugin API expects prompt with delivery queue; try multiple shapes
        const promptApi = ctx.session as unknown as { prompt: (arg: unknown) => Promise<void> };
        try {
          await promptApi.prompt({ sessionID, text: replayText, delivery: "queue" });
        } catch (firstErr) {
          // fallback shape: {sessionID, prompt: {text: replayText}, delivery}
          log(`prompt shape1 failed, trying shape2: ${String(firstErr)}`);
          await promptApi.prompt({ sessionID, prompt: { text: replayText }, delivery: "queue" } as unknown as Record<string, unknown>);
        }
        log(`re-dispatched prompt sid=${sessionID.slice(0,8)} len=${replayText.length}`);
      } catch (e) {
        log(`prompt replay failed sid=${sessionID.slice(0,8)} err=${String(e)}`);
      }
    }

    // event subscription loop (defensive both types)
    (async () => {
      try {
        const stream = (ctx.event as unknown as { subscribe: (opts: { signal: AbortSignal }) => AsyncIterable<{ type: string; data: Record<string, unknown>; id?: string }> }).subscribe({ signal: ac.signal });
        log("event loop started, subscribing to session.error + session.execution.failed + session.created");
        for await (const ev of stream) {
          const t = ev.type as string;
          log(`event received type=${t} data=${JSON.stringify((ev as unknown as { data: unknown }).data).slice(0,500)}`);
          if (t === "session.error" || t === "session.execution.failed" || t === "session.status") {
            if (t === "session.status") {
              const d = (ev as unknown as { data: Record<string, unknown> }).data as Record<string, unknown> | undefined;
              if (d && (d["status"] as Record<string, unknown>)?.["type"] === "retry") {
                log(`session.status retry sid=${String(d["sessionID"] ?? "").slice(0,8)}`);
              }
              continue;
            }
            const data = (ev as unknown as { data: Record<string, unknown> }).data ?? (ev as unknown as { properties: Record<string, unknown> }).properties ?? {};
            await handleFailure(data as Record<string, unknown>);
          } else if (t === "session.created") {
            const d = (ev as unknown as { data: Record<string, unknown> }).data ?? {};
            const sid = extractSessionID(d);
            if (sid) log(`session.created sid=${sid.slice(0,8)}`);
          } else if (t === "session.idle") {
            // placeholder for proactive routing (MVP no-op)
          }
        }
      } catch (e) {
        if ((e as Error).name !== "AbortError") log(`event loop error: ${String(e)} ${(e as Error).stack ?? ""}`);
      }
    })();

    log("setup complete, no tools registered (hooks+events only)");

    return async () => {
      log("dispose start");
      ac.abort();
      for (const p of [globalPath, projectPath, altProjectPath]) {
        try { unwatchFile(p); } catch {}
      }
      clearInterval(pollNew);
      store.stopPrune();
      store.cleanup();
      log("dispose done");
    };
  },
});

export default plugin;
