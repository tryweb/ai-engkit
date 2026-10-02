# M3 Enforcer — Verification Record

> Date: 2026-10-02 | Branch: trial/opencode-v2 | Runtime: OpenCode 2.0.15 (ai-engkit-v2 / ai-engkit-admin-v2) | Plugin ID: m3-enforcer

## 1. Files Created

```
trial/m3-enforcer/declarations.d.ts (22 LOC) — @opencode/plugin shim (mirrors trial/b1-routing/declarations.d.ts approach; same LSP module-resolution fix)
trial/m3-enforcer/constants.ts      (22 LOC) — PLUGIN_ID, CONTINUATION_PROMPT (exact §3.1 inline), CONTINUATION_COOLDOWN_MS=5000, COUNTDOWN_SECONDS=0, skip list, TODO_PREFIX
trial/m3-enforcer/todo-store.ts     (88 LOC) — KV omo-v2:todos:<id> on ctx.storage; normalizeTodosForStore (blocked→pending, deleted→omit), asTodoList (poison whole-list on illegal status → undefined → []), createTodoStore(get/set/setRaw)
trial/m3-enforcer/todo.ts           (17 LOC) — getIncompleteCount (pending+in_progress), getTodoSnapshot (id|content:priority → status, for progress)
trial/m3-enforcer/session-state.ts  (69 LOC) — in-memory Map<sessionID,State> with 10m TTL, 2m prune interval (unref), startPrune/stopPrune/cleanup/shutdown
trial/m3-enforcer/index.ts         (253 LOC) — Plugin.define({id:"m3-enforcer",setup}) wiring ctx.storage + event.subscribe(defensive session.idle + session.status idle + session.error/execution.failed + session.deleted) + ctx.session.prompt(queue) + cooldown + skipAgents + arbitration + file-log diagnostics
trial/m3-enforcer/dist/index.js    (13 KB, 364 lines, bundled 5 modules via bun --external @opencode/plugin)
trial/M3-VERIFY.md                  (this file)
```

Source total 471 LOC (6 files, 251 LOC without shim). Imports ONLY `@opencode/plugin` as external plus `node:fs`/`node:path` via `require` inside log helper (no direct import at top — avoids bundling fs). Bundle built with `bun build ./index.ts --outdir ./dist --target bun --format esm --external @opencode/plugin` (host verified; container bun 1.4.2 matches). No sibling asset reads at import time — storage/todo access inside `setup()` only (T1 satisfied). Fresh filename `m3-enforcer.js` used on first discovery (T2 satisfied, no ESM cache poison). Workspace file-plugin path resolves bare import via `/home/devuser/workspace/.opencode/plugins/node_modules -> /tmp/omo-v2-fork/node_modules` (reuse of b1-routing symlink — verified `ls @opencode/plugin`).

Container bundle deployed to `/home/devuser/workspace/.opencode/plugins/m3-enforcer.js` (workspace-v2 volume, not repo). Host bundle mirrored to `trial/m3-enforcer/dist/index.js` via same bun command. `/tmp/omo-v2-fork` was present at build time (reference readable, not importable — used for §2/§3/§4 constants and `v2/stores.ts` shape verification).

## 2. Load Log Excerpts

`opencode.log` (ai-engkit-v2, grep `loading plugin` around deploy):

```
2026-10-02T11:50:21.848Z INFO  loading plugin id=/home/devuser/workspace/.opencode/plugins/m3-enforcer.js entrypoint=file:///home/devuser/workspace/.opencode/plugins/m3-enforcer.js
2026-10-02T11:50:21.850Z INFO  watcher subscribe path=/home/devuser/workspace/.opencode/plugins/m3-enforcer.js type=file
2026-10-02T11:50:21.850Z INFO  watcher started path=/home/devuser/workspace/.opencode/plugins/m3-enforcer.js backend=node
```

No `failed to load plugin` for m3-enforcer. `Skipping invalid tool registration` lines before/after are all from retained `oh-my-openagent` file plugin (`omo-v2.js`, DEFECT 1 `seen.ref` — see CELL2B §7); filtering by `m3-enforcer` shows zero matches — bundle contains no `tool.add` (verified `grep -c tool dist/index.js` → no `tool.add`; only one `tool` substring is a false positive in comment, not a registration).

