import { Plugin } from "@opencode/plugin";
import { appendFileSync } from "node:fs";
import { tool } from "@opencode-ai/plugin/tool";
import { CONTINUATION_COOLDOWN_MS, CONTINUATION_PROMPT, DEFAULT_SKIP_AGENTS, PLUGIN_ID, TODO_PREFIX } from "./constants";
import { createTodoStore, normalizeTodosForStore } from "./todo-store";
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

// --- seen.ref shim (normalizeToolArgSchemas equivalent) ---
// Patches each schema._zod.toJSONSchema to delegate via tool.schema.toJSONSchema(schema)
// so host's Zod serialization (which threads `seen: {ref}`) does not throw `seen.ref`.
function applyNormalizeShim(def: { args: Record<string, unknown> }): void {
  for (const schema of Object.values(def.args as Record<string, Record<string, unknown>>)) {
    const zodState = (schema as unknown as { _zod?: Record<string, unknown> })._zod;
    if (!zodState) continue;
    if (typeof zodState["toJSONSchema"] === "function") continue;
    const original = zodState["toJSONSchema"] as (() => unknown) | undefined;
    (zodState as Record<string, unknown>)["toJSONSchema"] = function (this: unknown): unknown {
      const saved = zodState["toJSONSchema"];
      try {
        // Remove override so tool.schema.toJSONSchema sees the bare schema
        delete zodState["toJSONSchema"];
        const out = (tool.schema as unknown as { toJSONSchema: (s: unknown) => Record<string, unknown> }).toJSONSchema(schema);
        const { $schema: _s, ...rest } = out as Record<string, unknown>;
        return rest;
      } finally {
        if (original !== undefined) zodState["toJSONSchema"] = original;
        else if (saved !== undefined) zodState["toJSONSchema"] = saved;
        else delete zodState["toJSONSchema"];
        // restore our override for next call
        if (typeof zodState["toJSONSchema"] !== "function") {
          (zodState as Record<string, unknown>)["toJSONSchema"] = (arguments.callee as unknown as () => unknown);
        }
      }
    };
  }
}

