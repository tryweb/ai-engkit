# DB Maintenance Rollback Runbook: Volume Restore from Run Backup

## Context

Each maintenance run creates a compressed volume backup (`maintenance-<timestamp>/opencode.db.gz`) verified with `gzip -t` before any delete. If post-run verification fails, the operator restores the volume from that backup. The backup is the only rollback for destructive deletes (e.g., >30d removed 4346/6500 sessions in the production drill).

## Problem

A maintenance run may fail at reclaim/verify or the restarted `ai-dev` may not reach healthy, leaving the database in a state that requires restoring to the pre-run backup.

## Solution

### 1. Locate the run backup

Backups are under the maintenance backup directory (default `/opt/ai-engkit/maintenance-backups/`):

```bash
ls -lt /opt/ai-engkit/maintenance-backups/ | head
# maintenance-2026-09-08T12-00-00-000Z/opencode.db.gz
```

The API status includes the backup path in the `backup` success event. The file is gzip-compressed (13.5G → 3.7G observed).

### 2. Verify the backup before restore

```bash
gzip -t /opt/ai-engkit/maintenance-backups/maintenance-<ts>/opencode.db.gz && echo "ok"
# must print ok — CRC of full stream. Do not restore a failing backup.
```

### 3. Quiesce ai-dev (single-writer window)

```bash
# From host or via admin docker socket
docker compose -p <project> stop ai-dev
# or: docker stop -t 60 <ai-dev-container>
# Confirm WAL frozen:
stat /var/lib/docker/volumes/<project>_opencode-data/_data/opencode.db-wal
# mtime must not advance after stop
```

### 4. Restore the volume

```bash
# Decompress backup into the volume's data directory (or via a helper container):
docker run --rm \
  -v <project>_opencode-data:/data \
  -v /opt/ai-engkit/maintenance-backups/maintenance-<ts>:/backup:ro \
  alpine sh -c 'gzip -dc /backup/opencode.db.gz > /data/opencode.db && sync'

# Remove stale WAL/SHM if present (they belong to the old incarnation):
rm -f /var/lib/docker/volumes/<project>_opencode-data/_data/opencode.db-wal
rm -f /var/lib/docker/volumes/<project>_opencode-data/_data/opencode.db-shm
```

Alternative via direct host path (when volume is bind-mounted):

```bash
gzip -dc /opt/ai-engkit/maintenance-backups/maintenance-<ts>/opencode.db.gz > /var/lib/docker/volumes/<project>_opencode-data/_data/opencode.db
rm -f /var/lib/docker/volumes/<project>_opencode-data/_data/opencode.db-wal
rm -f /var/lib/docker/volumes/<project>_opencode-data/_data/opencode.db-shm
```

### 5. Verify before restart

```bash
# Run quick_check while ai-dev is still stopped (rw mount):
docker run --rm -v <project>_opencode-data:/data alpine sh -c 'apk add -q sqlite && sqlite3 /data/opencode.db "PRAGMA quick_check;"'
# must print: ok
# Note: readonly open of a WAL DB with unrecovered WAL fails with CANTOPEN/14 — use rw mount while stopped.

# Row-count spot check:
docker run --rm -v <project>_opencode-data:/data alpine sh -c 'apk add -q sqlite && sqlite3 /data/opencode.db "SELECT COUNT(*) FROM session; SELECT COUNT(*) FROM event;"'
```

### 6. Restart and health poll

```bash
docker compose -p <project> --env-file /opt/ai-engkit/.env -f /opt/ai-engkit/compose.yml up -d ai-dev
# Poll health (mirrors the engine's poll):
for i in $(seq 1 40); do
  if curl -fsS http://localhost:8000/healthz >/dev/null 2>&1; then echo "healthy"; break; fi
  sleep 3
done
# Also verify OpenChamber:
curl -fsS http://localhost:8000/ | head -c 200
```

### 7. Confirm rollback

- Compare post-restore `SELECT COUNT(*) FROM session` to pre-run count recorded in the run log.
- Confirm `PRAGMA integrity_check` or `quick_check` is `ok`.
- Confirm `ai-dev` is running: `docker ps --filter name=ai-dev`.
- Record the rollback in the maintenance event log (admin API will show `failed` with the guard that tripped).

## Why It Works

- The backup is verified with `gzip -t` (full-stream CRC) before any delete gates — a corrupt backup never leads to deletion.
- The restore path is volume-level (byte-for-byte file copy) + WAL/SHM removal, which is exactly what the backup captured. VACUUM's temp is already removed on failure (killed VACUUM is fail-safe; observed twice), so the original is either intact or replaced by the backup.
- `quick_check` before restart proves page-level integrity without requiring the writer to be up. The WAL-mtime freeze guarantees no concurrent writer raced the window.
- The engine's state machine surfaces `failed` with the specific guard (disk, WAL, restart timeout) so the operator knows whether a rollback is needed.

## Side Effects / Tradeoffs

- Restoring discards all sessions created after the backup timestamp. Export keepers before the run if needed (`opencode export`).
- The volume restore requires `ai-dev` to be stopped — OpenChamber UI is down during the window (same class as the maintenance window itself).
- Stale WAL/SHM must be removed after restore; leaving them causes `SQLITE_CANTOPEN` on next open with an unrecovered WAL.
- The backup directory must have been on a path with sufficient free space at run time — the engine's pre-start headroom guard ensures this.

## Evidence

- Production drill: backup `/home/jonathan/opencode-20260908.db.gz` (3.7G) passed `gzip -t`; restore was exercised against a staging volume via the same `docker run -v :ro` pattern.
- Unit tests exercise corrupt-backup-fails-before-delete and restart-failure-surfaces-failed against fixture DBs with injected fakes (no production writes).
- Fail-safe VACUUM kill verified: temp removed, original DB intact (observed twice during the 5.4G-free incident).

## Related Files

- `src/admin/lib/db-maintenance.ts` (state machine, backup/verify/quiesce/delete/reclaim/verify)
- `src/admin/routes/db-maintenance.ts` (status/log/run API, 409 on concurrent)
- `docs/knowledge/troubleshooting/opencode-db-cleanup-maintenance.md` (FK-correct delete order, WAL-mode VACUUM, disk guards — ground truth for engine behavior)

## Tags

- opencode
- sqlite
- maintenance
- rollback
- backup
- vacuum
- docker
