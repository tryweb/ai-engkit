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
| **Total** | | | **<$0.001** |

Open threads for quota use (require explicit re-authorization per run): M3 idle→inject live E2E (needs todo-write path built first — code before quota), B1 proactive/full-scope probes, Admin E2E, executor-family write-capable tasks.
