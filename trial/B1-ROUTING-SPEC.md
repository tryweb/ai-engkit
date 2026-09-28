# B1 — Self-Built Model-Routing + Reactive-Fallback Thin Plugin for OpenCode V2

> Branch: `trial/opencode-v2` | Date: 2026-09-29 | Target runtime: **OpenCode 2.0.15 + OpenChamber 2.0.0** via `Plugin.define({ id, setup(ctx) })`
> Status: **SPEC — upstream contract** for Admin chain-config rewrite. The §4 config-schema section is the downstream write-format contract.
> Scope: no OMO (`OMO_ENABLED=0`, `plugin: []`, no `~/.omo/omo.jsonc`). One new file `trial/B1-ROUTING-SPEC.md` only.
> References: `trial/CELL1.md` (12 agents, U1 gap), `trial/CELL2B.md` (§4 skips, §7 DEFECT 1, key chase), `trial/TODO-SPEC.md` (countdown/dedupe interaction), fork `Hallaxius/oh-my-openagent` `Hallaxius/feat/opencode-v2-runtime@aada48e` read-only at `/tmp/omo-v2-fork` inside `ai-engkit-v2` (reference, not dependency).

---

## 1. Requirements

### 1.1 The U1 gap (from `trial/CELL1.md` §4.1/§6 U1)

OMO `.opencode/omo.jsonc.default` declares for `plan` and `prometheus`:

```json
"models": [
  { "model": "opencode-go/kimi-k3", "variant": "max" },
  { "model": "openai/gpt-5.6-sol", "variant": "high" },
  { "model": "openai/gpt-5.6-luna" }
]
```

Semantics on OMO V1 (`@opencode-ai/plugin` `4.19.4`):

- `models[]` is an **ordered chain of `{model: "provider/id", variant?}` triples** (variant ∈ `{max, high, medium, low, xhigh, ...}` — provider-specific reasoning/effort label).
- Runtime resolution walks the chain at **session/task start** and on **failure** (rate-limit, quota, 5xx, auth): the next reachable entry is selected via `selectFallbackProvider` + `transformModelForProvider` + `connectedProvidersCache` + `providerModelsCache` gating.
- `fallback_models` (the `4.19.4` key) was proven harmful: injecting it into a single agent invalidates **every** persisted `agents.<name>.model` at resolution (Mechanism A, `docs/knowledge/patterns/omo-fallback-model-config.md`). Admin's `buildJqWriteCommand` correctly **deletes** both `models` and `fallback_models` on every apply — that deletion is defensive and **must not be undone** until a non-poisonous replacement exists. The V2 replacement must live outside `~/.omo/omo.jsonc` (new config path).

Native OpenCode V2 file-agents expose only:

```yaml
model: "provider/model-id"   # single pin, e.g. opencode-go/kimi-k3
# no models[], no fallbacks, no ordered chain
```

with optional provider passthrough keys (`reasoningEffort`, `textVerbosity`, `thinking.budgetTokens`, etc.) under agent `Additional` per `https://opencode.ai/docs/models`. Variant labels (`max`/`high`) are **not** a standard V2 key; V2's equivalent is `provider.models[model].variants[variant]` options (see §2.5). Cell 1 pinned `plan`/`prometheus` to the first chain entry and **dropped** variants, recording the gap for this spec.

### 1.2 What the thin plugin must provide

**Proactive routing (session/task start):**
- On `session.created` (and on first `session.prompt` / `session.idle` for pre-existing sessions), select the **primary** entry of the configured chain for the target agent and ensure `session.switchModel` / `session.switchAgent` reflects it **before** the first LLM turn. If the primary is unavailable (not in catalog, not connected), walk forward to the first reachable entry.

**Reactive fallback (on failure):**
- On `session.execution.failed` (V2's canonical error event) or `session.error` (V1-compat translation), classify the error as retryable-fallback-eligible (429/500/502/503/504 by default, plus AI-SDK `AI_APICallError` `isRetryable:true` like CF 524, **excluding** token-limit / `context_length_exceeded` / unrecoverable 400/422 — see fork's `token-limit-detection` / `unrecoverable-request-error`). If eligible and chain has remaining entries, atomically `switchModel` to the next entry and re-dispatch `session.prompt(..., delivery:"queue")`.

**Per-session cursor, cooldown/dedupe/loop-guard (§3), and todo-enforcer countdown coexistence (§3.6).**

### 1.3 Non-requirements

- No general cost/capability optimizer, no per-message LLM classifier, no budget ledger (full scope only, §6).
- No cross-session chain sharing, no persistence of fallback state across `opencode` restart (in-memory only for MVP).
- No mutation of `opencode.json` or `.opencode/agents/*.md` at runtime — the chain lives in its own config file (see §4).

---

## 2. V2 Surface Inventory — Actually Present on OpenCode 2.0.15

Every row below was verified against **two** sources where marked **BOTH**: the fork's `src/v2/` compat layer in-container **and** live V2 docs via `WebFetch https://opencode.ai/docs/*`. A row marked **FORK-ONLY** or **DOCS-ONLY** is **UNCONFIRMED** for the purpose of this spec and must not be assumed.

### 2.1 Plugin define / setup

| Surface | Verified | Evidence |
|---|---|---|
| `import type { Plugin } from "@opencode/plugin"` → `Plugin.define({ id, setup(ctx): dispose })` | **BOTH** | FORK: `src/v2/setup-v2.ts`, `src/v2/*.ts` import `Plugin.Context`; DOCS: `https://opencode.ai/docs/plugins` — "A plugin is a JS/TS module that exports one or more plugin functions. Each function receives a context object `{project, client, $, directory, worktree}` and returns a hooks object." `Plugin` type from `@opencode-ai/plugin` for V1 vs `@opencode/plugin` for V2 distinguished in fork's `compat-client.ts` header. |
| `ctx: Plugin.Context` fields `{ project, directory, worktree, client, $ }` (V1) vs `ctx: { session, tool, event, storage, ... }` (V2) | **BOTH** | FORK: `compat-client.ts` documents the split and bridges `directory` → `location.directory`; DOCS: plugins page lists `project/directory/worktree/client/$` as the V1 plugin function args. V2 split is **FORK-ONLY** for the exact field names — treat `ctx.session / ctx.tool / ctx.event / ctx.storage` as **FORK-ONLY UNCONFIRMED** until docs add a typed V2 plugin reference. |
| `setup()` return is a dispose function (async) wiring `eventBus.run(signal)` + hook registrations | **FORK-ONLY UNCONFIRMED** | FORK: `src/v2/setup-v2.ts` creates `createEventBus` + `registerHookBridge` and returns `disposeAll`. No docs page lists the return contract explicitly. |

### 2.2 Session hook kinds available

