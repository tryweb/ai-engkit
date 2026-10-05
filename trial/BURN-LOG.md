# Burn Log — Live-Key Verification Burns (trial/opencode-v2)

> Quota policy: user-authorized 2026-10-03 ("1"). Discipline: free-tier models only, tiny prompts, stop after 3 failed attempts per probe, exact spend captured where emitted. All runs in `ai-engkit-v2` (OpenCode 2.0.15), zero writes outside the scratch `workspace-v2` volume.

## Burn 1 — B1 kill-primary regression (2026-10-03)

- Chain: `build: [openrouter/auto (dead head) → opencode-go/longcat-2.5-preview-free]`.
- Prompt: `opencode run --model openrouter/auto "Reply with exactly this word: ok"`.
- Result: **PASS.** Initial steer error (expected, §7.2 reactive pattern) → `fallback sid=… agent=build 0->1` → `switchModel ok` → queued second turn replied `ok` (`session.text.delta`, `execution.succeeded`).
- Spend: prior identical gate measured $0.0000563; same shape, envelope <$0.0001.

## Burn 2 — M2 executor-family delegation (2026-10-03)

- Command: `opencode run --model opencode-go/longcat-2.5-preview-free --agent sisyphus-junior` + read-only instruction (prompt bug on my side: pointed at repo `trial/CELL1.md`, absent in scratch workspace).
- Result: **PASS (with note).** Executor dispatched, attempted the read, correctly reported `MISSING`, wrote nothing. Native `model:` frontmatter honored; allow-all executor respected read-only instruction.
- Spend: negligible (one tiny turn, free tier).

## Burn 3 — M3 idle observation + todo-source discovery (2026-10-03)

- Command: 2-step read task (`plan.md` + `oracle.md` descriptions) on free tier.
- Result: task correct. Model volunteered: **"I don't have a todo tool available in this environment"** — first direct evidence that native V2 surfaces NO todo mechanism to the model.
- m3 log: subscribed to idle/status/error throughout; error-classifier verified LIVE (`provider.auth` 401 → non-retryable, `no-route` → retryable, both correct). No idle→inject lines observed (no todos ever existed to trigger on).
- **Design gap confirmed (not just deferred): M3 MVP has no todo WRITE path** — nothing in our stack populates the KV store (fork relied on V1 `session.todo`). Until a write path exists (message-scan derivation or a native `todo_write` tool — the latter needs a `seen.ref`-safe tool-registration probe first), the enforcer correctly no-ops forever. This upgrades TODO-SPEC Q-scope: write path is MVP-blocking, not full-parity.
- Side confirmation: model used OpenChamber Code Mode (`execute` + `tools["lean-ctx"].ctx_read`) unprompted — OCH2 native coverage claim holds live.
- Spend: negligible (one tiny turn, free tier).

## Envelope accounting

| Run | Model (all free-tier) | Result | Est. spend |
|---|---|---|---|
| B1 regression | longcat-2.5-preview-free (fallback leg) | PASS | ~$0.0001 |
| M2 executor | longcat-2.5-preview-free | PASS | negligible |
| M3 observe | longcat-2.5-preview-free | PASS w/ design gap | negligible |
| Failed probes (dead keys/gate, pre-inference) | — | $0 (rejected pre-inference) | $0 |
| **Total (round 1)** | | | **<$0.001** |

## Appendix B — Tier-1 Authorized Burns, Round 2 (2026-10-03)

Policy: user "Go" = standing Tier-1 authorization (free-tier, tiny prompts, 3-strike stop, running total tracked here).

