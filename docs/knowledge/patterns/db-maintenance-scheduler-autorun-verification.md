# DB Maintenance Scheduler — Verifying Auto-Run With Host Evidence

## Context

The admin has a retention-policy feature (`src/admin/lib/db-maintenance.ts`,
`src/admin/routes/db-maintenance.ts`) that hard-deletes expired opencode
sessions. It is gated by design — enable is locked until one successful manual
run exists — and can run on a daily schedule. State lives in three JSON files
plus a backups directory under the deployment's `admin-data` / `backups`
bind mounts.

## Problem

"Did the daily auto-run actually execute?" cannot be answered from the UI alone
— the dashboard shows derived state, and an agent looking at a screen can't
prove the run wasn't triggered by hand. We needed host-side, timestamp-grade
evidence that the scheduler fired on its own at the configured time.

## Solution

Verify auto-execution from host files, not the UI:

1. **Configured schedule** — `admin-data/retention-policy.json`:
   `{"enabled":true,"cutoffDays":30,"dailyRunAt":"08:05"}`

2. **Scheduler fired** — `admin-data/maintenance-scheduler.json` is written only
   after an evaluation completes (absent = `NO_SCHED`, eval still in progress):
   ```json
   {"lastEvaluationAt":"2026-09-12T00:05:00.001Z","lastSkipReason":null,"lastRunAt":"2026-09-12T00:05:00.001Z"}
   ```
   Keys: `lastEvaluationAt` (when the scheduler evaluated the run condition),
   `lastRunAt` (when the maintenance run itself started — same instant here),
   `lastSkipReason` (null = ran; non-null = why skipped).

3. **Backup artifact** — `backups/db-maintenance/` gains a directory named
   `maintenance-<UTC-ISO-with-ms>` created in the same instant as
   `lastEvaluationAt`. A second backup dir that did not exist before =
   the scheduler produced it; no manual action can fake the sub-second match
   between `lastEvaluationAt` and the dir name timestamp.

4. **Run completed** — `admin-data/db-maintenance-state.json`:
   `"lastSuccessAt":"2026-09-12T00:12:10.283Z"` (refreshed only on success).
   This is also the `hasPriorSuccess` gate marker.

Reading all three files + `ls backups/db-maintenance/` after the scheduled
time is conclusive: configured → fired at exact second → run completed.

## Why It Works

- `evaluateMaintenanceScheduler` polls on `DEFAULT_EVALUATION_INTERVAL_MS` and
  fires when `now >= resolveDailyRunAt(dailyRunAt)`; the eval then executes
  `runMaintenance` and only afterwards persists the scheduler state file —
  so the file appearing IS the completion signal.
- The backup dir uses the run start time with millisecond precision
  (`00-05-00-001Z` = 08:05:00.001 Taipei), recording the exact trigger moment.
- The gate marker (`lastSuccessAt`) and the schedule file are written by
  separate code paths, so cross-checking them rules out a stale file.

## Side Effects / Tradeoffs

- **Quiesce can take up to 10 minutes**: `waitForIdleSessions`
  (`src/admin/agent/commands.ts:575`) probes busy/retry opencode sessions
  every 15 s until idle, deadline 10 min. Observed: manual run waited ~2.5 min;
  an auto-run with an actively-connected agent session waited ~7 min
  (08:05:00 backup → 08:12:10 success). A long gap between backup dir and
  `lastSuccessAt` is normal, not a hang — as long as it is < 10 min.
- While the run is in quiesce, `maintenance-scheduler.json` does not exist yet
  (`NO_SCHED`) and `lastSuccessAt` is stale — do not declare failure from
  mid-run snapshots.
- Timezone: scheduler state is UTC ISO; the UI shows server-local time
  (Asia/Taipei on the verification host). `00:05:00.001Z` = 08:05:00.001
  Taipei; the dir name uses UTC.

## Evidence

Verified end-to-end on `192.168.11.194` (test env, `jonathan` project — host
inventory in `troubleshooting/admin-restart-self-destruct.md`):

- Gate: fresh install → enable checkbox locked + `enable-gate-hint` shown;
  manual run escape allowed (`allowDisabledPolicy: true`); after one successful
  manual run, marker `lastSuccessAt` written → UI unlocks via SSE reload.
- Manual run deleted 4 sessions with cutoff `2026-08-13` (+VACUUM +
  integrity verify) and wrote marker `2026-09-12T00:01:07.519Z`.
- Auto-run: policy set to `dailyRunAt:"08:05"`; at 08:05:00.001 Taipei the
  scheduler fired (backup dir `maintenance-2026-09-12T00-05-00-001Z` created,
  no human action); completed 08:12:10 with `lastSuccessAt` refreshed to
  `2026-09-12T00:12:10.283Z`; scheduler file shows
  `lastEvaluationAt=lastRunAt=00:05:00.001Z`.
- 1094 local tests pass; UI/API both gate the enable on `hasPriorSuccess`.

## Related Files

- `src/admin/lib/maintenance-scheduler.ts` — `scheduleNext`(L250),
  `evaluateMaintenanceScheduler`(L142), `resolveDailyRunAt`(L36),
  `DEFAULT_EVALUATION_INTERVAL_MS`(L18)
- `src/admin/lib/db-maintenance.ts` — `runMaintenance` state machine
- `src/admin/agent/commands.ts:575` — `waitForIdleSessions` (quiesce, 10-min cap)
- `src/admin/views/retention-policy.tsx` — `applyEnableGate`/`enable-gate-hint`
- `docs/knowledge/troubleshooting/db-maintenance-rollback-runbook.md`
- `docs/knowledge/architecture/dev-verification-limitations.md` — why backup
  cannot be verified in dev (named volume)

## Tags

`#db-maintenance` `#scheduler` `#verification` `#retention` `#quiesce`