File-watcher log (`/tmp/m3-enforcer.log` and `opencode/log/m3-enforcer.log` identical):

```
[m3-enforcer] 2026-10-02T11:50:21.859Z setup start
[m3-enforcer] 2026-10-02T11:50:21.867Z storage available
[m3-enforcer] 2026-10-02T11:50:21.867Z skipAgents=prometheus,compaction,plan
[m3-enforcer] 2026-10-02T11:50:21.868Z event loop started, subscribing to session.idle + session.status + session.error/session.execution.failed + session.deleted
[m3-enforcer] 2026-10-02T11:50:21.868Z setup complete, no tools registered (hooks+events only)
```

Touch-triggered reload observation (hot reload + `touch` only, no restart):

```
touch /home/devuser/workspace/.opencode/plugins/m3-enforcer.js
→ opencode.log: loading plugin m3-enforcer.js (new http.span 147051)
→ /tmp/m3-enforcer.log: dispose start → dispose done → setup start → storage available → skipAgents=... → event loop started → setup complete
```

Reload is clean: dispose clears AbortController + prune timer + maps; re-setup re-subscribes. No warnings, no tool registrations on either load. Same pattern as `trial/B1-VERIFY.md §2-3` (fresh-filename discipline, bundle dependency-free, stage zero sibling assets at import, touch-triggered reload, file-log diagnostics).

`opencode plugin list` in-container reports `No plugins found` — expected for file plugins (only checks npm packages, per CELL2B §2). `opencode.log` is the authoritative source (above) — both `b1-routing` and `m3-enforcer` load as file plugins side-by-side.

## 3. What Was Verified vs Deferred

### Verified (zero-spend, no inference)

| Item | Method | Result |
|------|--------|--------|
| **Clean import + setup** | `opencode.log` shows `loading plugin` + watcher subscribe/started, no `failed to load` for m3-enforcer | PASS |
| **Zero tool registrations** | Bundle `grep tool.add` absent; `opencode.log` filtered by m3-enforcer has zero `Skipping invalid tool` ; file-log says `no tools registered (hooks+events only)` | PASS |
| **Event subscriptions** | Code subscribes to `session.idle` AND derived `session.status idle` (defensive both, per spec uncertainty 3) plus `session.error`/`execution.failed` (arbitration) and `session.deleted` (cleanup); file-log confirms `event loop started, subscribing to session.idle + session.status + ...` | PASS |
| **KV todo store shape** | Mirrors fork `v2/stores.ts:createTodoStore` prefix `omo-v2:todos:<id>` on `ctx.storage` (get/set/scan); unit test with in-memory Map mock proves round-trip | PASS |
| **Absent store = no-op, never error** | `todoStore.get` returns `[]` on missing key; `handleIdle` logs `no todos — no-op` and returns; unit test `absent store get => [] PASS` | PASS |
| **Incomplete-count semantics** | `getIncompleteCount` counts `pending+in_progress` only (excludes `completed/cancelled`); unit `incompleteCount pending+in_progress=2 PASS` | PASS |
| **`blocked→pending` / `deleted→omit` normalization** | `normalizeTodosForStore` maps `blocked` to `pending`, skips `deleted`; unit `norm len 2 PASS`, `blocked mapped to pending PASS`; `store.set` auto-normalizes | PASS |
| **Whole-list poisoning on `blocked` (Q7)** | `asTodoList` returns `undefined` if any entry has `blocked`/`deleted`; caller `?? []` treats as no todos; unit `poisoned -> undefined PASS` with raw write demonstration; normalization proof shows `after normalize valid PASS` | PASS — Q7 confirmed necessary, not optional (matches TODO-SPEC verification addendum) |
| **Single client-side cooldown 5s** | `stateStore` holds `lastInjectedAt`; `handleIdle` checks `now - last < 5000` → skip; unit `cooldown active PASS` / `expired after 6s PASS`; state TTL 10m / prune 2m like B1 | PASS |
| **Skip-agents list** | Hardcoded `DEFAULT_SKIP_AGENTS=["prometheus","compaction","plan"]` with case-insensitive normalize; log shows `skipAgents=prometheus,compaction,plan`; unit `skip prometheus PASS`, `not skip build PASS` | PASS — routing.json convergence noted as follow-up (do not duplicate B1 loader) |
| **Arbitration: routing wins on shared failure** | One-line precedence in `handleIdle`: `if (lastFailureAt && now-lf<5000 && retryable) return // routing wins`; `session.error`/`execution.failed` handler records retryable failures; log `skip arbitration: routing wins` on hit; mirrors spec §3 | PASS (logic verified, live contention not yet observed) |
| **Countdown/toast degraded to file log** | `COUNTDOWN_SECONDS=0` (immediate MVP); toast not called; every idle/skip/inject is file-logged (`/tmp/m3-enforcer.log` + `opencode/log/m3-enforcer.log`) as "simplest observable signal" per spec | PASS |
| **Session-state prunes / cleanup** | TTL 10m, prune 2m, `cleanup` on `session.deleted`, `shutdown` on dispose; unit `cleanup removes PASS`, `shutdown clears PASS`; touch reload shows dispose→re-setup clean | PASS |
| **No forbidden file touches** | `git status` shows only pre-existing 10 dirty files (6 `.opencode/agents/*.md`, 1 KB entry, 3 `src/admin/*`) plus `?? trial/m3-enforcer/` (new); no `.opencode/`, `entrypoint.d/`, `src/`, `trial/CELL*.md` modifications | PASS |