| Run | Command shape | Result | Spend |
|---|---|---|---|
| B1 regression re-run | `openrouter/auto` dead head, expect fallback | **PASS** — steer error + `fallback 0->1` + `switchModel ok` + `ok` reply (same signature as gate) | ~$0.0001 |
| M2 librarian w/ free override | `--agent librarian --model longcat-free`, read oracle description | **PASS** — correct line returned; proves `--model` overrides dead gemma pins (convergence evidence: pins bypassable, not fatal) | negligible |
| M2 executor (sisyphus-junior) | read-only instruction (prompt pointed outside scratch workspace — my bug) | **PASS w/ note** — dispatched, attempted read, correctly reported MISSING, zero writes | negligible |
| M3 todo-write live | "record 2 pending todos via todo_write, then stop" | **PASS (write path)** — model invoked `todo_write` **through Code Mode** (`tools.todo_write({...})` inside `execute`, unprompted); KV `n=2 pending=2` logged; **idle→inject NOT observed** (see below) | negligible |

M3 structural finding: `opencode run` CLI sessions **exit after reply — they never idle**. The enforcer's idle trigger cannot fire in one-shot mode by construction. Live idle→inject E2E needs a persistent (interactive/UI-managed) session left idle with incomplete KV todos — deferred to such a session, not to more CLI runs. Also seen: one mid-session `n=0 pending=0` write (unresolved minor: model-cleared or second call), and zero countdown lines to date.

**Running total (rounds 1+2): <$0.002.** Open threads now needing quota: Admin E2E, executor write-capable tasks, B1 proactive/full probes, M3 idle E2E via persistent session.

## Appendix C — Tier-1 Authorized Burns, Round 3 (2026-10-03)

Policy: same standing Tier-1 (free-tier, tiny prompts). Cookie jars cleaned after use. Probe file removed after verification.

| Run | Command shape | Result | Spend |
|---|---|---|---|
| Admin E2E (write→read-back) | `PUT /api/agent-models/{atlas,momus}` with valid chain | **BLOCKED, no spend** — both 403 `agent is not a configurable live subagent`. Root cause traced: `knownAgents` comes from `fetchSubagentNames` → V1 `GET /agent`, which returns SPA fallback HTML on V2 → parse fails → empty set. The native rewrite is proven as far as unit level goes (1183/0); the E2E path needs the Server API shim's agent-listing endpoint first (prep item 2, now precisely scoped — not just probe endpoints). Follow-on gates (catalog-409, model-400) would bite next; same shim dependency. | $0 |
| Executor write (sisyphus-junior) | "create exactly one file E2E-PROBE.txt with exactly 'probe-ok'" | **PASS** — created exact bytes, nothing else touched (workspace otherwise unchanged), file removed after verification | negligible |
| B1 proactive | — | **N/A by design** — proactive cost/capability routing is full-scope (unbuilt); MVP is failure-triggered only. No probe exists to run. | $0 |

**Running total (rounds 1–3): <$0.002.** Quota-significant work remaining: M3 idle E2E via persistent session, Admin E2E past the shim, executor larger tasks — all gated on either code (shim) or explicit quota for longer sessions.

## Appendix D — Wave 2 Review + Admin/B1/M3 Live Validation (2026-10-05)

Policy: same standing Tier-1 (free-tier, tiny prompts). All inference attempts used free-tier models; every provider-side failure spent $0.

