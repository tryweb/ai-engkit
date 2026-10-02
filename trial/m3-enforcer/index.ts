import { Plugin } from "@opencode/plugin";
import { appendFileSync } from "node:fs";
import { CONTINUATION_COOLDOWN_MS, CONTINUATION_PROMPT, DEFAULT_SKIP_AGENTS, PLUGIN_ID } from "./constants";
import { createTodoStore } from "./todo-store";
import type { V2TodoItem } from "./todo-store";
import { getIncompleteCount } from "./todo";
import { createEnforcerStateStore } from "./session-state";

function log(...args: unknown[]): void {
  const line = `[${PLUGIN_ID}] ${new Date().toISOString()} ${args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ")}`;
  try { console.log(line); } catch {}
  try { appendFileSync("/tmp/m3-enforcer.log", line + "\n"); } catch {}
  try { appendFileSync("/home/devuser/.local/share/opencode/log/m3-enforcer.log", line + "\n"); } catch {}
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

function normalizeAgentKey(a: string): string { return a.toLowerCase().trim(); }

export const plugin = Plugin.define({
  id: PLUGIN_ID,
  setup: async (ctx: Plugin.Context) => {
    log("setup start");

    // --- storage: KV todo store on ctx.storage (ONLY durable todo store on V2) ---
    const storage = (ctx as unknown as { storage: unknown }).storage as {
      get: (k: string) => Promise<unknown>;
      set: (k: string, v: unknown) => Promise<void>;
      remove: (k: string) => Promise<void>;
      scan: (opts: { prefix: string; after?: string; limit: number }) => Promise<{ entries: { key: string; value: unknown }[]; next?: string }>;
    } | undefined;

    if (!storage || typeof storage.get !== "function" || typeof storage.set !== "function") {
      log("storage unavailable — enforcer running in no-op mode (no todos possible)");
    } else {
      log("storage available");
    }

    const todoStore = storage ? createTodoStore(storage as unknown as Parameters<typeof createTodoStore>[0]) : null;

    const stateStore = createEnforcerStateStore();
    stateStore.startPrune();

    // --- skipAgents: hardcode MVP to ALL native agents with skipAgents constant ---
    // Follow-up: converge with B1's routing.json reader if reused (do not duplicate loader now)
    const skipAgents = new Set(DEFAULT_SKIP_AGENTS.map(normalizeAgentKey));
    log(`skipAgents=${[...skipAgents].join(",")}`);

    // Track last retryable failure per session for arbitration (routing wins on shared failure)
    const lastFailureAt = new Map<string, number>();
    const lastFailureRetryable = new Map<string, boolean>();

    function isRetryableLike(msg: string): boolean {
      const m = msg.toLowerCase();
      return m.includes("unavailable") || m.includes("rate limit") || m.includes("overloaded") || m.includes("timeout") || m.includes("retry");
    }

    async function handleIdle(sessionID: string): Promise<void> {
      if (!sessionID) return;

      // Arbitration: routing wins on shared failure — one-line precedence (spec §3)
      // If last failure was retryable and very recent (<5s), defer to b1-routing's fallback.
      const lf = lastFailureAt.get(sessionID);
      if (lf && Date.now() - lf < CONTINUATION_COOLDOWN_MS && lastFailureRetryable.get(sessionID)) {
        log(`skip arbitration: routing wins sid=${sessionID.slice(0, 8)} lastFailure ${Date.now() - lf}ms ago`);
        return;
      }

      // Cooldown guard — single client-side 5s hold per spec MVP
      const st = stateStore.getExisting(sessionID);
      if (st?.lastInjectedAt && Date.now() - st.lastInjectedAt < CONTINUATION_COOLDOWN_MS) {
        log(`skip cooldown sid=${sessionID.slice(0, 8)} remain=${CONTINUATION_COOLDOWN_MS - (Date.now() - st.lastInjectedAt)}ms`);
        return;
      }
      if (st?.allTodosCompletedAt) {
        log(`skip allDone sid=${sessionID.slice(0, 8)} completedAt=${st.allTodosCompletedAt}`);
        return;
      }

      // Fetch todos from KV — absent store = no todos = no-op, never error
      if (!todoStore) {
        log(`skip no-store sid=${sessionID.slice(0, 8)}`);
        return;
      }
      let todos: V2TodoItem[];
      try {
        todos = await todoStore.get(sessionID);
      } catch (e) {
        log(`todo fetch failed sid=${sessionID.slice(0, 8)} err=${String(e)} — no-op`);
        return;
      }
      if (!todos || todos.length === 0) {
        log(`no todos sid=${sessionID.slice(0, 8)} — no-op`);
        // reset allDone if previously set and todos cleared (allows reuse)
        if (st) delete st.allTodosCompletedAt;
        return;
      }

      const incompleteCount = getIncompleteCount(todos);
      const total = todos.length;
      const completed = total - incompleteCount;

      if (incompleteCount === 0) {
        const s = stateStore.getState(sessionID);
        s.allTodosCompletedAt = Date.now();
        log(`all done sid=${sessionID.slice(0, 8)} total=${total} — gate closed`);
        return;
      }
      // clear allDone if new incomplete appeared
      if (st?.allTodosCompletedAt) delete st.allTodosCompletedAt;

      // Optional agent skip — try to resolve agent from session.get, else skip check if unknown
      let agent: string | undefined;
      try {
        const info = await (ctx.session as unknown as { get: (arg: unknown) => Promise<unknown> }).get({ sessionID } as unknown as Record<string, unknown>) as Record<string, unknown>;
        const unwrapped = (info as Record<string, unknown>)["data"] as Record<string, unknown> | undefined;
        const src = unwrapped ?? info;
        if (src && typeof src["agent"] === "string") agent = src["agent"] as string;
      } catch {}
      // also try session.context fallback for agent (best-effort, no error)
      if (!agent) {
        try {
          const c = await (ctx.session as unknown as { context: (arg: unknown) => Promise<unknown> }).context({ sessionID } as unknown as Record<string, unknown>) as Record<string, unknown>;
          const msgs = (c as Record<string, unknown>)["messages"] ?? (c as Record<string, unknown>)["data"];
          if (Array.isArray(msgs)) {
            for (let i = msgs.length - 1; i >= 0; i--) {
              const m = msgs[i] as Record<string, unknown>;
              const info = (m as Record<string, unknown>)["info"] as Record<string, unknown> | undefined;
              const ag = (info?.["agent"] ?? (m as Record<string, unknown>)["agent"]) as string | undefined;
              if (typeof ag === "string" && ag.length > 0) { agent = ag; break; }
            }
          }
        } catch {}
      }
      if (agent && skipAgents.has(normalizeAgentKey(agent))) {
        log(`skip agent sid=${sessionID.slice(0, 8)} agent=${agent}`);
        return;
      }

      // Build continuation prompt per spec §3.1 + status line
      const incompleteTodos = todos.filter((t) => t.status !== "completed" && t.status !== "cancelled");
      const statusLine = `[Status: ${completed}/${total} completed, ${incompleteCount} remaining]`;
      const remainingList = incompleteTodos.map((t) => `- [${t.status}] ${t.content}`).join("\n");
      const text = `${CONTINUATION_PROMPT}\n\n${statusLine}\n\nRemaining tasks:\n${remainingList}`;

      // Dispatch via V2 session.prompt with delivery:"queue" (MVP: no dedupe beyond cooldown, no tools forwarding per Q8)
      try {
        const promptApi = ctx.session as unknown as { prompt: (arg: unknown) => Promise<void> };
        try {
          await promptApi.prompt({ sessionID, text, delivery: "queue" });
        } catch (firstErr) {
          const msg = String(firstErr);
          // fallback shape if server expects different envelope
          if (msg.includes("path must be") || msg.includes("sessionID")) {
            log(`prompt shape1 failed, trying shape2 sid=${sessionID.slice(0, 8)} err=${msg.slice(0, 200)}`);
            await promptApi.prompt({ sessionID, prompt: { text }, delivery: "queue" } as unknown as Record<string, unknown>);
          } else {
            throw firstErr;
          }
        }
        const s = stateStore.getState(sessionID);
        s.lastInjectedAt = Date.now();
        log(`injected sid=${sessionID.slice(0, 8)} incomplete=${incompleteCount} total=${total} agent=${agent ?? "-"} len=${text.length}`);
      } catch (e) {
        log(`inject failed sid=${sessionID.slice(0, 8)} err=${String(e).slice(0, 300)}`);
        // do not update lastInjectedAt on failure — allows retry after cooldown
      }
    }

    const ac = new AbortController();

    // Defensive subscribe BOTH idle-ish events per spec uncertainty 3 pattern (session.idle + session.status idle)
    (async () => {
      try {
        const stream = (ctx.event as unknown as { subscribe: (opts: { signal: AbortSignal }) => AsyncIterable<{ type: string; data: Record<string, unknown> }> }).subscribe({ signal: ac.signal });
        log("event loop started, subscribing to session.idle + session.status + session.error/session.execution.failed + session.deleted");
        for await (const ev of stream) {
          const t = ev.type as string;
          const data = (ev as unknown as { data: Record<string, unknown> }).data ?? (ev as unknown as { properties: Record<string, unknown> }).properties ?? {};
          // keep log bounded
          if (t === "session.idle" || t === "session.status" || t === "session.error" || t === "session.execution.failed" || t === "session.deleted") {
            log(`event type=${t} sid=${String((data as Record<string, unknown>)["sessionID"] ?? (data as Record<string, unknown>)["id"] ?? "").slice(0, 8)}`);
          }
          if (t === "session.idle") {
            const sid = extractSessionID(data as Record<string, unknown>);
            if (sid) await handleIdle(sid);
          } else if (t === "session.status") {
            const d = data as Record<string, unknown>;
            const status = (d["status"] as Record<string, unknown>)?.["type"] as string | undefined;
            if (status === "idle") {
              const sid = extractSessionID(d);
              if (sid) {
                log(`derived idle from session.status sid=${sid.slice(0, 8)}`);
                await handleIdle(sid);
              }
            }
          } else if (t === "session.error" || t === "session.execution.failed") {
            const d = data as Record<string, unknown>;
            const sid = extractSessionID(d);
            if (sid) {
              const errRaw = (d["error"] ?? d["data"] ?? d) as unknown;
              let msg = "";
              try { msg = JSON.stringify(errRaw).slice(0, 500); } catch { msg = String(errRaw).slice(0, 500); }
              const retryable = isRetryableLike(msg);
              lastFailureAt.set(sid, Date.now());
              lastFailureRetryable.set(sid, retryable);
              log(`recorded failure sid=${sid.slice(0, 8)} retryable=${retryable} msg=${msg.slice(0, 120)}`);
              // prune old failure entries after 30s
              setTimeout(() => {
                if (Date.now() - (lastFailureAt.get(sid) ?? 0) > 30000) {
                  lastFailureAt.delete(sid);
                  lastFailureRetryable.delete(sid);
                }
              }, 30000);
            }
          } else if (t === "session.deleted") {
            const sid = extractSessionID(data as Record<string, unknown>);
            if (sid) {
              stateStore.cleanup(sid);
              lastFailureAt.delete(sid);
              lastFailureRetryable.delete(sid);
              log(`cleanup sid=${sid.slice(0, 8)}`);
            }
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
      stateStore.shutdown();
      lastFailureAt.clear();
      lastFailureRetryable.clear();
      log("dispose done");
    };
  },
});

export default plugin;
