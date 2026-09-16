## Purpose

Defines upgrade-time safeguards that preserve OpenChamber project registrations across image upgrades: snapshot the registration state before upgrading and reconcile missing registrations afterward so the project list survives version changes.

## Requirements

### Requirement: Upgrade snapshots OpenChamber registration state

Before recreating containers, every upgrade path SHALL copy the OpenChamber `settings.json` from the `openchamber-data` volume into the pre-upgrade backup directory used by that path — `backups/pre-<timestamp>/` for the admin UI path, `backup_<TIMESTAMP>/` for the host `upgrade.sh` path — before any container is recreated. The snapshot SHALL preserve the full `projects` array content of the file at snapshot time. When a domain Compose overlay is configured, the backup SHALL also preserve the upstream base reference/content and the overlay reference/content needed to reconstruct the effective Compose configuration.

#### Scenario: Snapshot created before containers are recreated

- **WHEN** an upgrade runs and the OpenChamber `settings.json` exists
- **THEN** a copy of the file containing the current `projects` entries is written to that path's pre-upgrade backup directory before any container is recreated

#### Scenario: Overlay configuration is included in the backup

- **WHEN** an upgrade runs with a configured domain Compose overlay
- **THEN** the backup contains enough base, overlay, and environment information to reconstruct the pre-upgrade effective Compose configuration without copying secrets into upgrade logs

#### Scenario: Snapshot retains the pre-upgrade project list

- **WHEN** the pre-upgrade registration list contains N projects and the upgrade completes
- **THEN** the snapshot file in `backups/pre-<timestamp>/` still contains exactly those N pre-upgrade project entries

### Requirement: Upgrade reconciles missing OpenChamber project registrations

After the upgrade completes, every upgrade path SHALL compare the deployment's workspace project directories against the OpenChamber registration list and re-add entries for directories that are present on disk but missing from the registration list. The reconcile SHALL be add-only and idempotent: it SHALL NOT remove any existing registration, and re-running it when nothing is missing SHALL make no changes.

#### Scenario: Missing registrations are restored after upgrade

- **WHEN** an upgrade completes and 3 workspace project directories are absent from the registration list
- **THEN** all 3 directories are re-added to the registration list and the OpenChamber UI shows them without manual action

#### Scenario: Consistent registration list is left unchanged

- **WHEN** an upgrade completes and every workspace project directory already has a registration
- **THEN** the registration list is unchanged and the reconcile reports that nothing was missing

#### Scenario: Stale registrations are never removed by the reconcile

- **WHEN** the registration list contains an entry whose directory is no longer present on disk
- **THEN** the entry is kept and the reconcile does not remove it

### Requirement: Upgrade outcome is reported in the admin UI

When an upgrade is run through the admin UI, the post-upgrade result SHALL indicate how many project registrations were restored, or that the registration list was already consistent.

#### Scenario: Admin UI upgrade reports restored registrations

- **WHEN** an admin completes an upgrade through the admin UI and the reconcile re-added 3 registrations
- **THEN** the upgrade result states that 3 project registrations were restored

#### Scenario: Admin UI upgrade reports a consistent list

- **WHEN** an admin completes an upgrade through the admin UI and the reconcile found nothing missing
- **THEN** the upgrade result states that the registration list is consistent and no registrations needed restoring

### Requirement: Snapshots follow the existing backup retention policy

The pre-upgrade OpenChamber registration snapshots SHALL be subject to the same retention cleanup as the other pre-upgrade backup directories controlled by `BACKUP_RETENTION` (`pre-*` for the admin path, `backup_*` for the host path). Overlay-related base and reference/content backup data SHALL be retained and pruned with the same backup directory.

#### Scenario: Old registration snapshots are cleaned up with other backups

- **WHEN** backup retention cleanup runs and a registration snapshot is older than the configured retention window
- **THEN** the snapshot is removed together with the other expired `pre-*` backups

#### Scenario: Overlay backup data follows retention cleanup

- **WHEN** backup retention cleanup removes an expired upgrade backup
- **THEN** the base and overlay backup data belonging to that upgrade is removed with the same backup directory

### Requirement: Effective Compose configuration preserves one local domain overlay

The system SHALL support one explicitly configured local domain Compose overlay that is merged after the upstream AI-EngKit base. The effective configuration SHALL be used for Admin upgrade, ai-dev restart, and every Admin-managed ai-dev recreate path. The overlay SHALL be applied only to the supported AI-EngKit service integration surface and SHALL NOT manage the domain worker lifecycle or Admin service configuration.