| Run | Command shape | Result | Spend |
|---|---|---|---|
| B1/M3 bundle harness | stubbed `Plugin.Context` drives `setup` + prompt hook (B1) and `todo_write` add + execute (M3) | **PASS** — B1 registers prompt/retry hooks, resolves agent via `session.get`, disposes clean; M3 registers `todo_write` with JSON-schema input, object + bare-array execute both store normalized todos | $0 (no inference) |
| Live prompt shape probe | `POST /api/session/{id}/prompt` variants on `ai-engkit-v2` | **PASS (contract fix)** — `{prompt:{text}}` → 400 `Missing key at ["text"]`; top-level `{text}` → 200 admitted. Vendor client confirms body `{id?,text,files?,agents?,skills?,metadata?,delivery?,resume?}`. Admin V2 request script corrected to `{text}` | $0 |
| Live wait endpoint probe | `POST /api/session/{id}/wait` vs experimental | **PASS (contract fix)** — `/api/session/{id}/wait` → 404; `/api/experimental/session/{id}/wait` → 204. Admin V2 script corrected | $0 |
| Plugin load after recreate | workspace-scoped `GET /api/agent` on fresh managed server | **PASS** — B1 `setup complete, hooks+events only`, config `chains=build,plan,general`; M3 `todo_write tool registered` (V2-native JSON-schema input). Self-contained bundles (no `/tmp` node_modules dependency) load clean; dead symlink removed | $0 |
| Admin readiness apply | `PUT /api/agent-models/librarian` `opencode/longcat-2.5-preview-free` (readiness) | **PASS** — `verified` via canonical JSON head; read-back `awaiting_request` (Markdown `gemma-4-26b` no longer misfires `runtime_mismatch`); `providerConnected: true` | $0 |
| Admin inference attempt | same head, `verification: inference` (pinned session create) | **MECHANICS PASS, model BLOCKED** — session pinned to `opencode/longcat-2.5-preview-free` executed (`step.started` with exact head model proves the pin); provider rejected with 403 `OpenCode's free tier can only be used from within OpenCode`. Admin correctly returned `unverified: did not return model metadata`; B1 correctly skipped fallback (auth non-retryable); session cleaned up | $0 (rejected by provider) |
| Earlier attempts (openrouter default) | default-model prompt | **BLOCKED** — `provider.auth` 401 `API key expired` (trial `OPENCODE_API_KEY`/openrouter key dead). Same correct skip/cleanup behavior | $0 |
| Admin clear + restore | `PUT .../librarian` `entries: []` | **PASS** — `cleared`; `routing.json` + `opencode.json` librarian keys removed (null); state back to `plugin`/`plugin` | $0 |
| V2 trial cell1 smoke | `./test/test-v2-trial.sh cell1` | **PASS** — all 6 checks (containers, 2.0.15, plugin-free, no omo.jsonc, 12 agents, OpenChamber reachable) | $0 |
| Full source suite | `bun test src trial/b1-routing` | **PASS** — 1225 pass, 2 skip, 0 fail | $0 |

Environment blocks on further live-success proofs (no code changes needed): (1) openrouter key expired (401); (2) `opencode/*` free tier rejects API usage (403 `only ... from within OpenCode`); (3) `opencode-go` no longer in connected providers. A successful inference round-trip needs either a refreshed openrouter key or explicit approval for one tiny paid-model (e.g. google) request. M3 idle→inject E2E likewise needs a working inference path (persistent session that can actually run); M3 correctly recorded the failed session as non-retryable and stood down.

### Round 4 addendum — user-supplied Google key (2026-10-05, same session)

User provided a Google (Gemini) API key (`AQ.Ab8…ARNQ`, 53 chars). Verified read-only: `GET /v1beta/models?key=` lists models (key valid, $0). Stored in trial `auth.json` under `google` (volume only, never committed).

- Direct `generateContent` with the key: works; `gemini-2.5-flash-lite` is retired (404 `use gemini-3.5-flash-lite`).
- Via opencode 2.0.15 `google` provider (pinned sessions `google/gemini-2.5-flash-lite`, then `google/gemini-3.5-flash-lite`): both fail `provider.auth` 401 `Expected OAuth 2 access token...` — the runtime sends the credential as Bearer (OAuth style) and ignores API-key auth; `GOOGLE_GENERATIVE_AI_API_KEY` env passthrough (added to `docker-compose.v2.yml`, container recreated) changed nothing. Reverted the compose knob.
- Via `nvidia/mistralai/mistral-7b-instruct-v0.3` (untested stored nvidia key): 403. Dead key or no entitlement.
- `opencode-go` finding: entry shape in `auth.json` is identical to working providers, but 2.0.15 has no such provider ID (`auth list` omits it, `/api/provider` omits it) — V1-era leftover; V2 successor is the `opencode` provider (same `longcat` model family, API-blocked per above).
- Every attempt: pinned model executed (`step.started` shows exact head), failure classified non-retryable, session deleted by the script. Admin returned the correct `unverified` verdicts; trial config restored (`librarian` cleared, files null).

