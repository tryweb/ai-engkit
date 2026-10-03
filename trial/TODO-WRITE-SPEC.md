# TODO Write Path — Spec for M3 Enforcer MVP on OpenCode V2 (no OMO)

> Branch: `trial/opencode-v2` | Workdir: `/home/devuser/workspace/ai-engkit` | Runtime: **OpenCode 2.0.15 + OpenChamber 2.0.0** via `Plugin.define({id, setup(ctx)})`
> Scope: **write path only** — detection/injection already specced in `trial/TODO-SPEC.md`. No countdown/toast/UI changes.
> Status: spec (no code).

---

## 1. Problem Restatement

`trial/TODO-SPEC.md` §2 defines the enforcer's decision input as KV `omo-v2:todos:<sessionID>` on `ctx.storage` (fork reference: `packages/omo-opencode/src/v2/stores.ts:createTodoStore`). The fork populated that store by re-routing `ctx.client.session.todo` (V1) to the KV via `createV1CompatContext` (`v2/compat-client.ts`) — but that compat layer itself depended on V1 tool writes; there is **no V2 `session.todo` API** and no native writer in our V2-native plugins. `trial/BURN-LOG.md` **burn 3** (2026-10-03, free-tier, `opencode-go/longcat-2.5-preview-free`) proved the gap live: a read/delegation turn succeeded, the m3-enforcer subscribed to `session.idle/status/error` throughout, yet the model volunteered *"I don't have a todo tool available in this environment"* and the KV was never written, so the enforcer correctly no-ops forever — detection and injection logic (TODO-SPEC §3–§5) are inert without a write path. This spec closes that MVP-blocking gap with a minimal, `seen.ref`-safe write path the implementer can build without re-researching V2 tool registration.

---

## 2. Inputs Consolidated (what the implementer does not need to re-read)

