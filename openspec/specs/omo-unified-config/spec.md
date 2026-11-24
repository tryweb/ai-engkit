# OMO unified config

> **Historical V1-only specification.** This spec describes the retired OMO
> runtime and does not apply to the V2 branch. V2 does not install, configure,
> or invoke the OMO plugin; only the explicit legacy-data import in
> `scripts/migrate-omo-to-native.sh` remains.

## Purpose

Ship pinned OMO agent defaults in a unified config while preserving user customizations and preventing legacy migration failures.

## Requirements

### Requirement: Ship OMO defaults in omo.jsonc format
AI-EngKit SHALL ship its OMO agent defaults as an omo.jsonc-format template (`.opencode/omo.jsonc.default`), baked into the image at `/etc/opencode/omo.jsonc.default`. The template SHALL contain the supported agent presets and SHALL conform to the schema of the pinned OMO release. Agent entries SHALL NOT contain a `permission` key; required per-tool restrictions SHALL use schema-valid `tools` booleans. Primary model overrides SHALL use top-level `agents.<name>.model`, and the template SHALL NOT contain model entries under `[opencode].agents`.

#### Scenario: Image contains omo.jsonc default
- **WHEN** the Docker image is built
- **THEN** `/etc/opencode/omo.jsonc.default` parses as valid JSONC, contains no agent `permission` key or `[opencode].agents` model layer, and passes the pinned OMO config migration dry run without validation errors

#### Scenario: Legacy template no longer installed to runtime config
- **WHEN** a container starts from the image
- **THEN** the entrypoint does not create or update `~/.config/opencode/oh-my-openagent.json`

#### Scenario: Read-only restrictions use tools
- **WHEN** a shipped agent preset restricts shell or write tools
- **THEN** those restrictions are represented under `agents.<name>.tools` with boolean values

### Requirement: Runtime omo.jsonc generation and merge
The entrypoint SHALL ensure `~/.omo/omo.jsonc` exists and SHALL idempotently normalize known incompatible settings before OMO starts. It SHALL remove stale `[opencode].agents` model entries, convert known per-tool `permission` allow/deny entries to equivalent `tools` booleans, remove redundant allow-all permission entries, and preserve top-level `agents.<name>.model` plus unrelated user settings. If an unsupported permission shape cannot be converted without changing meaning, startup SHALL preserve the original value and report an actionable validation error rather than silently deleting it.

#### Scenario: First start creates omo.jsonc from default
- **WHEN** a container starts with an empty `~/.omo/`
- **THEN** `~/.omo/omo.jsonc` is created from the shipped defaults without unsupported permission or stale migration model entries

#### Scenario: Known stale settings are normalized
- **WHEN** an existing file contains `[opencode].agents.librarian.model` and known agent `permission` entries alongside `agents.librarian.model`
- **THEN** the stale migration agent layer is removed, known tool restrictions are represented under `tools`, and the top-level librarian model is preserved

#### Scenario: Unrelated customization is preserved
- **WHEN** normalization processes an existing user configuration
- **THEN** unrelated top-level keys, unrelated agent settings, and the `$schema` value remain unchanged

#### Scenario: User customizations preserved across restarts
- **WHEN** a normalized user configuration contains supported custom agent models, tools, or unrelated settings and the container restarts
- **THEN** those supported customizations remain unchanged

#### Scenario: Idempotent repeated starts
- **WHEN** the normalized container starts again without user edits
- **THEN** `~/.omo/omo.jsonc` is byte-identical after the second startup

#### Scenario: Unsupported permission shape is not silently weakened
- **WHEN** an existing permission value cannot be represented by the supported `tools` map
- **THEN** the entrypoint retains that value, reports the incompatible path, and does not claim normalization succeeded

### Requirement: Schema pinned to release tag
The `$schema` URL in the shipped omo.jsonc default SHALL reference the same verified tagged oh-my-openagent release as the runtime pin, not a floating branch such as `dev`.

#### Scenario: Schema URL is tag-pinned
- **WHEN** inspecting `/etc/opencode/omo.jsonc.default`
- **THEN** the `$schema` value contains the pinned release tag and does not contain `/dev/`

### Requirement: Coexistence with OMO legacy migration
AI-EngKit SHALL archive, but not import or delete, every recognized legacy OMO config filename before OMO starts. The archive SHALL remain within `~/.config/opencode` so the rename does not cross Docker volumes. AI-EngKit SHALL then generate unified defaults directly, leaving OMO no recognized legacy migration source.

#### Scenario: Existing legacy file auto-migrates once
- **WHEN** a container with a pre-existing legacy `oh-my-openagent.json` starts on the new image
- **THEN** the legacy file is present under an AI-EngKit backup suffix in `~/.config/opencode`, `~/.omo/omo.jsonc` contains the supported defaults, and OMO creates neither a migration journal nor an OMO migration backup

#### Scenario: Legacy file is preserved for manual recovery
- **WHEN** a container starts with a recognized legacy OMO config
- **THEN** its original content is retained under an AI-EngKit backup suffix in `~/.config/opencode` and is not imported into unified config

### Requirement: OMO version pinned and declared at runtime
The Dockerfile SHALL pin `OH_MY_OPENAGENT_VERSION` to the currently verified release (4.19.4). The entrypoint SHALL emit `oh-my-openagent@<pinned-version>` for an unset or bare `oh-my-openagent` plugin token; an explicitly versioned user token remains unchanged. The shipped omo.jsonc default `$schema` SHALL reference the same pinned version tag.

#### Scenario: Generated plugin declaration is pinned
- **WHEN** a container starts without an explicitly versioned OMO plugin token
- **THEN** generated `opencode.json` declares the same explicit version as `OH_MY_OPENAGENT_VERSION`, and `check-versions.sh` tracks that version against upstream

#### Scenario: Default schema matches runtime pin
- **WHEN** inspecting `/etc/opencode/omo.jsonc.default`
- **THEN** its `$schema` URL references the same version tag as `OH_MY_OPENAGENT_VERSION`