// Minimal fallback: if _zod patching mismatches runtime shape, we also provide a simpler
// patch that directly mirrors the reference implementation (attachJsonSchemaOverride).
function attachJsonSchemaOverrideSimple(schema: unknown): void {
  const z = (schema as unknown as { _zod?: { toJSONSchema?: () => unknown } })._zod;
  if (!z) return;
  if (z.toJSONSchema) return;
  const toolSchema = tool.schema as unknown as { toJSONSchema: (s: unknown) => Record<string, unknown> };
  z.toJSONSchema = (): Record<string, unknown> => {
    const orig = z.toJSONSchema;
    delete z.toJSONSchema;
    try {
      const out = toolSchema.toJSONSchema(schema);
      const { $schema: _schema, ...rest } = out as Record<string, unknown>;
      return rest;
    } finally {
      if (orig) z.toJSONSchema = orig;
    }
  };
}

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

    // --- todo_write tool registration (Option B) ---
    // Args built ONLY via tool.schema.* primitives; shim applied before add.
    if (todoStore && (ctx as unknown as { tool?: { transform: unknown } }).tool) {
      try {
        const schemaStrings = tool.schema as unknown as {
          string: () => { min: (n: number) => { max: (m: number) => { describe: (s: string) => unknown } } };
          enum: (vals: string[]) => { describe: (s: string) => unknown; optional: () => unknown };
          object: (shape: Record<string, unknown>) => unknown;
          array: (inner: unknown) => { min: (n: number) => { max: (m: number) => { describe: (s: string) => unknown } } };
        };
        const todoItemSchema = (tool.schema as unknown as { object: (s: Record<string, unknown>) => unknown }).object({
          content: (tool.schema as unknown as { string: () => { min: (n: number) => { max: (m: number) => { describe: (s: string) => unknown } } } }).string().min(1).max(500).describe("Task description"),
          status: (tool.schema as unknown as { enum: (v: string[]) => { describe: (s: string) => unknown } }).enum(["pending", "in_progress", "completed", "cancelled"]).describe("Task status"),
          priority: (tool.schema as unknown as { enum: (v: string[]) => { optional: () => { describe: (s: string) => unknown } } }).enum(["low", "medium", "high"]).optional().describe("Optional priority"),
          id: (tool.schema as unknown as { string: () => { optional: () => { describe: (s: string) => unknown } } }).string().optional().describe("Stable ID; if omitted, derived as content:priority for diffing"),
        });
        const todosArraySchema = (tool.schema as unknown as { array: (i: unknown) => { min: (n: number) => { max: (m: number) => { describe: (s: string) => unknown } } } }).array(todoItemSchema).min(1).max(50).describe("Full replacement todo list for this session");

        const toolDef: { description: string; args: Record<string, unknown>; execute: (args: unknown, context: unknown) => Promise<unknown> } = {
          description:
            "Manage the session todo list. Create or update tasks; the enforcer uses this list to continue work after idle. " +
            "Statuses: pending (not started), in_progress (active), completed, cancelled. Use blocked/deleted semantics via pending/omit.",
          args: {
            todos: todosArraySchema,
          },
          execute: async (args: unknown, context: unknown) => {
            // Accept both {todos:[...]} and bare array for robustness
            let raw: V2TodoItem[];
            if (Array.isArray(args)) raw = args as V2TodoItem[];
            else {
              const a = args as { todos?: V2TodoItem[] };
              raw = Array.isArray(a.todos) ? a.todos : [];
            }
            const capped = raw.slice(0, 50);
            const normalized = normalizeTodosForStore(capped as unknown as Parameters<typeof normalizeTodosForStore>[0]);
            const ctxObj = context as { sessionID?: string };
            const sid = ctxObj.sessionID;
            if (!sid || typeof sid !== "string") throw new Error("missing sessionID");
            await todoStore.set(sid, normalized);
            const pending = getIncompleteCount(normalized);
            log(`todo_write sid=${sid.slice(0, 8)} n=${normalized.length} pending=${pending}`);
            const preview = normalized.slice(0, 5).map((t) => `[${t.status}] ${t.content.slice(0, 80)}`).join("\n");
            const text = `stored ${normalized.length} tasks (${pending} pending/in_progress)\n${preview}`;
            return { content: text } as unknown as string;
          },
        };

        // Apply seen.ref shim before registration (exact fix for 14-tool failure)
        for (const s of Object.values(toolDef.args as Record<string, unknown>)) {
          attachJsonSchemaOverrideSimple(s);
        }

        const toolInstance = tool(toolDef as unknown as Parameters<typeof tool>[0]);
        // Attach name explicitly if helper didn't set it (Tool.Info requires name)
        const withName = { ...(toolInstance as Record<string, unknown>), name: "todo_write" } as unknown as Record<string, unknown>;
        // Ensure _zod patch survived tool() wrapping — re-patch if needed via withName.input handling
        // tool() sets input via tool.schema.object(args); we need to ensure that inner schemas are patched.
        // Fallback: patch the constructed input's properties if present.
        const maybeInput = withName["input"] as { _zod?: unknown; def?: unknown } | undefined;
        // No-op if already patched; defensive.

        await (ctx as unknown as { tool: { transform: (fn: (e: { add: (i: unknown) => void }) => void) => Promise<void> } }).tool.transform(
          (editor) => {
            editor.add(withName);
          }
        );
        log("todo_write tool registered");
      } catch (e) {
        log(`todo_write registration failed (non-fatal, enforcer stays hooks-only): ${String(e).slice(0, 500)}`);
      }
    } else {
      log("todo_write not registered (storage or tool domain missing)");
    }

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

    log("setup complete, tools: todo_write registered via ctx.tool.transform");

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
