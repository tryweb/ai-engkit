# Spec Delta

## Purpose

Defines the AI-EngKit v1 runtime's image-controlled core update policy, offline integrity recovery, managed CLI repair, and data-preserving startup refusal.

## ADDED Requirements

### Requirement: OpenChamber web self-update is rejected before execution

The system SHALL reject any OpenChamber web self-update request synchronously with an HTTP 409 response carrying a JSON body whose `error` field explains that the runtime core is image-managed. The rejection SHALL occur before any "update accepted" success response is returned and before any installation child process is scheduled or spawned.

#### Scenario: Web update request is refused
- **WHEN** an authenticated browser or client sends an OpenChamber web update-install request
- **THEN** the response is HTTP 409 with a JSON `error` explaining the core is image-managed, and no installer process is spawned

#### Scenario: No success acknowledgement precedes refusal
- **WHEN** the update-install endpoint is called
- **THEN** no HTTP success acknowledgement is emitted and no detached installation is scheduled

### Requirement: OpenChamber CLI self-update exits nonzero

The system SHALL make the `openchamber update` CLI command fail with a nonzero exit status and a managed-install explanation instead of installing `@openchamber/web@latest` into the running container.

#### Scenario: CLI update is refused
- **WHEN** an operator runs `openchamber update` in the container
- **THEN** the command exits nonzero and reports that the core is image-managed

### Requirement: OpenChamber-managed OpenCode upgrade is rejected

The system SHALL reject the OpenChamber-managed OpenCode upgrade endpoint so the web UI cannot independently replace the CLI half of the pinned core, returning the same managed-install refusal.

#### Scenario: Managed OpenCode upgrade is refused
- **WHEN** the web UI calls the OpenChamber-managed OpenCode upgrade endpoint
- **THEN** the request is rejected with a managed-install explanation and no upgrade is executed

### Requirement: Update checks and notifications remain unchanged

The system SHALL NOT disable, suppress, or alter OpenChamber or OpenCode update checks, update notifications, or notification settings as part of core update protection. Notification visibility SHALL remain independent of the update execution policy.

#### Scenario: Notifications still render
- **WHEN** an update notification setting is enabled and a newer version is advertised
- **THEN** the notification is still shown and update checks still run

### Requirement: Core update policy is baked into the image

The managed core update policy SHALL be baked into the image build and SHALL NOT be exposed as a user-facing runtime notification toggle that enables or disables update protection.

#### Scenario: No runtime disable switch
- **WHEN** an operator inspects runtime configuration and environment variables
- **THEN** no setting disables or re-enables core update protection

### Requirement: Managed core is isolated from user packages

The system SHALL place the managed core and its launch executable in a dedicated image-owned prefix separate from the user global Bun package location, so user-installed packages and the managed core do not overwrite each other.

#### Scenario: User package install does not touch the core
- **WHEN** a user installs an unrelated global Bun package
- **THEN** the managed core files under the dedicated prefix remain unchanged

### Requirement: Core install carries a complete dependency closure

The managed core installation SHALL include its full transitive, platform-specific, and symlinked dependency closure, and its launch wrappers SHALL remain resolvable through the existing PATH and by current script consumers.

#### Scenario: Launch works through PATH
- **WHEN** the runtime launches the managed core through its existing PATH contract
- **THEN** the executable resolves with no missing transitive or platform dependency

### Requirement: Reserved core package names are rejected

The AI-EngKit startup package installer SHALL reject requests for managed-core package names with a clear error before installing any package from that request. This policy SHALL NOT globally intercept arbitrary Bun commands or prevent unrelated user package installation.

#### Scenario: Reserved name rejected
- **WHEN** `BUN_PACKAGES` includes `opencode-ai`, `@opencode/cli`, or `@openchamber/web`, with or without a version
- **THEN** the startup install request is refused before mutation with an explicit reserved-name error

### Requirement: Build fails on upstream pin mismatch

The image build SHALL verify that the pinned upstream sources match the expected version and source shape and SHALL fail the build when a check does not match, rather than shipping reduced guard coverage.

#### Scenario: Mismatched upstream fails the build
- **WHEN** a pinned upstream source does not match the expected version or source shape
- **THEN** the build fails with a diagnostic instead of completing

### Requirement: Expected pins are emitted as build metadata

The system SHALL derive expected core versions and identifiers from image build arguments and emit them as build metadata, and SHALL NOT parse the repository at runtime to determine expected versions.

#### Scenario: Runtime reads build metadata
- **WHEN** the runtime needs the expected core versions
- **THEN** it reads the build-emitted metadata and does not inspect the source repository

### Requirement: Root-owned offline recovery artifact with integrity manifest

The image SHALL ship a root-owned pristine core archive together with an explicit pin and integrity manifest, and recovery SHALL NOT perform a network reinstallation at runtime.

#### Scenario: Recovery uses the offline artifact
- **WHEN** the managed core must be recovered
- **THEN** the root-owned archive and manifest are used with no network access

#### Scenario: No network reinstall at startup
- **WHEN** the container starts with a missing or drifted core
- **THEN** recovery uses only image-local artifacts and performs no network fetch

### Requirement: Integrity verification precedes exact-tree restore

The system SHALL verify the managed core against the integrity manifest and, on drift or corruption, restore the exact pinned tree so that no partially restored core is ever active.

#### Scenario: Drift triggers a verified restore
- **WHEN** a partial install, same-version drift, or unexpected core file is detected and the offline recovery artifact is valid
- **THEN** the core is restored to the exact pinned tree and no partial tree is ever active

