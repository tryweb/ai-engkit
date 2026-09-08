# opencode.db Space Reclamation: FK Trap, WAL-Mode VACUUM, and Disk Guards

## Context

Production `opencode.db` (SQLite, WAL mode, page 4096, `auto_vacuum=0`) in Docker volume `jonathan_opencode-data` (mounted at `/home/devuser/.local/share/opencode` in the `ai-engkit` container, compose project `jonathan`, service `ai-dev`) grew to 13.5G + 266M WAL. Host root fs hit 96% (5.4G free). An earlier research report recommended raw-SQL deletion assuming `DELETE FROM session` cascades to all child tables including `event`/`event_sequence`.

## Problem

- `event` (1.7M rows: `message.part.updated.1` 1.1M + `message.updated.1` 455K streaming snapshots) was the largest table, but the report's cascade assumption was wrong (see below).
- OpenChamber's built-in retention (`autoDeleteEnabled`, verified separately) is frontend-orchestrated and never fires headless — not a viable automation.
- VACUUM needs ~1x DB size in temp space; with 5.4G free it fails mid-run with disk 100%.

## Solution

Verified procedure (executed 2026-09-08, 13.5G to 4.8G):

1. **Read-only recon first.** `bun:sqlite` readonly open via `docker exec ai-engkit bun <script>` (host python cannot read `/var/lib/docker`; no sqlite3 binary on host; `docker run` with `:ro` volume mount also works). Confirmed schema, counts, and that `event_sequence.aggregate_id` matches `session.id` 6645/6645.
2. **Correct the cascade plan.** FK dump showed 13 tables with `ON DELETE CASCADE`, but `event` only references `event_sequence(aggregate_id)`, and `event_sequence` has **no FK to `session`**. Raw `DELETE FROM session` orphans all events. Fix: delete `event_sequence` explicitly first (`DELETE FROM event_sequence WHERE aggregate_id IN (SELECT id FROM session WHERE ...)`), which cascades to `event` via FK; then delete sessions (cascades to message to part, todo, session_share, session_message, session_input, session_context_epoch). Always set `PRAGMA foreign_keys=ON` (sqlite CLI defaults it OFF).
3. **Free host space before touching the DB.** Safe wins: `docker image prune -f`, `docker builder prune -f`, `docker volume prune -f`, plus `docker rmi` of specific unused tagged images (fail-safe: refuses images used by any container). Reached 14G free. Never start without free space comfortably above DB+WAL size.
4. **Compressed backup with verify.** `docker run --rm -v <vol>:/src:ro -v /home/jonathan:/dst alpine sh -c 'cat /src/opencode.db | gzip -6 > /dst/opencode-YYYYMMDD.db.gz'` (13.5G to 3.7G), then `gzip -t` (full-stream CRC) in background with a done-marker file; poll for it.
5. **Maintenance window.** `docker stop -t 60 ai-engkit` (single-writer guarantee; admin container unaffected; OpenChamber UI down during window). Verify WAL mtime frozen.
6. **Delete in stages, checkpoint, then VACUUM with a kill-switch.** Conservative round first (>90d: 332 sessions), then the real round (>30d: 4346 sessions). `PRAGMA wal_checkpoint(TRUNCATE)` between delete and VACUUM. Run VACUUM in background (`nohup ... &`), poll `df` every ~1 min, kill threshold: abort if free drops under ~1.5G. A killed VACUUM is fail-safe: temp is removed, original DB untouched (observed twice).
7. **Know WAL-mode VACUUM behavior.** In WAL mode VACUUM rewrites through the WAL file (observed 4.8G WAL growth during VACUUM with zero other writers), not a side temp file. Do not mistake WAL growth for a rogue writer: confirm with volume-mount inspection that only the VACUUM container holds the volume.
8. **Verify before restart.** `PRAGMA quick_check` must print `ok` (note: readonly open of a WAL DB with unrecovered WAL fails with CANTOPEN/14 — run the check with a rw mount while the service is stopped, or accept the artifact). Then `docker start ai-engkit`, expect host port 8000 (container 3000 maps to host 8000, not 3000) to return HTTP 200, plus row-count spot check.

## Why It Works

- FK-correct deletion removes the actual bulk (881K streaming events) instead of orphaning it.
- Checkpoint-then-VACUUM with disk guards turns the two failure modes (disk-full mid-VACUUM, writer racing the rewrite) into non-events.
- Compressed backup plus `quick_check` on both sides gives rollback and integrity proof at each step.

## Side Effects / Tradeoffs

- First VACUUM attempt hit 100% disk (temp needs ~1x live DB); killed cleanly, zero damage — but a full root fs risks other services, so the 1.5G kill threshold and pre-sized headroom are mandatory, not optional.
- Deleting >30d sessions is destructive (4346 of 6500 removed); the gzip backup is the only rollback. Selective `opencode export` of keeper sessions should precede any repeat.
- Stopping `ai-engkit` takes OpenChamber UI down; schedule the window explicitly.
- The leftover `dd92fa2` untag quirk: `docker rmi <id>` fails for multi-tagged images ("referenced in multiple repositories") — remove by tag names instead.

## Evidence

- Pre: page_count 3,531,599 (13.5G), freelist 0, session 6820, event 1,719,155, part 652,783; host 116G fs at 96% (5.4G free).
- Post: page_count 1,241,230 (4.8G), freelist 0, session 2154, event 837,937, part 279,548; host at 78% (26G free); OpenChamber HTTP 200; `quick_check` ok.
- `event_sequence.aggregate_id IN (SELECT id FROM session)` matched 6645/6645 pre-cleanup.
- Backup `/home/jonathan/opencode-20260908.db.gz` (3.7G) passed `gzip -t`.
- Reusable scripts left on host `/tmp`: `op.sql` (90d round), `op2.sql` (30d round) — change only the millisecond cutoff constant.

## Related Files

- `/var/lib/docker/volumes/jonathan_opencode-data/_data/opencode.db` (production DB, host path)
- `/home/jonathan/opencode-20260908.db.gz` (verified backup)
- `docs/knowledge/tooling/openchamber-session-retention-fields-frontend-only.md` (why OpenChamber retention is not the automation)
- `docs/knowledge/troubleshooting/opencode-session-auto-archive.md` (related 30-day archive history)
- `/opt/ai-engkit/compose.yml` (compose project `jonathan`, service `ai-dev`)

## Tags

- opencode
- sqlite
- disk-space
- vacuum
- maintenance
- docker