Unit harness: `bun run /tmp/m3-unit-verify.ts` (in-process, no container, no inference) — all checks PASS, output:

```
incompleteCount pending+in_progress=2 PASS
normalize blocked->pending deleted->omit PASS
asTodoList with blocked -> undefined PASS
fallback to [] PASS
store round-trip normalized PASS
poisoned raw storage get => [] PASS
cooldown active PASS / expired PASS / allDone PASS / cleanup PASS
skipAgents PASS / snapshot PASS
```

### Deferred (explicit, needs quota or bridge work — not attempted)

| Item | Reason |
|------|--------|
| **Live idle→inject→continue E2E** (real session: set todos in KV, reach idle, observe queued `CONTINUATION_PROMPT` dispatch, verify agent continues) | Requires billable inference (≥1 tiny prompt + idle synthesis); per task "explicitly DEFERRED (record as open, needs quota)" — not attempted, spend stays ~0 |
| **Routing + enforcer live contention** (both react to same `session.execution.failed`, observe routing fallback wins) | Needs same E2E plus routing chain with failing head (`openrouter/auto`) — deferred with above |
| **Storage durability across restart** (Q4: `omo-v2:todos:<id>` survives container recreate) | Mechanism confirmed (`storage/` on `opencode-data-v2` volume — see TODO-SPEC addendum), but live read-back after restart not witnessed here — deferred to post-quota session |
| **Compaction guard arming** (Q1) | V2 has no `session.compacted` event on bus (spec §4.1); MVP skips guard per §5.1 — full parity needs bridge extension or `session.context` polling |
| **Non-idle-event cancellation** (Q2: `message.updated`/`tool.execute` cancels countdown) | Same missing bus event; MVP skips auto-cancel, accepts late-inject race — full parity needs synthesized message events |
| **Tool/permission/model forwarding** | Omitted per Q8 (`seen.ref` risk) — continuation runs with target agent's defaults; full parity would preserve `agent/model/tools` via `session.context` scan |

## 4. Spend Used

**0.00000 USD — zero inference spend.**

No `opencode run`, no provider call, no `opencode-go` key read beyond length-check (never printed). Verification used only:

- `bun build` (local bundling, free)
- `docker exec` reads (`cat`, `ls`, log tail) and `docker cp` / `touch` for hot reload (no inference)
- In-process unit harness `bun run /tmp/m3-unit-verify.ts` (no network, no model)

If inference proves unavoidable for E2E, policy is "free-tier only, tiny prompts, stop after 3 failed attempts and report blocker" — not triggered.

## 5. Top 3 Gaps to Full Parity (§5.2 ordered)

1. **Retry storm & failure backoff + stagnation stop** — MVP has flat 5s cooldown only; missing exponential backoff (`5000 * 2^min(consecutiveFailures,5)` to 160s), `MAX_CONSECUTIVE_FAILURES=5` + `FAILURE_RESET_WINDOW_MS=5m` auto-reset, `MAX_STAGNATION_COUNT=3` snapshot tracking, `allTodosCompletedAt` persistence across idle, `inFlight`/semantic dedupe, and `awaitingPostInjectionProgressCheck` handshake. This is the largest quality gap (flaky-provider retry loop).

