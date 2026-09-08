## Why

Production `opencode.db` regrew from manual cleanup to multi-GB scale before (13.5G, host at 96%), and the only proven reclamation path is a destructive maintenance window (stop writes, FK-correct delete, VACUUM) that today requires SSH expertise. OpenChamber's own retention switch was verified schema-only and never fires headless, so there is no automatic protection today. Admin needs a first-class, user-operable maintenance mechanism before the next disk-full incident.

## What Changes

- New admin capability `admin-db-maintenance`: retention policy config (enabled flag, inactivity cutoff days; delete-only), persisted server-side.
- Manual maintenance run trigger with explicit confirm, live progress events, and rollback backup — reusing the `admin-upgrade` backup/event pattern.
- Read-only DB health status (size, freelist, row counts, host free space) surfaced in admin.
- Scheduled execution evaluated at runtime on a daily cadence with fail-closed disk guards (refuse to run when free space is below threshold); no silent background deletes without prior successful manual run.
- No changes to OpenChamber settings passthrough or the upgrade flow.

## Capabilities

### New Capabilities

- `admin-db-maintenance`: retention policy configuration, manual maintenance trigger with progress/backup/verify, DB health status, and guarded scheduled execution for opencode.db space reclamation.

### Modified Capabilities

(none — existing upgrade, dashboard, and settings behaviors are unchanged)

## Impact

- `src/admin`: new routes/lib/views for maintenance (config, trigger, status); scheduler hook in admin server; docker exec against ai-dev (`execInAiDev`) plus compose stop/start of `ai-dev` for the single-writer window.
- Production `ai-engkit` container: brief OpenChamber downtime during each maintenance run (same class of disruption as the existing upgrade recreate).
- Host disk: each run needs backup space plus ~1x live-DB VACUUM headroom; guards refuse to start otherwise.
- No dependency changes; no API breaking changes.