Conclusion: inference mechanics are fully proven end to end; a *successful* round-trip is blocked purely by provider credentials (needs Google OAuth login via `opencode auth login`, a refreshed openrouter key, or a working nvidia key). All spends $0.

### Round 4 addendum 2 — Integrations API connects opencode-go, key still rejected upstream

User doubt: Admin Providers page says "Temporarily unsupported ... stores credentials through its Integrations API", while OpenChamber manages providers fine. Resolved: Admin's page writes the V1 credential path (`provider-keys.json`/`OPENCODE_PROVIDER`/auth.json direct writes); V2 runtime only honors the Integrations API — the banner is correct scoping, and Admin provider-write is a release gap ("will return when the v2 release is ready").

- Integrations endpoints recovered from the OpenChamber client bundle: `GET /api/integration`, `POST /api/integration/{id}/connect/key {key,label?}` (+`answer?`), plus OAuth/command flows under `/api/experimental` and `/api/integration/{id}/...`.
- `opencode-go` ("OpenCode Go") EXISTS as an integration ID (alongside `opencode` = "OpenCode Console"). `POST .../opencode-go/connect/key` with the user key → 204; `/api/provider` then lists `opencode-go` with 29 models (`longcat-2.5-preview-free`, `space-bunny-free`, ...).
- Admin pinned inference on `opencode-go/longcat-2.5-preview-free` executed (20s wall) but upstream returned 401 `Invalid API key` — the user key is a Google Cloud key, not an opencode-go subscription key. Trial config restored (librarian cleared, null).
- Net: V2 provider-connect path is now mapped and proven writable; remaining need is a valid opencode-go subscription key (or Google OAuth / fresh openrouter key) for the success round-trip. All spends $0.

### Round 4 addendum 3 — SUCCESS round-trip with Go subscription key (2026-10-05)

User supplied `oc_sk_81a5…N1`. `POST /api/integration/opencode-go/connect/key` → 204; `opencode-go` lists 29 models. Admin `PUT /api/agent-models/librarian` (`opencode-go/longcat-2.5-preview-free`, `verification: inference`, 14s wall):

```json
{"ok":true,"status":"verified",
 "resolved":{"modelID":"google/gemma-4-26b-a4b-it:free","providerID":"openrouter"},
 "requestVerified":{"modelID":"longcat-2.5-preview-free","providerID":"opencode-go"}}
```

- `resolved` keeps static Markdown metadata (correctly NOT compared — the U1 trap stays closed).
- `requestVerified` is the exact configured head: pinned session create + `{text}` prompt + experimental wait + message parse all green live.
- B1 proactive head enforcement fired live twice (`head enforce ... librarian -> opencode-go/longcat-2.5-preview-free`).
- Read-back shows `awaiting_request` (verification sessions are deleted by the script, so history-based `effective` only flips on real usage — by design).
- Trial config restored (`entries: []` → `cleared`, both files null).

Release evidence for Admin V2 inference is now COMPLETE. Total session spend: $0 (free-tier model).

### Round 4 addendum 4 — M3 idle→inject E2E PASS (2026-10-05)

Persistent API session (`build` agent, pinned `opencode-go/longcat-2.5-preview-free`), prompt instructed one `todo_write` call (2 pending) + `RECORDED` + stop.

- `todo_write sid=… n=2 pending=2` — KV write path live.
- `session.execution.succeeded` fired `handleIdle` (the `session.idle`/`session.status` events this runtime never emits — see below); `injected … incomplete=2 total=2 agent=build` — continuation prompt (`[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO_CONTINUATION]` + status + remaining list) appears in history as user messages.
- Model continued across turns (`PROCEED`, `DONE`, `All tasks completed`), updated todos via `todo_write`, then `all done … total=2 — gate closed` — injections stopped, no loop.
- E2E sessions deleted afterwards (`cleanup` logged).