The overlay path SHALL be configured by `AI_ENGKIT_COMPOSE_OVERLAY` and SHALL resolve to a canonical path beneath the mounted `/opt/ai-engkit/extensions/` directory. The supported overlay surface SHALL be limited to `ai-dev` environment, networks, named volumes, labels, and healthchecks. Host bind mounts, including Docker socket mounts, are forbidden. The overlay SHALL NOT change the image, container identity, command, entrypoint, published ports, privilege settings, Admin service, or domain worker services. The upstream base SHALL be staged under the `/opt/ai-engkit` Compose project directory before validation.

#### Scenario: Upgrade preserves a domain network integration

- **WHEN** a valid overlay adds an external network to `ai-dev` and the domain worker is attached to that network
- **THEN** an upgrade recreates `ai-dev` with the external network attached and the worker can resolve the stable `ai-dev` service name on that network

#### Scenario: Restart retains the overlay

- **WHEN** a valid overlay is configured and an Admin-managed ai-dev restart or recreate is requested
- **THEN** the operation uses the same base-plus-overlay effective configuration rather than the base file alone

#### Scenario: Unsupported overlay ownership is rejected

- **WHEN** the overlay attempts to modify an Admin or domain worker service, or a protected `ai-dev` field such as image, command, published ports, privilege, or Docker socket mounts
- **THEN** validation fails before recreation and the active deployment remains unchanged

#### Scenario: No overlay preserves existing behavior

- **WHEN** no overlay is configured
- **THEN** upgrade and restart behavior remains compatible with the existing single-file Compose workflow

### Requirement: Effective Compose configuration is validated before mutation

The system SHALL validate the merged base-plus-overlay Compose configuration before replacing the active base reference or recreating any container. Validation SHALL fail closed when the overlay is unreadable, the merged configuration is invalid, or the expected `ai-dev` service is missing or renamed.

#### Scenario: Invalid overlay blocks recreation

- **WHEN** the configured overlay cannot be read or the merged Compose configuration fails validation
- **THEN** no container is recreated and the active deployment remains unchanged while the failure is reported

#### Scenario: Upstream removes ai-dev

- **WHEN** the selected upstream base no longer contains the expected `ai-dev` service
- **THEN** the upgrade fails before recreation and does not guess a replacement service

### Requirement: Failed effective-configuration upgrades attempt complete rollback

When recreation or health verification fails after an effective configuration has been staged, the system SHALL attempt to restore the previous base, overlay reference/content, environment, and container configuration before reporting the failure. If complete restoration is not possible, the result SHALL identify the incomplete rollback.

#### Scenario: Health failure restores the previous effective configuration

- **WHEN** the new base-plus-overlay configuration recreates `ai-dev` but health verification times out
- **THEN** the system attempts to restore the previous effective configuration and start the previous deployment again

#### Scenario: Rollback failure is visible

- **WHEN** restoration of any effective-configuration component fails
- **THEN** the upgrade result reports the original failure and the incomplete rollback details

### Requirement: Overlay lifecycle status is reported without exposing secrets

The Admin upgrade status and outcome SHALL indicate whether a local overlay is active and whether effective configuration validation succeeded or failed. Status and logs SHALL not expose `.env` secret values or arbitrary overlay file contents.

#### Scenario: Active overlay is reported before upgrade

- **WHEN** an upgrade is requested with a configured readable overlay
- **THEN** the Admin status identifies that an overlay is active and warns that the effective base-plus-overlay configuration will be recreated

#### Scenario: Validation error is actionable

- **WHEN** overlay validation fails
- **THEN** the Admin status identifies the validation failure and the affected path or service without exposing secret values

### Requirement: Host upgrade path does not silently discard a configured overlay

The host `upgrade.sh` path SHALL apply the same validated single-overlay workflow for configured overlays so existing installations can bootstrap the overlay-aware Admin image. It SHALL stage the target base, validate the overlay-only and merged configurations, verify the target base exposes the required overlay mounts, back up the previous effective inputs, and recreate `ai-admin` and `ai-dev` with base plus overlay. It SHALL stop before replacing the active base when any prerequisite or validation fails.

#### Scenario: Host upgrade bootstraps an existing overlay installation

- **WHEN** `upgrade.sh` detects a valid configured overlay and the target base exposes the required overlay mounts
- **THEN** it replaces the active base only after validation and recreates `ai-admin` and `ai-dev` with the effective base-plus-overlay configuration

#### Scenario: Host upgrade refuses unsafe overwrite

- **WHEN** `upgrade.sh` detects an invalid overlay, missing validator, or target base without the required overlay mounts
- **THEN** it exits before replacing the active base file and reports the prerequisite failure
