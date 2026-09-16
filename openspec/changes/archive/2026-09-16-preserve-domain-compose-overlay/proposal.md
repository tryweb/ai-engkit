## Why

Admin upgrades currently replace the effective Compose file with the upstream file before recreating `ai-dev`. Domain deployments that add an external network, runtime environment, or other integration settings therefore lose those settings after an upgrade, even though their workspace and data volumes remain intact. The upgrade lifecycle needs an explicit ownership boundary: AI-EngKit manages the upstream base while the domain project manages one local overlay.

## What Changes

- Add V1 support for one explicitly configured, local domain Compose overlay via `AI_ENGKIT_COMPOSE_OVERLAY`, resolved only beneath the mounted `/opt/ai-engkit/extensions/` directory.
- Render and validate the effective base-plus-overlay configuration before any recreate operation.
- Apply the same effective Compose configuration to upgrade, restart, and other `ai-dev` recreate lifecycle paths.
- Preserve the overlay reference/content and related configuration in upgrade backups.
- Fail closed when the overlay is unreadable, invalid, or no longer matches the expected `ai-dev` service.
- Attempt complete restoration of the previous effective configuration when recreate or health verification fails, and report any partial rollback explicitly.
- Keep Admin-owned services and the domain worker lifecycle outside the overlay contract.
- Limit the overlay surface to `ai-dev` environment, networks, volumes, labels, and healthchecks; reject image, container identity, command/entrypoint, ports, privilege, Docker socket, Admin, and domain worker changes.
- Verify the OpenCode runtime environment names and the ep-design network/endpoint integration rather than assuming variable semantics.
- Make the host `upgrade.sh` path overlay-aware so existing overlay installations can bootstrap the new Admin image without a manual migration.
- Do not add multi-overlay ordering, overlay editing, or automatic conflict resolution in V1.

## Capabilities

### New Capabilities

<!-- No standalone capability is introduced; this change extends the existing upgrade contract. -->

### Modified Capabilities

- `admin-upgrade`: upgrades must preserve and apply a configured domain Compose overlay across upgrade, recreate, validation, backup, rollback, and outcome reporting.

## Impact

- Affected Admin upgrade orchestration, Compose command construction, restart/recreate callers, host `upgrade.sh`, and their tests.
- Production Compose mounting must make the configured overlay visible to the Admin container and Docker Compose client.
- The Admin API/UI and upgrade event log may expose overlay-active, validation, and rollback outcomes without exposing secrets.
- No new runtime dependency is required; Docker Compose's native multi-file merge and config validation are used.
