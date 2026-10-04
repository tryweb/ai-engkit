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