| Hook kind | Verified | Notes |
|---|---|---|
| `session.hook("prompt", fn)` | **BOTH** | FORK: `hook-bridge.ts:registerPromptHook` + `hook-bridge.test.ts` expects `"prompt"`; DOCS: not listed as a named hook on the plugins page, but `message.updated/part.updated` + `session.*` are events, and prompt is referenced indirectly via `session.prompt`. The prompt hook is **FORCED by fork tests** — treat as **BOTH (fork test + inferred from docs SDK)** but flag if docs never mention it. For this spec, `prompt` is available to intercept/append text before dispatch (fork mutates `input.prompt.text`). |
| `session.hook("context", fn)` (system/context injection, maps to V1 `experimental.chat.messages.transform` / `experimental.chat.system.transform`) | **BOTH** | FORK: `hook-bridge.ts:registerContextHooks` registers **two** `context` hooks (messages-transform + system-transform) with delta-append semantics (`input.system.push(...)` for appended turns, `appendUserDelta` for last-user delta); test expects two `"context"` registrations. DOCS: `experimental.session.compacting` is documented; `context` is the V2 name for that family. The `model` field inside `context` hook is **readonly** — `registerChatParamsBridge` explicitly logs `chat.params skipped (model readonly in V2 context hook; no faithful sink)` and does **not** register a hook. |
| `session.hook("compaction", fn)` (maps to V1 `experimental.session.compacting`) | **BOTH** | FORK: `hook-bridge.ts:registerCompactionHook` registers `"compaction"`; output sink is `input.result = { summary }` when `output.prompt` is set, else augmentation is **dropped** (no sink for bare `context` push). DOCS: plugins page documents `experimental.session.compacting` with `output.context.push(...)` and `output.prompt = "..."` semantics — matches. |
| `session.hook("generate")` / `session.hook("title")` | **DOCS-ONLY UNCONFIRMED** | DOCS: `https://opencode.ai/docs/agents` lists `compaction/title/summary` as hidden system agents (title/summary are primary agents invoked automatically). No fork file registers `"generate"` or `"title"` hooks; `compat-client.ts:session.summarize` calls `v2.session.generate({sessionID, prompt})` as an **SDK call**, not a hook. Do **not** claim a V2 hook kind `"generate"` or `"title"` without fork evidence — they are agents, not hooks. |
| Tool hooks `tool.hook("execute.before")` / `tool.hook("execute.after")` | **BOTH** | FORK: `hook-bridge.ts:registerToolHooks` registers both via `tool.hook`; tests assert both; DOCS: plugins page documents `"tool.execute.before/after"` as hook hooks. |
| `session.hook("model.request")` with mutable `model` field | **UNCONFIRMED — evidence suggests it does NOT exist** | FORK explicitly states the opposite: `chat.params` (the V1 surface that mutated model) is **skipped** because `model is readonly in V2 context hook; no faithful sink` (`hook-bridge.ts:registerChatParamsBridge`). No fork file registers a V2 `model.request` hook, and docs have no such hook name. Conclusion for this spec: **proactive model selection cannot be done by mutating `model` inside a `context` hook** — it must use `session.switchModel` reactively or at session start before the first turn. If a future doc adds `model.request`, re-evaluate, but today it is absent. |

### 2.3 Event-subscribe channel (`ctx.event.subscribe` / `event` hook)

| Event `type` | Verified | Shape | Notes |
|---|---|---|---|
| `session.created` | **BOTH** | `{sessionID, id, projectID, directory, title, time}` | FORK: `hook-bridge.ts:registerEventBridge` subscribes `session.created`; DOCS: plugins page lists `session.created` under Session Events. |
| `session.deleted` | **BOTH** | `{sessionID/id}` | Same as above; statusCache path: `registry.remove(id)` in compat layer. |
| `session.idle` | **BOTH** | `{sessionID}` | FORK bus maps `session.execution.*` → `idle/busy` via `statusFromType`; DOCS lists `session.idle`. Primary trigger for todo-enforcer and fallback. |
| `session.status` | **BOTH** | `{sessionID, status:{type:"idle"|"busy"|"retry", attempt?, message?, next?}}` | FORK: `registerEventBridge` subscribes `session.status` and re-emits V1 `session.status`; bus `statusCache` tracks last status per session. |
| `session.execution.failed` | **FORK-ONLY UNCONFIRMED** | `{sessionID, error}` → translated to V1 `session.error {sessionID, error}` | FORK: `hook-bridge.ts` subscribes `session.execution.failed` as the **sole** V1 `session.error` source; DOCS plugins page lists `session.error` under Session Events (V1 name) but does **not** list `session.execution.failed` explicitly — likely the V2 internal type. Treat `session.execution.failed` as **FORK-ONLY** and defensively subscribe to **both** `session.error` and `session.execution.failed` in the new plugin. |
| `session.compacted` | **BOTH** (but starved on V2) | — | DOCS lists `session.compacted`; FORK's `eventBus`/`hook-bridge` **do not** subscribe it — `TODO-SPEC.md:§4` flags this as a missing starvation. For routing, compaction guard must be synthesized (see §3). |
| `message.updated` / `message.part.updated` / `message.part.delta` | **BOTH (as events) but MISSING from fork bus** | — | DOCS lists `message.updated/part.updated/part.removed`; FORK's `bus` subscribes **only** `session.*` + `permission.asked` (6 types) — `message.*` is **not** fanned out. TODO-SPEC warns that `non-idle-events` starves on pure V2. For routing, do **not** depend on `message.*` for countdown cancel. |
| `permission.asked` | **BOTH** | `{sessionID, ...}` | Forwarded. |
| `tool.execute.before/after` (as events) | **UNCONFIRMED — routed via tool hooks, not event bus** | — | FORK comment: "session.tool.called/success/failed stay with the tool hooks; there is no V1 session.status-less equivalent." The plugin page lists `tool.execute.before/after` under Tool Events but the V2 bus does not emit them as `event` types. |
| `catalog.updated` | **UNCONFIRMED — not evidenced in either source** | — | Task requires inventory of `catalog.updated async behavior (catalog EMPTY at setup, populates later)`. No fork file under `src/v2/` contains `catalog.updated`; connected-provider/provider-models caches are **file-backed** (`json-file-cache-store`) and **lazy-populated** (empty at startup → fetched later). The live docs have no `catalog.updated` event either. The behavior described ("catalog EMPTY at setup, populates later") is **real but via file caches**, not a typed `catalog.updated` event. Treat `catalog.updated` **as UNCONFIRMED** — if an event by that name exists, it is not evidenced here; the spec's async-population warning must reference the file-cache source instead. |

### 2.4 `switchModel` / `switchAgent` mechanics

| Claim | Verified | Detail |
|---|---|---|
| `v2.session.switchModel({ sessionID, model: { id, providerID } })` | **FORK-ONLY UNCONFIRMED** | FORK: `compat-client.ts:session.promptAsync` does `await v2.session.switchModel({ sessionID: id, model: { id: model.modelID, providerID: model.providerID } }).catch(()=>{})` **before** `v2.session.prompt`. The V2 SDK field names are `{id, providerID}` (not `{modelID, providerID}`). Var-length `modelID` may contain slashes (e.g. `nvidia/org/model`). Signature has no `variant` — variant is a separate concern (see §2.5). Behavior is `catch(()=>{})` — failures are swallowed (likely transient during no-session). No docs page shows the exact TS signature; list as **FORK-ONLY**. |
| `v2.session.switchAgent({ sessionID, agent })` | **FORK-ONLY UNCONFIRMED** | Same file, same pattern, same caveat. |
| `v2.session.prompt({ sessionID, text, delivery:"queue"|"steer", files? })` | **BOTH** | FORK: `compat-client.ts` calls `v2.session.prompt({sessionID, text, ...files, delivery:"queue"})`; DOCS: plugins page `Inject environment variables` + `custom tools` show `Plugin` shape; `TODO-SPEC.md:§3.3` documents V2 `delivery:"queue"` as the queued path and notes `prompt-async-gate` is absent on V2. `session.get({sessionID}).outcome` guard in `v2/prompt-gate.ts` checks whether session already has a terminal outcome before prompt. |
| `v2.session.get({ sessionID }) → { outcome?, title, time }` | **FORK-ONLY UNCONFIRMED** | FORK: `prompt-gate.ts:session.get` checks `info.outcome`; DOCS have no `session.get` vs `client.app.log` distinction — server/docs describe `client.app.log` for logging, not session retrieval. |
| `agent.transform` timing (when agent switch takes effect) | **UNCONFIRMED** | Neither docs nor fork state when `switchAgent`/`switchModel` materializes (immediately vs next turn). Fork does `switchAgent`/`switchModel` **before** `prompt`, implying next-turn effect. Spec assumes **next `session.prompt` turn** after the switch sees the new model/agent; for mid-turn fallback this means re-dispatch is required (see §3). |

### 2.5 Variant passthrough semantics

