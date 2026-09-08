## Context

See proposal.md (Why) and specs/admin-db-maintenance/spec.md (behavior contract). Current state shaping this design: admin already drives `ai-dev` via `execInAiDev` (`src/admin/lib/docker.ts`), owns a stepped backup→recreate→health→reconcile→cleanup upgrade pipeline with SSE progress events (`src/admin/lib/upgrade.ts`), and reads/writes OpenChamber `settings.json` — but never touches `opencode.db`. Production DB lives in the `jonathan_opencode-data` volume mounted into `ai-dev`; OpenChamber's retention fields were verified schema-only with no server executor, so the maintenance engine must live in admin. Verified FK ground truth: `event` cascades only from `event_sequence`, which has no FK to `session` — deletion must target event sequences explicitly.

## Goals / Non-Goals

**Goals:**

- Manual maintenance run that is confirm-gated, backup-first, progress-visible, and integrity-verified, reusing the upgrade pipeline's proven patterns.
- Guarded daily scheduling that can only fire after a successful manual run and refuses unsafe conditions fail-closed.
- Read-only health status with zero write side effects.

**Non-Goals:**

- No OpenChamber retention passthrough (verified ineffective headless) and no changes to the upgrade flow itself.
- No archive retention action: verified to reclaim zero bytes; the policy is delete-only by design (see spec).
- No per-session selective export UI in this change; keepers are handled by existing `opencode export` before a run.
- No multi-policy or per-project retention granularity.

## Decisions

### 1. Maintenance engine reuses the upgrade pipeline shape, not a new framework

New `src/admin/lib/db-maintenance.ts` state machine (idle → backup → quiesce → delete → reclaim → verify → done/failed) mirroring `upgrade.ts` steps and its subscribe/emit event bridge for live progress. Rationale: operators already understand upgrade progress UX; tests can inject fake deps the same way (`UpgradeDeps` pattern). Alternative (standalone cron script on host) rejected: loses UI visibility, confirm gate, and audit trail the spec requires.

### 2. Single-writer window via compose stop/start of `ai-dev`

Quiesce = `docker stop ai-dev`, verify WAL mtime frozen, run SQL, `docker start ai-dev`. Rationale: proven in production drill; `restart-ai-dev.ts` already wraps compose recreate/restart. Alternative (online delete while serving) rejected: VACUUM cannot run against active writers and raw deletes bypass the event projector — the window is mandatory.

### 3. FK-correct delete order with `foreign_keys=ON`

`DELETE FROM event_sequence WHERE aggregate_id IN (<cutoff sessions>)` first (cascades to `event`), then `DELETE FROM session WHERE ...` (cascades message→part, todo, session_share, session_message, session_input, session_context_epoch). Rationale: verified 6645/6645 aggregate_id-to-session match; naive session-only delete orphans the largest table. sqlite CLI/python both default FK off — the runner must set it explicitly and assert pre-delete counts match post-delete deltas.

### 4. Compressed volume-level backup before every run

`docker run --rm -v <data-vol>:/src:ro -v <backup-dir>:/dst` + gzip stream, verified with `gzip -t` before any delete. Rationale: 13.5G→3.7G observed; `:ro` source mount prevents accidents; CRC of the full stream is the rollback proof. Backup and verification both run on the host via throwaway containers (same filesystem namespace) — never local mkdir, never inside ai-dev, which cannot see the backup path. Alternative (SQLite Online Backup API) deferred: file copy is simpler and was proven sufficient.

### 5. WAL-mode-aware reclaim with disk guards and kill-switch

`wal_checkpoint(TRUNCATE)` then `VACUUM`; pre-start guard requires free space above backup-plus-temp headroom, mid-run monitor aborts under a critical floor (killed VACUUM is fail-safe: temp removed, original intact — observed). Rationale: in WAL mode VACUUM rewrites through the WAL file (4.8G growth observed with zero other writers), so headroom math must assume ~1x live-DB temp, and a 100%-full root fs endangers all services. Long-running phases execute detached with log-file polling, matching the drill's nohup pattern.

### 6. Scheduler gated on prior manual success

Daily evaluation runs the same guard suite and additionally requires a recorded successful manual run; every skip records its reason. Rationale: prevents a freshly-enabled policy from silently deleting before an operator has seen the full backup→verify cycle succeed once.

### 7. Scheduling primitive: in-process wall-clock daily timer in the admin server (server local time)