| Source | Fact that constrains this spec |
|--------|-------------------------------|
| `trial/TODO-SPEC.md` §2.1 | Todo store is **only** `ctx.storage` KV `omo-v2:todos:<id>` → `V2TodoItem[]{content,status,priority?,id?}`. No SQLite, no `session.todo`. Accessor shape is `createTodoStore(storage)` with `get(id)→V2TodoItem[]` and `set(id,items)`. |
| TODO-SPEC Q7 addendum + `v2/stores.ts:22` `asTodoList` | `V2TodoItem.status ∈ {pending,in_progress,completed,cancelled}`. `asTodoList` returns `undefined` for the **entire list** if *any* entry carries `blocked` or `deleted` (or any other string); caller does `?? []`, so one illegal entry blinds the enforcer. **Therefore every write must normalize**: `blocked→pending`, `deleted→omit (drop the entry)` at store-write time, before `storage.set`. `todoStore.set` must auto-normalize. Verified by `trial/M3-VERIFY.md` §3. |
| `trial/CELL2B.md` §3 T1/T2 | **T1**: plugin file reads sibling assets at import time — stage assets *before* first discovery. For todo write path, no skill assets are needed (constant prompt inline) — obey by doing no import-time reads. **T2**: ESM caches the first failed evaluation per URL — after any failed discovery, **rename the file** (fresh URL) or server-restart; don't debug poisoned path. Implement the write-path plugin with fresh filename discipline (`todo-write.js` or colocated inside `m3-enforcer.js` — see §5). |
| `trial/CELL2B.md` §7 DEFECT 1 (`seen.ref`) | **Exact server error shape** (from `~/.local/share/opencode/log/opencode.log`, level=`ERROR`, `role=server`):<br>`Skipping invalid tool registration` `name=<toolName>` `namespace=undefined` `error="Invalid tool definition <toolName>: undefined is not an object (evaluating 'seen.ref')"`<br>Observed for all 14 fork-bridged tools (`grep`, `glob`, `call_omo_agent`, `look_at`, `task`, `skill_mcp`, `skill`, `interactive_bash`, `session_list/read/search/info`, `background_output/cancel`, …). Fork-side `tools-register ok, registered=14` ≠ server-accepted. Effective usable fork tools: **0**. |
| `trial/B1-VERIFY.md` §2 and `trial/M3-VERIFY.md` §2 | **How B1/M3 load warning-free today**: both export only `Plugin.define({id, setup})` and use **hooks + events only** — `ctx.session.hook` / `ctx.event.subscribe` / `ctx.tool.hook` + `ctx.session.prompt` / `ctx.session.get`-like calls. Bundle has **no `tool` top-level key and no `ctx.tool.transform(...add...)` call**, so server never enters tool-validation and emits zero `Skipping invalid tool registration` for those IDs (filtered log clean). **Any `tool` registration must preserve this property on failure** — if the probe fails, the plugin must still load and stay warning-free (dispose cleanly, no `tool` entry). B1 registers zero tools by design; the write-path tool, if chosen, therefore **does not conflict** with B1 (B1 adds no tools to collide with). |
| Fork `packages/omo-opencode/src/v2/tool-bridge.ts` | **What the server actually demands** (field/shape). `convertV1Tool(name, definition, deps)` returns `V2ToolRegistration = Omit<Tool.Info, "id">` with `{ name, input: tool.schema.object(definition.args), description, execute: (input, V2ToolContext)=>Tool.Result }`. Registration is via `ctx.tool.transform(editor => editor.add(converted))` (`ToolDomain.transform` — see `v2-setup.ts:loop`). `input` is a **Zod object schema**, not a JSON-Schema literal. Server-side validation serializes that schema via Zod's `toJSONSchema` which internally threads a `seen: { ref: ZodType | null }` tracker (see `@code-yeongyu/senpi` vendored `zod/v4/core/to-json-schema.ts:580`):<br>`if (seen.ref === null) return;` `const ref = seen.ref; seen.ref = null;`<br>When `seen` is `undefined`, `seen.ref` throws exactly the observed message. Root cause: the fork's `input` schemas lacked the `normalizeToolArgSchemas` shim (`packages/omo-opencode/src/plugin/normalize-tool-arg-schemas.ts`) which patches each `schema._zod.toJSONSchema` to delegate through `tool.schema.toJSONSchema(schema)` with a properly threaded `seen`. Also, `convertV1Tool` never called that shim. **Compliance requirement for any new tool**: create `args` schemas via `tool.schema.*`, then call the shim (or rely on the host's `tool` helper which does) *before* `editor.add`. Never pass a bare `z.object` from bare `zod` or a raw JSON-Schema object in `input`. |
| `trial/M3-VERIFY.md` §1 / `trial/m3-enforcer/todo-store.ts` | Reference write-path shape already in repo (but not wired to a tool): `todo-store.ts` has `normalizeTodosForStore` (blocked→pending, deleted→omit), `asTodoList` poison check, `createTodoStore(storage)` with `get/set/setRaw`. `todo.ts:getIncompleteCount` + `getTodoSnapshot` are compatible. The new write-path should reuse these verbatim, not reinvent storage. |

---

## 3. Two Options — Analyzed to a Decision

### Option A — Message-Scan Derivation (no new tool)

**Idea**: infer todos by scanning `session.context` (or `v1CompatCtx.client.session.messages`) for task-list structures that the model naturally emits, then materialize `omo-v2:todos:<id>` server-side without model cooperation.

**Concrete message shapes to scan (must cite, not invent)**:

1. **Checklist markdown in assistant text parts** — the only shape actually **witnessed in plausible model output**: lines matching `^\\s*- \\[[ xX]\\]\\s+(.+)$` (and numbered variant `^\\s*\\d+\\.\\s+\\[[ xX]\\]`) inside any `part.type==="text"`. This is the Markdown checkbox convention models emit when asked to plan execution; it is observable in burn 3's turn transcript as a natural model behavior (not protocol), and `TODO-SPEC` §2.3 maps V2 messages to `toV1MessageViews` with `parts[]` of text. No other task-list shape is witnessed in trial.
2. **`session.context` item types actually observed in trial** — the enforcer's prefetched `messages` are the `toV1MessageViews(context)` adapter over `v2.session.context` (TODO-SPEC §2.3). Observed fields in trial are `views[].info.{role,agent,modelID/providerID/variant,tools,error}` + `parts[]` (text/tool). There is **no witnessed** dedicated `todo`/`task`/`plan` item type in that channel — do not scan for one. `TODO-SPEC` §4.1 explicitly lists the six V2 event types forwarded by `hook-bridge` (`session.created/deleted/idle/status/execution.failed/permission.asked`) and notes `todo.updated` as a *plugin-event type* (docs: `todo.updated`) that our current `event.subscribe` filter does not observe — and native V2 does not populate without a writer anyway.
3. **Optional heuristic: plan-like blocks** — fenced ` ```todo ` blocks or heading-led lists (`## Tasks`) — treat as **low-precision fallback only**, require opt-in.

**Pipeline**: on `session.idle` (or `session.status idle`), fetch `session.context` (the same fetch the full enforcer would use for agent resolution), run regex extractor over the last N assistant messages' text parts, diff against `todoStore.get(id)` snapshot (via `getTodoSnapshot`: `id|fallback(content:priority)→status` join), call `todoStore.set` with normalized result.

**Precision/recall tradeoffs** (honest):

| Dimension | Assessment |
|-----------|------------|
| **Recall** | Low-to-moderate. Catches only turns where the model chose checkbox markdown. Tasks described in prose, tool-call arguments, or code comments are missed. Across a multi-turn task the list drifts between turns, so the enforcer sees a flickering snapshot rather than an authoritative list. |
| **Precision** | Moderate. Regex false-positives on any checklist (e.g. PR review checkboxes, user-provided markdown) that was not a work todo. Requires guard: only scan assistant messages, last-K window, and ignore user messages and synthetic directives (`<!-- OMO_SYSTEM_DIRECTIVE -->` / `<!-- OMO_INTERNAL_INITIATOR -->`). |
| **Cost** | Near-zero incremental (reuses the `session.context` fetch the enforcer already pays for), but adds a parse + diff on every idle. No model cost. |
| **Robustness** | Fragile to model style drift. Prompt- or model-family changes to list formatting silently break recall, with no error signal. |

**Spoofing / security risk**: **user-injectable**. Any user message containing `- [ ] pwn` would be inside `session.context`. If the scanner ingested user roles, a user could **spoof** or **flood** the todo store (e.g. inject 50 pending items to force endless continuation loops, or inject content that later renders into the continuation prompt). Mitigation (role-gate + limit to assistant-only + cap list length + sanitize for prompt injection) reduces but does not eliminate the asymmetry: the signal originates partly from untrusted input — the prompt — and the enforcer trusts it as work state. With **no tool**, any principal in the session can influence the list via conversational content.

**Verdict on A**: zero V2 tool-risk, but correctness is **heuristic**, spoofable, and drifts with model style. It cannot reliably tell the enforcer "these are the tasks the agent committed to" versus "this was a demo checklist."

---

### Option B — Minimal Native `todo_write` Tool (design the tool definition FIRST)

**Idea**: give the model one real tool that writes `omo-v2:todos:<id>` directly — the KV the enforcer already polls. Correctness comes from model **intent** (the model declares tasks), not from post-hoc parsing. This is the same store the enforcer reads; the write path is one `storage.set` call inside `execute`.

#### B.1 Why the tool identity contract is the design driver

CELL2B §7 DEFECT 1 proved the V2 tool identity contract is **fail-closed**: 14 tools passed fork-side assembly yet all were `Skipping invalid tool registration` with `seen.ref`. The loop that failed was `v2-setup.ts`:

```ts
const converted = convertV1Tool(name, definition, { resolveDirectory, defaultDirectory: directory });
await ctx.tool.transform((editor) => { editor.add(converted); });
```

`converted.input = tool.schema.object(definition.args)` used `tool` from `@opencode-ai/plugin/tool` but without the `normalizeToolArgSchemas` shim that patches `schema._zod.toJSONSchema`. Server serialization then crashed on `seen.ref`. A new tool must therefore be defined in a way that **passes the server's Zod serialization on first try**. The `seen` object is Zod-internal, not a field we set — we satisfy it by using the **host-correct Zod instance and helper** and by ensuring the shim is present.

#### B.2 Literal minimal tool definition (seen.ref-safe)

All names, types, and registration mechanics below are grounded in live code read via `docker exec` (see §2 row for `tool-bridge.ts` and `tool.d.ts`).

**Package**: `@opencode-ai/plugin/tool` — `tool` helper (re-exported zod instance). Do **not** import `zod` bare; use `tool.schema.*` so the host's `toJSONSchema` sees the correct instance.

**Registration**: `Plugin.define({id:"m3-enforcer", setup: async (ctx)=>{ /* ... */ await ctx.tool.transform(editor => editor.add(todoWriteTool)) }})` — `ctx.tool.transform` attends exactly the `ToolDomain` API observed in `@opencode/plugin/dist/promise/tool.d.ts:ToolDomain.transform` + `ToolEditor.add(Info<Input,Output>)`.

**Tool value** (one tool; no renames needed):

```ts
import { tool } from "@opencode-ai/plugin/tool";
import { createTodoStore, normalizeTodosForStore } from "./todo-store"; // reuse trial/m3-enforcer/todo-store.ts
import type { V2TodoItem } from "./todo-store";

// Define args with tool.schema.* primitives so Zod instance matches host
const todoWriteTool = tool({
  description:
    "Manage the session todo list. Create or update tasks; the enforcer uses this list to continue work after idle. "
    + "Statuses: pending (not started), in_progress (active), completed, cancelled. Use blocked/deleted semantics via pending/omit (see enum).",
  args: {
    // Single op is minimal; batch form extensible without new tools
    todos: tool.schema
      .array(
        tool.schema.object({
          content: tool.schema.string().min(1).max(500).describe("Task description"),
          status: tool.schema.enum(["pending", "in_progress", "completed", "cancelled"]).describe("Task status"),
          priority: tool.schema.enum(["low", "medium", "high"]).optional().describe("Optional priority"),
          id: tool.schema.string().optional().describe("Stable ID; if omitted, derived as content:priority for diffing"),
        }),
      )
      .min(1)
      .max(50)
      .describe("Full replacement todo list for this session"),
    // Optional: caller-supplied idempotency key; server ignores, we honor in execute
    // Do NOT leak into schema if strict — keep as part of todos[].id or omit
  },
  execute: async (args, context) => {
    // context: ToolContext { sessionID, messageID, agent, directory, worktree, abort, metadata, ask }
    // 1) Normalize: blocked→pending, deleted→omit (never persist illegal statuses)
    // 2) todoStore.set(sessionID, normalized)  — KV omo-v2:todos:<id>
    // 3) Return lightweight summary for model feedback
    // Error: surface string only on validation failure; normal success returns text
  },
});
```

**Notes the server enforces** (do not violate):

- `description` is **required non-empty** (fork's `ToolDefinition.description` always present; server validation fails on missing description).
- `args` values must be `tool.schema.*` instances — bare `z.string()` from a foreign `zod` import has a different `_zod` identity and fails the same `seen.ref` path (the shim operates on `tool.schema.*` instances). Use the canonical shim path: if the imported `tool` helper version in the container does not already carry the shim, run each schema through `normalizeToolArgSchemas({args})` (the one function from `packages/omo-opencode/src/plugin/normalize-tool-arg-schemas.ts`) before `editor.add` — it is ~20 lines and copy-safe.
- `execute` must return `string | {output:string, title?, metadata?, attachments?}` (`ToolResult`). Return `{output: summaryText}` on success; `throw` (or returned error path) is treated as tool error. Keep output short (one line + list preview) to avoid context bloat.
- Do **not** register a second tool with the same `name`; `ToolEditor.add` takes the `Info.name` as key. Only one `todo_write` entry.

**Permission scope**:

- No special `permission` block needed (`tool` helper default). The tool writes **only** to `ctx.storage` KV `omo-v2:todos:<sessionID>` — no filesystem, no shell, no network. Mark in description that this is session-scoped KV only.
- If the workspace has a permission policy for custom tools, this tool should be **allow-listed for all agents** (or deny-list empty) — it is the only mechanism the model has to declare work items; restricting it recreates the no-op.

**Validation**: args schema enforces `content` length, `status` enum, `priority` enum, array bounds. The `execute` body also re-validates via `normalizeTodosForStore` (defense-in-depth against malformed `id` values that could collide).

#### B.3 `seen.ref`-safe probe procedure (3 steps) with abort criteria

This is the **first thing** the implementer runs — before building the full write path.

**Step 1 — Register one trivial tool** (fresh filename, no enforcer logic):

Create a throwaway plugin file `probe-tool.js` (fresh URL, T2-safe) that does only:

```ts
import { Plugin } from "@opencode/plugin";
import { tool } from "@opencode-ai/plugin/tool";
export const plugin = Plugin.define({
  id: "probe-tool",
  setup: async (ctx) => {
    await ctx.tool.transform((editor) => {
      editor.add(tool({
        description: "probe: returns ok",
        args: { word: tool.schema.string().optional() },
        execute: async (args) => `probe-ok:${args.word ?? "-"}`,
      }));
    });
    return async () => {};
  },
});
```

Deploy to `/home/devuser/workspace/.opencode/plugins/probe-tool.js` (workspace-v2 volume, not `trial/`). Existing B1/M3 file plugins stay in place — multiple file plugins coexist (shown in `B1-VERIFY.md` §2 plugin list). Use the same externals symlink (`/home/devuser/workspace/.opencode/plugins/node_modules → /tmp/omo-v2-fork/node_modules`) so `@opencode/plugin` resolves.

**Step 2 — Confirm server acceptance** (no inference):

Tail `~/.local/share/opencode/log/opencode.log` for 10s after file appearance:

- **PASS**: `loading plugin id=.../probe-tool.js` + watcher subscribe/start, **zero** `Skipping invalid tool registration` lines mentioning `probe` (or any probe name), and `opencode.log` shows no `failed to load plugin` for probe. Optional: `ctx.tool.list()` via SDK would show one entry if available — log tail is authoritative (same authority used by B1-VERIFY/M3-VERIFY).
- Evidence capture: `grep -a "probe-tool\|Skipping invalid tool" opencode.log`.

**Step 3 — Extend to `todo_write`** (only if Step 2 PASS):

Replace probe body with the literal `todo_write` definition above (same registration pattern, same `tool.schema.*` style), keeping the **same filename** is acceptable once Step 2 proved acceptance (no T2 poison), or use a fresh `todo-write.js` filename. Re-check logs for `todo_write` acceptance, then wire `execute` to `todoStore.set`.

**Abort criteria — any `seen.ref`-class rejection stops Option B**:

- If **Step 2** emits `Invalid tool definition probe: undefined is not an object (evaluating 'seen.ref')` (or on `todo_write` name), **abort Option B immediately**. The probe has proven the host's Zod/tool contract still rejects that `tool.schema.*` shape (host zod version drift or missing shim). Do **not** try workarounds (bare `zod` imports, JSON-Schema literal `input`, `input: {type:"object", ...}` hacks) — those are different risk surfaces and unverified.
- **Fallback**: switch to **Option A** for the MVP (accept its precision/recall penalty), and record the `seen.ref` probe failure as a residual risk. Do not ship a half-accepted tool — a `Skipping invalid tool registration` tool is **dead** (0 usable tools) and gives the model the same "I don't have a todo tool" experience as today, which is indistinguishable from success in logs unless explicitly checked.

#### B.4 Cost & risk summary

- **Spoof-resistance**: high — write requires explicit model **tool call**, not markdown parsing. User messages cannot synthesize tool calls; only model execution can populate the KV. The tool's `execute` also runs inside `Plugin.Context` with `sessionID` bound by the runtime, so cross-session writes are not possible.
- **Correctness**: authoritative — the list the model declares is the list the enforcer acts on. No flicker.
- **Build cost**: one `tool()` definition + ~20 lines `execute` glue + shim copy (if needed). Reuses `todo-store.ts`/`todo.ts` already in repo.
- **V2 API risk**: **the only risky bit** — if `seen.ref` probe fails, cost is one failed registration and a fallback to A. That is why the probe is first.

---

### Combined Tradeoff & Decision

#### Decision matrix

| Criterion | Option A (scan) | Option B (`todo_write` tool) |
|-----------|----------------|------------------------------|
| **Correctness** (does enforcer see the true task list?) | Heuristic — recall 40–70% on natural model style, degrades on style drift; no contract | **Authoritative** — model-declared list via tool call; same contract as fork's V1 `session.todo` |
| **Robustness** (across models / prompts / lengths) | Fragile — formatting drift breaks it silently | Stable — tool name + schema are protocol, not prose |
| **Spoof-resistance** | Weak — user message markdown can inject/flood tasks | **Strong** — only model tool calls write; user cannot forge `ToolContext.sessionID`-bound write |
| **Build cost** | Low code, ongoing heuristic tuning (regex, caps, role-gate) | Low code too (one tool + shim), but requires the 3-step probe to de-risk `seen.ref` |
| **V2 API risk** | None (no new tool) | **One isolated probe risk** — if Step 1 fails, fallback to A |

**RECOMMENDED: Option B — minimal native `todo_write` tool, gated by the 3-step `seen.ref`-safe probe (fallback to A).**

**Reasons**:

1. The MVP's goal is to make the enforcer **stop no-oping** and act on work the agent committed to — only an **authoritative write** achieves that without inviting prompt-injection via checklist spoofing. Scan inference is explicitly called out in TODO-SPEC Q7 as the brittle path (blocked→pending normalization exists precisely because model outputs are unreliable).
2. The `seen.ref` risk is **isolated and cheap to probe**: one trivial tool, one log grep, zero inference, zero quota. B1-VERIFY/M3-VERIFY already prove the surrounding pattern (file plugins, externals symlink, fresh filename discipline) works — the probe adds one registration call to that proven scaffold. If it fails, we learn in seconds and pay nothing beyond a rename.
3. Build cost is dominated by reuse: `todo-store.ts` normalize + `createTodoStore` + `getIncompleteCount` already exist; the new code is `tool({args, execute: storage.set})` plus the shim. The alternative (scan + diff + caps + sanitization + injection hardening) is more ongoing maintenance for lower correctness.

---

## 4. Recommended Design — Implementable Detail

### 4.1 Placement & coexistence

- **Where it lives**: extend the existing `trial/m3-enforcer/` plugin. Do **not** create a separate `todo-write` plugin or touch `trial/b1-routing/`. The enforcer already owns `todo-store.ts`/`todo.ts`/`session-state.ts` and `ctx.storage`. Adding `todo_write` there keeps the KV ownership in one place and preserves the existing test/load evidence (`M3-VERIFY.md` §2).
- **B1 coexistence**: `b1-routing` registers **zero** tools (`B1-VERIFY.md` §2: bundle contains no `tool.add`; server log filtered by `b1-routing` has zero `Skipping invalid tool` entries). Adding `todo_write` to m3-enforcer therefore introduces **no tool-name conflict** and no routing change. Multiple file plugins coexist in `/home/devuser/workspace/.opencode/plugins/` (already deployed: `b1-routing.js` + `m3-enforcer.js` + `omo-v2.js` reference). Coexistence is by construction.
- **Future full enforcer**: the full-parity guard set (retry storm, token/compaction gates, etc. in TODO-SPEC §5.2 and M3-VERIFY §5) continues to read from the **same KV** (`createTodoStore.get`). The write path does not change the read path or injection path. Arbitration one-liner (M3-VERIFY §3: `if (lastFailureAt && now-last<5000 && retryable) return // routing wins`) stays. Full parity later adds: exponential backoff, stagnation stop, durability of `omo-v2:enforcer:<id>` for restart — all server-side reads, no new tools.

### 4.2 Data flow

```
Model (reasoning)                         Plugin (m3-enforcer)                     ctx.storage (durable)
 ─────                                     ───────────────                          ───────────────
"Need to do X, Y, Z"                      ctx.tool.transform ── add(todo_write) ──▶ registration
  │  tool_call: todo_write({                ▲                                        ┌──────────────┐
  │    todos:[{content,                     │ execute(args,ctx)                       │omo-v2:todos: │
  │      status,priority,id}]})             │  1) normalizeTodosForStore(args.todos)  │  <id> → V2[] │
  │◀────────────────────────────────────────┘  2) todoStore.set(sessionID, normalized) └──────┬───────┘
  │                                           3) return summary text                          │
  │  tool_result: "stored N tasks (p/i/c/x)"  ────────────────────────────────────────────────┘
  │                                                                                           │
  └─ next turns edit same list via            session.idle handler reads same KV ─────────────┘
     subsequent todo_write calls               getIncompleteCount → maybe inject continuation
```

- **Write trigger**: any model call to `todo_write`. There is no polling, no scan, no file watcher. The first call creates the list; subsequent calls are **full replacements** (same semantics as V1 `session.todo` replace). Model is instructed (via description + agent guidance) to call at task-start (`pending`/`in_progress`), on status change, and at task-end (`completed`).
- **Read path** (unchanged): `handleIdle` does `todos = await todoStore.get(sessionID)` → `getIncompleteCount` → cooldown/skip checks → `ctx.session.prompt({sessionID, text: CONTINUATION_PROMPT + status line + remaining list, delivery:"queue"})`. This already exists in `trial/m3-enforcer/index.ts:handleIdle`.
- **Storage keys**: `omo-v2:todos:<sessionID>` only. No `omo-v2:enforcer:<id>` needed for MVP (that is full-parity durable enforcer state). Storage is the `opencode-data-v2` volume's `storage/` directory — durable across restart/recreate per TODO-SPEC Verification Addendum (Q4 confirmed mechanism).

### 4.3 Status vocabulary & normalization (Q7)

**Model-facing enum** (in `args.todos[].status`): `pending | in_progress | completed | cancelled`.

**Storage enum** (`V2TodoItem.status`): same four. **Never persist** `blocked` or `deleted`.

**Normalization** (`normalizeTodosForStore`, already in `trial/m3-enforcer/todo-store.ts`):

- `blocked` → `pending` (keep content, map status)
- `deleted` → **omit** the entry entirely (do not persist a tombstone)
- Any other illegal status → either omit that entry or reject the entire tool input (choose **omit that entry + log** for tool path; forbid silently blending illegal values into the list).

**Poison rule**: `asTodoList(value) → V2TodoItem[] | undefined` — returns `undefined` for *entire list* if *any* entry has an illegal status (verified in M3-VERIFY unit `poisoned -> undefined PASS`). The caller (`todoStore.get`) does `asTodoList(raw) ?? []`, so one unnormalized `blocked` blinds the enforcer. `todoStore.set` must call `normalizeTodosForStore` **before** `storage.set` — never write raw `args.todos`. `setRaw` (test helper) is not for production.

**Priority**: `low | medium | high | undefined` — pass through.

### 4.4 Idempotency keys & diffing

- **`todos[].id` is the idempotency key**. When provided, `getTodoSnapshot` keys by `id → status` (see `todo.ts:getTodoSnapshot`: `id ?? "${content}:${priority}" → status` join). Without `id`, the fallback key is `content:priority` (content string + priority) — less stable but deterministic.
- **Write is idempotent** by construction: `todo_write({todos:[...]})` **replaces** the entire list (`storage.set` overwrites). A retry with the same payload yields the same KV state. No partial-patch semantics.
- **Client-side duplicate suppression**: `M3-VERIFY` cooldown (`lastInjectedAt` per-session 5s flat, 10m TTL, 2m prune) prevents duplicate `todoStore.set` churn from becoming duplicate continuation prompts. The store itself does not deduplicate — the enforcer's idle handler does.
- **Model guidance**: advise stable `id` per task (e.g. slug of content, or `task-1`..N) so `getTodoSnapshot` stagnation logic (future parity) diffs correctly. Not enforced by write path; enforced by prompt/AGENTS.md.

### 4.5 Tool execute detail (implementable)

```ts
execute: async (args, context) => {
  const raw: V2TodoItem[] = args.todos;

  // --- idempotency / safety caps (never trust input length) ---
  const capped = raw.slice(0, 50); // schema max is 50; double-enforce

  // --- normalization (blocked→pending, deleted→omit) ---
  const normalized = normalizeTodosForStore(capped);
  // normalizeTodosForStore: for each item, if status==="blocked" swap to "pending",
  // if status==="deleted" (shouldn't pass enum, but defensive) drop it.

  // --- session scoping ---
  const sid = context.sessionID;
  if (!sid || typeof sid !== "string") throw new Error("missing sessionID");

  // --- storage write (the only durable side-effect) ---
  await todoStore.set(sid, normalized); // -> ctx.storage.set("omo-v2:todos:"+sid, [...])

  // --- observable feedback (file-log + tool result) ---
  log(`todo_write sid=${sid.slice(0,8)} n=${normalized.length} pending=${getIncompleteCount(normalized)}`);
  const preview = normalized.slice(0, 5).map(t => `[${t.status}] ${t.content.slice(0,80)}`).join("\n");
  return `stored ${normalized.length} tasks (${getIncompleteCount(normalized)} pending/in_progress)\n${preview}`;
}
```

- `todoStore` is the same instance the idle handler reads (constructed from `ctx.storage` at `setup` time).
- `log` goes to `console.log` + `/tmp/m3-enforcer.log` + `opencode/log/m3-enforcer.log` (same sink as existing enforcer — simplest observable signal, per TODO-SPEC §3 toast degradation).
- Return value is text — the model sees a concise summary.

### 4.6 What does NOT change about M3 MVP behavior

Detection + injection already specced (TODO-SPEC §3–§4) are untouched except **the store now gets written**:

- `session.idle` → `todoStore.get` → `getIncompleteCount` → cooldown → `ctx.session.prompt({delivery:"queue"})` still applies.
- `COUNTDOWN_SECONDS=0` immediate MVP (no toast), 5s `lastInjectedAt` cooldown, `skipAgents={prometheus,compaction,plan}`, routing-wins arbitration line — preserved.
- File-log diagnostics stay (no new UI).

The only new observable is: after a model `todo_write` call, the enforcer's next idle **will see todos** where burn 3 saw none.

---

## 5. Verification Plan — Split (no-key vs live-key, free-tier only)

### 5.1 No-key checks (0 inference, 0 quota, must all PASS before live-key)

These run with `bun build`, `docker exec` reads, in-process `bun run` harnesses — same discipline as M3-VERIFY §3.

| # | Check | Method | Pass criterion |
|---|-------|--------|---------------|
| N1 | **Probe tool accepted** | §3 Step 1–2: deploy `probe-tool.js` (`word` arg) via fresh filename to workspace-v2 file-plugin path (same symlink trick as B1/M3), `grep -a "Skipping invalid tool\|loading plugin.*probe" opencode.log` | `loading plugin probe-tool.js` present, **zero** `Skipping invalid tool registration … probe` lines |
| N2 | **`todo_write` accepted** | Same filename or fresh `todo-write.js` with literal definition in §3 B.2 | `loading plugin` present, zero `Skipping invalid tool … todo_write` |
| N3 | **Bundles import-clean** | `bun build ./index.ts --outdir ./dist --target bun --format esm --external @opencode/plugin` on host and `docker exec` (bun 1.4.2) | Build succeeds, no import-time side-effects (no `readFileSync` at top level), no `@ts-ignore` |
| N4 | **Setup loads warning-free** | `opencode.log` tail 10s after touch-deploy (`loading plugin m3-enforcer.js`, watcher subscribe/start) | No `failed to load plugin` for `m3-enforcer`, no new `Skipping invalid tool` attributed to it |
| N5 | **Store round-trip + normalization + poison** | In-process `bun run` harness of `todoStore` over `Map` mock (same as M3-VERIFY §3): `store.set([{content,status:"blocked"}])` → get reads `pending`; `store.setRaw` with `blocked` → `get` returns `[]` (poison); `getIncompleteCount` counts `pending+in_progress` | Unit harness PASS (same 9 lines as M3-VERIFY) |
| N6 | **TodoStore.set auto-normalizes** | Assert `todoStore.set` always calls `normalizeTodosForStore` before `storage.set` (code review: one call site) | No raw `storage.set` path without normalize |
| N7 | **No forbidden file touches** | `git status --porcelain` | Only pre-existing 10 dirty files + new/modified enforcer files (under `trial/m3-enforcer/`). No changes to `.opencode/`, `entrypoint.d/`, `src/`, `trial/CELL*.md`, `trial/TODO-SPEC.md`, `trial/B1-*.md`, `trial/DECISIONS.md` etc. |
| N8 | **B1 still loads** | `grep b1-routing opencode.log` after m3 touch reload | `loading plugin b1-routing.js` still succeeds, no tool noise attributed to either |

If **N1 or N2 FAIL** with `seen.ref` error → **abort Option B** (record fallback to A, do not proceed to §5.2). This is the *only* acceptable abort that preserves warning-free behavior (plugin returns dispose cleanly, enforcer stays in A mode).

### 5.2 Live-key checks (explicit re-authorization per run, free-tier only, tiny prompts)

All runs: model `opencode-go/longcat-2.5-preview-free` (proven free-tier in burn 3/B1 gate), prompt length ≤ 30 chars where possible, `opencode run` in disposable `workspace-v2` scratch. Stop after 3 failed attempts per probe; exact spend captured. **Do not** rotate/replace/print the `opencode-go` key (lives in auth store + container env).

| # | Check | Prompt / call | Expected |
|---|-------|---------------|----------|
| L1 | **`todo_write` is offered to the model** | Tiny prompt that explicitly asks the model to create a todo list: `Use todo_write to create 2 todos: pending "write a file" and pending "verify it". Reply done.` via `opencode run --model opencode-go/longcat-2.5-preview-free "..."` | Trace shows `tool call todo_write` (or `tool.execute.before/after` for `todo_write` in hook bridge / `session.text.delta` tool result), and enforcer file-log shows `todo_write sid=... n=2` |
| L2 | **KV written is readable by enforcer** | After L1 completes, `docker exec` read of `ctx.storage.get("omo-v2:todos:<sid>")` round-trip (or synthesize via `m3-enforcer.log` tool-result + state-store idle path) — if live storage dump isn't exposed via CLI, confirm via next idle injection: `todoStore.get(sid)` in a follow-up turn returns the 2-item list | `todoStore.get` returns 2 items, `getIncompleteCount===2` |
| L3 | **Status transitions** | Follow-up `todo_write` with one status moved to `in_progress`, another to `completed`; then idle handler | KV updates to `in_progress/completed`, `getIncompleteCount===1` |
| L4 | **Idle→continuation E2E (enforcer now fires)** | After L2/L3 with 1+ pending remaining, wait for `session.idle` (or re-prompt idle), observe enforcer `session.text.delta` + `execution.started` continuation prompt (`<!-- OMO_SYSTEM_DIRECTIVE:TODO_CONTINUATION -->` + remaining list) queued via `ctx.session.prompt({delivery:"queue"})` | File-log shows `idle sid=... todos=1 incomplete=1 → prompt queue` and session shows continuation turn |
| L5 | **Q7 normalization live** | `todo_write` with `status:"blocked"` entry (if schema allowed — if not, via raw `setRaw` shim in test harness only): confirm `asTodoList` poison would have blinded, but normalized path stores `pending`| Normal path: `todoStore.get` returns `pending`; raw poison path (harness): `get` returns `[]` |
| L6 | **Coexistence: routing fallback wins under shared failure** | Chain head `openrouter/auto` (dead: `Model unavailable`) → free leg `longcat-2.5-preview-free` plus todos pending; trigger retryable `no-route` error | Log shows `skip arbitration: routing wins` suppression of enforcer continuation within 5s window; routing `switchModel` to second leg (as in B1 gate) |

Cost envelope: ≤ 4 tiny prompts (L1–L4, then L6), each free-tier ≤ $0.0001. Total < $0.001. Stop after 1 successful fallback for L6 (mirroring B1 gate spend discipline).

### Recording

Append results to `trial/BURN-LOG.md` (Burn 4+), capturing session IDs (`ses_...` prefix, 8-char short), tool-call + enforcer log excerpts, and exact spend (`cost`, `tokens`, `cache` fields from SDK response) — same accounting as Burns 1–3.

---

## 6. Non-Goals (explicit)

- **Detection/injection redesign** — out of scope (already specced in TODO-SPEC §3–§5; this spec only populates the KV they read).
- **Countdown/toast/UI** — no 2s cancellable window, no `tui.showToast`, no `COUNTDOWN_GRACE_PERIOD_MS=500`. File-log diagnostics remain the observable signal (MVP).
- **Message-scan pipeline** — Option A is fallback-only; do not build scan + regex + caps + sanitization if Option B probe passes. Do not ship both.
- **Stagnation/retry-storm/backoff** — full-parity TODO-SPEC §5.2 rows 1–12 (exponential cooldown, `MAX_CONSECUTIVE_FAILURES`, `MAX_STAGNATION_COUNT`, `allTodosCompletedAt` persistence) are deferred.
- **Guard layer beyond skipAgents** — no abort/token-limit/unrecoverable, compaction-guard (`session.compacted` bridge), `hasUnansweredQuestion`, `write-permission`, `backgroundManager` parent-wake, `pendingUserMessageID` deferred classification. Each is full parity.
- **Agent/model/tools continuity** — continuation reuses target agent defaults; no `resolveLatestMessageInfo` / `findNearestMessageWithFields` / `variant` ladder in MVP.
- **Durable enforcer state** (`omo-v2:enforcer:<id>` on `ctx.storage`) — restart-surviving stagnation/cooldown is full parity.
- **Changes to** `trial/TODO-SPEC.md`, `trial/CELL2B.md`, `trial/B1-*.md`, `trial/M3-*.md`, `trial/DECISIONS.md`, `trial/ADMIN-NATIVE-DESIGN.md`, `.opencode/`, `entrypoint.d/`, `src/`, `docs/`, `docker-compose*`, `Dockerfile`, `.github/`, `trial/b1-routing/`, `trial/m3-enforcer/` existing file semantics beyond the additive `todo_write` tool, the 10 already-dirty files, git history, container lifecycle, or network installs.

---

## 7. Residual Risks (top 3 after this spec)

1. **`seen.ref` host-zod drift on upgrade** — The shim's success is host-zod-version-sensitive. A future OpenCode bump that upgrades vendored zod (or changes `toJSONSchema` arity) can re-break tool registration with the same `seen.ref` symptom, with no code change on our side. Mitigation: pin `@opencode-ai/plugin` and `@opencode/plugin` versions in the plugin bundle's externals contract, and keep the 3-step probe in CI / upgrade smoke (N1/N2).
2. **Noisy model / tool-call hygiene** — The model must actually call `todo_write`. Not all models call tools reliably on small tasks; some will describe tasks in prose and skip the tool. Enforcer will still no-op for those turns (correctly — no task contract was declared). Mitigation: reinforce via agent instruction / `AGENTS.md` ("use todo_write for multi-step work") and consider a soft nudge (system reminder) later — not in this MVP.
3. **KV as sole todo truth with no GC** — `omo-v2:todos:<id>` grows per session and is never pruned by this MVP (prune is TTL on in-memory state only, not storage). Over many sessions or runaway tool calls the scan cost (`storage.scan` limit 100 pagination) and storage size grow. Mitigation: add `storage.remove(prefix+id)` on `session.deleted` (already wired for state-store cleanup — extend to todos) and a `completed+cancelled` TTL in full parity — not in this MVP.

---

*Reader contract*: after implementing §4 against §2 inputs and passing §5.1 with a **PASS** on the `seen.ref` probe, the write path is verified usable without re-researching V2 tool registration; proceed to §5.2 live verification on free-tier only.*