| Claim | Verified | Detail |
|---|---|---|
| Variant is a **per-provider reasoning/effort label** (`high/max/medium/low/xhigh/none/minimal`) defined under `provider.models[model].variants[variant]` with `options: {reasoningEffort, textVerbosity, reasoningSummary, thinking:{type,budgetTokens}, temperature, ...}` | **BOTH** | DOCS: `https://opencode.ai/docs/models#variants` lists built-in variants (Anthropic `high/max`, OpenAI `none/minimal/low/medium/high/xhigh`, Google `low/high`) and shows custom variants `reasoningEffort`/`textVerbosity`/`reasoningSummary`/`include`. Agent `Additional` passthrough lets any key (e.g. `reasoningEffort`) ride on the agent alongside `model`. FORK: `FallbackEntry` type has `{providerID, modelID, variant?, reasoning?, reasoningEffort?, temperature?, top_p?, maxTokens?, thinking?}` — variant plus expanded passthrough; OMO's `opencode-go/kimi-k3` uses `variant:max` mapped via `provider.models.kimi-k3.variants.max.options`. |
| Variant must travel **alongside** `modelID`, not embedded in it (`provider/model(variant)` is a V1 string parse artifact) | **BOTH** | DOCS: model id is `provider_id/model_id` (`opencode/gpt-5.1-codex`); variant is a separate `agent` or `provider.models[].variants` key, not part of the slash id. FORK: `parseVariantFromModelID` + `parseModelString` handle `model(variant)` and `model-high` suffixes as **back-compat parsing** (`model-string-parser.ts`) — on V2 the spec should always keep them separate. |
| `model` field is `providerID/modelID` without variant | **BOTH** | As above. |

### 2.6 `catalog.updated` async population (UNCONFIRMED event, CONFIRMED behavior via file caches)

The task asserts "catalog EMPTY at setup, populates later" and a `catalog.updated` event. Verdict:

- **No `catalog.updated` event was found** in fork `src/v2/*.ts` nor on the `https://opencode.ai/docs/plugins` events list (which lists only the 20 event types in §2.3). Mark `catalog.updated` **UNCONFIRMED**.
- **Async population is still real**, but via fork's `shared/connected-providers-cache.ts` + `provider-models-cache` file stores (`connected-providers.json` / `provider-models.json` under `~/.cache/oh-my-opencode/` or the plugin's cache dir). At `setup()` the caches are **empty/null** (`readConnectedProvidersCache() → null`, `readProviderModelsCache() → null` guarded by `has()` checks). `next-fallback.ts:createReachabilityChecker` handles this by returning `() => true` (allow any provider) when `connectedSet === null` — i.e., when catalog is unpopulated, **no filtering** is done yet. This is the "empty at setup" behavior the spec must warn about.
- **Routing implication**: MVP must **not** gate chain-walk on catalog availability; if catalog is empty, walk the chain in declared order and let `switchModel` fail fast, falling through to next entry. Full scope may add a `retry with catalog-ready` gate.

### 2.7 Summary: what the routing plugin can actually rely on (2.0.15)

- **Reliable (BOTH):** `session.hook("prompt"|"context"|"compaction")`, `tool.hook("execute.before/after")`, `event` fan-out for `session.created/deleted/idle/status/error` (error via `session.execution.failed` translation), `ctx.storage` KV, `ctx.session.prompt/get/switchModel/switchAgent` as **SDK calls** (not hooks).
- **Fork-only (use defensively):** `v2.session.switchModel({id,providerID})` exact field names, `session.get().outcome` guard, `eventBus` status derivation (`idle/busy/retry`).
- **Absent / readonly:** `session.hook("model.request")` with mutable `model` — does not exist; `model` is readonly in `context` hook (`chat.params` bridge skipped). Proactive routing must use `switchModel` + re-prompt, never hook mutation.

---

## 3. Design

### 3.1 Where the routing decision lives

```
┌──────────────────────────────────────────────────────────────────────┐
│  Admin (writes chain config) ──▶ routing.json (see §4)              │
│                     ▲                                                │
│                     │  reads at setup + watches file watcher          │
│                     ▼                                                │
│  Thin plugin setup(ctx):                                             │
│   ┌─────────────┐  ┌──────────────────┐  ┌─────────────────────────┐ │
│   │ event bus   │  │ session.hooks    │  │ tool hooks (optional)   │ │
│   │ session.*   │  │ prompt/context/  │  │ (for countdown cancel   │ │
│   │ idle/status │  │ compaction       │  │  if bus starved)        │ │
│   │ error/failed│  └──────────────────┘  └─────────────────────────┘ │
│   └──────┬──────┘                                                    │
│          │  resolve agent → load chain → per-session cursor (Map)     │
│          ▼                                                           │
│   ┌─────────────────────────┐    ctx.session.switchModel(...)       │
│   │ Router core (in-mem)    │──▶ ctx.session.switchAgent(...)        │
│   │ per-session state       │    ctx.session.prompt({delivery:"queue"})│
│   │ (Map<sessionID,State>)  │    + toast/log (degraded on V2)        │
│   └─────────────────────────┘                                         │
│          │  uses ctx.storage KV only for chain config cache (optional)│
│          │  uses V1CompatStores pattern for nothing else             │
└──────────────────────────────────────────────────────────────────────┘
```

- **Decision point:** `setup()` loads `routing.json` (§4) once, then on each **routing trigger** (`session.created` first-prompt, `session.prompt` hook before LLM, `session.execution.failed` / `session.error`) resolves the session's agent (`resolveLatestMessageInfo` reverse-scan of `session.context`, fallback `session.get` agent, then sessionID regex) and looks up that agent's chain. The chain is **per-agent, per-session** — each session gets its own cursor (index) into the chain.
- **No tool registration.** The routing plugin **MUST NOT register tools** (`tool: { ... }` in the returned hooks object) unless it can prove the tool definitions pass server validation (`seen.ref` contract). `trial/CELL2B.md:§7 DEFECT 1` proved that 14 fork-bridged tools all failed `Invalid tool definition ... undefined is not an object (evaluating 'seen.ref')` server-side, leaving **0** usable tools. Routing has no need for tools anyway (all work is via `event` + `session.hook` + SDK calls). If a future iteration needs a tool (e.g., `routing_status`), it must ship a minimal tool with explicit `seen.ref`-shaped validation or skip it.
- **Storage:** `ctx.storage` is the only durable KV, but routing state itself stays **in-memory** (Map) for MVP. Chain config persistence is filesystem (`routing.json`), not storage. Storage may be used later for restart-recovery (§6).

### 3.2 Fallback state machine

```
                    ┌───────────┐
           setup    │  IDLE     │◀────────────────────────┐
           load ──▶ │ (no cursor)│   success / manual     │
                    └─────┬─────┘   reset                │
                          │ session.created /             │
                          │ first prompt / switchModel+   │
                          │ prompt success               │
                          ▼                               │
                    ┌───────────┐  error eligible          │
                    │ PRIMARY   │──────────────────┐     │
                    │ idx=0     │                  │     │
                    │ (active)  │  error eligible   ▼     │
                    └─────┬─────┘            ┌──────────┐ │
                          │                  │ FALLBACK │ │
                          │ error            │ idx=N+1  │ │
                          │ ineligible       │ (active) │ │
                          │ (token-limit /   └────┬─────┘ │
                          │  unrecoverable)        │       │
                          ▼                        │ error │
                    ┌───────────┐                  │ eligible
                    │ EXHAUSTED │◀─────────────────┘       │
                    │ (terminal)│   error still eligible    │
                    │ no more   │   but chain end          │
                    │ entries   │──────────────────────────┘
                    └─────┬─────┘
                          │ cooldown expiry
                          │ (full scope)
                          ▼
                    ┌───────────┐
                    │ COOLDOWN  │
                    │ (retry    │
                    │  after Δ) │
                    └───────────┘
```

**States:**

| State | Meaning | `State` fields |
|---|---|---|
| `IDLE` | No session seen yet; chain loaded but no cursor allocated. | `chain?: ChainEntry[]` (shared config), `cursor?: number` not set |
| `PRIMARY` | Cursor at `0`, primary model active. Normal path. | `cursor=0`, `attemptCount=0`, `pending=false`, `failedModels=Map<string,number>`, `lastFailureAt?`, `fallbackStartAt` |
| `FALLBACK` | Cursor at `N>0`, fallback model active after successful switch. Still eligible for further fallback on next failure. | `cursor=N`, `attemptCount=N`, `pending=false`, `failedModels` updated |
| `EXHAUSTED` | Chain walked to end; `attemptCount >= chain.length` or no reachable candidate. Terminal until reset/cooldown. | `cursor=chain.length`, `attemptCount`, `exhaustedAt=now`, `lastError` |
| `COOLDOWN` | (Full scope) Per-model cooldown window active; next fallback skips the failed model for `cooldown_seconds`. | `failedModels: Map<modelKey, failedAt>` with `now - failedAt < cooldownMs` gating |

