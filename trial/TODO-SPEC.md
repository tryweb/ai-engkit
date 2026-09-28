# Todo Continuation Enforcer — Self-Build Spec for OpenCode V2 Native

> Target runtime: **OpenCode 2.0.15 + OpenChamber 2.0.0** via `Plugin.define({ id, setup(ctx) })` (V2 plugin API).
> Reference implementation: fork `Hallaxius/oh-my-openagent` branch `Hallaxius/feat/opencode-v2-runtime` commit `aada48e` (PR #8768), read-only via `docker exec ai-engkit-v2` at `/tmp/omo-v2-fork/`.
> The fork is **reference only** — V2-native build must not import `omo-opencode` or `@opencode-ai/plugin` (V1 SDK). All opencode surfaces below map to `@opencode/plugin` (V2) + `@opencode/client@2.0.15` semantics documented in `packages/omo-opencode/src/v2/`.

---

## 1. Per-Module Behavior Table

Source of truth enumerated live from container: `ls /tmp/omo-v2-fork/packages/omo-opencode/src/hooks/todo-continuation-enforcer/` (non-test `.ts`):

| # | File | Exported Symbol | Triggers (event.type) | State Inputs (SessionState fields read) | Outputs / Side Effects | Guards (skip/cancel conditions) |
|---|------|-----------------|----------------------|----------------------------------------|------------------------|--------------------------------|
| 1 | `index.ts` | `createTodoContinuationEnforcer(ctx, opts)` factory | None directly; wires `sessionStateStore` + returns `{handler, markRecovering, markRecoveryComplete, cancelAllCountdowns, dispose}` | Delegates to store | Creates fresh `createSessionStateStore()` per enforcer instance; wires `backgroundManager`, `skipAgents`, `isContinuationStopped` through to `createTodoContinuationHandler` | Validates `opts.skipAgents` presence; no throw path |
| 2 | `handler.ts` | `createTodoContinuationHandler({ctx, sessionStateStore, backgroundManager, skipAgents, isContinuationStopped})` → `handler(event)` | `session.error`, `session.idle`, `session.compacted`, `session.deleted`, else → `handleNonIdleEvent` | Reads/writes `wasCancelled`, `abortDetectedAt`, `tokenLimitDetected`, `unrecoverableErrorDetected`, `consecutiveFailures`, `lastInjectedAt`, `recentCompactionAt/Epoch` | On `session.error`: classifies error via `extractSessionErrorInfo` → `isTokenLimitError` / `isUnrecoverableRequestError` else abort-name check; mutates state, `cancelCountdown`, logs. On `session.idle`: `startPruneInterval()` + `handleSessionIdle`. On `session.compacted`: `armCompactionGuard`. On `session.deleted`: `clearContinuationMarker` + `handedBackSyncSessions.delete`. All other events: delegates to `handleNonIdleEvent`. | `resolveSessionEventID(props)` must yield non-empty `sessionID` else early return. `extractSessionErrorInfo` tolerates string / Error / `{data.error}` shapes. |
| 3 | `idle-event.ts` | `handleSessionIdle({ctx, sessionID, sessionStateStore, backgroundManager, skipAgents, isContinuationStopped})` | `session.idle` (also synthesized from `session.status idle` via V1 `normalizeSessionStatusToIdle` — not trusted on V2; V2 emits `session.idle` directly, see §4) | Reads all of: `allTodosCompletedAt`, `isRecovering`, `wasCancelled`, `tokenLimitDetected`, `unrecoverableErrorDetected`, `abortDetectedAt`, `lastInjectedAt`, `consecutiveFailures`, `inFlight`, `recentCompactionEpoch`, `countdownStartedAt`, etc. | Fetches `ctx.client.session.messages({path:{id}, query:{directory}})` → `normalizeSDKResponse` → abort/pending-question/internal-continuation checks. Fetches `ctx.client.session.todo`. Computes `incompleteCount`. Applies cooldown `CONTINUATION_COOLDOWN_MS * 2^min(consecutiveFailures,5)`. Resolves agent via `resolveLatestMessageInfo` (+ `getSessionAgent` fallback). Calls `trackContinuationProgress` + `shouldStopForStagnation`. If passes, calls `startCountdown`. | Chain of early-returns in order: (1) `allTodosCompletedAt` set, (2) `isRecovering`, (3) `wasCancelled`, (4) `handedBackSyncSessions.has(id)`, (5) `tokenLimitDetected`, (6) `unrecoverableErrorDetected`, (7) `abortDetectedAt` within `ABORT_WINDOW_MS=3000` (clears flag after window), (8) `backgroundManager` running/pending or `hasPendingParentWake`, (9) `isLastAssistantMessageAborted` (API fallback), (10) `hasUnansweredQuestion`, (11) `latestAssistantTurnBlocksInternalPrompt` (pending internal-continuation response gate), (12) todo fetch failure, (13) empty todos → `resetContinuationProgress`, (14) `incompleteCount===0` → `allTodosCompletedAt=now`, (15) `inFlight`, (16) `consecutiveFailures >= MAX_CONSECUTIVE_FAILURES(5)` without `FAILURE_RESET_WINDOW_MS(5m)` expiry, (17) cooldown active, (18) `latestMessageWasCompaction`, (19) agent in `skipAgents`, (20) compaction guard active without agent, (21) `isContinuationStopped(id)`, (22) `continuationBlockReason` set, (23) `shouldStopForStagnation` true. |
| 4 | `non-idle-events.ts` | `handleNonIdleEvent({eventType, properties, sessionStateStore})` | `message.updated`, `message.part.updated`, `message.part.delta`, `tool.execute.before/after`, `session.deleted` | Reads/writes `countdownStartedAt`, `abortDetectedAt`, `wasCancelled`, `tokenLimitDetected`, `unrecoverableErrorDetected`, `awaitingPostInjectionProgressCheck`, `continuationResponseObserved`, `continuationBlockReason`, `pendingUserMessageID` | Cancels countdowns; classifies user vs assistant vs tool activity; defers classification of split `message.updated` (no `parts` yet) via `pendingUserMessageID`; `pauseForGenuineUserInterruption` sets `continuationBlockReason="user-interruption"` and clears cancellation/token flags. | `resolveMessageEventSessionID` must resolve; synthetic/internal user messages (`isSyntheticOrInternalOnlyTextParts` / `isSyntheticOrInternalUserMessage`) are ignored except internal continuation cancels countdown. Grace period: user message within `COUNTDOWN_GRACE_PERIOD_MS=500` of `countdownStartedAt` is ignored. `hasAcceptedContinuationLifecycle` gates whether user activity pauses vs cancels. |
| 5 | `stagnation-detection.ts` | `shouldStopForStagnation({sessionID, incompleteCount, progressUpdate})` | Called from `handleSessionIdle` after `trackContinuationProgress` | `progressUpdate.{hasProgressed, stagnationCount, previousIncompleteCount}` | Logs; returns `true` if `stagnationCount >= MAX_STAGNATION_COUNT(3)` → idle handler returns without countdown. On `hasProgressed` logs recovery even if previous was stopped. | Pure predicate; caller owns skip. |
| 6 | `pending-question-detection.ts` | `hasUnansweredQuestion(messages)` | Idle gate | Scans `messages[].parts` reverse from last; `question` / `ask_user_question` / `askuserquestion` tool parts with `state.status !== "completed"` | Returns bool; logs when detected. | Skips `isSyntheticOrInternalUserMessage` user turns while scanning; bottoms out to last non-synthetic user→no-question, last assistant with tool→check. |
| 7 | `token-limit-detection.ts` | `isTokenLimitError({name?, message?})` | `session.error` + injection catch | `name`, `message` of error | Returns bool; first consults `isRetryableModelError` from `@oh-my-opencode/model-core`; only non-retryable + name `contextlengtherror`/`context_length_exceeded` counts as token-limit; otherwise substring scan of `message` against `TOKEN_LIMIT_FALLBACK_PATTERNS` (`"prompt is too long"`, `"context_length_exceeded"`, `"token limit"` etc.). | Requires `error` defined; case-insensitive; narrow by design — retryable errors never count. |
| 8 | `unrecoverable-request-error.ts` | `isUnrecoverableRequestError(error)` | `session.error` + injection catch | `getRuntimeFallbackStatusCode`, `getRuntimeFallbackRetryableSignal` | True only when `statusCode ∈ {400,422}` AND `isRetryable===false` (Anthropic `tool_use` without `tool_result` on compaction). | Empty/shapeless → false; 400 without explicit `isRetryable:false` → false; 429 even with false → false. |
| 9 | `abort-detection.ts` | `isLastAssistantMessageAborted(messages)` | Idle API fallback | Last assistant message's `info.error.name` | True if `MessageAbortedError` or `AbortError`; used when `session.error` event was missed. | Needs ≥1 assistant message; missing `error.name` → false. |
| 10 | `compaction-guard.ts` | `armCompactionGuard(state, now)`, `acknowledgeCompactionGuard(state, epoch)`, `isCompactionGuardActive(state, now)` | `session.compacted` + idle `resolveLatestMessageInfo` | `recentCompactionAt`, `recentCompactionEpoch`, `acknowledgedCompactionEpoch` | `arm` bumps epoch, stamps `now`. `acknowledge` marks observed epoch as handled (only if matches). `isActive` true when not acknowledged and `now - recentCompactionAt < COMPACTION_GUARD_MS(60_000)`. Idle skips when guard active and agent unknown, or when `latestMessageWasCompaction`, or when no agent resolved while guard active. | Pure time window; callee must pass observed epoch through `resolveLatestMessageInfo.then(acknowledge)`. |
| 11 | `countdown.ts` | `startCountdown({ctx, sessionID, incompleteCount, resolvedInfo, backgroundManager, skipAgents, sessionStateStore, isContinuationStopped})` | Called only from idle handler after all guards | `countdownTimer`, `countdownInterval`, `countdownStartedAt` | `cancelCountdown` previous; `showCountdownToast` at 2s then 1s (`ctx.client.tui.showToast` variant `warning`, `duration=900ms`, title `"Todo Continuation"`, message `"Resuming in Xs... (N tasks remaining)"`). `setTimeout 2000ms` → `injectContinuation`. `setInterval 1000ms` for second tick. Logs start. | Toast failures swallowed (`.catch(()=>{})`). Interval/timer stored on state; must be `cancelCountdown`-cleared. |
| 12 | `continuation-injection.ts` | `injectContinuation({ctx, sessionID, backgroundManager, skipAgents, resolvedInfo, sessionStateStore, isContinuationStopped})` | `setTimeout` from countdown | Re-reads todos; `wasCancelled`, `isRecovering`, `continuationBlockReason`, `inFlight`, `backgroundManager` running, `resolvedInfo.{agent,model,tools}`; also `ctx.client.session` messages/files fallback | Validates still has incomplete todos; resolves `agentName/model/tools` fallback: if missing, `isSqliteBackend()` → `findNearestMessageWithFieldsFromSDK(ctx.client, id)` else `getMessageDir(id)` → `findNearestMessageWithFields(dir)` (reads message files from `MESSAGE_STORAGE`). Normalizes agent via `getAgentConfigKey` / `resolveRegisteredAgentName` / `normalizeAgentForPrompt`. Enforces `skipAgents` again; `hasWritePermission(tools)` (deny on `edit:false|"deny"` or `write:false|"deny"`). Builds `prompt = CONTINUATION_PROMPT + "\n\n[Status: X/Y completed] ...\nRemaining tasks:\n- [status] content"`. Double-checks bg tasks + `wasCancelled` + `continuationBlockReason` right before dispatch. Sets `inFlight=true`. Calls `dispatchInternalPrompt({mode:"async", client: ctx.client, sessionID, source: HOOK_NAME, settleMs:0, queueBehavior:"defer", semanticDedupeHoldMs: CONTINUATION_COOLDOWN_MS, input:{path:{id}, body:{agent:promptAgent, ...model, ...tools, parts:[createInternalAgentContinuationTextPart(prompt)]}, query:{directory}}})`. On `failed` with `isAmbiguousPostDispatchPromptFailure` → treat as success: `lastInjectedAt=now`, `awaitingPostInjectionProgressCheck=true`, `consecutiveFailures=0`. On `failed` else → throw. On `!isInternalPromptDispatchAccepted(result)` (skipped/dupe) → `inFlight=false` return. On success → `inFlight=false`, `lastInjectedAt=now`, `awaitingPostInjectionProgressCheck=true`, clear block fields, `consecutiveFailures=0`. On throw → `inFlight=false`, `lastInjectedAt=now`, `consecutiveFailures++`, classify `isTokenLimitError` → `tokenLimitDetected=true` / `isUnrecoverableRequestError` → `unrecoverableErrorDetected=true`. | Early returns on recovering/cancelled/handedBack/stopped/bgRunning/no-incomplete/skipAgents/unknown-agent-with-guard/no-write-permission/blockReason. `inFlight` guards double dispatch. `resolveInheritedPromptTools` merges tools for child context. |
| 13 | `session-state.ts` | `createSessionStateStore() → SessionStateStore` | All modules | All `SessionState` fields below (in-memory `Map<string, TrackedSessionState>`; `TrackedSessionState={state, lastAccessedAt, lastCompletedCount, lastTodoSnapshot}`) | `getState` (creates if absent), `getExistingState`, `startPruneInterval` (single `setInterval 2m`, `unref`, prunes entries older than `10m` TTL: `cancelCountdown` + `Map.delete`), `trackContinuationProgress(id, incompleteCount, todos)` (snapshot via `getTodoSnapshot` = sorted `id|fallback(content:priority) → status` join `"|"`; increments `stagnationCount` only when `hadSuccessfulInjectionAwaitingProgressCheck` and no progress; resets on `hasProgressed` which is `incompleteCount<prev` OR `completedCount>prev` OR `snapshotChanged`), `resetContinuationProgress`, `cancelCountdown` (clearTimeout+clearInterval+`inFlight=false`), `cleanup`, `cancelAllCountdowns`, `shutdown` (clear prune + cancelAll + clear Map). | `getTodoSnapshot` compares only `id→status`; content/priority changes do NOT reset stagnation (issue #4013). Prune interval lazy-started by idle handler. TTL 10m / prune 2m. |
| 14 | `todo.ts` | `getIncompleteCount(todos)` | Idle + injection | `Todo[].status` | `todos.filter(s !== "completed" && s !== "cancelled" && s !== "blocked" && s !== "deleted").length` — `in_progress` and `pending` count as incomplete. | Pure. |
| 15 | `types.ts` | Interfaces | — | `TodoContinuationEnforcerOptions{ backgroundManager?, skipAgents?, isContinuationStopped?}`, `TodoContinuationEnforcer{handler, markRecovering, markRecoveryComplete, cancelAllCountdowns, dispose}`, `Todo{content,status,priority,id?}`, `SessionState{countdownTimer?, countdownInterval?, isRecovering?, wasCancelled?, tokenLimitDetected?, unrecoverableErrorDetected?, countdownStartedAt?, abortDetectedAt?, lastIncompleteCount?, lastInjectedAt?, awaitingPostInjectionProgressCheck?, continuationResponseObserved?, continuationBlockReason?, pendingUserMessageID?, inFlight?, stagnationCount, consecutiveFailures, allTodosCompletedAt?, recentCompactionAt?, recentCompactionEpoch?, acknowledgedCompactionEpoch?}`, `MessageInfo`, `ResolvedMessageInfo`, etc. | No runtime behavior; shape contract. | — |
| 16 | `constants.ts` | Constants | — | — | `HOOK_NAME="todo-continuation-enforcer"`, `DEFAULT_SKIP_AGENTS=["prometheus","compaction","plan"]`, `CONTINUATION_PROMPT` (see §3), `COUNTDOWN_SECONDS=2`, `TOAST_DURATION_MS=900`, `COUNTDOWN_GRACE_PERIOD_MS=500`, `ABORT_WINDOW_MS=3000`, `COMPACTION_GUARD_MS=60000`, `CONTINUATION_COOLDOWN_MS=5000`, `MAX_STAGNATION_COUNT=3`, `MAX_CONSECUTIVE_FAILURES=5`, `FAILURE_RESET_WINDOW_MS=300000`. | — | — |
| 17 | `message-directory.ts` | Re-export `getMessageDir` | `continuation-injection` fallback | `sessionID` | Thin shim: `export { getMessageDir } from "../../shared/opencode-message-dir"`; returns filesystem path to message dir or null (validates `ses_` prefix, no path traversal, `MESSAGE_STORAGE` exists). | Null return triggers skip of file-scan fallback. |
| 18 | `resolve-message-info.ts` | `resolveLatestMessageInfo(ctx, sessionID, prefetchedMessages?)` | `handleSessionIdle` agent resolution | `ctx.client.session.messages` | Iterates `messages` reverse: flags `encounteredCompaction` if any `isCompactionMessage`, `latestMessageWasCompaction` if last entry is compaction; skips `isSyntheticOrInternalUserMessage`; returns first entry with `agent` or `model` or `modelID/providerID` as `ResolvedMessageInfo{agent, model:{providerID,modelID,variant?}, tools}`. Logs none. If none, `{resolvedInfo:undefined, encounteredCompaction, latestMessageWasCompaction}`. | Uses prefetched messages when supplied to avoid extra fetch; otherwise fetches via SDK. |

**Read status — all non-test files listed above were read via `docker exec cat` and are covered. Test-only companions (no standalone module) flagged below:**

| Name | Presence | Coverage |
|------|----------|----------|
| `dispose` | No `dispose.ts`; behavior lives in `index.ts:dispose` → `sessionStateStore.shutdown()` | See rows 1,13 |
| `parent-wake-race` | No `parent-wake-race.ts`; behavior is the `backgroundManager.hasPendingParentWake(sessionID)` + `getTasksByParentSession` checks in `idle-event.ts` and `continuation-injection.ts`, covered by `parent-wake-race.test.ts` | See rows 3,12 |
| `opencode-overload-continuation` | No `opencode-overload-continuation.ts`; overload continuation scenario is tested in `opencode-overload-continuation.test.ts` and handled by the `stagnationCount` / `continuationResponseObserved` machinery — no separate file exists | — |

One entry (`index.ts` companion `todo-continuation-enforcer.test.ts`) is a combined integration harness not enumerated above — its 30+ cases are the source of the guard-order and flag-clearing semantics quoted in rows 3–12.

---

## 2. State-Source Map

"Where does the state that drives the enforcer come from?" — Three tiers, and the fork makes them explicit.

### 2.1 Todo State — the decision input

| Layer | Store | Accessor (fork) | Accessor (V2 native) | Persistence | Compaction / Restart Survivability |
|-------|-------|------------------|-----------------------|-------------|-----------------------------------|
| **V1** | SQLite `opencode.db` tables `todo` (session-scoped) | `ctx.client.session.todo({path:{id}})` → `normalizeSDKResponse(resp, [] as Todo[], {preferResponseOnMissingData:true})` (V1 plugin `PluginInput["client"]`) | **NO V2 `session.todo` API exists** — confirmed absent in `@opencode/plugin` V2 `Plugin.Context["session"]` surface. Fork's `compat-client.ts` documents this explicitly. | SQLite under `~/.local/share/opencode/opencode.db`, session-keyed; survives compaction if session survives; survives restart. | Survives compaction; survives process restart. |
| **V2 compat (fork)** | `ctx.storage` JSON KV via `createTodoStore(storage)` at `stores.ts` — keys `omo-v2:todos:<sessionID>`, values `V2TodoItem[]{content,status,priority?,id?}` (status ∈ `pending|in_progress|completed|cancelled`; fork maps V1 `blocked/deleted` away — see §4 gap). | `todos.get(id)` / `todos.set(id, items)` layered under `createV1CompatContext(ctx, {todos})` so `client.session.todo` is re-routed to the KV store. | **Reference pattern for self-build**: implement the same KV store on `ctx.storage` (V2 storage is the only per-session durable KV available to a V2 plugin). Do NOT attempt to read SQLite directly. | `ctx.storage` (opencode managed; durable JSON, `scan` paginated `limit 100`). | Survives compaction + restart (storage is durable). |

**Semantics to reproduce exactly:**
- `getIncompleteCount` counts every todo whose `status` is NOT in `{"completed","cancelled","blocked","deleted"}`. On V2's reduced status set this means `pending` and `in_progress` are incomplete.
- Snapshot for progress detection (`session-state.ts:getTodoSnapshot`) keys by `todo.id ?? "${content}:${priority}"` and value is `status` only — content/priority edits are **not** progress.
- `allTodosCompletedAt` is set when `incompleteCount===0` after a fetch; it gates idle forever until cleared by new todos or cleanup. `resetContinuationProgress` clears it (called when no todos, or on completion state reuse).

### 2.2 Session State — the enforcer's own bookkeeping

| Field | Source | Store | Lifetime |
|-------|--------|-------|----------|
| `stagnationCount`, `consecutiveFailures`, `lastIncompleteCount`, `lastInjectedAt`, `allTodosCompletedAt` | Computed in `trackContinuationProgress` / injection success/failure handlers | In-memory `Map<string,TrackedSessionState>` inside `createSessionStateStore()` — **not** persisted to SQLite or `ctx.storage` | Per-enforcer-instance memory; pruned after `SESSION_STATE_TTL_MS=10m` idle, or `cleanup(sessionID)` on `session.deleted`, or `shutdown()` on dispose. `_lastCompletedCount` / `_lastTodoSnapshot` for accurate stagnation math also in-memory. |
| `countdownTimer`, `countdownInterval`, `countdownStartedAt`, `inFlight` | Countdown/injection lifecycle | Same in-memory map; timer handles are `number | {unref}` | Cleared by `cancelCountdown` / `cancelAllCountdowns` / prune. |
| `wasCancelled`, `abortDetectedAt`, `tokenLimitDetected`, `unrecoverableErrorDetected` | `session.error` classifier + `message.*` handlers | Same map; set on error/abort, cleared on genuine user/assistant/tool activity or window expiry | `abortDetectedAt` window `3000ms`; `tokenLimitDetected`/`unrecoverableErrorDetected` persist until genuine user message clears them (see `non-idle-events`). `wasCancelled` sticky until user/assistant/tool clears it. |
| `awaitingPostInjectionProgressCheck`, `continuationResponseObserved`, `continuationBlockReason`, `pendingUserMessageID` | Injection success → progress-check handshake | Same map | `awaiting` set on successful injection, cleared on next `trackContinuationProgress` (or on progress). `continuationBlockReason` is `"directive-response"` (agent replied to directive without todo progress) or `"user-interruption"` (real user message arrived during awaiting window). |
| `recentCompactionAt/Epoch`, `acknowledgedCompactionEpoch`, `isRecovering` | `session.compacted` + `markRecovering` API | Same map | Guard window `60s`; recovering set externally. |
| `handedBackSyncSessions` (external `Set<string>`) | `features/claude-code-session-state.ts` (subagent handoff) | In-memory global Set | Checked on every idle/injection; cleared on `session.deleted`. |

**Compaction/restart caveat (the "heart of the spec"):** The enforcer's own session-state map **does not survive process restart** and is **not rehydrated from storage**. On compaction, todo state survives (storage/SQLite) but the guard epoch preserves intent for one window. On restart, stagnation/consecutive-failure counters reset — by design; the fork accepts this. Formal persistence of continuation state across restart would require serializing the map to `ctx.storage` (prefix `omo-v2:enforcer:<sessionID>`), which the fork does not do and §6 marks as full-parity scope.

### 2.3 Message / Agent / Model State — who to impersonate

| Question | Source (fork V2 compat) | Accessor |
|----------|------------------------|---------|
| What were the last turns? | `ctx.client.session.messages` in V1; `v2.session.context({sessionID})` in V2 via `compat-client.ts` → `toV1MessageViews(messages, id)` adapter (maps V2 content to `views[].info.{role,agent,modelID/providerID/variant,tools,error}` + `parts[]`). | `handleSessionIdle` prefetches one `messages` response and reuses it for `isLastAssistantMessageAborted` + `hasUnansweredQuestion` + `latestAssistantTurnBlocksInternalPrompt` + `resolveLatestMessageInfo` (pass-through prefetched array). |
| Who was the last agent/model? | `resolveLatestMessageInfo` reverse scan (skip `isCompactionMessage` + synthetic/internal); fallback to `getSessionAgent(sessionID)` (registry) then to `findNearestMessageWithFieldsFromSDK` (V2 path, SDK) or `findNearestMessageWithFields(getMessageDir(id))` (V1 fallback, reads message files under `MESSAGE_STORAGE/sessionID`). | `continuation-injection.ts` |
| Message dir for file-scan | `getMessageDir(sessionID)` → `node:fs existsSync(join(MESSAGE_STORAGE, sessionID))` scan | `message-directory.ts` re-export. |

### 2.4 Storage Topology Diagram (V2 native)

```
ctx.storage (durable KV, JSON)                  In-memory (SessionStateStore Map)
┌──────────────────────────────┐               ┌──────────────────────────────┐
│ omo-v2:session:<id>  → V2SessionRecord      │ TrackedSessionState per id   │
│ omo-v2:todos:<id>    → V2TodoItem[]  ──────▶│  state: SessionState { ... } │
│ omo-v2:enforcer:<id> (not in fork;          │  lastAccessedAt              │
│                     future §6 proposal)     │  lastCompletedCount          │
│ (used by V2 compat stores.ts)               │  lastTodoSnapshot            │
└──────────────┬───────────────┘               └──────────────┬───────────────┘
               │  via createSessionRegistry/                    │  TTL 10m / prune 2m
               │  createTodoStore(ctx.storage)                  │  isRecovering
               ▼                                                ▼
     createV1CompatContext(ctx) re-routes          Countdown timers
     client.session.todo → todos.get               (2s toast + injection)
              │
              ▼
     ctx.client.session (V1-compat facade)
         ├─ todo()      → KV store
         ├─ messages()  → v2.session.context → toV1MessageViews
         ├─ promptAsync() → v2.session.prompt({delivery:"queue"})
         └─ status()    → statusCache.snapshot()
```

---

## 3. Injection Mechanism

### 3.1 The Continuation Prompt (exact value to reproduce)

`constants.ts:CONTINUATION_PROMPT`:
```
<!-- OMO_SYSTEM_DIRECTIVE:TODO_CONTINUATION -->   // from createSystemDirective(SystemDirectiveTypes.TODO_CONTINUATION)
\n
Incomplete tasks remain in your todo list. Continue working on the next pending task.

- Proceed without asking for permission
- Mark each task complete when finished
- Do not stop until all tasks are done
- If you believe all work is already complete, the system is questioning your completion claim. Critically re-examine each todo item from a skeptical perspective, verify the work was actually done correctly, and update the todo list accordingly.
```

At injection time (`continuation-injection.ts`) the prompt is extended:
```
CONTINUATION_PROMPT + "\n\n[Status: X/Y completed, N remaining]\n\nRemaining tasks:\n" + incompleteTodos.map(t => `- [${t.status}] ${t.content}`).join("\n")
```
where `incompleteTodos = todos.filter(t.status !== "completed" && t.status !== "cancelled")` (keeps `blocked/deleted` in the list for the user to see, even though `getIncompleteCount` excludes them from the decision — intentional).

The part is wrapped with `createInternalAgentContinuationTextPart(prompt)` which appends `<!-- OMO_INTERNAL_INITIATOR -->`, sets `synthetic:true`, `metadata:{compaction_continue:true}`. This is how `isSyntheticOrInternalUserMessage` and `isSyntheticOrInternalOnlyTextParts` recognize the injection and **ignore it** in `non-idle-events` / `resolveLatestMessageInfo` / `hasUnansweredQuestion`.

### 3.2 Dispatch Path (prompt-async-gate)

The fork **never calls `ctx.client.session.promptAsync` directly** after the migration — it calls the shared `dispatchInternalPrompt` from `@oh-my-opencode/utils/prompt-async-gate` (re-exported via `packages/utils/src/prompt-async-gate.ts` → `hooks/shared/prompt-async-gate`). Exact call:

```ts
await dispatchInternalPrompt({
  mode: "async",
  client: ctx.client,            // PluginInput["client"] (V1 compat) or raw v2.client
  sessionID,
  source: HOOK_NAME,             // "todo-continuation-enforcer"
  settleMs: 0,                   // no idle settle — we already waited countdown
  queueBehavior: "defer",        // if queue draining, enqueue rather than steer
  semanticDedupeHoldMs: CONTINUATION_COOLDOWN_MS, // 5000ms — duplicate prompt text coalesced
  input: {
    path: { id: sessionID },
    body: {
      agent: promptAgent,        // normalized via getAgentConfigKey → resolveRegisteredAgentName → normalizeAgentForPrompt
      ...(launchModel ? { model: launchModel } : {}),   // {providerID, modelID} stripped of variant
      ...(launchVariant ? { variant: launchVariant } : {}),
      ...(inheritedTools ? { tools: inheritedTools } : {}), // resolveInheritedPromptTools(sessionID, tools)
      parts: [createInternalAgentContinuationTextPart(prompt)],
    },
    query: { directory: ctx.directory },
  },
})
```

`dispatchInternalPrompt` internals (relevant for V2 mapping):
- Resolves a dispatch client via `tryResolveDispatchClientSync` then `resolveDispatchClient` (live route vs queued route, `LIVE_ROUTE_UNAVAILABLE` fallback).
- Honors a `semanticDedupeHoldMs` window — second identical `CONTINUATION_PROMPT` within 5s is `coalesceRecentSemanticPromptDispatch` → `status:"skipped"`.
- Honors `queueBehavior:"defer"` — if `isPromptQueueDraining(sessionID)`, enqueues at `nextPromptQueueID()` instead of immediate dispatch.
- Path compatibility: tries `{path:{id}}` then falls back to `{path:id}` on `"path must be string"` error.
- Post-dispatch hold: `DEFAULT_PROMPT_ASYNC_POST_DISPATCH_HOLD_MS` (hold map per `sessionID`; duplicate within hold → `skipped`).
- Return `InternalPromptDispatchResult` discriminated union: `{status:"dispatched"}` | `{status:"skipped", reason}` | `{status:"failed", error}`. Handle accordingly:
  - `isAmbiguousPostDispatchPromptFailure(result)` → treat as success (optimistically mark injected).
  - `!isInternalPromptDispatchAccepted(result)` (skipped/dupe) → clear `inFlight` without counting.
  - Success → `inFlight=false`, `lastInjectedAt=Date.now()`, `awaitingPostInjectionProgressCheck=true`, `consecutiveFailures=0`.

**V2 native equivalent (§4):** `ctx.session.prompt({sessionID, text, delivery:"queue", agent?, model?})` directly, plus a local semantic dedupe + queue drain layer if needed (the fork's `prompt-async-gate` is not available on V2 — see §4 gap). Minimal MVP can call `session.prompt` without dedupe and accept the duplicate risk.

### 3.3 Countdown + Toast

`COUNTDOWN_SECONDS=2`. `startCountdown`:
1. `cancelCountdown` previous timer/interval for that session.
2. Immediate `showCountdownToast(ctx, 2, N)` then `setInterval 1000 → showCountdownToast(1, N)` (last tick N>0 check).
3. `setTimeout 2000 → injectContinuation(...)`.
4. Toast call: `ctx.client.tui.showToast({body:{title:"Todo Continuation", message:"Resuming in Xs... (N tasks remaining)", variant:"warning", duration:TOAST_DURATION_MS(900)}}).catch(()=>{})`.

Non-idle activity during the 2s window cancels the countdown (see `non-idle-events` cases). The V2 compat maps `client.tui.showToast` to `log("[omo-v2] toast degraded to log")` — i.e., **toasts are silently dropped on V2** (no headless TUI surface). MVP can degrade to log only.

### 3.4 Cooldowns & Resets

| Guard | Constant | Semantics |
|-------|----------|-----------|
| Base cooldown | `CONTINUATION_COOLDOWN_MS=5000` | Per-session `lastInjectedAt`; `effectiveCooldown = 5000 * 2^min(consecutiveFailures,5)` (exponential backoff to 160s at 5 failures). Idle handler early-returns if within window. |
| Failure cap | `MAX_CONSECUTIVE_FAILURES=5` | On injection throw, `consecutiveFailures++`; idle returns `Skipped: max consecutive failures reached` until window. On success, reset to 0. |
| Failure reset window | `FAILURE_RESET_WINDOW_MS=300000` (5m) | If `consecutiveFailures>=5` AND `now - lastInjectedAt >= 5m`, auto-reset to 0 before the cap check — allows recovery after long idle. Also reset on `MessageAbortedError` event. |
| Stagnation | `MAX_STAGNATION_COUNT=3` | Incremented only when `awaitingPostInjectionProgressCheck===true` and no progress; at 3, `shouldStopForStagnation` returns true → no countdown. Reset to 0 on `hasProgressed` or via `resetContinuationProgress`. |
| Abort window | `ABORT_WINDOW_MS=3000` | After `MessageAbortedError/AbortError` on `session.error`, next `session.idle` within 3s is skipped; after 3s the `abortDetectedAt` is cleared (but `wasCancelled` persists). `pendingUserMessageID` handshake delays classification of split `message.updated`. |
| Grace period | `COUNTDOWN_GRACE_PERIOD_MS=500` | User `message.updated` within 500ms of `countdownStartedAt` is ignored (race avoidance). |
| TTL/prune | `10m / 2m` | In-memory session-state pruned; `startPruneInterval` lazy-started on first `session.idle`. |

### 3.5 Skip-Agents

- Default `DEFAULT_SKIP_AGENTS = ["prometheus", "compaction", "plan"]` (matched via `getAgentConfigKey` case-insensitive normalize). Purpose: planner/compaction agents must not be nudged — they don't own todos.
- Configurable via enforcer option `skipAgents: string[]` (empty array allowed — then only injection-time per-tool permission gate remains).
- Checked twice: in `handleSessionIdle` (before countdown) and again in `injectContinuation` (post `getSessionAgent` / `resolveLatestMessageInfo`). If `agent===undefined` and compaction guard active, idle also skips.
- `isContinuationStopped(sessionID)=>boolean` is an external kill-switch (e.g., `stop-continuation` skill); checked at idle and right before dispatch; during countdown race, also gates `injectContinuation` right before `dispatchInternalPrompt`.

---

## 4. V1→V2 API Mapping Table

Every opencode surface the subsystem (and its compat scaffolding) touches, mapped to V2, citing the fork's own `src/v2/` compat layer where it bridges.

| V1 Surface (as imported by `omo-opencode` under V1) | How the enforcer uses it | V2 Equivalent (OpenCode 2.0.15 `@opencode/plugin` + `@opencode/client`) | Fork Bridge File | Gap / Workaround on V2 |
|----------------------------------------------------|--------------------------|-------------------------------------------------------------------------|-----------------|------------------------|
| `PluginInput` (`@opencode-ai/plugin`) — `input.client.session.todo({path:{id}})` | Core decision: fetch todos | **NO V2 `session.todo`** (migration-watch: "todo/boulder continuation = no-op"; `trial/CELL2B.md:§4` skip `tool.definition`) | `v2/stores.ts:createTodoStore(ctx.storage)` + `v2/compat-client.ts` (`session.todo → todos.get(id)`) | **BLOCKING.** Must ship `createTodoStore(ctx.storage)` (KV `omo-v2:todos:<id>`) plus tool/file writes that populate it. Every todo write (tool `todo_write` / `edit` etc.) must call `todos.set`. Fork's workaround is the reference pattern — do not store todos in SQLite directly. Status enum shrinks (`blocked`/`deleted` → map to `pending` or omit; fork drops them from validation). |
| `PluginInput["client"].session.messages({path:{id}, query:{directory}})` | Abort fallback, pending-question, agent/model resolution, compaction detection | `v2.session.context({sessionID})` → `toV1MessageViews()` adapter (V2 messages are `session.context` history; V2 has no paginated `messages` with `info` envelope) | `v2/compat-client.ts:session.messages` + `v2/message-text.ts:toV1MessageViews` | Adapter required; V2 shape lacks `info.error.name` at top level — verify field mapping before classifying aborts. Fallback `findNearestMessageWithFields` reads files, not API, when SDK field absent. |
| `PluginInput["client"].session.promptAsync({path:{id}, body:{agent,model,variant,tools,parts}, query:{directory}})` | Continuation injection dispatch | `v2.session.prompt({sessionID, text, delivery:"queue" | "steer", agent?, model?, files?})` (V2 has no `promptAsync` distinction — `prompt` with `delivery:"queue"` is the queued path; `wait` is separate) | `v2/compat-client.ts:session.promptAsync → v2.session.prompt` with `promptTextFromParts` + `switchAgent`/`switchModel` pre-calls | **Widening.** V2 has no `parts[]` with `synthetic/metadata` on prompt; `createInternalAgentContinuationTextPart`'s `metadata:{compaction_continue:true}` has no V2 sink — mark as `synthetic:true` text-only and rely on marker string match for synthetic detection. Also `providerID/modelID/variant` split: V2 `switchModel({model:{id,providerID}})`. |
| `PluginInput["client"].tui.showToast({body:{title,message,variant,duration}})` | Countdown countdown toast | No headless TUI on V2 — `compat-client.ts` maps to `log("[omo-v2] toast degraded to log")` | `v2/compat-client.ts:tui.showToast` | **Degraded.** V2 has no `tui` for plugins. Degrade to `console.log` / opencode logger; optional: use `session.notify` or `tool` progress if available in future V2. |
| `PluginInput["client"].event.subscribe({query:{directory}})` / V1 `event` hook | Multiplexed enforcer: `session.error`, `session.idle`, `session.compacted`, `session.deleted`, `message.updated`, `message.part.updated/delta`, `tool.execute.before/after` | `ctx.event.subscribe({signal})` (V2 `Plugin.Context["event"]` is an `AsyncIterable<V2Event>{type, data, location?}`) + `ctx.tool.hook("execute.before/after", fn)` (V2 tool hooks — signature changed, see §4.1) + `createEventBus` (fan-out + `statusCache`) | `v2/event-bus.ts` + `v2/hook-bridge.ts:registerEventBridge` / `registerToolHooks` | V1 `event ({type, properties:{sessionID, error}})` → V2 `event {type, data:{sessionID, error}}`. See translation table below. **Critical gap**: V2 has no `session.compacted` event — fork synthesizes compaction guard from `session.execution.*`? No: hook-bridge **does not forward `session.compacted`** (only `session.created/deleted/idle/status/execution.failed`). The fork's enforcer path therefore **misses compaction guard arming on V2** unless the compat layer is extended. Documented workaround: arm guard on `session.status` idle after a busy period with compaction-like message shape, or on `session.context` length drop. |
| `PluginInput["client"].session.status()` | Used by idle handler to sanity-check? (via statusCache snapshot) | `ctx.session.get({sessionID})`? Actually `statusCache.snapshot()` built by `event-bus` from `session.status` events is the V2 source | `v2/stores.ts:createStatusCache` + `v2/event-bus.ts:statusCache.set` from `session.status` + derived from `session.idle/busy/execution.*` | Snapshot is in-memory, not persisted. |
| `PluginInput["directory"]` / `ctx.directory` / `worktree` | `query:{directory}` on todo/messages, `findNearestMessageWithFields` file path, `MESSAGE_STORAGE` base | `ctx.location.directory` (V2) | `v2/compat-client.ts` maps `directory` correctly | — |
| `PluginInput["client"].provider.list` / `model.list` / `app.agents` | Not used by enforcer (manager-level); but part of compat surface | `ctx.provider.list`, `ctx.model.list`, `ctx.agent.list` | `v2/compat-client.ts` | — |
| `PluginInput["client"].config.get` | Not used by enforcer | `ctx.config` (V2 config is `opencode.json` / `cli.json` unified) | — | — |
| `Plugin` lifecycle `server(input)` / `Plugin.define({setup})` | Enforcer is mounted by `createHooks({isHookEnabled, safeHookEnabled})` under `server`; V2 by `createV2Setup()`. | V2 `Plugin.define({id, setup(ctx): ()=> disposeFn})` → `createV2Setup` creates `registry/todos/statusCache/bus/managers/tools/hooks/bridge` and returns `disposeAll` | `v2-setup.ts` (full wiring) | Fork's honest skips (from `trial/CELL2B.md:§4` and `hook-bridge.ts` docs): **`chat.params`** — `model` is readonly in V2 `context` hook; bridge logs skip, never ports. **`tool.definition`** — V2 tool descriptions fixed at `tool.add` time; no `update-by-id`; bridge logs skip. **`command.execute.before`** — guards move into V2 command `execute` bodies. **`session.todo`** — no sink; KV workaround above. **`directory-agents-injector`** — auto-disabled on 2.0.15 (native agent support). **`nativeSkills`** — unavailable (no generated client). **`ctx.shell`** — only `{hook("create.before")}` exposed; `ctx_execute`-like surface unavailable. All apply to the self-build. |
| Dispatch internals (`prompt-async-gate`) | `dispatchInternalPrompt`, `semanticDedupe`, `promptQueue`, `recentDispatches`, `reservations`, `route-resolver`, `session-idle-dispatch` | No V2 `prompt-async-gate` package | `v2/prompt-gate.ts:createV2PromptGate` (fork's minimal V2 gate: `holdMs=2000`, dup hold + `outcome` check) | **Partial.** Fork's `v2/prompt-gate.ts` is NOT wired to the enforcer path (enforcer still uses `dispatchInternalPrompt` via utils). On V2-native, replace with `createV2PromptGate(session).dispatch({sessionID,text,delivery:"queue"})` or inline dedupe. Queue/drain and semantic dedupe are not available on V2. |
| Storage primitives | `ctx.storage.get/set/remove/scan` (KV) | Same (`Plugin.Context["storage"]`) | `v2/stores.ts` | Scan is paginated (`limit 100`, `after` cursor) — callers must loop. |

### 4.1 Event Translation (hook-bridge `registerEventBridge` — what V2 actually fans out today)

| V2 `event.type` | V2 `data` shape | V1 `event` synthesized | Handled by enforcer? |
|-----------------|----------------|------------------------|---------------------|
| `session.created` | `{sessionID,id,projectID,directory,...}` | `session.created {info:{id,projectID,directory,title,version,time}}` | No |
| `session.deleted` | `{sessionID/id}` | `session.deleted {info:{id,...}}` | Yes — cleanup |
| `session.idle` | `{sessionID}` | `session.idle {sessionID}` | **Yes — primary trigger** |
| `session.status` | `{sessionID, status:{type:"idle"|"busy"|"retry"}}` | `session.status {sessionID, status}` | Not directly, but `handler.ts` comment says V1 synthesized idle from it; on V2 use `session.idle` directly |
| `session.execution.failed` | `{sessionID, error}` | `session.error {sessionID, error}` | Yes — abort/token/unrecoverable classification |
| `permission.asked` | `{sessionID, ...}` | `permission.asked` | No |
| _(no V2 event)_ | — | `session.compacted` | **MISSING** — gap noted above |
| _(no V2 event)_ | — | `message.updated` / `part.updated/delta` | **MISSING from bus** — these come from `session.context` diff, not V2 events; on V2 they route through `tool.execute` hooks observation or `session.context` polling — the enforcer's `non-idle-events` handler would be starved on pure V2 unless bridged. The fork's V1 path relies on V1's `event` hook delivering `message.*`; V2 `hook-bridge` currently subscribes only the 6 types listed. |
| _(no V2 event)_ | — | `tool.execute.before/after` | Routed via `registerToolHooks(tool)` on `ctx.tool`, not the event bus |

This table is the most important part of §4 for planning: the **two missing event sources on V2** (`message.*` and `session.compacted`) mean the fork's enforcer is currently running on V1 events even when mounted on V2 setup. A V2-native port must decide to either extend the bus or poll `session.context` — see §6 open questions.

---

## 5. Minimal Self-Build MVP vs Full Parity

### 5.1 MVP — "detect incomplete todos + nudge/continue" (shippable without reading the fork)

**Goal:** From `session.idle`, if todos remain incomplete, post one queued continuation prompt; nothing else.

**Scope — 4 files, ~120 LOC + stores:**

1. **`stores/todoStore.ts`** (from `v2/stores.ts:createTodoStore` — 15 lines): KV `omo-v2:todos:<id>` on `ctx.storage` (`get/set/scan`). Companion: wire every todo mutation (your `todo_write` tool or equivalent) to `todos.set`.
2. **`todo.ts`** (`getIncompleteCount` — 5 lines): same predicate (`≠ completed/cancelled/blocked/deleted`).
3. **`constants.ts`** (subset): `HOOK_NAME`, `CONTINUATION_PROMPT` (copy value §3.1), `CONTINUATION_COOLDOWN_MS=5000`, `COUNTDOWN_SECONDS=2` (or 0 for immediate MVP).
4. **`enforcer.ts`** (single module, no split):
   - `inMemory: Map<string,{lastInjectedAt?: number, timer?: handle}>` with TTL prune (or none for MVP).
   - `setup(ctx):` register `ctx.event.subscribe` for `session.idle` **and** derive idle from `session.status` idle (whichever arrives first).
   - `onIdle(sessionID)`:
     ```
     todos = await todosStore.get(sessionID)
     if empty → return
     if getIncompleteCount(todos)===0 → return
     if lastInjectedAt && now - lastInjectedAt < 5000 → return
     // optional: fetch session.context to read last agent; if agent in ["compaction","plan"] skip (hardcode 2)
     text = CONTINUATION_PROMPT + status line + remaining list
     await ctx.session.prompt({sessionID, text, delivery:"queue"})
     lastInjectedAt = now
     ```
   - No countdown timer required for MVP (dispatch immediately). If toast desired, `log` instead.
   - No `skipAgents` config, no `stagnation`, no `abort`/`token`/`compaction` guards — they can be omitted and the core loop remains correct for sunny path.

**What MVP delivers:** Correct todo detection, single continuation prompt with cooldown, no duplicate within 5s, no prompt when todos done. Covers 70% of user-visible value.

**What MVP drops (acceptable):** Exponential backoff, compaction guard, pending-question gate, abort/token/unrecoverable stops, stagnation stop, write-permission gate, synthetic-message filtering, background-task stall, pending parent wake, variant/model preservation, `allTodosCompletedAt` persistence, inFlight dedupe beyond timestamp.

### 5.2 Full Parity — every guard the fork enforces

Add iteratively; each adds one file/logical concern (the fork's split is the right decomposition):

| Order | Add | File / Logic | Why (bug it fixes) |
|-------|-----|--------------|-------------------|
| 1 | Cooldown backoff + max failures | `session-state` `consecutiveFailures` + `FAILURE_RESET_WINDOW_MS` | Prevents retry storm on flaky provider |
| 2 | Abort detection (event + API fallback) | `abort-detection` + `handler session.error` branch | User cancelled run — must not auto-resume |
| 3 | Token / unrecoverable stops | `token-limit-detection` + `unrecoverable-request-error` | Context overflow / Anthropic 400 wedge — retry worsens it |
| 4 | Countdown + toast (+ grace period) | `countdown` + `COUNTDOWN_GRACE_PERIOD_MS` | Lets user interrupt before dispatch; 2s UX |
| 5 | `inFlight` / semantic dedupe | `continuation-injection` dedupe + `promptGate` | Prevents duplicate during countdown |
| 6 | `skipAgents` + `isContinuationStopped` + write-permission | `continuation-injection` agent resolution | Planner/compaction safety; `stop-continuation` kill switch; read-only agent |
| 7 | `allTodosCompletedAt` + `resetContinuationProgress` | `session-state` | Avoids re-nudging completed work |
| 8 | Compaction guard | `compaction-guard` + `session.compacted` (or V2 workaround §4.1) | Prevents injection on stale/compacted context |
| 9 | Pending question detection | `pending-question-detection` | Don't interrupt a question awaiting user answer |
| 10 | `latestAssistantTurnBlocksInternalPrompt` gate | Check `messages` via shared util | Don't stack continuations while one's reply pending |
| 11 | Stagnation detection | `stagnation-detection` + `trackContinuationProgress` snapshots | Agent not making progress (3* no-change → stop) |
| 12 | `pendingUserMessageID` deferred classification + synthetic filter | `non-idle-events` + `internal-initiator-marker` | Correctly distinguishes real user interruption from synthetic continuation text |
| 13 | Background tasks + parent wake race | `idle-event` `backgroundManager` checks + `handedBackSyncSessions` | Don't inject while subagents still running or parent wake pending |
| 14 | `variant`/`model`/`tools` preservation + messaging dir fallback (`findNearestMessageWithFields`) | `resolve-message-info` + `message-directory` | Continuation inherits correct model/agent/tools; compaction post-fork agent identity |
| 15 | Durable enforcer state across restart | `omo-v2:enforcer:<id>` on `ctx.storage` (NEW — does not exist in fork) | Optional; recovers stagnation/cooldown state after `opencode` restart |

Each row is one PR-sized increment. The fork's file-per-concern layout is worth keeping at full parity — it maps directly to this order.

---

## 6. Open Questions Blocking Implementation

| # | Question | Why blocking | Evidence needed | Proposed resolution for MVP |
|---|----------|--------------|-----------------|-----------------------------|
| 1 | **V2 has no `session.compacted` event — how does a V2-native enforcer arm `compaction-guard`?** | Without it, injection after compaction has no agent context and wedges (`isCompactionGuardActive` never arms). Fork's bridge drops this event entirely. | Log whether V2 emits any synthetic `session.compacted` or `session.context` delta on compact; or inspect `session.context` length drop across `session.status busy→idle`. | MVP: skip guard entirely (accept rare wedge). Full parity: synthesize from `session.status` transition + `session.context` size regression (poll context pre/post compact). |
| 2 | **V2 has no `message.updated/part.updated/delta` events on `event.subscribe` — how does `non-idle-events` stay fed?** | `handleNonIdleEvent` cancels countdowns on any user/assistant/tool activity; starved of those events, countdowns never cancel and inject after user already resumed typing. | In-trial probe: `ctx.event.subscribe` traffic log during one real prompt (see `trial/CELL2B.md:§7` cheap follow-up: one minimal prompt + `grep` both logs for hook firing). | MVP: skip auto-cancel (only idle trigger); accept late inject race. Full parity: extend `hook-bridge` to subscribe synthesized message events or poll `session.context` at countdown expiry. |
| 3 | **V2 `session.context` shape for `info.error.name` / `info.agent` / `info.tools` — does `toV1MessageViews` cover it?** | `abort-detection` & `resolveLatestMessageInfo` rely on those fields; if V2 `context` flattens them elsewhere, detection silently fails. | One `v2.session.context` dump in trial (with a cancelled turn) + mapping diff against adapter. | Until verified, dual-classify: check both `info.error.name` and top-level `error.name` on `context` items. |
| 4 | **V2 `ctx.storage` durability + prefix isolation — do `omo-v2:todos:<id>` and `omo-v2:session:<id>` survive `opencode` restart and domain overlay recreate?** | Todo KV is the only durable todo store on V2. If volume is ephemeral, todos vanish and enforcer becomes a no-op. | Restart `ai-engkit-v2` once and `ctx.storage.get("omo-v2:todos:<known>")` round-trip (follow-up in `trial/CELL2B.md:§6` suggested cold-start test). | Treat as durable (fork assumes so; `opencode` docs confirm storage is host-backed). If not, add SQLite fallback read. |
| 5 | **V2 plugin file asset path — where does `skills/` / `continuation prompt` template live so `CONTINUATION_PROMPT` is discoverable?** | `trial/CELL2B.md:§3 T1` proves V2 loads plugin file from first discovery — assets must be staged alongside bundle at `skills/...` relative to bundle path. | Reuse T1 fix: stage `skills/` next to built plugin bundle (symlink or copy) before first discovery; use new filename after any failed load (T2 cache). | For todo-only enforcer, no skill assets needed — `CONTINUATION_PROMPT` is inline constant. |
| 6 | **V2 early-load `session.prompt` semantics — does `delivery:"queue"` plus `holdMs` dedupe compose correctly, or does the server reject second queue while first still settling?** | Fork's `dispatchInternalPrompt` added `settleMs`, `queueBehavior:"defer"`, `semanticDedupeHoldMs` to repair races. Raw `ctx.session.prompt({delivery:"queue"})` may race with `session.idle` re-emit. | One trial with two rapid `session.idle` events — observe whether second prompt is queued or rejected (`seen.ref`-like error from `trial/CELL2B.md:§7 DEFECT 1`). | MVP: accept duplicate-queue risk; set 5s `lastInjectedAt` cooldown as client-side mutex. Full parity: port fork's `v2/prompt-gate.ts:createV2PromptGate` (hold map + `session.get outcome` guard) as client-side gate. |
| 7 | **Status enum mapping — do V1 `blocked`/`deleted` todos need explicit mapping when persisted to V2 `V2TodoItem`?** | `V2TodoItem.status` type in fork's compat only allows `pending|in_progress|completed|cancelled`. Persisting `blocked` would corrupt `asTodoList` validation (returns `undefined` ⇒ `[]` ⇒ enforcer thinks no todos). | Try `todos.set` with `blocked` — observe whether `todos.get` strips or keeps it. | Map `blocked→pending`, `deleted→omit` at write time (pre-store normalization). |
| 8 | **V2 tool name identity contract — does the fork's `Invalid tool definition: undefined is not an object (evaluating 'seen.ref')` (DEFECT 1, `trial/CELL2B.md:§7`) affect `prompt({tools})` inherited call?** | If V2 validates `tools` with the same `seen.ref` contract, then `inheritedTools` passed through to continuation prompt could cause server rejection, turning every injection into a silent failure counted as `consecutiveFailures`. | Trial injection with `tools:inheritedTools` vs `tools:undefined` — observe success/failure. | MVP: omit `tools` forwarding (no `inheritedTools`). Continuation will run with target agent's default toolset — sufficient for todo continuation. |

---

*Generated from read-only inspection of `/tmp/omo-v2-fork/packages/omo-opencode/src/hooks/todo-continuation-enforcer/*` and `/tmp/omo-v2-fork/packages/omo-opencode/src/v2/*` on branch `Hallaxius/feat/opencode-v2-runtime` (commit `aada48e`) under `trial/opencode-v2` on `2026-09-29`. No provider inference was invoked; all behaviors are reconstructed from source and test harnesses. File path: `trial/TODO-SPEC.md`.*

## Top 3 Spec Uncertainties

1. **Event surface gap (Q1+Q2 above):** `hook-bridge.ts` on V2 currently forwards only `session.created/deleted/idle/status/execution.failed/permission.asked`; neither `session.compacted` nor `message.updated/part.*` is bridged, so the enforcer's guard/cancel machinery starves on pure V2 and requires either a bridge extension or a `session.context`-poll workaround before full parity can be verified.

2. **Storage as sole todo source (Q4+Q7):** the self-build's todo state depends entirely on `ctx.storage` KV `omo-v2:todos:<id>` with a narrowed status enum; durability across restart and the `blocked→pending` / `deleted→omit` mapping are assumed but have no witnessed read-back in this container.

3. **Injection dedupe vs V2 queue (Q6+Q8):** `dispatchInternalPrompt`'s semantic dedupe / queue-drain / `seen.ref` contract does not map 1:1 to raw `ctx.session.prompt({delivery:"queue"})`; without the fork's gate or a hold-map reimplementation, rapid double-idle can either double-queue or be rejected server-side, and `tools` forwarding may trigger the same `seen.ref` rejection that voided all fork tools in `CELL2B.md:§7`.

## Verification Addendum (2026-09-29, zero-quota probes)

- **Q4 durability — mechanism confirmed.** `~/.local/share/opencode/storage/` exists in-trial and lives on the `opencode-data-v2` named volume → survives container restart/recreate by construction. Remaining (live read-back of `omo-v2:todos:<id>`) still needs a session, but there is no durability cliff.
- **Q7 mapping — confirmed necessary, not optional.** `asTodoList` (`v2/stores.ts:22`) returns `undefined` for the *entire list* if *any* entry carries a status outside `{pending,in_progress,completed,cancelled}`, and the caller falls back to `?? []` ("no todos" → `resetContinuationProgress`). A single `blocked` entry therefore blinds the enforcer, exactly as speculated. The spec's pre-store normalization (`blocked→pending`, `deleted→omit`) is required in the MVP, not a full-parity nicety.

