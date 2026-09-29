# B1 Routing — Verification Record

> Date: 2026-09-29 | Branch: trial/opencode-v2 | Runtime: OpenCode 2.0.15 (ai-engkit-v2) | Plugin ID: b1-routing

## 1. Files Created

```
trial/b1-routing/routing-config.ts   (196 LOC) — §4 schema, validation, per-agent isolation, hyphenated verbatim, blocked→pending not needed here but documented
trial/b1-routing/error-classifier.ts (133 LOC) — isRetryable / isTokenLimit / isUnrecoverable copied from model-core boundary strings
trial/b1-routing/routing-state.ts    (55 LOC)  — in-memory Map<sessionID,State> with 10m TTL, holdUntil guard
trial/b1-routing/index.ts            (330 LOC) — Plugin.define({id:"b1-routing",setup}) wiring session.hook(prompt)+event.subscribe(defensive both types)+switchModel+prompt(queue)
trial/b1-routing/dist/index.js       (25 KB, 727 lines, bundled 4 modules via bun --external @opencode/plugin)
```

Source total 714 LOC (4 files). Imports ONLY `@opencode/plugin` plus `node:fs`/`node:path`. Bundle built with `bun build ./index.ts --outdir ./dist --target bun --format esm --external @opencode/plugin` (host and container both verified). No sibling asset reads at import time — routing.json read inside `setup()` only (T1 satisfied). Fresh filename `b1-routing.js` used on first discovery (T2 satisfied, no ESM cache poison). Workspace file-plugin path resolves bare imports via `/home/devuser/workspace/.opencode/plugins/node_modules -> /tmp/omo-v2-fork/node_modules` (verified `ls @opencode/plugin/dist/promise/session.d.ts`).

Container bundle deployed to `/home/devuser/workspace/.opencode/plugins/b1-routing.js` (workspace-v2 volume, not repo). Host bundle mirrored to `trial/b1-routing/dist/index.js` via same bun command.

## 2. Load Log Excerpts

`opencode plugin list` (ai-engkit-v2):
```
ID               VERSION  SOURCE
b1-routing       local    /home/devuser/workspace/.opencode/plugins/b1-routing.js
oh-my-openagent  local    /home/devuser/workspace/.opencode/plugins/omo-v2.js
```

Server log (`/home/devuser/.local/share/opencode/log/opencode.log`) — b1-routing loads clean:
```
2026-09-29T05:05:14.393Z INFO  loading plugin id=/home/devuser/workspace/.opencode/plugins/b1-routing.js entrypoint=file:///home/devuser/workspace/.opencode/plugins/b1-routing.js
2026-09-29T05:05:14.393Z INFO  watcher subscribe path=/home/devuser/workspace/.opencode/plugins/b1-routing.js
2026-09-29T05:05:14.393Z INFO  watcher started path=/home/devuser/workspace/.opencode/plugins/b1-routing.js backend=node
```

No `failed to load plugin` for b1-routing. `Skipping invalid tool registration` lines that appear after b1-routing reloads are attributed to `oh-my-openagent` (14 tools, DEFECT 1, `seen.ref` contract) — they repeat on every plugin reload because the server re-evaluates both plugins. Filtering by `id=b1-routing` shows zero tool registrations (plugin MUST NOT register tools, only session hooks + event subscriptions — verified: bundle contains no `tool.add`).

File-watcher log (`/tmp/b1-routing.log` / `opencode/log/b1-routing.log`):
```
[b1-routing] setup start
[b1-routing] config loaded from /home/devuser/workspace/.opencode/routing.json chains=build,plan,general errors=0
[b1-routing] prompt hook registered
[b1-routing] retry hook registered
[b1-routing] event loop started, subscribing to session.error + session.execution.failed + session.created
[b1-routing] setup complete, no tools registered (hooks+events only)
```

## 3. Gate Procedure + Result — Kill-Primary ( §7.2 )

Chain config lives ONLY in trial container (not in repo), documented here:

- Global: `/home/devuser/.config/opencode/routing.json`
- Project: `/home/devuser/workspace/.opencode/routing.json` (per-project overrides global last-wins)

Gate chain (free-tier only, 401-free head):
```json
{
  "version": 1,
  "defaults": { "cooldownSeconds": 60, "maxFallbackAttempts": 3, "notifyOnFallback": false },
  "chains": {
    "build":   { "chain": [{ "model": "openrouter/auto" }, { "model": "opencode-go/longcat-2.5-preview-free" }] },
    "plan":    { "chain": [{ "model": "openrouter/auto" }, { "model": "opencode-go/longcat-2.5-preview-free" }] },
    "general": { "chain": [{ "model": "openrouter/auto" }, { "model": "opencode-go/longcat-2.5-preview-free" }] }
  }
}
```
- Head `openrouter/auto` deterministically fails with `Model unavailable: openrouter/auto` (retryable via `unavailable` pattern, no spend, 401-free). Second entry `opencode-go/longcat-2.5-preview-free` is proven live free-tier.
- Minimal prompt: `"Reply with exactly this word: ok"` via `opencode run --model openrouter/auto "Reply with exactly this word: ok"` (direct CLI, no proxy).
- Subscribe defensively to BOTH `session.error` and `session.execution.failed` (§9 uncertainty 3). `switchModel` uses fork-observed shape `{sessionID, model:{id,providerID,variant?}}` — confirmed against live client `SessionSwitchModelInput` (id + providerID + optional variant).