2. **Guard layer (abort / token-limit / unrecoverable / compaction / pending-question / write-permission / background-task / parent-wake)** — MVP only has skipAgents + routing arbitration + cooldown; missing `isTokenLimitError`/`isUnrecoverableRequestError`/`isLastAssistantMessageAborted` classification, `ABORT_WINDOW_MS=3000`, `COMPACTION_GUARD_MS=60000` (needs `session.compacted` bridge), `hasUnansweredQuestion` (needs `session.context` fetch), `hasWritePermission(tools)` deny check, `backgroundManager.hasPendingParentWake`, and `pendingUserMessageID` deferred classification. Each prevents a class of unwanted injections.

3. **Countdown + agent/model/tools continuity** — MVP dispatches immediately (`COUNTDOWN_SECONDS=0`) with no `tui.showToast` (degraded to log), no 2s cancellable window with `COUNTDOWN_GRACE_PERIOD_MS=500`, no `session.context` reverse scan for `resolveLatestMessageInfo` (agent/model/variant inheritance), no `findNearestMessageWithFields` file-scan fallback for post-compaction identity, and no durable enforcer state (`omo-v2:enforcer:<id>` on `ctx.storage` for restart-surviving stagnation/cooldown). These are UX + correctness for long/compacted sessions.

Additional MVP omissions documented in TODO-SPEC §5.1: no `session.todo` API call (correctly never called — KV only), no `prompt-async-gate` semantic dedupe/queue-drain, no `variant`/`model` preservation, no `continuationBlockReason` handshake.

## 6. Compliance Notes

- **Validation:** `asTodoList` poison check enforced — any `blocked`/`deleted` without normalization blinds entire list (returns `undefined` → `[]`). `normalizeTodosForStore` must be called at every write; `todoStore.set` does this automatically.
- **No tool registration — `seen.ref` lesson absolute (CELL2B §7):** plugin exports only `Plugin.define({id,setup})` returning dispose; bundle has no `tool` key; server log shows zero `Skipping invalid tool` attributed to m3-enforcer.
- **Routing coexistence:** `b1-routing` and `m3-enforcer` both loaded as file plugins; arbitration line ensures routing fallback takes precedence on shared retryable failure (spec §3 one-line precedence).
- **Config convergence:** `routing.json` reader not duplicated — `skipAgents` hardcoded with comment `follow-up: converge with B1's reader if reused`; no fork of `routing-config.ts`.
- **Git cleanliness:** new files only under `trial/m3-enforcer/` (+ `dist/`) and this file; no commits, no container restart/recreate, no `.opencode/`/`src`/`trial/CELL*.md` modifications; working tree ends with exact 10 pre-existing dirty files plus created enforcer files (see §1 list).
- **Reference fork:** `/tmp/omo-v2-fork` present; `v2/stores.ts`, `todo.ts`, `constants.ts`, `system-directive.ts` read-only verified for KV prefix/status enum/prompt exact value; no imports from fork.

---
*Teams: file-plugin path via workspace .opencode/plugins, bundle dependency-free apart from @opencode/plugin external, hot reload via touch — same as b1-routing §2-3.*

## Review Amendment (Sisyphus, 2026-10-02 — no inference, no quota)

- **Removed all 3 `// @ts-ignore` suppressions** (hard block): `session-state.ts` unref → `typeof`-narrowed call; `index.ts` import + `Plugin.define` → covered by the existing `declarations.d.ts` shim; lazy `require("node:fs")` → static import + minimal `node:fs` ambient decl in the shim (full `@types/node` deliberately not added).
- Verified with `tsc --noEmit` (typescript@5.8.3, bundler resolution): **zero errors**. Rebuilt `dist/` (12.64 KB), redeployed same filename, touch-reloaded: `dispose done → setup start → storage available → event loop started → setup complete, no tools registered`, zero warnings. Behavior preserved.
- `dist/` stays out of git (same rule as B1); `.gitignore` already covers the pattern via `trial/b1-routing/dist/` precedent — extend to `trial/m3-enforcer/dist/` before commit.