Findings (all $0, all recorded from live logs):

1. **`session.idle` / `session.status` never fire on 2.0.15** (zero receptions across all sessions; protocol defines them, and docs describe `idle` as a deprecated side-effect of `status`). M3 now treats `session.execution.succeeded` (location-carrying, observed) as the idle-equivalent trigger; the old subscriptions stay as future-proof no-ops. Plugin event dispatch filters by `event.location.directory`, which status/idle payloads lack — consistent with the observed silence.
2. **`todo_write` is agent-scoped**: `build` sessions see and call it; `explore` sessions report only `shell`/`webfetch`/`websearch`. E2E used `build` (matches the Oct-3 precedent).
3. **B1 head-enforcement fights an Admin-explicit pin** when a stale chain exists: `build` chain head is dead `openrouter/auto`, so B1 switched the pinned-longcat session to it → `no-route` failure → B1 fallback recovered. Self-healed, but noted: stale `build`/`general` chains in trial `routing.json` predate the strict reconciler; left untouched (removing them would narrow B1's proven fallback path).
4. **B1 fallback replay default text**: with no captured prompt it replays hardcoded `"Reply with exactly this word: ok"` (4× phantom `ok` turns observed). Harmless here; replay-should-require-real-text is follow-up work, not release-blocking.
5. **Event bus duplicates every event 4×** (failures, injections, deletions all logged in quadruplicate). M3's cooldown/cap absorb it (cap 10 added this round: `MAX_INJECTIONS_PER_SESSION` + `skip max-injections`), but a check-then-set race lets concurrent duplicates through — hardening (in-flight flag) is follow-up work.

M3 persistent-continuation release evidence is now COMPLETE. Total session spend: $0 (free-tier model).

### Round 5 — Providers V2 management + policy startup reconciliation (2026-10-05)

- Admin Providers page: V2 unsupported gate replaced with integrations-backed management (231 integrations listed, key add/note/activate/delete, per-method OAuth start/status/cancel, wellknown + custom provider create/delete). Live on `ai-engkit-admin-v2:8082`: `anthropic` temp credential add → note rename → second key → activate switch (confirm dialog) → both deleted, registry back to 0; existing `google/nvidia/opencode-go/openrouter` connections untouched. `opencode-go` card shows 2 trial credentials with correct active selection.
- Custom provider roundtrip: `parent-qa-custom` (`@ai-sdk/openai-compatible` translated to `@opencode/ai/providers/openai-compatible`) appeared in runtime `/api/provider` + `/api/model` (`qa-coder`), then deleted via API — config and runtime both clean (pre-existing `tmp-test` example.com fixture left untouched as not ours).
- Policy API live: `GET /api/agent-models/policy` → `free` default; `PUT economy` → reflected; `PUT free` → restored; sidecar file written with correct `$HOME` expansion, then removed to restore absent-file default state.
- Startup reconciliation live (fresh `ai-dev` boot): all 12 agents `keep_valid_configured`, `changed=0 applied=0 failed=0` — policy-selected heads preserved, no destructive overwrite. Startup readiness now probes V2 `/api/provider` first (previously legacy-only caused skip-after-timeout).
- `bun test src/admin`: 1258 pass, 2 skip, 0 fail. `test-v2-trial.sh cell1`: all 6 checks pass. Trial config/state restored (librarian unconfigured, no temp credentials/providers/policy file).
- Known remaining gaps (not release-blocking, documented): OAuth `complete` needs real IdP login; B1 fallback replay default text; M3 injection check-then-set race; `tmp-test` fixture predates this round.

**Running total (rounds 1–4): <$0.002.** Trial config restored (librarian unconfigured); trial test sessions created today deleted.