**Transitions:**

| From | Event | Guard | To | Action |
|---|---|---|---|---|
| `IDLE` | `session.created` / first `prompt` | agent has chain in config | `PRIMARY` | Allocate `cursor=0`, `attemptCount=0`, call `switchModel(primary)` if not already active |
| `PRIMARY`/`FALLBACK` | `session.execution.failed` / `session.error` | `isRetryableModelError(error) && !isTokenLimitError(error) && !isUnrecoverableRequestError(error)` and `attemptCount < chain.length` and not deduped | `FALLBACK` | `cursor++`, `failedModels.set(prevModel, now)`, `switchModel(next)`, `prompt({delivery:"queue"})`, toast/log, bump `consecutiveFailures`-like counter, hold dedupe window |
| `PRIMARY`/`FALLBACK` | `session.execution.failed` | token-limit / unrecoverable / non-retryable | *(no transition)* | Log, stay; surface error to user (no automatic retry — retry would worsen overflow) |
| `*_` | `session.execution.failed` | same `provider/model` as last failure within dedupe window | *(no transition)* | `isSameFailedModel` dedup — ignore duplicate arm (fork's `fallback-state-controller:isSameFailedModel` uses lowercased `providerID` + dotted-vs-dash canonicalized `modelID`) |
| `FALLBACK` | `session.execution.failed` | `attemptCount >= chain.length` or `getNextReachableFallback` returns null | `EXHAUSTED` | Log `Max fallback attempts reached` / `No more fallbacks`, delete pending entry, stop retrying |
| `EXHAUSTED` | `session.execution.failed` | still fails | `EXHAUSTED` | Ignore (no retry loop) — require manual reset or cooldown expiry |
| `FALLBACK`/`EXHAUSTED` | `session.prompt` success / streamed `session.status busy → idle` with no error | — | `PRIMARY` (reset) | Clear cursor state for that session (successful turn proves chain head works again). Only on **user-visible success**, not on speculative success. |
| `*_` | `session.deleted` / TTL prune (10m) / `dispose()` | — | `IDLE` (removed) | `Map.delete(sessionID)`, clear timers, release holds |

### 3.3 Per-session chain cursor

- **Keyed by `sessionID` (string `ses_*`).** Value: `{ providerID, modelID, variant?, fallbackChain: ChainEntry[], attemptCount, pending, failedModels }` mirroring fork's `ModelFallbackState` but **without** `FallbackEntry.providers[]` multiplicity for MVP — MVP entries are single-provider (`provider/model`) not multi-provider alternatives. See §4 for the trimmed shape.
- **Source of chain:** `getSessionFallbackChain(sessionID)` override if present (per-session chain set at bootstrap), else `routing.json[agent].chain`, else nothing (no routing for that agent). Fork's controller prefers `sessionFallbackChains` map over `AGENT_MODEL_REQUIREMENTS[agent].fallbackChain`; same precedence here.
- **Mutation:** cursor increments only on **successful dispatch** of the next fallback (after `switchModel` resolves). The `pending` flag gates duplicate arms while a fallback dispatch is in flight (fork's `pending:true → false` on `getNextReachableFallback` success). Re-arming a pending entry without progress is rejected (`Pending fallback already armed`).
- **No persistence across restart** for MVP (Map only). Full scope may serialize to `ctx.storage` key `routing:cursor:<sessionID>` (see §6).

### 3.4 Cooldown / dedupe / loop-guard

| Guard | Constant (MVP) | Constant (full) | Behavior |
|---|---|---|---|
| **Dedupe** | 5 s hold (semantic dedupe) | 5 s `semanticDedupeHoldMs` + `DEFAULT_PROMPT_ASYNC_POST_DISPATCH_HOLD_MS` | Fork's `dispatchInternalPrompt` dedupes identical `CONTINUATION_PROMPT` within 5 s. Routing reuses the same idea: after `switchModel`+`prompt`, set `holds.set(sessionID, now+holdMs)` (`v2/prompt-gate.ts:holdMs=2000` minimal, spec recommends 5000 to match todo-enforcer). Second failure within hold → `skipped: duplicate dispatch inside post-dispatch hold`. |
| **Same-model dedup** | — | — | Fork's `isSameFailedModel` canonicalizes `modelID` dotted↔dash and lowercases. If fallback arms again for the same `provider/model` that just failed and `attemptCount>0`, ignore. |
| **No-op skip** | — | — | Fork's `isNoOpFallback` (`provider+canonical modelID` identical to failed model) → skip entry, try next. Prevents `switchModel` to self. |
| **Reachability skip** | — | — | Fork's `createReachabilityChecker`: if catalog is populated, skip entries whose provider not in `connectedSet`. If catalog empty (`connectedSet===null`), allow all. MVP must replicate this: do not hard-fail when catalog empty. |
| **Cooldown per model** | `cooldown_seconds=60` default (runtime-fallback) | Same | After `prepareFallback`, `failedModels.set(failedModel, now)`; `isModelInCooldown(model, state, cooldownSeconds)` returns true if `now - failedAt < cooldownMs` → `findNextAvailableFallback` skips that candidate. `clear` resets on success. |
| **Max attempts** | `max_fallback_attempts=3` default | Same | `if (attemptCount >= max_fallback_attempts) return {success:false, error:"Max fallback attempts reached"}`. Fork's model-fallback uses `chain.length` as cap; runtime-fallback uses fixed `max_fallback_attempts`. Spec caps at **min(chain.length, max_fallback_attempts)**. |
| **Loop guard** | — | — | Never re-enter fallback synchronously: fallback dispatch is via `delivery:"queue"` (queued, not steer). The next failure arrives as a new `session.execution.failed` event, not a recursive call. |

### 3.5 Interaction with `session.hook` / catalog timing

- **At `setup()`:** catalog is empty. Do **not** block routing on catalog — walk chain in declared order. Optionally schedule a one-shot `setTimeout 2s` re-check of `providerModelsCache` / `connectedProvidersCache` and log which entries would have been skipped.
- **`switchModel` semantics:** must be called **before** the next `session.prompt`. The `context` hook cannot mutate `model` readonly, so the only valid proactive path is `switchModel` → `prompt`. Reactive path is identical: `switchModel(next)` then `prompt({delivery:"queue"})` to replay the failed turn. Do **not** call `prompt` with `model` inline (V2 has no such field on `prompt`).
- **`agent.transform` timing:** assumed to apply on **next turn**; document as UNCONFIRMED. The plugin must not expect the current turn to see the new model.

### 3.6 Interaction with todo-enforcer countdowns (§3, `trial/TODO-SPEC.md`)

Both the routing plugin and the todo-enforcer react to `session.idle` and `session.execution.failed`.

| Conflict | Who wins | Rule |
|---|---|---|
| Routing fallback and todo-enforcer countdown both trigger on `session.idle` after a failure | **Routing wins for the first `holdMs` window; enforcer defers** | Routing's dedupe hold (5 s) covers the `TODO_CONTINUATION` 2 s countdown. Enforcer's `handleSessionIdle` already checks `backgroundManager` running/pending and `isRecovering`/`wasCancelled` — routing must set a shared flag or rely on the enforcer's existing `consecutiveFailures` cooldown (`effectiveCooldown = 5000 * 2^min(f,5)` up to 160s). The simplest coexistence: routing fallback **does not** interfere with enforcer's own `consecutiveFailures`; enforcer's `Max consecutive failures reached` gate already stops its own retries independently. |
| Routing's `session.prompt({delivery:"queue"})` replay vs enforcer's `dispatchInternalPrompt({semanticDedupeHoldMs:5000})` | **Routing's replay is a user-visible retry, enforcer's is a directive** | They target different prompt semantics (`delivery:"queue"` retry vs `<!-- OMO_SYSTEM_DIRECTIVE:TODO_CONTINUATION -->` directive). The enforcer's `isSyntheticOrInternalUserMessage` filter already ignores synthetic continuation parts; routing's replay is **not synthetic** — it is the original user prompt replayed with a new model. No filter conflict. |
| Both want to `switchModel` | **Only routing switches models** | Enforcer's `continuation-injection` preserves `model/variant` (`model: launchModel` captured from `resolveLatestMessageInfo`) but never switches. Routing owns the model. |
| Countdown cancel on `message.updated` / `tool.execute.before` | **Enforcer's cancel starves on V2** (no bus for `message.*`) | So countdown may not cancel even when routing has already re-dispatched. Mitigation: keep routing's dedupe independent of enforcer's countdown; accept that a late enforcer `injectContinuation` may race routing's replay. The enforcer's `awaitingPostInjectionProgressCheck` + `continuationResponseObserved` machinery will detect no-progress and stop after `MAX_STAGNATION_COUNT=3`. |
| `allTodosCompletedAt` / `tokenLimitDetected` / `abortDetectedAt` gates | **Routing ignores them** | Those are enforcer-specific gates (todo state). Routing classifiers are strictly error-shape (`isRetryableModelError`, `isTokenLimitError`, `isUnrecoverableRequestError`). Routing must not read todo state. |

**Implementation rule:** routing and enforcer share only `ctx.event.subscribe` (they each get their own subscription). Routing must not call `cancelCountdown` or mutate enforcer's `SessionStateStore`. Keep them in separate Maps.

---

## 4. ★ DOWNSTREAM CONTRACT — Chain Config Schema (exact)

> **Flag:** this section is the **exact downstream contract** for the Admin rewrite that will write the chain config this spec defines. An Admin implementer must be able to define the config write format from this section alone. Any deviation is a breaking change.

### 4.1 File location & format

- **Path:** `<project>/.opencode/routing.json` (per-project) **or** `~/.config/opencode/routing.json` (global). Per-project overrides global (last-wins merge, same precedence as `opencode.json` per `https://opencode.ai/docs/config#precedence-order`).
- **Encoding:** UTF-8, JSONC-compatible (comments allowed, but Admin writes strict JSON). `$schema` key optional (no registry yet).
- **No `~/.omo/omo.jsonc` involvement.** The routing file is independent to avoid the Z1 single-key-poisons-all failure (`docs/knowledge/patterns/omo-fallback-model-config.md`): a bad entry in `routing.json` must **not** invalidate every agent's chain, only the agent that owns the bad chain.
- **Admin write command** (to be implemented by the Admin rewrite, not this spec): writes `routing.json` transactionally (`write tmp → mv`) and never touches `~/.omo/omo.jsonc`. Validation errors are reported per-agent, not whole-file.

### 4.2 Top-level schema

```json
{
  "version": 1,
  "defaults": {
    "cooldownSeconds": 60,
    "maxFallbackAttempts": 3,
    "notifyOnFallback": false
  },
  "chains": {
    "<agentName>": {
      "chain": [ ChainEntry, ... ],
      "cooldownSeconds": 60,
      "maxFallbackAttempts": 3
    }
  }
}
```

**Field table — top-level:**

| Field | Type | Required | Default | Validation |
|---|---|---|---|---|
| `version` | `number` (`1`) | **yes** | — | Must be `1`. Future versions bump this; unknown versions must be rejected with a clear error, not silently ignored. |
| `defaults` | `object` | no | `{}` | If absent, each per-chain field falls back to hard defaults below. Unknown keys inside `defaults` are **ignored** (forward-compat), not rejected. |
| `defaults.cooldownSeconds` | `number` (integer) | no | `60` | `1 ≤ n ≤ 3600`. Per-model cooldown before a failed model can be retried again. |
| `defaults.maxFallbackAttempts` | `number` (integer) | no | `3` | `1 ≤ n ≤ 10`. Caps total fallback steps per failure sequence (also capped by `chain.length`). |
| `defaults.notifyOnFallback` | `boolean` | no | `false` | If `true`, routing shows a toast (`TUI toast` when available, else `client.app.log` degraded). |
| `chains` | `Record<string, AgentChain>` | **yes** | — | Keys are agent names; values are `AgentChain`. At least one entry may be present (empty `chains:{}` is valid but routing is a no-op). Unknown top-level keys besides `version/defaults/chains/$schema` are **ignored**. |

### 4.3 `AgentChain` schema

| Field | Type | Required | Default | Validation |
|---|---|---|---|---|
| `chain` | `ChainEntry[]` | **yes** | — | `1 ≤ length ≤ 10`. Ordered, head is primary. Empty chain is a validation error for that agent (agent is then treated as no-chain). Entries beyond 10 are rejected (truncate is not allowed — fail loudly). |
| `cooldownSeconds` | `number` | no | `defaults.cooldownSeconds` or `60` | Same range as defaults. Per-agent override. |
| `maxFallbackAttempts` | `number` | no | `defaults.maxFallbackAttempts` or `3` | Same range. Per-agent override. |
| `notifyOnFallback` | `boolean` | no | `defaults.notifyOnFallback` or `false` | Per-agent override. |

Agent-name keys:

- **Allowed:** the 12 native agents from `trial/CELL1.md:§2` plus V2 built-ins `build/plan/general/explore/scout/compaction/title/summary` (case-sensitive lowercased). Valid set: `plan, prometheus, explore, oracle, librarian, multimodal-looker, metis, momus, sisyphus, hephaestus, atlas, sisyphus-junior, build, general, scout, compaction, title, summary`. Unknown agent keys are **accepted but warned** (log warning, not error) — forward-compat for future agents. Hyphenated names must be preserved verbatim (`multimodal-looker`, `sisyphus-junior`) — `lib-native-agent-overrides.bash` bracket-notation caveat applies if Admin ever `jq`-patches this file.
- **Normalization:** agent keys are lowercased + trimmed before lookup (matches fork's `getAgentConfigKey`). Session agent resolution already does `normalizeAgentName` / `resolveLatestMessageInfo` lowercasing.

### 4.4 `ChainEntry` schema (the triple)

```ts
type ChainEntry = {
  model: string              // required, "provider/model-id" e.g. "opencode-go/kimi-k3"
  variant?: string           // optional, e.g. "max", "high", "low", "off"
  // expanded passthrough (all optional, full scope — MVP may persist but ignore beyond variant)
  reasoningEffort?: string   // "low"|"medium"|"high"|"xhigh"|"max" etc.
  textVerbosity?: string
  reasoningSummary?: string
  temperature?: number       // 0.0–2.0
  top_p?: number             // 0.0–1.0
  maxTokens?: number         // 1–200000
  thinking?: { type: "enabled"|"disabled"; budgetTokens?: number }
}
```

**Field table — ChainEntry:**

| Field | Type | Required | Validation |
|---|---|---|---|
| `model` | `string` `"provider/model-id"` | **yes** | Must match `^[^/\s]+\/\S+$` (provider segment slash-free, model segment non-empty, no whitespace). Provider prefix may itself be hyphenated (`opencode-go`). Model segment **may** contain slashes (e.g. `nvidia/org/model` — the pattern allows it via `\S+` after first slash). Empty string, missing slash, or whitespace → validation error for that agent's chain. The referenced `provider/model` must exist on connected providers or availability-gated fallback will treat it as unreachable (log + skip). |
| `variant` | `string` | no | If present, must be one of `VARIANTS` known to the runtime (`max/high/medium/low/xhigh/none/minimal/off` etc. — Admin should populate a dropdown from `provider.models[model].variants` when editing). Unknown variant strings are **accepted but warned** (they become passthrough `reasoningEffort` mapping; runtime may ignore). `null`/empty string → omit. |
| `reasoningEffort` | `string` | no | Provider-specific (`high/max` etc.). Reserved for full scope. |
| `textVerbosity` | `string` | no | Reserved. |
| `reasoningSummary` | `string` | no | Reserved. |
| `temperature` | `number` | no | `0.0 ≤ n ≤ 2.0`. |
| `top_p` | `number` | no | `0.0 ≤ n ≤ 1.0`. |
| `maxTokens` | `number` (int) | no | `1 ≤ n ≤ 200000`. |
| `thinking` | `object` | no | `{type: "enabled"|"disabled", budgetTokens?: number}`. |

**Z1 non-repeat guarantee:** `ChainEntry` does **not** support `providers: string[]` multiplicity (fork's `FallbackEntry.providers: string[]` per entry). Each entry is a **single** `provider/model` pin, not a provider-choice. This keeps the schema trivial and avoids the `fallback_models` hazard where a bad multi-provider entry poisons other agents. Multi-provider fallbacks are deferred to full scope (§6) and must then be a new `providers` array field behind a major `version` bump, never a silent reinterpretation of `model`'s provider segment. A `ChainEntry` with unparseable `model` invalidates **only that agent's** `chain`; other agents remain operable.

### 4.5 Validation rules (Admin must enforce before write)

1. `version` must be `1`; unknown versions → reject whole file (`error: unsupported version`).
2. `chains` must be an object; non-object → reject whole file.
3. Per-agent: `chain` must be an array `1..10` long; violation → reject **that agent's** chain only (set `chain: []` + record per-agent error), continue validating others.
4. Per-entry: `model` must match `^[^/\s]+\/\S+$`; violation → reject that entry (drop it) and record per-agent error. If dropping makes `chain` empty, reject the agent's chain.
5. `variant` unknown value → accept but warn.
6. Numeric ranges (`cooldownSeconds`, `temperature`, etc.) out of range → reject that field, use default, warn.
7. Duplicate `provider/model` within a chain → **allowed** but warned (detected at runtime as no-op skip via `areRuntimeModelsEquivalent`).
8. Unknown agent keys → accept, warn.
9. Unknown top-level/defaults keys → ignore.
10. File-level JSON parse error (invalid JSONC) → reject whole file, routing disabled, log error, do **not** fall back to stale cache.

### 4.6 Example JSON (3-chain, mixed variants, realistic)

> This example is normative — an implementer can validate a parser against it.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "version": 1,
  "defaults": {
    "cooldownSeconds": 60,
    "maxFallbackAttempts": 3,
    "notifyOnFallback": false
  },
  "chains": {
    "plan": {
      "chain": [
        { "model": "opencode-go/kimi-k3", "variant": "max" },
        { "model": "openai/gpt-5.6-sol", "variant": "high" },
        { "model": "openai/gpt-5.6-luna" }
      ]
    },
    "prometheus": {
      "chain": [
        { "model": "opencode-go/kimi-k3", "variant": "max" },
        { "model": "openai/gpt-5.6-sol", "variant": "high" },
        { "model": "openai/gpt-5.6-luna" }
      ],
      "maxFallbackAttempts": 5
    },
    "sisyphus": {
      "chain": [
        { "model": "anthropic/claude-opus-5-5", "variant": "max" },
        { "model": "opencode-go/kimi-k3" },
        { "model": "opencode/big-pickle" }
      ],
      "cooldownSeconds": 30,
      "notifyOnFallback": true
    }
  }
}
```

Notes on the example:

- `plan`/`prometheus` reproduce the exact OMO default triples from `.opencode/omo.jsonc.default` — this is the parity restoration for U1.
- `sisyphus` shows an executor chain with a final `big-pickle` catch-all (matches fork's `AGENT_MODEL_REQUIREMENTS.sisyphus` fallback tail).
- `prometheus` overrides `maxFallbackAttempts` to `5` to consume more of the chain on quota bursts; `sisyphus` overrides `cooldownSeconds`.
- `variant` absent on last entries means "use provider default" (no `delete variant` in payload — matches `chat-message-fallback-handler: delete output.message.variant` when `fallback.variant===undefined`).

### 4.7 Downstream Admin rewrite obligations (checklist)

- [ ] Write path is `routing.json` (new file), **never** `~/.omo/omo.jsonc`. Do not read or write `omo.jsonc` for routing.
- [ ] Use the exact field names above (`version/defaults/chains/chain/model/variant/cooldownSeconds/maxFallbackAttempts/notifyOnFallback`). Do not emit legacy `models[]` or `fallback_models` keys into this file — those are OMO V1 keys and are DEFECTIVE on 4.19.4.
- [ ] On Admin Apply, `buildJqWriteCommand`-style deletion of `models`/`fallback_models` from `omo.jsonc` **stays** (it is defensive). Routing writes do not re-introduce those keys.
- [ ] Before `write tmp → mv`, run the validation rules in §4.5 and surface **per-agent** errors in the UI (do not fail the whole write if one agent's chain is bad).
- [ ] On read, the plugin watches `routing.json` via the file watcher (or `ctx.storage` cache) and hot-reloads without restart.
- [ ] The plugin MUST stage no assets beside the bundle that could poison `T1` (assets must exist before first discovery; see `trial/CELL2B.md:§3 T1/T2`). `routing.json` is outside the plugin bundle path, so it is safe.

---

## 5. OMO Parity Mapping

| OMO V1 concept | Where it lived | What it did | V2-native equivalent (this spec) | Status |
|---|---|---|---|---|
| `models[]` chain on `agents.<name>` (ordered `model+variant` triples) | `.opencode/omo.jsonc.default` + `~/.omo/omo.jsonc` | Primary + fallbacks walked at resolution time via `AGENT_MODEL_REQUIREMENTS[agent].fallbackChain` + `resolveModel`/`getNextReachableFallback` | `routing.json: chains[agent].chain[]` with same triple shape (§4.4). Per-session cursor replaces OMO's per-resolution walker. | **Parity — MVP** |
| `variant` (`max/high/medium/low/xhigh/off`) | `models[].variant` | Mapped to `provider.models[model].variants[variant].options` (`reasoningEffort`/`thinking.budgetTokens`) via `provider-model-id-transform` and `model-requirements` | Same `variant` field; plugin passes `variant` alongside `switchModel` (variant travels via agent/model passthrough; exact V2 SDK passthrough is `switchModel` + agent Additional options). | **Parity — MVP (variant passthrough)** |
| `fallback_models` (single-agent, schema-legal) | `~/.omo/omo.jsonc: agents.<name>.fallback_models` | Read by `getRawFallbackModelsForSession`; **poisons** every agent's persisted model (Z1) | **Explicit non-goal.** Deleted on every Admin apply (`del(models,fallback_models)`), never emitted into `routing.json`. The spec's `chain[]` replaces it without the poison semantics. | **Non-goal (harmful V1 surface)** |
| Category chains (`CATEGORY_MODEL_REQUIREMENTS`: `visual-engineering/ultrabrain/deep-low/quick` etc.) | `packages/model-core/src/category-model-requirements.ts` | Routed a **task category** (not agent) to a fallback chain via `CATEGORY_MODEL_REQUIREMENTS[category].fallbackChain` and `runtime-fallback` dispatcher | **Non-goal for MVP.** Deferred to full scope (§6) as `categoryChains` top-level key behind `version:2`. MVP routes only by **agent**, not task category. | **Full scope** |
| Compiled fallback chain defaults (`AGENT_MODEL_REQUIREMENTS` hardcoded tails like `sisyphus→claude-opus-5-5→kimi-k3→...→big-pickle`) | `packages/model-core/src/agent-model-requirements.ts` | Built-in hard defaults when no user chain present | **Explicit non-goal.** MVP has **no** compiled defaults — if `chains[agent]` absent, routing is a no-op for that agent (uses primary file-agent `model:` pin). Admin must populate desired chains; silent fallback to compiled defaults is undesirable on V2. | **Non-goal (implicit behavior, not desired)** |
| `sessionFallbackChains` per-session override | `fallback-state-controller: sessionFallbackChains Map` | `delegated-child-session-bootstrap:setSessionFallbackChain` propagated a chain to a child session | Retained for fork-compat if needed, but MVP does not expose a per-session setter. Future: `internalSetSessionFallbackChain` tool (gated) could enable it. | **Non-goal for MVP** |
| Provider reachability gating (`connectedProvidersCache` + `providerModelsCache`) | `shared/connected-providers-cache.ts`, `next-fallback.ts:createReachabilityChecker` | Skips fallback entries whose provider not in connected set; skips no-op same-model entries; skips in-cooldown entries | **Parity — MVP** (reachability + no-op skip; cooldown deferred to full) | **MVP partial** |
| Retryable error classification (`shouldRetryError` / `isRetryableModelError`) | `model-error-classifier.ts` + `runtime-fallback-retryable-patterns` | Classifies 429/500/502/503/504 + `isRetryable:true` AI-SDK errors as fallback-eligible; token-limit and unrecoverable 400/422 are **not** eligible | **Parity — MVP** (same classifier reused via `@oh-my-opencode/model-core` without importing OMO — copy the boundary strings) | **MVP** |
| `chat.message` mutation (V1 hook that rewrites `output.message.model` before next turn) | `model-fallback/hook: "chat.message"` + `chat-message-fallback-handler:applyFallbackToChatMessage` | Mutates in-flight `chat.message` to swap `providerID/modelID` + toast | **Not portable to V2.** V2 has no `chat.message` hook; fallback must be **reactive off `session.execution.failed`** and re-dispatched via `switchModel` + `prompt(queue)`. The `"chat.message"` handler is V1-coupled (foreground-fallback path assumes V1 `PluginInput` shape). | **V1-coupled — do not port** |
| `prompt-async-gate` (`dispatchInternalPrompt` with `semanticDedupeHoldMs`, `queueBehavior:defer`, `settleMs`) | `shared/prompt-async-gate` / `utils/prompt-async-gate` | Dedupe + queue-drain for continuation dispatch | **Not portable.** V2 has no `prompt-async-gate` package; fork's `v2/prompt-gate.ts:createV2PromptGate` is a minimal hold-map replacement (hold 2 s, duplicate skip). MVP reuses the V2 gate pattern inline. | **V1-coupled — replace with V2 gate** |
| `controllerAccessor.register` indirection | `model-fallback/controller-accessor.ts` | Allows `delegated-child-session-bootstrap` to `setSessionFallbackChain` without holding the controller directly | **Portable pattern** (not OMO-specific) — keep if per-session chain override is needed. MVP can omit (no child delegation yet). | **Portable — optional** |
| Toast + `getTaskToastManager` update | `chat-message-fallback-handler` | Shows `Using provider/model (variant)` warning + task-model sync | **Degraded on V2.** `compat-client:tui.showToast` degrades to `log("[omo-v2] toast degraded to log")`; no headless TUI surface. MVP logs via `client.app.log`. Full scope may use `session.notify` if available. | **Portable but degraded** |

---

## 6. MVP vs Full

### 6.1 MVP — shippable without reading the fork

**Goal:** failure-triggered fallback across a static per-agent chain + variant passthrough.

| Dimension | MVP | Full |
|---|---|---|
| **Chain source** | `routing.json: chains[agent].chain[]` single-provider entries (`provider/model`) | + per-agent `providers[]` alternatives per entry (multi-provider), + category chains (`categoryChains` key), + budget/capability routing |
| **Trigger** | `session.execution.failed` / `session.error` on retryable errors only | + proactive `session.created` primary selection + `session.idle` pre-warm + cost/capability classifier |
| **Classification** | Copy of fork's retryable boundary (429/500/502/503/504 + `isRetryable:true`, **not** `context_length_exceeded`/token-limit, **not** 400/422 unrecoverable) | + provider-specific quota signals (402 terminal quota, 529 overload), + CF 524 AI-SDK handling, + user-configurable `retry_on_errors` list |
| **Variant handling** | Pass `variant` alongside `switchModel`; passthrough `reasoningEffort`/`thinking` omitted | + full passthrough (`reasoningEffort/textVerbosity/reasoningSummary/thinking/temperature/top_p/maxTokens`) per entry |
| **State** | In-memory `Map<sessionID,State>` (cursor, attemptCount, failedModels, holdUntil) | + persisted cursor to `ctx.storage` (`routing:cursor:<id>`), + cross-restart recovery, + `sessionStatusRetryKeys` per-status dedupe |
| **Reachability** | `connectedProvidersCache` file read; if empty, allow all (no gating) | + `providerModelsCache` exact model-id fuzzy matching (`isModelAvailable`/`fuzzyMatchModel`) |
| **Cooldown** | None (MVP exhausts then stops) | Per-model `cooldown_seconds` + `MAX_CONSECUTIVE_FAILURES` exponential backoff (`5000 * 2^min(f,5)` up to 160 s) |
| **Dedupe** | Simple `holdUntil` map (5 s) | + `isSameFailedModel` canonical check + semantic dedupe hold + `inFlight`/pending guard |
| **Catalog empty at setup** | Walk chain in order, let `switchModel` fail through | + `catalog.updated`-like deferred re-check; queue fallback until catalog ready |
| **Loop guard** | `delivery:"queue"` (no synchronous re-entry) | + `clearPendingModelFallback` on success + `session.get outcome` guard (skip if already Terminal) |
| **Enforcer coexistence** | No shared flag; rely on enforcer's own cooldown to absorb duplicate | + explicit shared `routing:inflight:<sessionID>` flag or event ordering test |
| **Notifications** | `client.app.log` only | + degraded toast + `session.notify` when available |

**MVP file budget (est. 3–4 files, ~200 LOC):**

1. `routing-config.ts` — load/validate `routing.json` per §4, hot-reload on watcher, `getChain(agent)→ChainEntry[]`.
2. `error-classifier.ts` — `isRetryableModelError` / `isTokenLimitError` / `isUnrecoverableRequestError` (copy boundary strings from `model-core`, do not import OMO).
3. `routing-state.ts` — `createRoutingStateStore()` (`Map<sessionID, SessionRoutingState>` + prune interval).
4. `router.ts` — `setup(ctx)` wiring `event.subscribe` (`session.created/idle/status/error/execution.failed`) + `session.hook("prompt")` for proactive primary (optional) + `session.get` + `switchModel` + `prompt(queue)` fallback path. Variant: `createV2PromptGate` inline.

### 6.2 Full — cost/capability/budget-aware routing

- **Proactive cost/capability routing:** before first turn, score chain entries by capability heuristic (`model-capability-heuristics` / `model-capability-guardrails` from `model-core`) and cost, selecting cheapest capable model. Already encoded in fork's `AGENT_MODEL_REQUIREMENTS` vs `CATEGORY_MODEL_REQUIREMENTS` split.
- **Variant cycling:** on repeated capability failures (not auth/quota), cycle through `model-core: VariantCycler` (provider-specific variant ladder like `low→medium→high→xhigh→max`) before switching models.
- **Budget-awareness:** track token spend per session (`session.context` length / `session.status` retry metadata) and prefer cheaper lane after a spend threshold (e.g., `kimi-k3` over `claude-opus-5-5` after 100k tokens).
- **Persisted cursor, category routing, multi-provider entries, and the 5 remaining TODO-SPEC parity rows** (§5.2 ordered list: cooldown backoff, abort/token/compact/pending-question/stagnation guards). Each is one PR-sized increment per `trial/TODO-SPEC.md:§5.2`.

---

## 7. Verification Plan

### 7.1 What is unit-testable without a key / without inference

All of these run via `bun test` with in-memory fakes; no provider key, no network, no quota spend.

- **Config validation (§4.5):** feed malformed JSON variants (bad `version`, missing `model`, bad slash format, out-of-range `cooldownSeconds`, unknown variant) and assert per-agent vs whole-file error semantics. Validate the supplied 3-chain example parses to expected `ChainEntry[]` shapes.
- **Error classifiers:** port fork's `model-error-classifier` + `token-limit-detection` + `unrecoverable-request-error` boundary strings; unit-test the retryable vs token-limit vs unrecoverable partitions (e.g., `context_length_exceeded` is token-limit → ineligible; `status 429 isRetryable:true` → eligible; `status 400 isRetryable:false` with `tool_use without tool_result` → unrecoverable → ineligible).
- **Dedupe / loop-guard:** simulate two `session.execution.failed` events for same `provider/model` within hold window → second is ignored; simulate no-op candidate (`provider+canonical modelID` same as failed) → skipped.
- **Reachability checker:** stub `connectedProvidersCache` with `{connected:["openai"]}` then assert a `anthropic/claude-opus-5-5` entry is skipped, and that `null` catalog (empty) allows all.
- **State machine:** drive `IDLE → PRIMARY → FALLBACK → EXHAUSTED` via `setPendingModelFallback` / `getNextReachableFallback` calls and assert `attemptCount` and cursor progression (`model-fallback/hook.test.ts` existing test shape proves this pattern: `ses_model_fallback_main` progression test asserts `verbose`→`claude-opus-5-5`→`kimi-k3` across repeated `session.error` retries with `variant` deletion).
- **`switchModel` field names:** assert SDK calls use `{id, providerID}` not `{modelID, providerID}` (compat-client boundary).
- **DEFECT 1 non-regression:** assert the plugin's returned hooks object does **not** contain a `tool` key (or that any tool definitions satisfy the `seen.ref` contract). `trial/CELL2B.md:§7` mandatory — routing plugin must not register tools or must prove registration passes server validation first.

### 7.2 What needs live inference (spends quota / requires a working key)

- **Kill-primary → observe-fallback E2E:** configure `plan` chain head as a deliberately invalid or quota-blocked model (or inject a 429 via a proxy/mocked provider), dispatch `session.prompt("hello")` in trial container `ai-engkit-v2`, then assert `session.execution.failed` fires with retryable error and the plugin `switchModel`s to the second entry before the next `session.prompt(queue)` succeeds. Log via `client.app.log` + `/tmp/oh-my-opencode.log` fallback trace. This is the **gate** for MVP ship.
- **Variant passthrough E2E:** send a prompt with `variant: max` chain head, assert the routed call carries `variant` (or equivalent `reasoningEffort` / `thinking.budgetTokens`) to the provider; after fallback, assert `variant` is deleted or replaced per entry.
- **Cooldown expiry E2E:** trigger fallback to `EXHAUSTED`, wait `cooldownSeconds + 1`, dispatch again, assert the previously-failed head is retried (not permanently blacklisted).
- **Enforcer coexistence smoke:** with both routing and todo-enforcer plugins loaded, trigger `session.idle` with incomplete todos **and** a retryable error; assert only one `session.prompt(queue)` is dispatched within the hold window (no duplicate queue).

Per `trial/CELL2B.md:§8`, trial has **no billable inference path** today (openrouter/google 401, nvidia 403, `big-pickle` Console-gated). The live-E2E lane is blocked until billing owner rotates a working key via Admin Providers page (`admin-data/provider-keys.json` → `auth.json` → container restart) or enables Console OAuth via UI (free tier passes parent sessions). All unit-testable coverage in §7.1 should be completed **before** the key arrives.

### 7.3 Success criteria

- Admin implementer can define the `routing.json` write format from §4 alone and produce the example chain that validates.
- Plugin implementer can build the MVP (failure-triggered fallback across static per-agent chain + variant passthrough) without reading the fork — §3 + §4 + §6.1 are sufficient.
- `bun test` green on §7.1 with zero `seen.ref` tool-registration failures and zero whole-file validation regressions (Z1 non-repeat proven).

---

## 8. Appendix — Fork Lineage (what each piece does & portability)

| Fork piece | What it does | Portable to V2 thin plugin? |
|---|---|---|
| `hooks/model-fallback/hook.ts` + `fallback-state-controller.ts` (state Map `pendingModelFallbacks / lastToastKey / sessionFallbackChains`) | Owns fallback cursor: `setPendingModelFallback` arms a retry on `session.error`, `getNextFallback` → `getNextReachableFallback` walks `attemptCount` and returns next `providerID/modelID/variant`, `clearPendingModelFallback` on success, dedup via `isSameFailedModel` + `pending` flag | **Portable core.** Trim `providers: string[]` multiplicity, keep single-provider. |
| `hooks/model-fallback/next-fallback.ts:getNextReachableFallback` | Reachability check (`connectedProvidersCache`), provider pick, no-op skip, `attemptCount++`, `pending=false` | **Portable.** Keep catalog-empty → allow-all branch. |
| `hooks/model-fallback/chat-message-fallback-handler:applyFallbackToChatMessage` | Mutates V1 `output.message.model = {providerID, modelID}` + toast dedupe (`lastToastKey`) | **V1-coupled.** V2 has no `chat.message` hook — replace with `switchModel` + `prompt(queue)` re-dispatch. Toast logic is portable as log fallback. |
| `hooks/model-fallback/controller-accessor` | Indirection so `delegated-child-session-bootstrap` can `setSessionFallbackChain` without holding controller | Portable pattern, optional for MVP. |
| `hooks/runtime-fallback/*` (category chains, `createRuntimeFallbackHook`, `fallback-state`, `auto-retry*`) | Broader category-based auto-retry with file-backed cooldown, max attempts, `retry_on_errors` config, `sessionFallbackTimeouts` | **Partially portable.** The `fallback-state`/`findNextAvailableFallback` cooldown logic is portable; the category dispatch keyed by `CATEGORY_MODEL_REQUIREMENTS` is full-scope. |
| `shared/model-requirements` + `packages/model-core/src/agent-model-requirements.ts` (`AGENT_MODEL_REQUIREMENTS`) | Compiled hard-default chains per agent | **Not portable as defaults** (explicit non-goal). Portable as **shape reference** for `FallbackEntry` (`providers[]` vs single `provider`). |
| `shared/connected-providers-cache` + `shared/provider-model-id-transform` (`transformModelForProvider`, `selectFallbackProvider`) | File-cache of connected providers + provider-specific model-id transform (e.g., `kimi-k3` alias mapping) | **Portable.** The caches are file-backed and async; keep the read path (`readConnectedProvidersCache()` / `readProviderModelsCache()`). |
| `shared/model-error-classifier` (`isRetryableModelError`, `selectFallbackProvider`) | Boundary strings for retryable vs token-limit vs unrecoverable | **Portable** (copy boundary strings, do not import OMO). |

---

## 9. Top 3 Spec Uncertainties

1. **`catalog.updated` async population (`UNCONFIRMED` event).** Neither fork `src/v2/` nor live docs evidence a typed `catalog.updated` event. The real async source is file caches (`connected-providers.json` / `provider-models.json`) that are empty at `setup()` and populate later. The spec's reachability checker handles the empty case as allow-all, but a true catalog-ready callback (if the event exists under a different name) would let proactive routing defer until precise filtering is possible. Confirm by grepping the live V2 server's event list or by observing cache file `mtime` after container boot and correlating to any emitted event type.
   > *Impact:* P1 — affects when proactive routing can trust provider gating. MVP survives by walking chains in order; full scope could be more precise with a confirmed event.

2. **`switchModel` exact SDK signature + materialization timing (`FORK-ONLY`).** Fork bridges `switchModel({sessionID, model:{id, providerID}})` (field `id` not `modelID`). No live docs page types this call, and `agent.transform` timing (immediately vs next turn) is unstated. If the real SDK field is `{modelID}` or the switch is synchronous, the plugin's `switchModel→prompt` replay would misbehave.
   > *Impact:* P1 — breaks fallback re-dispatch. Confirm by reading the generated OpenCode 2.0.15 client `docs/knowledge/tooling/opencode-v2-migration-watch.md` measured surface or by capturing a real `v2.session.switchModel` call in a live session with a working key.

3. **Reactive fallback must target `session.execution.failed` vs `session.error` (`FORK-ONLY`).** Docs list `session.error` under Session Events; fork subscribes only `session.execution.failed` and translates it to `session.error` for V1 consumers. If the live V2 server emits the V1 name directly, the plugin's `execution.failed`-only subscription would miss failures; if it emits the V2 name, an `error`-only subscription would miss them. The spec hedges by subscribing to **both**, but the true emitted type is unconfirmed.
   > *Impact:* P2 — missed fallback trigger. Confirm by logging `event.subscribe` traffic during a real `opencode run` failure (expired key / 429) and seeing which `type` arrives, as suggested in `trial/CELL2B.md:§7` cheap follow-up (one minimal prompt + grep both logs for hook firing).