Daily evaluation runs as an in-process wall-clock timer in the admin Bun server at the `dailyRunAt` wall-clock time (server local time, container TZ `Asia/Taipei` labeled "Server time" in UI). The scheduler computes the next daily occurrence of `dailyRunAt` as a pure `nextDailyOccurrence(HH:MM, nowMs)` strictly > now in server local time (handling midnight wrap and exact-minute boundary by rolling to next day), then arms a `setTimeout` for that delay; after each evaluation it recomputes from the wall clock so there is no drift and no catch-up backfill. On start it schedules only the next future occurrence, never a catch-up run. Persisted state remains `lastEvaluationAt`/`lastSkipReason`/`lastRunAt`; `nextEvaluationAt` is derived live from the stored policy's `dailyRunAt`. Rationale: off-peak 03:00 server-time default matches observed low-traffic window without drifting from boot time; wall-clock recomputation survives container restarts and keeps the guard suite in the same process as the run engine. Alternative (host cron invoking an admin endpoint) rejected: admin owns no host access, and cron would split the guard logic across two trust boundaries. Alternative (fixed-interval `setInterval` every 24h from boot) rejected: drifts from wall-clock time and cannot honor operator-configured off-peak.

### 8. Policy storage: admin-owned state file, separated from OpenChamber settings

The retention policy lives in a new admin-owned JSON state file alongside other admin server state — explicitly not in OpenChamber `settings.json` (verified separate schema boundary) and not covered by the upgrade flow's settings snapshot. Rationale: avoids schema collision with OpenChamber's sanitizer and keeps policy lifecycle (backup per run, survive upgrades) under admin control.

### 9. Idle-session wait reuses the restart flow's probe, fails closed instead of force fallback

Before quiesce, the engine calls the existing `waitForIdleSessions(probeIdleViaOpenCodeServer)` — the same source the graceful restart uses: the opencode `/session/status` map (authenticated with `OPENCODE_SERVER_PASSWORD` when set), which lists only busy/retry sessions, so an empty map means nothing is running. When no managed server exists at all (same pid namespace and HOME searched), the probe reports idle rather than unknown — otherwise quiet systems would skip every run; a server started later is covered by re-probing each interval. This matches the server's own message-queue consumer; per-id `/state` and the bare `/session` list were verified unreliable on the running build (HTML fallback / empty body). Unlike restart, which falls back to force on timeout/unavailable, maintenance fails the run with ai-dev untouched: deleting sessions out from under a running agent is worse than skipping. A wall-clock `time_updated`-recency heuristic was considered and rejected — recency cannot distinguish a running agent from a recently-finished one.

### 10. Post-quiesce SQL runs from a volume-mounted helper, never via exec

`docker exec` cannot reach a stopped container, so every SQL step after quiesce (FK check, deletes, checkpoint, VACUUM, quick_check) runs from a throwaway alpine container sharing the data volume, with SQL piped base64-encoded on stdin (shell-safe at every layer). Counts stay on the live exec path (pre-stop reads). Free-space probes try the live path first and fall back to host-side `df` of the volume, so the mid-run floor guard stays armed after the stop. The data volume is resolved from ai-dev's mounts by destination path — never guessed from naming conventions (dev uses `dev_opencode-data-dev`; guessing makes docker silently auto-create an empty volume, observed in testing). Backup verification additionally asserts non-trivial file size, since an empty volume gzips to a valid ~20-byte file that `gzip -t` accepts.

## Risks / Trade-offs

- [VACUUM temp exhausts disk mid-run] → Pre-start headroom guard plus mid-run floor monitor with abort; temp auto-cleans on kill (verified).
- [Cutoff deletes too much (e.g., 30d removed 67% of sessions in drill)] → Confirm screen shows exact to-delete counts queried live before commit; backup retained per run.
- [`ai-dev` fails to restart after window] → Health poll with timeout; rollback procedure restores the volume from the run's gzip backup (documented in tasks, tested path).
- [Scheduler clock drift / missed evaluations] → Last-evaluation timestamp in status; a missed day simply runs next evaluation, never backfills destructively.
- [OpenChamber UI downtime per run] → Same disruption class as upgrade recreate; runs are operator-triggered or daily off-peak, never concurrent (second trigger rejected with conflict).

## Migration Plan

1. Ship config + status + manual run behind the new capability; scheduler ships active but inert until first manual success.
2. First production use follows the drill: off-peak window, operator present, backup verified.
3. Rollback: stop `ai-dev`, restore volume from run backup, start; no schema or code migration involved.

## Open Questions

- Exact headroom multiplier for the pre-start guard (1.3x vs 1.5x live-DB estimate) — to be calibrated from the first two production runs without changing specs or tasks.
- Whether the daily evaluation should also auto-prune docker dangling resources when space trends down — deferred; host hygiene stays manual in this change.
