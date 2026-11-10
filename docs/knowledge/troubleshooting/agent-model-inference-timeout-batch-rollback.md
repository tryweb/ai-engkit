# Inference Verify Timeout Caused Whole-Batch Rollback

## Context

Admin UI → Agent Models → Generate suggestions → check `Verify usability (may
consume quota)` → Apply. The batch writes `routing.json` (or `omo.jsonc`),
patches `opencode.json` heads, restarts ai-dev, then runs inference
verification (one real request + one model probe per agent).

## Problem

A single slow agent nuked the entire batch. UI showed per-row
`not applied — rolled back: batch rolled back after momus probe failure`, and
momus itself showed `rolled back — probe failed: probe polling timed out
after 90 seconds`. All 7 pending changes were reverted even though 6 models
were fine.

Cause chain (all confirmed in source):

1. The probe script polls the verification session and gives up after 90s:
   `OUT="probe polling timed out after 90 seconds"`
   (`src/admin/lib/model-probe.ts`, probe-script tail).
2. `classifyProbeResponse` maps that string to `{status: "timeout"}` —
   and its own comment says ambiguous results should degrade fail-open
   (`retryable`).
3. `verifyAppliedAgent` only treated `retryable/unreachable` as `unverified`;
   `timeout` (and `aborted`) fell through to `probe_failed`
   (`src/admin/lib/agent-models.ts`).
4. `applyAndVerifyBatch` rolls back the whole batch on any `probe_failed`:
   snapshot restore + recovery restart, other agents overwritten with
   `rollback_failed: batch rolled back after <agent> probe failure`.

So a transient slow model (here: heuristic free-tier `gemini-4-argon` with no
comparable benchmark) was classified as a dead model, and the rollback
punished every healthy agent in the batch.

## Solution

- Map `timeout`/`aborted` to `unverified` (keep config, no rollback), mirroring
  the PUT pre-probe gate which only blocks confirmed-dead models
  (`retired`/`wrong_endpoint`/`unavailable`, `routes/agent-models.ts`).
  Affected agents report yellow `unverified` and stay pending for retry.
- Earlier hardening on the same path (same files, prior commits):
  each batch agent writes with its own exec so failures name the agent and
  stderr instead of one opaque `cmd1 && cmd2 && ...`; after verification,
  re-read the config file and downgrade any `ok` result whose change is
  missing to `write_failed` (fail-closed against silent write loss; no
  rollback since live may be fine).

## Why It Works

The verify step now honors the classifier's own contract: only
confirmed-dead statuses can fail a batch. Transient statuses keep the
written config and report per-agent, so one slow model can no longer revert
unrelated agents. The read-back closes the complementary false-positive
(`verified` while the file never persisted).

## Side Effects / Tradeoffs

- A model that *always* times out stays configured with yellow `unverified`
  indefinitely. Accepted: explicit user state beats silent system rollback.
  Escalation (e.g. N timeouts → treat as dead) is deliberately not built.
- Partial success still keeps ALL pending (including verified agents) for
  retry, and retry restarts ai-dev again. Known UX limitation, out of scope.
- Retrying inference burns quota per agent; the checkbox default (off) and
  its label already disclose this.

## Evidence

- Failing UI: `not applied — rolled back: batch rolled back after momus
  probe failure` + `probe polling timed out after 90 seconds`.
- Regression test: inference apply with probe returning the timeout string →
  `{ok:false, status:"unverified"}`, `restartCount == 1`, no snapshot
  restore (`src/admin/lib/agent-models.test.ts`, "probe timeout keeps the
  applied config and reports unverified without rollback").
- `src/admin` suite: 1297 pass, 0 fail (90 files, `env -u OMO_ENABLED bun
  test src/admin`).
- Live (dev, rebuilt image): single-agent inference apply verified on the
  happy path with no rollback; config restored to all-effective after.

## Related Files

- `src/admin/lib/agent-models.ts` (`verifyAppliedAgent`, `applyAndVerifyBatch`)
- `src/admin/lib/model-probe.ts` (`classifyProbeResponse`, probe-script tail)
- `src/admin/routes/agent-models.ts` (PUT pre-probe gate)
- `src/admin/lib/agent-models.test.ts`, `src/admin/routes/agent-models.test.ts`

## Tags

- agent-models
- inference-verification
- probe-timeout
- batch-rollback
- fail-open
