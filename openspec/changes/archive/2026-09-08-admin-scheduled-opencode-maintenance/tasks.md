## 1. Retention Policy Config

- [x] 1.1 Add retention policy model with validation (enabled boolean, cutoff 1-365 days; delete-only with no archive action) and verify invalid inputs are rejected with no partial write via unit tests
- [x] 1.2 Add GET/PUT policy API with authenticated access and verify round-trip persistence plus field-level error responses via route tests
- [x] 1.3 Add policy UI section reusing the OpenChamber settings page pattern and verify save/load flow in a browser smoke check

## 2. Read-Only Health Status

- [x] 2.1 Add DB health probe (file size, freelist_count, session/event/message/part counts, host free space) over read-only access and verify it performs zero writes via unit tests with a fixture DB
- [x] 2.2 Add health status API and UI panel and verify values render while the system is serving traffic without interruption

## 3. Maintenance Run Engine

- [x] 3.1 Implement run state machine (idle → backup → quiesce → delete → reclaim → verify → done/failed) with single-run lock and progress events mirroring the upgrade pipeline, and verify concurrent trigger returns conflict via unit tests
- [x] 3.2 Implement compressed volume backup with gzip integrity verification and verify a corrupt/interrupted backup fails the run before any delete via unit tests
- [x] 3.3 Implement quiesce (stop ai-dev, confirm WAL frozen) and restart with health poll, and verify restart failure surfaces failed state without marking success via unit tests
- [x] 3.4 Implement FK-correct delete (event_sequence first with foreign_keys=ON, then sessions) with live to-delete counts for the confirm screen, and verify cascade deltas match pre-counts on a fixture DB via unit tests
- [x] 3.5 Implement reclaim (checkpoint, guarded VACUUM with pre-start headroom check and mid-run floor abort) plus quick_check verify, and verify guard refusal and abort paths via unit tests
- [x] 3.6 Document the volume-restore rollback procedure from a run backup and verify the steps against a staging volume

## 4. Guarded Scheduling

- [x] 4.1 Add daily policy evaluation that requires enabled policy, passing guards, and one prior successful manual run, and verify skip reasons are recorded on guard failure via unit tests
- [x] 4.2 Wire scheduler lifecycle to admin server start/stop and verify no destructive action occurs when disabled or never-manually-run via integration tests

## 5. Release Verification

- [x] 5.1 Run full admin test suite and lsp_diagnostics on changed files and verify zero regressions
- [x] 5.2 Execute an off-peak production drill (backup → 90d conservative run → verify → health check) with operator present and verify each phase matches the logged outcomes

## 6. Off-peak scheduling

- [x] 6.1 Add `dailyRunAt: "HH:MM"` to `RetentionPolicy` with `^(?:[01]\d|2[0-3]):[0-5]\d$` validation, field-level errors, and `03:00` default for stored policies missing the field
- [x] 6.2 Add pure `nextDailyOccurrence(timeHHMM, nowMs)` (server local time, strictly > now, midnight wrap, exact-minute boundary, invalid-input error) and replace fixed-interval timer with recomputed wall-clock `setTimeout` chain with no drift and no catch-up backfill
- [x] 6.3 Update schedule endpoint so `nextEvaluationAt` is the wall-clock occurrence derived from the stored policy via `readRetentionPolicy`, handling bad stored time and never-evaluated cases
- [x] 6.4 Add `<input type="time">` to the policy form card following `DESIGN.md` and existing form pattern (prefilled, included in save payload, responsive at 375/320, keyboard/focus-visible intact) and show next run with "(server time)" hint
- [x] 6.5 Update all affected unit/route tests and verify full admin suite + typecheck green and diagnostics clean
- [x] 6.6 Update openspec deltas: spec policy requirement (new field + scenario), design scheduler decision (wall-clock), tasks.md new section marked complete