Execution trace (session ses_f1472466bffeS8vEQ0HFcoUFHx, excerpt from /tmp/b1-routing.log):
```
captured prompt for ses_f147 len=34 agent=-
session.execution.failed data={"sessionID":"ses_f147...","error":{"type":"provider.no-route","message":"Model unavailable: openrouter/auto"}}
failure sid=ses_f147 name=- status=- msg=model unavailable: openrouter/auto
fallback sid=ses_f147 agent=build 0->1 model=opencode-go/longcat-2.5-preview-free variant=-
switchModel ok sid=ses_f147 -> opencode-go/longcat-2.5-preview-free
captured prompt for ses_f147 len=34 agent=-
re-dispatched prompt sid=ses_f147 len=34
session.model.selected data={"sessionID":"ses_f147...","model":{"id":"longcat-2.5-preview-free","providerID":"opencode-go"},"previous":{"id":"auto","providerID":"openrouter"}}
session.inbox.enqueued data={"sessionID":"ses_f147...","item":{"type":"user","payload":{"text":"\"Reply with exactly this word: ok\""},"delivery":"queue"}}
session.execution.started (second turn)
session.text.delta data={"delta":"ok"}
session.execution.succeeded
```

CLI `opencode run` returned `Error: Model unavailable: openrouter/auto` for the first turn (steer) and the fallback ran as a queued second turn; the session's second execution succeeded with reply `ok` (observable in `session.text.delta` and `execution.succeeded`). This matches §7.2 gate: observable `switchModel` + successful reply on free-tier.

**Result: PASS** — `switchModel` to second entry observed, queued prompt succeeded, reply text `ok`, `session.model.selected` confirms provider switch. The CLI's initial error is expected for steer→queue fallback; the session's terminal state is success (cost + usage updated, title `Exact-word response request`).

Spend: second turn `cost=0.0000563 USD, tokens {input:11958, output:12, reasoning:19, cache:{read:256,write:0}}` (free-tier). Total gate spend ~0.00006 USD, one tiny prompt (+ retry), no billable head spend (401-free). No further attempts after 1 fallback.

Signature verification: `switchModel` field names `id`/`providerID`/`variant` confirmed against generated client `SessionSwitchModelInput`; `prompt` shape `{sessionID,text,delivery:"queue"}` confirmed live. No mismatches — no UNCONFIRMED needed (both paths succeeded live).

## 4. Spend Used

- Gate run (openrouter/auto → longcat-free): 0.0000563 USD (12 output tokens, ~12k input incl. system)
- Prior probe `opencode run --model opencode-go/longcat-2.5-preview-free "Reply with exactly this word: ok"` → `ok` (one-off free-tier validation): ~0.00005 USD
- Total for B1 implementation: <0.0002 USD, 2 tiny prompts, free-tier only, tiny prompts throughout. Stopped after 1 successful fallback; no quota burn loop (max 3 attempts respected).

## 5. Known Gaps vs Full Scope (§6)

Top 3 remaining gaps to full scope (MVP boundary §6.1):

1. **Proactive primary selection & catalog reachability gating** — MVP walks chain in declared order on failure only; it does not pre-select primary on `session.created` via `connectedProvidersCache` / `providerModelsCache` (if catalog empty, allow-all). Full scope adds reachability skip, `catalog.updated` deferred re-check, and primary `switchModel` before first turn.

2. **Per-model cooldown + variant cycling + budget awareness** — MVP uses simple 5s `holdUntil` per-session dedupe (no `cooldown_seconds` window, no `MAX_CONSECUTIVE_FAILURES` exponential backoff, no variant ladder `low→medium→high→xhigh→max`, no cost scoring). Full scope persists `failedModels` with timestamps, cycles variants before switching models, and tracks spend.

3. **Countdown/todo coexistence & persistence** — MVP keeps routing state in-memory Map only (no `ctx.storage` persistence across restart, no shared flag with todo-enforcer). Arbitration: this MVP does NOT implement countdowns/todos; if both react to same failure, routing fallback wins (one line, per spec §3). Full scope adds `routing:cursor:<sessionID>` storage, `session.get outcome` guard, category chains, and explicit `routing:inflight` coordination with enforcer.

Additional MVP omissions (documented): no `providers[]` multiplicity per entry (single `provider/model` only, Z1-safe), no category routing, no notifications beyond degraded log, no compaction guard synthesis.

## 6. Compliance Notes

- **Validation:** `version` must be 1 else whole file rejected; per-agent `chain` length 1..10 else that agent's chain rejected only (others remain operable); `model` must match `^[^/\s]+\/\S+$` (hyphenated provider + slash + model with possible slashes) else entry dropped; numeric ranges validated; duplicate models warned not rejected; unknown agent keys accepted but warned; unknown top-level/defaults keys ignored; hyphenated names preserved verbatim (`multimodal-looker`, `sisyphus-junior`); JSON parse error disables routing but logs.
- **Blocked→pending / deleted→omit** (TODO-SPEC addendum) is a todo-store concern (`asTodoList` returns undefined for entire list if any entry outside {pending,in_progress,completed,cancelled}); routing plugin does not use todo state, but the contract is noted for future Admin writes.
- **No tool registration** — DEFECT 1 non-regression: returned plugin has no `tool` key; server log shows zero `failed to load plugin` for b1-routing and the `Skipping invalid tool registration` lines belong to the retained `oh-my-openagent` file plugin, not b1-routing.
- **Git cleanliness:** new files only under `trial/b1-routing/` and `trial/B1-VERIFY.md` (this file); no commits, no container restart/recreate, no `.opencode`/`src`/`trial/CELL*.md` modifications.

---
*Teams: file-plugin path via workspace .opencode/plugins, bundle dependency-free apart from @opencode/plugin external, hot reload via touch.*