#### Scenario: Invalid recovery source is refused
- **WHEN** the recovery archive or manifest is missing or fails integrity validation
- **THEN** core startup is blocked with guidance and no unverified tree replaces the active installation

#### Scenario: Recovery retains update protection
- **WHEN** the pinned core is restored from the offline artifact
- **THEN** its web and CLI update refusal behavior remains in effect

#### Scenario: Restore is idempotent
- **WHEN** recovery runs again on an already-recovered core
- **THEN** it reports a clean state without altering unrelated data

### Requirement: Recovery runs before user install and application startup

The system SHALL verify and recover the managed core at startup before user package installation, configuration generation and application, and application startup, and SHALL NOT activate this recovery path for the ai-admin command.

#### Scenario: Startup ordering
- **WHEN** the ai-dev container starts with a missing or drifted core
- **THEN** recovery completes before user packages, configuration, and the application start

#### Scenario: Admin command does not run recovery
- **WHEN** the ai-admin service or command starts
- **THEN** managed-core startup recovery does not run

### Requirement: Managed CLI selection repair is narrow and atomic

Before startup the system SHALL repair only a known image-managed or missing legacy OpenCode CLI selection, writing it atomically and taking a protected backup, while preserving unrelated settings, file permissions, and valid custom selections.

#### Scenario: Stale managed selection repaired
- **WHEN** the known legacy managed CLI path is stale or missing
- **THEN** it is repaired atomically with a backup, and unrelated settings and packages are preserved

#### Scenario: Valid custom selection preserved
- **WHEN** the settings contain a valid custom CLI selection
- **THEN** the custom selection is left intact

#### Scenario: Existing custom v2 binary is not launched
- **WHEN** a custom CLI selection resolves to a v2 executable in the v1 environment
- **THEN** startup is refused with guidance and the custom binary and settings selection are preserved

#### Scenario: Unsafe settings file is preserved
- **WHEN** the settings file is malformed or is a symlink
- **THEN** startup reports the unsafe settings and does not replace the file or its target

### Requirement: Unknown custom CLI selection is an explicit error

When a referenced custom CLI path is missing and is not the known image-managed legacy path, the system SHALL report an explicit error and SHALL NOT silently overwrite the selection.

#### Scenario: Unknown missing path errors
- **WHEN** the configured custom CLI path is missing and unrecognized
- **THEN** startup reports an explicit error and does not overwrite the selection

### Requirement: Read-only data compatibility gate before V1 touches state

Before the V1 binary touches session state, the system SHALL run a read-only compatibility gate that permits a fresh or recognized v1 database and blocks v2 or unknown schemas with the data files left untouched, without starting the old binary to probe the database.

#### Scenario: Fresh database allowed
- **WHEN** no session database exists yet
- **THEN** startup proceeds and creates fresh state

#### Scenario: Recognized v1 database allowed
- **WHEN** a recognized v1 session database is present
- **THEN** startup proceeds normally

#### Scenario: Session content does not change compatibility
- **WHEN** new sessions have been inserted into a supported v1 schema
- **THEN** the database is still recognized without depending on its content hash

#### Scenario: v2 or unknown schema blocked
- **WHEN** a v2 or unknown schema is detected
- **THEN** startup refuses and leaves the data files untouched

#### Scenario: Gate does not start the old binary
- **WHEN** the compatibility gate runs
- **THEN** the old binary is not started to inspect the database

### Requirement: SQLite gate is WAL-aware and non-writing

The data compatibility gate SHALL inspect SQLite without ignoring write-ahead log or shared-memory files, SHALL NOT write, checkpoint, or otherwise mutate the database, and SHALL block on locked, corrupt, or unknown databases with operator recovery guidance.

#### Scenario: WAL sidecar considered
- **WHEN** a write-ahead log or shared-memory file accompanies the database
- **THEN** the gate accounts for it without writing to or checkpointing the database

#### Scenario: Locked or corrupt database blocks
- **WHEN** the database is locked, corrupt, or of an unknown schema
- **THEN** the gate blocks startup with guidance and leaves the files untouched

### Requirement: No automatic database rollback or session deletion

The system SHALL NOT automatically restore database backups or delete newly created sessions as part of the compatibility gate or core recovery.

#### Scenario: No destructive rollback
- **WHEN** the compatibility gate blocks startup
- **THEN** no database backup is restored and no session is deleted automatically

### Requirement: Healthy v1 installations still boot

An existing healthy v1 configuration and session database SHALL still boot after this change is deployed.

#### Scenario: Healthy v1 boots unchanged
- **WHEN** a healthy v1 configuration and session database are present
- **THEN** the application starts normally

### Requirement: Startup failures avoid destructive retries

On a blocked ai-dev preflight the system SHALL emit clear guidance, skip application launch, and remain signal-responsive without state-mutating retries or repeated exits under the configured Docker restart policy. Application health SHALL NOT report success while blocked.

#### Scenario: Failure logged without a retry loop
- **WHEN** startup cannot proceed
- **THEN** clear diagnostic logs are written and no destructive retry loop runs

#### Scenario: Docker policy does not create a refusal loop
- **WHEN** incompatible data blocks startup under `restart: unless-stopped`
- **THEN** the application remains stopped, the container does not repeatedly restart, and explicit operator remediation and restart are required to retry

### Requirement: Bypass limitations are documented

The change SHALL document that image-based update protection prevents accidental updates only, cannot stop a deliberate sudo or Docker-level bypass, and does not guarantee a generic v2 downgrade.

#### Scenario: Documentation states the boundary
- **WHEN** a reader reviews the change documentation
- **THEN** it states the accidental-update boundary and the absence of a generic v2 downgrade guarantee
