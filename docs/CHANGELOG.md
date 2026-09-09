## [Unreleased]

## [1.18.8] - 2026-09-09

### Added
- Add Google to key-managed providers
- Hydrate component versions asynchronously
- Add async upgrade loading states
- Dashboard Projects card shows CodeGraph index health
- Dashboard LSP pill with enabled count and deferred hydration

### Fixed
- Render upgrade shell before version discovery

### Changed
- Polish Providers UI with icons, status and review fixes
- Simplify LSP server management display

## [1.18.7] - 2026-09-08

### Added
- Add scheduled and manually confirmed OpenCode database maintenance from the admin dashboard.
- Add read-only database health metrics, retention policy configuration, and off-peak scheduling.
- Add fail-closed backup, idle-session, WAL, headroom, and database verification guards.

### Fixed
- Resolve persistent Docker-out-of-Docker backup paths before creating maintenance backups.
- Measure database size and free space from the resolved OpenCode data volume when ai-dev is stopped.
- Clean up maintenance SSE subscribers on terminal completion, request abort, and stream cancellation.

### Documentation
- Add the database maintenance specification, operational runbook, rollback runbook, and retention-field boundary notes.

### Tests
- Add coverage for database maintenance, backup and disk-space fallbacks, scheduler behavior, health routes, retention policy, and SSE lifecycle cleanup.

## [1.18.6] - 2026-09-07

### Added
- Group LSP servers and clarify built-ins.

### Fixed
- Count LSP block changes.

### Changed
- Update the Ubuntu 24.04 APT package snapshot (18 packages have updates: bsdutils (1:2.39.3-9ubuntu6.5),coreutils (9.4-3ubuntu6.2),diffutils (1:3.10-1build1),ncurses-bin (6.4+20240113-1ubuntu2.1),util-linux (2.39.3-9ubuntu6.5),ncurses-base (6.4+20240113-1ubuntu2.1),mount (2.39.3-9ubuntu6.5),libattr1 (1:2.5.2-1build1.1),libblkid1 (2.39.3-9ubuntu6.5),libbz2-1.0 (1.0.8-5.1build0.1),libgcrypt20 (1.10.3-2ubuntu0.1),libmount1 (2.39.3-9ubuntu6.5),libsmartcols1 (2.39.3-9ubuntu6.5),libncursesw6 (6.4+20240113-1ubuntu2.1),libtinfo6 (6.4+20240113-1ubuntu2.1),libuuid1 (2.39.3-9ubuntu6.5),zlib1g (1:1.3.dfsg-3.1ubuntu2.1),gpgv (2.4.4-2ubuntu17.4)).
- Install ripgrep for the dependency-update compose isolation guard.
- Apply responsive styles to grouped LSP tables.

### Documentation
- Update admin dashboard screenshots.
- Document lean-ctx background shell polling.

## [1.18.5] - 2026-09-06

### Added
- Upgrade lean-ctx from 3.10.0 to 3.10.1.

## [1.18.4] - 2026-09-06

### Added
- Upgrade OpenChamber from 1.22.1 to 1.22.2.

### Documentation
- Document the OpenChamber self-update boundary.
- Update the README and Admin Dashboard screenshot.

### Changed
- Install ripgrep for the Compose isolation guard.

### Tests
- Avoid Docker-dependent exact cookie tests.

## [1.18.3] - 2026-09-05

### Fixed
- Align admin view type contracts
- Narrow secret and SSH route results
- Narrow projects route results
- Preserve project sync result typing
- Align LSP route payloads
- Type provider OAuth routes
- Narrow core route result handling
- Preserve upgrade rollback semantics
- Type restart result unions
- Narrow provider metadata results
- Narrow project library results
- Type model metadata results
- Align LSP config and reconciler contracts
- Harden Docker command execution
- Narrow agent model reconciliation results
- Normalize agent model contracts
- Inject real restart command dependencies

### Documentation
- Document compose test isolation
- Update contribution workflow
- Add English-only language policy, translate bg-notification entry

### Changed
- Update OpenCode and Playwright pins
- Add compose isolation regression guard
- Update dependency pin expectations
- Scope memory E2E to dev containers
- Harden leanctx evaluator fixtures
- Scope admin integration scripts to dev compose
- Scope core integration scripts to dev compose
- Update admin P1/P2 coverage
- Update upgrade route contracts
- Update status dependency fixtures
- Update agent contract fixtures
- Add typecheck toolchain
- Update dependency workflow guidance
- Tighten root TypeScript configuration
- Isolate dev compose and installer flows
- Gate admin checks and compose isolation

### Changed
- Upgrade OpenCode from 1.18.28 to 1.18.29.
- Upgrade Playwright from 1.62.1 to 1.63.0.

## [1.18.2] - 2026-09-05

### Added
- Bump Docker 29.7.2→29.8.0, Compose 5.5.0→5.5.1, OpenCode 1.18.27→1.18.28, OpenChamber 1.22.0→1.22.1, gh 2.99.0→2.100.0

### Documentation
- Add OpenCode V2 migration watch

### Changed
- Upgrade Docker Engine from 29.7.2 to 29.8.0.
- Upgrade Docker Compose from 5.5.0 to 5.5.1.
- Upgrade OpenCode from 1.18.27 to 1.18.28.
- Upgrade OpenChamber from 1.22.0 to 1.22.1.
- Upgrade GitHub CLI from 2.99.0 to 2.100.0.

## [1.18.1] - 2026-09-04

### Added
- Consolidate sidebar menu from 16 to 11 items

## [1.18.0] - 2026-09-03

### Added
- Admin-managed LSP server configuration (catalog, version selection, entrypoint lsp block, reconciler + apply)
- Bump buildx 0.36.1→0.37.0, opencode 1.18.25→1.18.27, glab 1.115.0→1.116.0, playwright-mcp 0.0.79→0.0.80, gh 2.98.0→2.99.0, openspec 1.11.0→1.12.0
- Add agent model verification modes

### Fixed
- Sync native overrides for multi-slash model IDs
- Escape agent model confirmation newlines
- Expose agent model verification controls
- Apply inference verification for reconciler changes
- Prevent agent model apply quota hangs
- Handle provider quota during model probing
- Preserve verified agent history mapping
- Bound agent model history collection

### Documentation
- Archive agent model quota-hang change
- Sync agent model quota-hang specifications
- Document agent model history scan policy

### Changed
- Upgrade Docker Buildx from 0.36.1 to 0.37.0.
- Upgrade OpenCode from 1.18.25 to 1.18.27.
- Upgrade GitHub CLI from 2.98.0 to 2.99.0.
- Upgrade GitLab CLI from 1.115.0 to 1.116.0.

### Tests
- Cover agent model apply flow end to end
- Extend agent model health coverage
- Update agent model history fixtures

## [1.17.0] - 2026-09-01

### Added
- Bump Playwright MCP to 0.0.80
- Add dashboard runtime data
- Redesign dashboard view
- Persist applied LeanCTX snapshots
- Add dashboard aggregate summaries
- Add OpenRouter provider support
- Add role-aware model diversity policy

### Fixed
- Show Pinned state on dashboard when AI_ENGKIT_VERSION is set
- Make dashboard restart handling explicit
- Harden admin restart flow

### Documentation
- Archive dashboard runtime overview change
- Add dashboard runtime overview spec
- Update LeanCTX admin config
- Update dashboard value metrics
- Update dashboard design contract
- Mention OpenRouter in provider guidance
- Document admin restart self-destruct fix
- Sync agent model selection specification
- Archive role-aware scoring requirements
- Archive role-aware scoring rationale
- Archive bounded diversity requirements
- Archive bounded diversity rationale
- Specify bounded diversity tasks
- Add bounded diversity proposal
- Specify role-aware scoring tasks
- Add role-aware scoring proposal

### Changed
- Polish dashboard layout
- Archive role-aware scoring metadata
- Archive bounded diversity metadata

### Changed
- Upgrade @playwright/mcp from 0.0.79 to 0.0.80.

## [1.16.8] - 2026-08-31

### Added
- Add agent model suggestion modes with bounded metadata catalog
- Expose mode-aware suggestions API
- Align upgrade target UI state

### Fixed
- Align upgrade route target modes

### Changed
- Upgrade OpenChamber from 1.21.1 to 1.22.0.

### Documentation
- Specify agent model selection modes
- Align upgrade channel specification

## [1.16.7] - 2026-08-31

### Added
- Add upgrade target selector
- Add version-aware upgrade API
- Add GHCR release discovery

### Fixed
- Route dashboard upgrades through official release
- Keep update checks on latest image
- Harden native override command quoting
- Verify decorated runtime agent assignments

### Documentation
- Add upgrade version selection spec
- Archive upgrade version selector change
- Update OMO v5 upgrade impact assessment to beta.30
- Document native agent bridge reconciliation
- Document decorated agent runtime verification

### Changed
- Cover stale runtime request history

## [1.16.6] - 2026-08-30

### Fixed
- Warn on partial mTLS configuration
- Track partial mTLS configuration
- Preserve invalid primaries during reconciliation
- Reclaim old release-tag images in pinned installs

### Documentation
- Make partial mTLS warning advisory
- Define invalid configured model preservation
- Simplify dashboard metrics scope
- Align reconfigure payload field
- Correct leanctx and superpowers specifications

## [1.16.5] - 2026-08-30

### Fixed
- Make Agent Models table mobile-friendly
- Make reconciliation deterministic
- Anchor session cookie match and guard signature length

### Documentation
- Record cookie substring session shadowing fix

### Changed
- Add responsive Agent Models table layout

## [1.16.4] - 2026-08-29

### Changed
- Simplify LeanCTX Admin configuration around the Docker image baseline, global persisted config, structured Save/Reset/Validate, and `lean-ctx config apply` without container recreation.
- Upgrade OpenCode from 1.18.23 to 1.18.25.
- Upgrade OpenChamber from 1.21.0 to 1.21.1.
- Upgrade lean-ctx from 3.9.20 to 3.10.0.

### Removed
- Remove Admin drift/status/doctor/set/delete routes, lifecycle drift UI, and the reliability gate from the `leanctx-admin-config` capability contract.

## [1.16.3] - 2026-08-27

### Added
- Batch apply agent models with single restart and pending UI

### Fixed
- Extend health wait to 180s, add RECONCILE_STARTUP_NO_RESTART no-kill path and CLI exit on failed

### Documentation
- Capture managed OpenCode health timeout

### Changed
- Update route test fixtures
- Wait through lifecycle health checks
- Log decisions before applying changes
- Apply reconciliation changes as one batch
- Add port re-discovery in polling loop

## [1.16.2] - 2026-08-27

### Added
- Pin CodeGraph to v1.6.0 and resolve deferred vulnerabilities.

### Fixed
- Publish the injected dependency image.
- Defer latest image promotion.

### Changed
- Upgrade OpenChamber from 1.20.0 to 1.21.0.
- Upgrade @fission-ai/openspec from 1.10.0 to 1.11.0.
- Remove original OpenSpec change directories after archiving.
- Add the Superpowers main specification.
- Archive the Superpower per-project enablement change.
- Sync and archive the lean-ctx reliability-gate specifications.

## [1.16.1] - 2026-08-26

### Changed
- Update the Ubuntu 24.04 APT package snapshot (3 packages have updates: libssl3t64 (3.0.13-0ubuntu3.12),libproc2-0 (2:4.0.4-4ubuntu3.2),procps (2:4.0.4-4ubuntu3.2)).

## [1.16.0] - 2026-08-26

### Added
- Harden agent model reconciliation (#66)

### Fixed
- Improve UX during model restart process

### Documentation
- Document -p dev dev/prod isolation for users
- Document dev/prod isolation in knowledge base troubleshooting notes
- Document dev/prod isolation in knowledge base tooling notes
- Document dev/prod isolation in knowledge base patterns

### Changed
- Remove unused .release directory
- Use -p dev project namespace in docker compose commands
- Use -p dev project namespace in dev container helper
- Use -p dev project namespace in docker compose commands

### Changed
- Upgrade GitLab CLI from 1.114.0 to 1.115.0.
- Upgrade lean-ctx from 3.9.19 to 3.9.20.

## [1.15.8] - 2026-08-25

### Added
- Warn about lean-ctx drift
- Expose lean-ctx drift status
- Detect lean-ctx runtime drift

### Fixed
- Migrate lean-ctx compression safely
- Default compression to off
- Accept multi-segment model ids; stabilize unit-test JSX transform (#62)

### Documentation
- Record fail-closed authority verdict
- Specify lean-ctx admin reliability
- Propose lean-ctx reliability gate
- Add troubleshooting entry for OpenChamber 1.20.0 default project regression
- Note root tsconfig fixes repo-root bun test JSX transform
- Record lean-ctx shell silent write-drop workaround

### Changed
- Update OpenCode to 1.18.23
- Exclude entrypoint test helpers
- Add disposable reliability harness
- Run live reliability profiles
- Verify frozen gate criteria
- Add reliability evaluator CLI
- Implement reliability gate checks
- Render reliability verdicts
- Evaluate reliability captures
- Capture deterministic command output
- Parse evaluation manifests and records
- Add evaluator foundations
- Add reliability evaluation fixtures
- Cover lean-ctx drift recovery

### Changed
- Upgrade OpenCode from 1.18.21 to 1.18.23.

## [1.15.7] - 2026-08-24

### Added
- Add probe spinner and cancel handling
- Auto-import auth-store keys into empty registry
- Add real model availability probe via opencode session API
- Restart ai-dev and verify lean-ctx daemon in LeanCTX apply flow

### Changed
- Remove obsolete OMO model defaults setting

## [1.15.6] - 2026-08-24

- Fix release test container and password setup
- Record release-channel publish/promote design
- Add promote-stable workflow
- Cancel superseded runs, gate suites post-merge, drop auto-latest
- Honor AI_ENGKIT_VERSION pin in upgrade.sh
- Parametrize image tag with AI_ENGKIT_VERSION
- Resolve deployable image ref via AI_ENGKIT_VERSION pin
- Rewrite triage escape-hatch guidance in baked AGENTS.md
- Correct lean-ctx triage guidance after live verification
- Record AGENTS.md default sync deadlock knowledge
- Sync AGENTS.md template block by content hash
- Preserve custom providers during dev sync
- Record agent-model verification knowledge
- Add agent-model health verification tests
- Route agent-model verification to the specified agent
- Add agent-model health verification with rollback
- Label Nvidia provider in admin
- Add Nvidia auth key support

## [1.15.5] - 2026-08-23

### Added
- Expose verified agent model status
- Verify agent model runtime assignments
- Use connected provider capability policy

### Fixed
- Mirror native plan model overrides
- Prevent overlapping sidebar active states
- Disable agent model editing without catalog
- Reject model changes without available catalog
- Expose model catalog availability in agent state
- Source agent model catalog from live providers
- Allowlist plan native agent in inline-agents integration check

### Removed
- Remove test file

### Documentation
- Add agent model troubleshooting records
- Update agent model migration knowledge
- Capture connected provider reconciliation rules
- Add knowledge recall-first workflow to baked AGENTS.md
- Add defensive jq usage guidance to baked AGENTS.md
- Document OpenChamber upgrade verification

### Changed
- Verify agent model request assignments
- Cover provider model verification commands

### Changed
- Upgrade OpenChamber from 1.19.0 to 1.20.0.

## [1.15.4] - 2026-08-22

### Added
- Bump OpenCode 1.18.19 -> 1.18.21, gh 2.97.0 -> 2.98.0
- Add LeanCTX config management

### Fixed
- Return invalid SSH key names as bad requests
- Enforce leanctx admin config contract
- Canonicalize leanctx runtime config
- Render leanctx editor inline script unescaped

### Documentation
- Archive leanctx admin config change
- Sync leanctx admin config specification

### Changed
- Bake playwright and @playwright/mcp CLIs into the image
- Add Bun Playwright E2E manifest
- Harden admin e2e coverage
- Align leanctx admin editor with schema

### Changed
- Upgrade OpenCode from 1.18.19 to 1.18.21.
- Upgrade GitHub CLI from 2.97.0 to 2.98.0.

## [1.15.3] - 2026-08-20

### Changed
- Bump OpenCode from 1.18.18 to 1.18.19

### Fixed
- Add SSH commands to lean-ctx shell allowlist

### Documentation
- Capture Docker volume persistence and lean-ctx troubleshooting updates

## [1.15.2] - 2026-08-20

### Fixed
- Update lean-ctx compression_level test to match Dockerfile lite setting
- Lower lean-ctx compression_level to lite and document triage escape hatches

### Documentation
- Capture lean-ctx triage blind-spot and bash-c permanent block
- Add lean-ctx shell-script execution guidance to AGENTS.md.default

### Changed
- Pin openspec version to v1.10.0

## [1.15.1] - 2026-08-19

### Fixed

- Rename add-modal addKey var to addName so it stops clobbering the registry addKey function

### Documentation

- Update OMO v5 upgrade impact assessment to beta.11

## [1.15.0] - 2026-08-19

### Added
- Bump lean-ctx from 3.9.18 to 3.9.19.

### Changed
- Upgrade lean-ctx from 3.9.18 to 3.9.19.

## [1.14.14] - 2026-08-18

## [1.14.13] - 2026-08-17

### Added
- Redesign Providers view
- Guard provider API-key routes
- Add ChatGPT OAuth routes
- Expose OpenAI provider metadata
- Extend OpenCode auth store
- Add OpenAI device-code OAuth
- Add CodeGraph reindex button to projects drawer

### Documentation
- Document Providers responsive contract

### Changed
- Add responsive Providers assets

## [1.14.12] - 2026-08-17

### Added
- Redesign projects page with filter bar, badges, and detail drawer
- Add project list CSS for redesigned projects page

### Fixed
- Raise API rate limit to 500/min and update projects page test for static JS
- Fix leanCTX active projects 24h count showing always zero

## [1.14.11] - 2026-08-17

### Added
- Add delete button and confirmation modal to projects UI
- Add DELETE /api/projects/:name/delete route with confirmation
- Add deleteProject() function for permanent project removal

### Fixed
- Inject version into dependency-update auto-release image

## [1.14.10] - 2026-08-16

### Changed
- Record the tracked latest version for @colbymchenry/codegraph as 1.5.0.
- Record the tracked latest version for @fission-ai/openspec as 1.9.0.
- Update the Ubuntu 24.04 APT package snapshot (3 packages have updates: libssl3t64 (3.0.13-0ubuntu3.11),libsystemd0 (255.4-1ubuntu8.16),libudev1 (255.4-1ubuntu8.16)).

## [1.14.9] - 2026-08-16

### Fixed
- Add content-hashed static asset URLs

### Changed
- Isolate filesystem mock in restart tests

## [1.14.8] - 2026-08-16

### Fixed
- Create project fixture for admin UI smoke test

## [1.14.7] - 2026-08-16

### Added
- Improve dashboard site overview UX
- Show feature stats tooltips for knowledge, maintenance, and openspec on projects overview
- Remove leanCTX column from projects overview and update e2e
- Surface leanCTX site and gain telemetry in status API and dashboard
- Add tool status probe with leanCTX site and gain telemetry

### Documentation
- Record dashboard overview UX pattern
- Document admin dashboard design contract

### Changed
- Archive admin-project-codegraph-leanctx-status and sync spec

## [1.14.6] - 2026-08-15

### Fixed
- Recreate ai-admin via helper container on restart

### Documentation
- Record agent restart helper-container fix

## [1.14.5] - 2026-08-15

### Added
- Support remote agent model query and set commands
- Add agent-models protocol command catalog
- Support clearing configured agent models

### Fixed
- Clarify agent model rollback failure

### Documentation
- Document agent-models protocol commands

### Changed
- Move agent model state collection into lib
- Verify clearing restores automatic model selection
- Cover agent model clear route

## [1.14.4] - 2026-08-15

### Added
- Bump OpenChamber 1.18.3 → 1.18.4
- Include configurable native subagents in agent-models
- Restrict agent models UI to primary model only
- Surface invalid agent config in model list
- Write agent model config with schema-valid keys
- Wire agent models routes and navigation
- Add agent model config UI page
- Add agent model config API routes
- Add agent model config domain library

### Fixed
- Report effective agent model resolution
- Normalize legacy agent configuration
- Verify managed server port reachability when discovering /agent
- Drop legacy permission key when writing agent model
- Space between invalid badge and source badge
- Write primary model only for agent model config

### Documentation
- Archive librarian model precedence change
- Sync and archive admin-agent-model-config change
- Sync and archive center-agent-remote-management change

### Changed
- Run OMO normalization regression
- Verify librarian Nemotron execution
- Cover agent model route resolution
- Cover split agent model configuration
- Split agent model configuration modules
- Align default config template with 4.19.4 schema
- Use schema-valid models key in agent-model e2e
- Add agent model config e2e script

### Changed
- Upgrade OpenChamber from 1.18.3 to 1.18.4.

## [1.14.3] - 2026-08-14

### Added
- Add center remote management commands for agent config

### Documentation
- Compose service label container discovery pattern
- Document remote management commands in agent-center-protocol
- Propose center-agent-remote-management change

### Changed
- Add grype ignore for headless Chromium and daemon-side docker GHSA

## [1.14.2] - 2026-08-14

### Added
- Report ai-dev upgrade availability in heartbeats
- Clarify provider registry wording and activation status
- Extract shared ai-dev restart helper
- Report per-container status for ai-dev and ai-admin in heartbeat

### Fixed
- Resolve test containers via compose service label
- Resolve ai-dev container via compose service label
- Discover ai-dev container via compose service label
- Only snapshot provider auth for key-managed providers in PUT active
- Harden provider key commands against failed applies and deferral
- Roll back provider auth and registry when a key apply fails

## [1.14.1] - 2026-08-14

### Added
- Bump openchamber 1.18.2 → 1.18.3

### Changed
- Upgrade OpenChamber from 1.18.2 to 1.18.3.

## [1.14.0] - 2026-08-13

### Added
- Bump opencode 1.18.17 → 1.18.18
- Bump opencode 1.18.16 → 1.18.17, glab 1.112.0 → 1.113.0
- Add provider-key commands to protocol catalog
- Implement provider-key command handlers with restart modes
- Drain deferred commands after terminal upgrade event

### Documentation
- Fix protocol doc citations and key-command semantics
- Sync provider-key specs and archive change

### Changed
- Cover provider-key round-trip and deferral in integration tests

### Changed
- Upgrade OpenCode from 1.18.16 to 1.18.18.
- Upgrade GitLab CLI from 1.112.0 to 1.113.0.

## [1.13.2] - 2026-08-11

### Fixed
- Load agent settings from the persisted admin-data environment at boot.
- Store provider registry and upgrade backups in admin-data.
- Migrate legacy provider-state data into admin-data during install and upgrade.
- Initialize admin-data persistence and permissions in dev containers.

### Documentation
- Document admin-data persistence and upgrade behavior.
- Sync admin-data persistence requirements to the main specs.
- Archive the admin-data-volume-and-agent-boot OpenSpec change.

### Changed
- Update the admin UI integration test to use the admin-data provider registry path.

## [1.13.1] - 2026-08-11

### Added
- Expose split agent credentials in settings
- Split agent registration credentials
- Bump OpenCode 1.18.15 → 1.18.16, OpenChamber 1.18.1 → 1.18.2

### Changed
- Upgrade OpenCode from 1.18.15 to 1.18.16.
- Upgrade OpenChamber from 1.18.1 to 1.18.2.

## [1.13.0] - 2026-08-10

### Added
- Add agent settings page, API, and env-file reload
- Apply URL-bootstrapped CA to the agent WebSocket
- Extract CA certificate from center registration URL
- Add query and event channels to agent protocol
- Add outbound agent connection module
- Add upgrade event lifecycle bridge
- Exclude disabled projects from sync
- Add disable/enable toggle to projects page
- Add project disable/enable API

### Fixed
- Point ai-admin at updated image in dependency-update CI
- Declare shared ai-dev image and order ai-admin after it
- Skip disabled projects in boot reconcile

### Documentation
- Capture OMO v5 upgrade impact pattern
- Add agent-center protocol specification
- Document CA-in-URL agent connection bootstrap
- Archive center-query-protocol change
- Sync center-query-protocol delta specs to main specs
- Archive agent-connection-module change
- Sync agent-connection-module delta specs to main specs
- Add center-query-protocol change proposal
- Revise agent-connection-module planning artifacts
- Capture disable/enable, JSX test-run, and typecheck-gap knowledge

### Changed
- Delegate routes to shared lib modules
- Extract shared read paths with tests
- Extract env redaction helper with tests

## [1.12.1] - 2026-08-09

### Added
- Add provider key note controls
- Add provider key note endpoints

## [1.12.0] - 2026-08-09

### Added
- Bump lean-ctx from 3.9.17 to 3.9.18.

### Documentation
- Update lean-ctx upgrade guidance.
- Document DooD workspace path incident.
- Warn against relative DooD workspace paths.

### Changed
- Upgrade lean-ctx from 3.9.17 to 3.9.18.

## [1.11.8] - 2026-08-08

### Added
- Configure `fallback_models` for the `plan`/`prometheus` agents via `.opencode/omo.jsonc.default` (OpenChamber 4.19.4 config-driven).

### Fixed
- Backfill `showOpenCodeUpdateNotifications: false` into existing OpenChamber settings at container start (`entrypoint.d/lib-openchamber-settings.bash`), so OpenCode update banners default to off on upgraded installs too; a user's explicit choice is never overwritten.
- Reconcile OpenChamber project registrations on restart, closing a boot mount race that transiently pruned registrations before the workspace bind mount was fully visible.

### Documentation
- Record the update-notification suppression fix.

## [1.11.7] - 2026-08-08

### Added
- Preserve OpenChamber projects across upgrades.

### Changed
- Gate release artifacts on vulnerability scanning.
- Group release vulnerability findings by severity.
- Add a Grype severity delta gate.
- Upgrade Docker Engine from 29.7.1 to 29.7.2.
- Upgrade OpenCode from 1.18.14 to 1.18.15.

## [1.11.6] - 2026-08-06

### Added
- Upgrade @playwright/mcp from 0.0.78 to 0.0.79.

### Fixed
- Harden pw-mcp browser discovery and add MCP JSON-RPC navigation coverage.

### Documentation
- Add the deferred vulnerability register and connect it to release/update workflows.
- Document independent Playwright pins, Chromium diagnostics, and `fixed` alert-state reconciliation.

## [1.11.5] - 2026-08-05

### Changed
- Upgrade OpenCode from 1.18.13 to 1.18.14.
- Update the tracked latest version for @fission-ai/openspec from 1.6.0 to 1.8.0.

## [1.11.4] - 2026-08-05

### Added
- Bump buildx 0.36.0→0.36.1, opencode 1.18.12→1.18.13, openchamber 1.18.0→1.18.1, glab 1.111.0→1.112.0, lean-ctx 3.9.14→3.9.17

### Changed
- Upgrade Docker Buildx from 0.36.0 to 0.36.1.
- Upgrade OpenCode from 1.18.12 to 1.18.13.
- Upgrade OpenChamber from 1.18.0 to 1.18.1.
- Upgrade GitLab CLI from 1.111.0 to 1.112.0.
- Upgrade lean-ctx from 3.9.14 to 3.9.17.

## [1.11.3] - 2026-08-04

### Added
- Add dependency-aware version checking for Bun requirements declared by OpenChamber.

### Fixed
- Repair auth-store provider import in the admin Providers page.
- Reload passphrase-less SSH keys into ssh-agent when ai-dev starts or restarts.
- Make OpenChamber project registration atomic and deduplicate settings entries.

### Documentation
- Document SSH agent reload behavior and derived Bun version management.

### Changed
- Upgrade OpenChamber from 1.17.2 to 1.18.0.
- Pin Bun to 1.3.14, aligned with OpenChamber 1.18.0.

## [1.11.2] - 2026-08-03

### Added
- Upgrade lean-ctx to 3.9.14 and Docker Compose to 5.4.0.

### Fixed
- Verify the `ctx_read`, `ctx_shell`, and `ctx_compose` MCP tools in integration tests.
- Avoid false negatives in output assertions when `pipefail` is enabled.

## [1.11.1] - 2026-08-03

### Fixed
- Move the provider API key registry to a directory mount so atomic updates work reliably.
- Migrate legacy provider registry files and directories during install and upgrade.

### Documentation
- Document the provider-state storage layout and bind-mount migration.

## [1.11.0] - 2026-08-02

### Changed
- Upgrade oh-my-openagent from 4.19.3 to 4.19.4.
- Sync the baked OMO schema reference in `.opencode/omo.jsonc.default` with the pinned plugin version; `check-updates` and CI now keep it aligned automatically.
- Upgrade OpenCode from 1.18.10 to 1.18.11.
- Upgrade OpenChamber from 1.17.1 to 1.17.2.

## [1.10.0] - 2026-08-01

### Added
- Bump Docker 29.7.0 → 29.7.1
- Add provider API key management with import, apply, and UI

### Fixed
- Ensure provider-keys.json exists before compose up
- Persist admin registry and env via named volume

### Documentation
- Capture run-tests container detection pitfall
- Archive admin-provider-config change and sync specs

### Changed
- Upgrade Docker Engine from 29.7.0 to 29.7.1.

## [1.9.4] - 2026-07-31

### Fixed
- Normalize GitLab hostname before credential helper git config

## [1.9.3] - 2026-07-31

### Fixed
- Make upgrade.sh RAM check container-aware and fault-tolerant
- Replace DOWNLOAD_TOOL curl/wget shim with portable download() helper
- Chown bind-mounted compose.yml in entrypoint so admin UI upgrade can write it

## [1.9.2] - 2026-07-31

- Bake git-credential-glab helper into the image (scripts/git-credential-glab) so git auth survives container recreation; entrypoint no longer re-adds `credential.helper store`

## [1.9.1] - 2026-07-31

### Added
- Backfill OpenChamber defaultModel on existing settings

### Fixed
- Use latest docker-compose.yml in admin upgrade and fix upstream URL

### Documentation
- Add knowledge entries for OpenChamber default model and OMO migration

### Changed
- Remove inert OMO model-default migration

## [1.9.0] - 2026-07-31

### Added
- Add a one-time `AI_ENGKIT_APPLY_OMO_MODEL_DEFAULTS=1` migration that fills only missing low-cost OMO model leaves and preserves existing user settings.

### Changed
- Upgrade Docker Engine from 29.6.2 to 29.7.0.
- Upgrade OpenCode from 1.18.9 to 1.18.10.
- Upgrade Playwright from 1.62.0 to 1.62.1.
- Upgrade GitHub CLI from 2.96.0 to 2.97.0.
- Upgrade GitLab CLI from 1.110.0 to 1.111.0.

## [1.8.0] - 2026-07-30

### Added
- Generate .gitignore for new projects and add system dirs to exclusion

### Changed
- Upgrade Docker Buildx from 0.35.0 to 0.36.0.
- Upgrade OpenChamber from 1.17.0 to 1.17.1.
- Bump BUILDX 0.35.0→0.36.0, OPENCHAMBER 1.17.0→1.17.1

## [1.7.4] - 2026-07-29

### Added
- Adopt unified OMO configuration

### Fixed
- Persist OMO configuration volumes

### Documentation
- Add OMO configuration specifications
- Clarify OMO update workflow
- Document version pin registration rule
- Document unified OMO configuration

### Changed
- Remove legacy OMO template
- Bump LeanCTX 3.9.12 to 3.9.13
- Archive OMO unified config change
- Check pinned OMO version updates

### Changed
- Upgrade lean-ctx from 3.9.12 to 3.9.13.
- Upgrade oh-my-openagent from latest to 4.19.3.

## [1.7.3] - 2026-07-29

### Changed
- Bump OpenCode 1.18.8->1.18.9, OpenChamber 1.16.3->1.17.0
- Replace insecure ~/.git-credentials with git-credential-glab helper

### Changed
- Upgrade OpenCode from 1.18.8 to 1.18.9.
- Upgrade OpenChamber from 1.16.3 to 1.17.0.

## [1.7.2] - 2026-07-28

### Added
- Bump OpenCode 1.18.7 -> 1.18.8, glab 1.109.0 -> 1.110.0
- Add standalone Secrets page separate from Env Editor

### Changed
- Upgrade OpenCode from 1.18.7 to 1.18.8.
- Upgrade GitLab CLI from 1.109.0 to 1.110.0.

## [1.7.1] - 2026-07-28

### Fixed
- Eliminate triple-nested sh -c quoting in admin restart

## [1.7.0] - 2026-07-28

### Added
- Bump OpenCode 1.18.6 → 1.18.7
- Add Restart ai-dev shortcut to dashboard
- Add mobile hamburger navigation with touch targets

### Fixed
- Make sidecar recreate DooD-aware

### Documentation
- Knowledge entries for mobile admin CSS/JS pitfalls
- Document DooD-aware sidecar recreation

### Other
- Archive admin-mobile-support change

### Changed
- Upgrade OpenCode from 1.18.6 to 1.18.7.

## [1.6.3] - 2026-07-27

### Added
- Bump OpenCode 1.18.5 → 1.18.6

### Fixed
- Read from /dev/tty directly instead of redirecting stdin
- Restore stdin after curl pipe on Alpine Linux
- Create .env in dependency-update workflow before docker compose up
- Make install.sh and upgrade.sh compatible with Alpine Linux (BusyBox)

### Documentation
- Update CHANGELOG for v1.6.3 release
- Update version management references
- Restructure README for onboarding
- Add Projects screenshot to README
- Add Projects page screenshot
- Document Admin Dashboard screenshots
- Add Admin Dashboard screenshots

### Changed
- Internationalize install/upgrade scripts and remove host-side CLI tools
- Remove retired README badge synchronization

### Changed
- Upgrade OpenCode from 1.18.5 to 1.18.6.

## [1.6.2] - 2026-07-26

### Fixed
- Reset inFlightCheck after update check completes
- Remove duplicate v prefix in admin version badge
- Read version from ai-dev, restart uses compose recreate
- Correct compose service name for ai-admin restart
- Read versions image metadata from ai-dev instead of ai-admin
- Run admin recreate in separate container to survive self-destruct
- Mount specific compose file path for admin recreate container
- Show admin own version in mismatch badge, dev version in table

### Documentation
- Add troubleshooting entry for admin restart self-destruct

## [1.6.1] - 2026-07-26

### Added
- Migrate project skills to folder SKILL.md format

### Fixed
- Update bootstrap.sh to produce folder SKILL.md format

### Documentation
- Add troubleshooting entry for OpenCode project skill discovery format
- Update pattern docs for skill folder format and add migration guide
- Update enable skill doc references to folder format

## [1.6.0] - 2026-07-26

### Added
- Add admin container restart button with version mismatch detection

### Fixed
- Add backups directory to permission auto-fix
- Fix health check and SSE streaming in upgrade pipeline
- Auto-fix .env ownership on container start

### Documentation
- Add D6/D7/D8 to agent-connection-module design
- Add upgrade engine SSE and compose troubleshooting entry
- Add bind mount .env ownership troubleshooting entry
- Add v1.5.2 changelog entry

### Changed
- Unify env var management via env_file directive

## [1.5.2] - 2026-07-25

### Fixed
- Detect docker compose project name from container labels; add `-p <project>` to all compose recreate commands (fixes "Compose recreate failed" when deployment directory differs from compose file path)

## [1.5.1] - 2026-07-25

### Fixed
- Add `--env-file` to env-restart compose command (fixes "Compose recreate failed" after env save)
- Add `--env-file` to post-upgrade admin restart for consistency

## [1.5.0] - 2026-07-25

### Added
- Show GitHub user info on auth page

### Fixed
- Align admin UI smoke test with branding and default password
- Run admin container tests in release and CI workflows
- Unify branding to AI-EngKit Admin
- Upgrade quoting bug, compose resilience, dev guard
- Use self-ref for env-aware sibling dev container targeting
- Prepare ./backups and workspace dirs before container start

### Documentation
- Env-aware sibling container targeting pattern

### Changed
- Remove broken compose volume mount

## [1.4.2] - 2026-07-25

### Fixed
- Replace GHCR HTTP version check with Docker digest comparison
- Fix bug
- Add working_dir to ai-admin for correct JSX transform
- Make admin port mapping respect ADMIN_PORT env var

### Changed
- Remove ADMIN_DEV_PORT from .env.example

## [1.4.1] - 2026-07-25

### Added
- Share single image between ai-dev and ai-admin in dev compose.

### Fixed
- Create .env from .env.example in CI to satisfy ai-admin env_file requirement.

## [1.4.0] - 2026-07-25

### Added
- Replace About link with modal dialog
- Add About link at bottom of sidebar
- Apply Zinc/Emerald color scheme + menu reorg + Inter font
- Add SSH key delete functionality
- Auto-check GHCR for new ai-engkit version + inline upgrade on Dashboard
- GitLab multi-instance auth with token support
- Auto-register generated SSH keys with ssh-agent
- Add Deploy button to SSH Keys table with Linux/Windows deploy command copy
- Add project sync with OpenChamber
- Add git error handling and post-creation remote management
- Add git init and remote URL to project creation
- Replace Init OpenCode with project feature enablement (knowledge, maintenance, openspec)
- Auto-register new projects in OpenChamber settings
- Add restart ai-dev button to env editor
- Restrict dashboard Component Versions to AI-EngKit, OpenCode, OpenChamber, Docker
- Align admin dashboard typography with OpenChamber
- Embed AI-EngKit version into image and expose in admin UI
- Integrate ai-admin as Docker sidecar service
- Add ai-admin dashboard server and views

### Fixed
- Replace favicon with final AI-EngKit logo version
- Refine favicon SVG - remove red/orange accents, keep green glow only
- Optimize favicon SVG to match PNG logo design
- Replace favicon with new 3D cube Dev/Ops/AI logo
- Remove smaller font from About link, match nav default
- Center feature columns in Projects table
- Match Projects header to env page layout + center feature columns
- Promote +New Project to primary button, reorder with Sync
- Update favicon from blue-purple gradient to Zinc/Emerald
- Reorder sidebar menu per user preference
- Exclude static assets and health check from rate limiting
- Detect dev mode in upgrade pipeline, skip unnecessary docker pull
- Dev admin container missing compose.yml mount causes upgrade to hang
- Gh device code flow blocks indefinitely, run in background
- Replace Deploy popup with inline Linux/Win buttons
- Copy button in SSH Keys pubkey modal now works on HTTP pages
- Resolve Hono JSX inline script escaping in 4 view files; add baked playwright skill for subagent usage
- Fix All button hidden due to duplicate style attr in sync modal
- Show Cancel button when sync modal has no diffs
- Properly detect empty git repo and fetch on remote set, improve error display
- Fetch remote content when setting git URL on empty or detached repo
- Add batch overview endpoint to avoid rate limiting
- Clone repo when remote URL provided, handle empty-dir init
- Prevent HTML escaping of inline script in projects page
- Prevent HTML escaping of inline script in env editor
- Make env editor work in DooD dev environment
- Wrap dockerCommand in sh -c so shell constructs (pipes, redirects) work
- Correct version extraction for Playwright and Node
- Correct version extraction for OpenChamber, glab, Node, Playwright
- Forward session cookie in versions page self-fetch
- Resolve login 500, logout 404, and DooD test port detection
- Align release skill CHANGELOG fallback format with existing convention
- Populate CHANGELOG v1.3.0 with commit content and fix release skill

### Changed
- Share single image between ai-dev and ai-admin in dev compose
- Bump OpenCode 1.18.4→1.18.5, Playwright 1.61.1→1.62.0
- Archive completed changes, extract Agent Connection Module
- Remove dead 'Initialize with OpenCode' checkbox from project creation
- Align ENV_SCHEMA with README and clean up dev env noise
- Archive completed redesign-versions-page change
- Add OpenSpec change definition for ai-admin-dashboard
- Add admin dashboard integration and UI smoke tests

### Documentation
- Unify product name casing to AI-EngKit in all user-facing text
- Add missing knowledge entries from earlier sessions
- Add production verification plan for upgrade and env editor
- Document dev verification limitations for upgrade and env editor
- Add knowledge entry for environment-agnostic operations pipeline
- Add knowledge entry for GitLab multi-instance auth
- Add knowledge entry for SSH key auto-registration with ssh-agent
- Add project-sync spec and fill task gaps in openspec artifacts
- Sync openspec artifacts with actual implementation
- Add OpenChamber project auto-registration pattern
- Add self-version-embedding pattern + update DooD troublshooting with solution C
- Add ai-admin service architecture and usage documentation

### Changed
- Upgrade OpenCode from 1.18.4 to 1.18.5.
- Upgrade Playwright from 1.61.1 to 1.62.0.

## [1.3.0] - 2026-07-24

### Added
- Vendor OMO agent permission defaults as standalone file (`oh-my-openagent.json.default`), following `AGENTS.md.default` pattern. The file ships to `/etc/opencode/` via Dockerfile COPY and is merged into the user's config directory at runtime by `entrypoint.d/02-init-config.sh`.

### Tested
- Add OMO agent permission verification tests (53 assertions across 8 sub-sections covering all 11 agents).

### Documentation
- Capture OMO agent permission default pattern as `docs/knowledge/patterns/omo-agent-permission-defaults.md`.

## [1.2.1] - 2026-07-23

### Changed
- Upgrade OpenChamber from 1.16.2 to 1.16.3.

## [1.2.0] - 2026-07-22

### Added
- Add `enable-finalize-maintenance` baked skill with deterministic bootstrap script. Follows the `enable-xxx` pattern: global skill bootstraps project-local `finalize-maintenance` skill + `docs/knowledge/maintenance/` scaffold. Auto-provisions `enable-project-knowledge` as a dependency when missing.
- Add `enable-xxx-skill-pattern` knowledge entry documenting the reusable pattern for future optional project skills.
- Add `OPENCODE_PROVIDER` env var support for injecting custom OpenCode providers (e.g., Ollama) into `opencode.json` at container startup. Configured via `entrypoint.d/02-init-config.sh`, exposed in `docker-compose.yml` and `docker-compose.dev.yml`. See `.env.example` for usage.

### Changed
- Upgrade OpenCode from 1.18.3 to 1.18.4.
- Upgrade GitLab CLI from 1.108.0 to 1.109.0.

## [1.1.23] - 2026-07-19

### Changed
- Upgrade OpenChamber from 1.16.1 to 1.16.2.

## [1.1.22] - 2026-07-18

### Changed
- Upgrade lean-ctx from 3.9.11 to 3.9.12.
- Update the tracked latest version for oh-my-openagent from 4.18.2 to 4.19.0.

## [1.1.21] - 2026-07-17

### Changed
- Upgrade Docker Engine from 29.6.1 to 29.6.2.
- Upgrade OpenCode from 1.18.2 to 1.18.3.
- Upgrade lean-ctx from 3.9.10 to 3.9.11.
- Update the tracked latest version for oh-my-openagent from 4.18.1 to 4.18.2.

## [1.1.20] - 2026-07-16

### Changed
- Upgrade OpenCode from 1.18.1 to 1.18.2.
- Upgrade lean-ctx from 3.9.9 to 3.9.10.

## [1.1.19] - 2026-07-15

### Changed
- Upgrade OpenCode from 1.17.18 to 1.18.1.
- Upgrade OpenChamber from 1.16.0 to 1.16.1.
- Upgrade GitLab CLI from 1.107.0 to 1.108.0.
- Upgrade lean-ctx from 3.9.8 to 3.9.9.
- Update the tracked latest version for oh-my-openagent from 4.17.0 to 4.18.1.

## [1.1.18] - 2026-07-13

### Changed
- Upgrade OpenChamber from 1.15.0 to 1.16.0.
- Upgrade lean-ctx from 3.9.7 to 3.9.8.

## [1.1.17] - 2026-07-12

### Changed
- Upgrade OpenChamber from 1.14.1 to 1.15.0.
- Upgrade lean-ctx from 3.9.4 to 3.9.7.
- Update the tracked latest version for oh-my-openagent from 4.16.2 to 4.17.0.
- Update the tracked latest version for @colbymchenry/codegraph from 1.3.1 to 1.4.1.
- Update the tracked latest version for @fission-ai/openspec from 1.5.0 to 1.6.0.

## [1.1.16] - 2026-07-10

### Changed
- Upgrade OpenCode from 1.17.15 to 1.17.18.
- Upgrade @playwright/mcp from 0.0.77 to 0.0.78.
- Upgrade lean-ctx from 3.9.2 to 3.9.4.
- Upgrade lean-ctx x86_64 musl SHA256 from 12b6b99bec2f326920c7372b0bbe457cbac76fbe46d45abdf89dbbc247c17c96 to a02ec8dbbe6cde3ab7eb04fe987121240ad27c660412f543b54f26d084f3cd9f.
- Update the tracked latest version for oh-my-openagent from 4.16.0 to 4.16.2.
- Update the tracked latest version for @colbymchenry/codegraph from 1.3.0 to 1.3.1.

## [1.1.15] - 2026-07-08

### Changed
- Upgrade Docker Compose from 5.3.0 to 5.3.1.
- Upgrade OpenCode from 1.17.14 to 1.17.15.
- Upgrade GitLab CLI from 1.106.0 to 1.107.0.

## [1.1.14] - 2026-07-07

### Changed
- Upgrade OpenCode from 1.17.13 to 1.17.14.
- Upgrade OpenChamber from 1.14.0 to 1.14.1.

## [1.1.13] - 2026-07-06

### Changed
- Upgrade OpenChamber from 1.13.9 to 1.14.0.
- Update the tracked latest version for lean-ctx from v3.8.18 to v3.9.1.

## [1.1.12] - 2026-07-03

### Changed
- Upgrade Docker Compose from 5.2.0 to 5.3.0.
- Upgrade OpenChamber from 1.13.8 to 1.13.9.
- Upgrade GitHub CLI from 2.95.0 to 2.96.0.
- Update the tracked latest version for @colbymchenry/codegraph from 1.1.6 to 1.2.0.
- Update the Ubuntu 24.04 APT package snapshot (4 packages have updates: ncurses-bin (6.4+20240113-1ubuntu2),ncurses-base (6.4+20240113-1ubuntu2),libncursesw6 (6.4+20240113-1ubuntu2),libtinfo6 (6.4+20240113-1ubuntu2)).

## [1.1.11] - 2026-07-02

### Changed
- Upgrade OpenCode from 1.17.12 to 1.17.13.

## [1.1.10] - 2026-07-01

### Changed
- Update the tracked latest version for oh-my-openagent from 4.14.1 to 4.14.2.

## [1.1.9] - 2026-07-01

### Changed
- Upgrade OpenCode from 1.17.11 to 1.17.12.
- Upgrade GitLab CLI from 1.105.0 to 1.106.0.
- Update the tracked latest version for oh-my-openagent from 4.13.0 to 4.14.1.
- Update the tracked latest version for @colbymchenry/codegraph from 1.1.2 to 1.1.6.
- Update the tracked latest version for lean-ctx from v3.8.15 to v3.8.17.

## [1.1.8] - 2026-06-30

### Changed
- Upgrade @playwright/mcp from 0.0.76 to 0.0.77.
- Update the tracked latest version for oh-my-openagent from 4.13.0 to 4.14.0.
- Update the tracked latest version for @colbymchenry/codegraph from 1.1.2 to 1.1.4.
- Update the tracked latest version for lean-ctx from v3.8.15 to v3.8.16.

## [1.1.7] - 2026-06-29

### Changed
- Upgrade OpenChamber from 1.13.7 to 1.13.8.
- Upgrade GitLab CLI from 1.103.0 to 1.105.0.
- Record the tracked latest version for @fission-ai/openspec as 1.5.0.

## [1.1.6] - 2026-06-28

### Changed
- Upgrade OpenChamber from 1.13.6 to 1.13.7.

## [1.1.5] - 2026-06-28

### Changed
- Update the tracked latest version for @colbymchenry/codegraph from 1.1.1 to 1.1.2.

## [1.1.4] - 2026-06-27

### Changed
- Upgrade OpenChamber from 1.13.5 to 1.13.6.

## [1.1.3] - 2026-06-27

### Changed
- Upgrade OpenChamber from 1.13.3 to 1.13.5.
- Update the tracked latest version for lean-ctx from v3.8.13 to v3.8.15.

## [1.1.2] - 2026-06-26

### Changed
- Upgrade Docker Engine from 29.6.0 to 29.6.1.
- Update the tracked latest version for lean-ctx from v3.8.12 to v3.8.13.

## [1.1.1] - 2026-06-25

### Changed
- Upgrade OpenCode from 1.17.10 to 1.17.11.
- Update the Ubuntu 24.04 APT package snapshot (1 packages have updates: tar (1.35+dfsg-3build1)).

## [1.1.0] - 2026-06-25

### Added
- Add `--output-dir .playwright-mcp` to pw-mcp wrapper so screenshots default to `.playwright-mcp/` instead of CWD

### Changed
- Translate zh-TW docs to English, relocate CONTRIBUTING & SECURITY to root, add GitHub templates

### Documentation
- Add OpenChamber project data architecture & rename recovery guide

## [1.0.2] - 2026-06-25

### Changed
- Update @colbymchenry/codegraph to latest tracked version 1.1.0 → 1.1.1

## [1.0.1] - 2026-06-24

### Changed
- Upgrade OpenCode 1.17.9 → 1.17.10
- Upgrade OpenChamber 1.13.2 → 1.13.3
- Update @colbymchenry/codegraph to latest tracked version 1.0.1 → 1.1.0
- Update lean-ctx to latest tracked version v3.8.11 → v3.8.12
- Update Ubuntu 24.04 APT package snapshot (1 package has updates: perl-base (5.38.2-3.2ubuntu0.2))

### Fixed
- Fix the `ai-engkit-ai-dev` typo in the `vuln-scan.md` skill Docker validation example to `ai-engkit-dev` (`codeforge-ai-dev` before the rename); the literal rename did not match the real container name in `docker-compose.dev.yml`.

## [1.0.0] - 2026-06-24

### Changed
- **Project rename**: `tryweb/Codeforge` → `tryweb/ai-engkit`. Rationale: the name "Codeforge" is already used by 10+ commercial products and open source projects in the AI coding tools market, creating too much search noise. The new name `ai-engkit` directly communicates the project's identity as **Your Self-hosted AI Engineering Kit for Dev & Ops** and avoids naming collisions.
  - The GitHub repository now has a permanent 301 redirect, so existing `tryweb/Codeforge` links continue to work.
  - The GHCR image was renamed to `ghcr.io/tryweb/ai-engkit:*` (CI internal tag `codeforge:ci` → `ai-engkit:ci`).
  - Docker Compose `container_name` changed from `codeforge` / `codeforge-dev` to `ai-engkit` / `ai-engkit-dev`.
  - The install command `curl ... tryweb/Codeforge/refs/heads/main/install.sh` was updated to `tryweb/ai-engkit`.
  - `.sisyphus/boulder.json` and `evidence/*.txt` were intentionally left unchanged because local paths and historical records should not be rewritten.
- Known leftover: the Docker example in `vuln-scan.md` still uses `ai-engkit-ai-dev` (originally `codeforge-ai-dev`). The typo predates the rename and remains for later cleanup.

## [0.17.1] - 2026-06-23

### Changed
- Upgrade Docker Compose from 5.1.4 to 5.2.0.
- Upgrade Playwright from 1.61.0 to 1.61.1.

## [0.17.0] - 2026-06-23

### Added
- Add the `vuln-scan` skill to combine GitHub code scanning alert triage with Dockerfile version updates.

### Fixed
- Fix Playwright MCP failing to find a browser by adding the `pw-mcp` wrapper. It resolves bundled Chromium under `/ms-playwright` and passes it to `@playwright/mcp` through `--executable-path`, avoiding the default system Chrome channel selected by `--browser`. Full Chromium is back in the image (the earlier `--only-shell` change was reverted), while the headless shell remains as the minimum fallback.

## [0.16.5] - 2026-06-22

### Changed
- Update the tracked latest version for oh-my-openagent from 4.12.1 to 4.13.0.

## [0.16.4] - 2026-06-21

### Changed
- Upgrade OpenCode from 1.17.8 to 1.17.9.

## [0.16.3] - 2026-06-20

### Changed
- Update the tracked latest version for oh-my-openagent from 4.12.0 to 4.12.1.
- Update the tracked latest version for lean-ctx from v3.8.9 to v3.8.11.

## [0.16.2] - 2026-06-20

### Fixed
- Fix the CodeGraph MCP config key test mismatch by checking both `.mcp.codegraph` (entrypoint format) and `.mcpServers.codegraph` (legacy format).

### Changed
- Update the tracked latest version for oh-my-openagent from 4.12.0 to 4.12.1.
  - CodeGraph init guidance: provide explicit guidance instead of failing silently when the workspace is not initialized.
  - CodeGraph MCP bootstrap: LazyCodex pre-initializes the CodeGraph runtime during the MCP serve phase.
  - Background task polling: no longer misleads users into polling `background_output`.
  - Ultraresearch: workers now prefer collaborative teams and real-time broadcast of findings.

## [0.16.1] - 2026-06-20

### Other
- Dockerfile image slimming (bun cache cleanup, remove libclang-dev), image 4.24GB → 3.70GB
- update GitHub Actions to Node 24 native versions

## [0.16.0] - 2026-06-20

### Added
- add .dockerignore to reduce build context size
- replace brew-installed gh and marksman with static binaries
  (saves ~2GB, image 6.27GB → 4.25GB)
- upgrade gh from 2.67.0 to 2.95.0
- add GH_VERSION and MARKSMAN_VERSION to dependency-update.yml

### Other
- add knowledge entry for test container name mismatch
- add docker image slimming issue tracker link (#17)

## [0.15.1] - 2026-06-20

### Changed
- Update the tracked latest version for oh-my-openagent from 4.11.1 to 4.12.0.

## [0.15.0] - 2026-06-20

### Added
- add markdown LSP support for project-level `.md` navigation

### Changed
- expand tooling and authentication docs
- add knowledge capture scaffold
- add knowledge base placeholders
- add knowledge base references

## [0.14.0] - 2026-06-20

### Added
- Add `karpathy-guidelines` as a baked global skill (Karpathy's four code quality principles).

## [0.13.1] - 2026-06-19

### Changed
- Upgrade Docker Engine from 29.5.3 to 29.6.0.

### Fixed
- Fix CHANGELOG comparison links for v0.12.6 and v0.13.0.

## [0.13.0] - 2026-06-19

### Added
- Add the baked skills mechanism: `enable-project-knowledge` and `knowledge-capture` are built in as global skills.
- Add automatic symlinking of baked skills into `~/.config/opencode/skills/` during entrypoint startup.
- Add the versioned `bootstrap-knowledge.sh` script to `.opencode/scripts/`.

### Changed
- Update the README OpenChamber badge from 1.13.1 to 1.13.2.

## [0.12.6] - 2026-06-18

### Fixed
- auto-start dev container and detect container name in release skill

### Changed
- install glab from official release binary

## [0.12.5] - 2026-06-18

### Changed
- Upgrade Docker Buildx from 0.34.1 to 0.35.0.
- Upgrade OpenChamber from 1.13.1 to 1.13.2.

## [0.12.4] - 2026-06-17

### Changed
- Upgrade OpenCode from 1.17.7 to 1.17.8.
- Update the tracked latest version for oh-my-openagent from 4.10.0 to 4.11.0.
- Update the tracked latest version for lean-ctx from v3.8.7 to v3.8.8.

## [0.12.3] - 2026-06-17

### Changed
- Upgrade OpenChamber from 1.13.0 to 1.13.1.

## [0.12.2] - 2026-06-16

### Changed
- Update the tracked latest version for lean-ctx to v3.8.7.

## [0.12.1] - 2026-06-16

### Changed
- Upgrade OpenChamber from 1.12.4 to 1.13.0.
- Upgrade Playwright from 1.60.0 to 1.61.0.

## [0.12.0] - 2026-06-15

### Added
- Add lean-ctx XDG Base Directory support (v3.8.5+).
  - Dockerfile: add `BASH_ENV` / `CLAUDE_ENV_FILE` so bash automatically loads the lean-ctx environment.
  - Dockerfile: pre-create `~/.local/share/lean-ctx`, `~/.local/state/lean-ctx`, and `~/.cache/lean-ctx` directories.
  - Dockerfile: add `lean-ctx-data` / `lean-ctx-state` volumes so vector indexes, the knowledge base, and sessions persist.
  - `docker-compose.yml` / `docker-compose.dev.yml`: add `lean-ctx-data` / `lean-ctx-state` named volumes.
  - `entrypoint.d/00-fix-perms.sh`: add lean-ctx directory permission repair.
  - `entrypoint.d/02-init-config.sh`: detect the legacy single-dir layout automatically and run `lean-ctx doctor --fix` migration.
  - `docs/ARCHITECTURE.md`: add lean-ctx volumes to the architecture diagram and persistence strategy table.

### Removed
- Remove the Ollama local LLM inference engine from Docker Compose, the Dockerfile, entrypoint, docs, and tests.
- Remove the `lancedb-opencode-pro` OpenCode plugin from the entrypoint, tests, and docs.

## [0.11.10] - 2026-06-14

### Changed
- Upgrade OpenCode from 1.17.6 to 1.17.7.

## [0.11.9] - 2026-06-14

### Changed
- Update APT packages.

## [0.11.8] - 2026-06-14

### Changed
- Update APT packages.

## [0.11.7] - 2026-06-14

### Changed
- Upgrade OpenCode from 1.17.4 to 1.17.6.

## [0.11.6] - 2026-06-13

### Changed
- Update the tracked latest version for lean-ctx to v3.8.4.
- Update APT packages.

## [0.11.5] - 2026-06-13

### Changed
- Update the tracked latest version for lean-ctx to v3.8.3.
- Update APT packages.

## [0.11.4] - 2026-06-11

### Fixed
- Separate version management for Playwright core and `@playwright/mcp`.
  - Manage Playwright core (1.60.0) and `@playwright/mcp` (0.0.76) independently, fixing the previous incorrect assumption that they had to stay on the same version.

### Changed
- Adjust CI so the image is built once and shared between jobs via artifacts.

## [0.11.3] - 2026-06-11

### Changed
- Pin Playwright to version 1.60.0 and add runtime smoke tests.

## [0.11.2] - 2026-06-11

### Added
- Add the `vuln-scan` skill for vulnerability scanning and version auditing.

### Changed
- Upgrade Docker from 29.4.1 to 29.5.3, Compose from 5.1.2 to 5.1.4, and Buildx from 0.33.0 to 0.34.1.

## [0.11.1] - 2026-06-11

### Changed
- Upgrade OpenCode from 1.16.2 to 1.17.3.
- Upgrade OpenChamber from 1.12.3 to 1.12.4.

## [0.11.0] - 2026-06-06

### Added
- Add Playwright browsers to the Docker image so MCP server workflows and tests are supported.
  - Install Chromium (about 291 MB) and 97 system dependencies.
  - Support both Playwright MCP browser automation and the Playwright test runner.

## [0.10.0] - 2026-06-06

### Added
- Add the lean-ctx MCP server to provide context engineering capabilities.
  - Install lean-ctx v3.7.5 in the Dockerfile via the universal installer.
  - Add the lean-ctx MCP server config block to `entrypoint.d/02-init-config.sh`.
  - Provide 69 MCP tools such as `ctx_read`, `ctx_shell`, `ctx_search`, and `ctx_tree`.

### Changed
- Upgrade OpenCode from 1.16.0 to 1.16.2.
- Upgrade OpenChamber from 1.12.1 to 1.12.3.

## [0.9.3] - 2026-06-05

### Changed
- Upgrade OpenCode from 1.15.13 to 1.16.0.

## [0.9.2] - 2026-06-05

### Changed
- Upgrade `@openchamber/web` from 1.11.7 to 1.12.1.

## [0.9.1] - 2026-06-02

### Added
- Bake Playwright MCP into the image so AI agents can drive browsers natively.
  - Dockerfile: add Playwright MCP configuration to the `/etc/opencode/opencode.json.default` template.
  - `entrypoint.d/02-init-config.sh`: include Playwright MCP when regenerating `~/.config/opencode/opencode.json` so it is not overwritten.
  - `test/run-tests.sh`: add two assertions to verify that the Playwright MCP config exists and uses `bunx`.
  - Replace the old workflow of AI-written Playwright scripts executed through bash with native MCP tooling.
  - New developers no longer need to install `@playwright/mcp` manually.

### Changed
- Upgrade `@openchamber/web` from 1.10.4 to 1.11.7.
- Upgrade OpenCode from 1.14.48 to 1.15.13 ([release notes](https://github.com/anomalyco/opencode/releases/tag/v1.15.13)).
- Replace the graph knowledge tool graphify (`graphifyy`) with `@colbymchenry/codegraph`.
  - Dockerfile: `uv tool install graphifyy` → `bun install -g @colbymchenry/codegraph`.
  - Update `README.md` and the test scripts together.
- Add a Git Authentication section for first-time users.
- Correct the credential volume mount explanation in the docs.
- Add documentation for the versioned `glab` credential helper path issue (#4).

### Fixed
- Clarify how host and container credentials are isolated.

## [0.8.3] - 2026-05-13

### Fixed
- Remove the blocking OpenCode warm-up step and increase the CI job timeout.

## [0.8.2] - 2026-05-13

### Changed
- Upgrade OpenCode from 1.14.33 to 1.14.48.
- Upgrade OpenChamber from 1.9.10 to 1.10.4.

## [0.8.1] - 2026-05-06

### Fixed
- Make skills create symlinks directly from the baked image instead of copying them into cache.
- Remove tmpfs mounts that conflict with named volumes.
- Bake Superpowers into the image so it is not masked by volume mounts.
- Keep the plugin cache and increase the warm-up timeout.

## [0.8.0] - 2026-05-05

### Added
- Add the Superpowers plugin (agentic skills framework) to the default plugins.
  - Provide 14 skills such as `brainstorming`, `systematic-debugging`, and `test-driven-development`.
- Add Superpowers to the default `docker-compose.yml` configuration so it works without setting `.env`.
- Make `entrypoint.d/02-init-config.sh` automatically create the Superpowers skills symlink.
  - Fix OpenCode #20940: changes to `skills.paths` from the plugin `config()` hook were not visible to skill discovery.
  - Make all existing projects discover Superpowers skills automatically.

### Changed
- Change the default plugins in `.env.example` to `oh-my-openagent,superpowers@git+https://github.com/obra/superpowers.git`.
- Remove the legacy release tests because the plugin is no longer used.

## [0.7.1] - 2026-05-04

### Fixed
- Fix Superpowers plugin detection failures in CI integration tests by wrapping the `jq` command in an explicit shell.
- Fix the `OPENCODE_PLUGINS` environment variable configuration in `docker-compose.dev.yml`.
- Fix consistency issues in `entrypoint.d/02-init-config.sh`.

## [0.7.0] - 2026-05-04

### Added
- Install graphify (the knowledge graph tool) through `uv tool install graphifyy`.
- Add the Superpowers plugin (agentic skills framework).
- Add graphify and Superpowers verification tests to `run-tests.sh`.

### Changed
- Remove the legacy plugin that had caused release test failures.

## [0.6.2] - 2026-04-25

### Changed
- Upgrade OpenCode to 1.14.33.
- Upgrade OpenChamber to 1.9.10.

## [0.6.1] - 2026-04-24

### Fixed
- Fix group inheritance when `entrypoint.sh` re-executes `exec sudo -E -u devuser -- env PATH="$PATH" "$@"`.
- Fix the `permission denied` error when running `docker ps` inside the OpenChamber Web UI terminal.

## [0.6.0] - 2026-04-23

### Added
- Add Docker Buildx v0.32.1 installation to support multi-platform builds.
- Add `git credential.helper store` configuration during startup.

### Fixed
- Fix the git credential helper to use `sudo -u devuser HOME=...` so it does not write into `/root`.

## [0.5.16] - 2026-04-22

### Changed
- Upgrade OpenCode to 1.14.20.
- Upgrade OpenChamber to 1.9.7.

## [0.5.15] - 2026-04-17

### Changed
- Upgrade OpenCode to 1.4.7.

## [0.5.14] - 2026-04-15

### Changed
- Upgrade OpenChamber to 1.9.5.

## [0.5.13] - 2026-04-12

### Fixed
- Remove the `NAPI_RS_FORCE_WASI` environment variable to fix the LanceDB initialization issue (`lancedb/lancedb#3267`).
- Fix Docker Compose issues in the CI workflow.

## [0.5.12] - 2026-04-11

### Added
- Add README.md documentation for configuring the memory plugin.

### Fixed
- Remove the `sg docker` wrapper from `entrypoint.sh` to fix environment variable inheritance.
  - This issue caused tools such as `memory_stats` to report the embedding service as offline.
- Add stale plugin cache cleanup to `entrypoint.d/02-init-config.sh`.
- Hardcode plugins in `docker-compose.dev.yml` to avoid host shell environment contamination.
- Fix the plugin name in `.env.example` (`oh-my-opencode` → `oh-my-openagent`).
- Fix the `test/test-memory-e2e.sh` script.

## [0.5.11] - 2026-04-10

### Added
- Add the `glab-config` volume so `glab` (GitLab CLI) auth state persists.
- Add the `06-init-glab-cli.sh` initialization script to create `~/.config/glab-cli` automatically.
- Update `00-fix-perms.sh` to repair permissions for `glab-cli`, `gh`, `ssh`, and `git`.

## [0.5.10] - 2026-04-10

### Added
- Upgrade OpenCode to 1.4.3.

## [0.5.9] - 2026-04-10

### Security
- Upgrade Docker CLI from v25.0.4 to v29.4.0 (eliminating about 20 CVE alerts).
- Upgrade Docker Compose from v2.24.5 to v5.1.2 (eliminating about 68 CVE alerts, including 6 critical ones).
- Add `docs/backlog.md` to track security technical debt.
- Add a version tracking section to `docs/SECURITY.md`.

## [0.5.8] - 2026-04-10

### Added
- Upgrade OpenCode to 1.3.12.

### Fixed
- Switch Docker Compose to the plugin installation model instead of a standalone `docker-compose` binary.
- Update `test-memory-e2e.sh` to use the hook-based test approach.
- Update `release-memory-test.sh` to use the `docker compose` command.

## [0.5.6] - 2026-04-08

### Added
- Add the `05-init-gh-cli.sh` initialization script to create `~/.config/gh` automatically.
- Add the `gh-config-dev` volume to `docker-compose.dev.yml`.

### Changed
- Update `entrypoint.sh` to run `05-init-gh-cli.sh` through `sudo`.
- Update `docs/ARCHITECTURE.md` with `gh-config` volume documentation.
- Update `docs/TROUBLESHOOTING.md` with GitHub CLI permission troubleshooting.

## [0.5.5] - 2026-04-08

### Added
- Add the `gh-config` named volume so `gh` auth data persists.

## [0.5.4] - 2026-04-08

### Added
- Add the full Memory E2E test script (`test-memory-e2e.sh`).
- Add a retry mechanism for the Memory plugin (up to 3 tries).
- Add the version extraction step to the release skill.
- Add version badges to `README.md`.

### Changed
- Downgrade OpenCode to 1.3.7.
- Upgrade OpenChamber to 1.9.4.
- Fix Docker Compose command compatibility.
- Fix the container name in `release-memory-test.sh`.

### Fixed
- Fix Memory plugin initialization on OpenCode 1.3.7.
- Fix the logic so `release-memory-test.sh` stops when tests fail.

## [0.5.2] - 2026-04-07

### Fixed
- Fix the `sed` command in the CI workflow so it replaces the container name correctly.

## [0.5.1] - 2026-04-07

### Added
- Add a documentation update check step to the release skill.

### Changed
- Reorder the release steps so docs are checked before committing.

### Fixed
- Fix `OLLAMA_BASE_URL` being overridden by the host environment in the dev setup.

## [0.5.0] - 2026-04-07

### Added
- Add multi-model switching.
- Add a named volume as the default workspace.
- Add `glab` (GitLab CLI).

### Changed
- Use named volumes as the default persistence strategy.
- Update `install.sh` and `.env.example`.
- Improve the entrypoint script structure.

## [0.3.3] - 2026-04-02

### Added
- Initial release.
- Ubuntu 24.04-based Docker development environment.
- Integrate the OpenCode AI coding assistant (v1.3.13).
- Integrate the OpenChamber web UI (v1.9.3).
- Integrate a local LLM inference engine (later removed).
- Support the LanceDB vector search plugin.
- Include GitHub CLI.
- Provide a full developer toolchain (`git`, `python`, `tmux`, `jq`, and more).
- Establish automated CI/CD workflows.
- Add vulnerability scanning with Grype.
- Create an integration test suite (39 test cases).

### Changed
- Use a two-container design (`ai-dev` + LLM inference container, later removed).
- Use Docker named volumes for persistence.
- Support bind mount local development mode.
- Add health checks and automatic restarts.
- Support dynamic package installation.

## [0.3.0] - 2026-04-02

### Added
- Add the `docs/SECURITY.md` security policy.
- Add the `docs/TROUBLESHOOTING.md` troubleshooting guide.
- Add the `docs/ARCHITECTURE.md` architecture guide.
- Add the `docs/CONTRIBUTING.md` contributor guide.

### Changed
- Improve the `README.md` document structure.
---

## Format

[Unreleased]: https://github.com/tryweb/ai-engkit/compare/v1.18.8...HEAD
[0.3.0]: https://github.com/tryweb/ai-engkit/releases/tag/v0.3.0
[0.3.3]: https://github.com/tryweb/ai-engkit/compare/v0.3.0...v0.3.3
[0.5.0]: https://github.com/tryweb/ai-engkit/compare/v0.3.3...v0.5.0
[0.5.1]: https://github.com/tryweb/ai-engkit/compare/v0.5.0...v0.5.1
[0.5.2]: https://github.com/tryweb/ai-engkit/compare/v0.5.1...v0.5.2
[0.5.4]: https://github.com/tryweb/ai-engkit/compare/v0.5.2...v0.5.4
[0.5.5]: https://github.com/tryweb/ai-engkit/compare/v0.5.4...v0.5.5
[0.5.6]: https://github.com/tryweb/ai-engkit/compare/v0.5.5...v0.5.6
[0.5.8]: https://github.com/tryweb/ai-engkit/compare/v0.5.6...v0.5.8
[0.5.9]: https://github.com/tryweb/ai-engkit/compare/v0.5.8...v0.5.9
[0.5.10]: https://github.com/tryweb/ai-engkit/compare/v0.5.9...v0.5.10
[0.5.11]: https://github.com/tryweb/ai-engkit/compare/v0.5.10...v0.5.11
[0.5.12]: https://github.com/tryweb/ai-engkit/compare/v0.5.11...v0.5.12
[0.5.13]: https://github.com/tryweb/ai-engkit/compare/v0.5.12...v0.5.13
[0.5.14]: https://github.com/tryweb/ai-engkit/compare/v0.5.13...v0.5.14
[0.5.15]: https://github.com/tryweb/ai-engkit/compare/v0.5.14...v0.5.15
[0.5.16]: https://github.com/tryweb/ai-engkit/compare/v0.5.15...v0.5.16
[0.6.0]: https://github.com/tryweb/ai-engkit/compare/v0.5.16...v0.6.0
[0.6.1]: https://github.com/tryweb/ai-engkit/compare/v0.6.0...v0.6.1
[0.6.2]: https://github.com/tryweb/ai-engkit/compare/v0.6.1...v0.6.2
[0.7.0]: https://github.com/tryweb/ai-engkit/compare/v0.6.2...v0.7.0
[0.7.1]: https://github.com/tryweb/ai-engkit/compare/v0.7.0...v0.7.1
[0.8.0]: https://github.com/tryweb/ai-engkit/compare/v0.7.1...v0.8.0
[0.8.1]: https://github.com/tryweb/ai-engkit/compare/v0.8.0...v0.8.1
[0.8.2]: https://github.com/tryweb/ai-engkit/compare/v0.8.1...v0.8.2
[0.8.3]: https://github.com/tryweb/ai-engkit/compare/v0.8.2...v0.8.3
[0.9.1]: https://github.com/tryweb/ai-engkit/compare/v0.8.3...v0.9.1
[0.9.2]: https://github.com/tryweb/ai-engkit/compare/v0.9.1...v0.9.2
[0.9.3]: https://github.com/tryweb/ai-engkit/compare/v0.9.2...v0.9.3
[0.10.0]: https://github.com/tryweb/ai-engkit/compare/v0.9.3...v0.10.0
[0.11.0]: https://github.com/tryweb/ai-engkit/compare/v0.10.0...v0.11.0
[0.11.1]: https://github.com/tryweb/ai-engkit/compare/v0.11.0...v0.11.1
[0.11.2]: https://github.com/tryweb/ai-engkit/compare/v0.11.1...v0.11.2
[0.11.3]: https://github.com/tryweb/ai-engkit/compare/v0.11.2...v0.11.3
[0.11.4]: https://github.com/tryweb/ai-engkit/compare/v0.11.3...v0.11.4
[0.11.5]: https://github.com/tryweb/ai-engkit/compare/v0.11.4...v0.11.5
[0.11.6]: https://github.com/tryweb/ai-engkit/compare/v0.11.5...v0.11.6
[0.11.7]: https://github.com/tryweb/ai-engkit/compare/v0.11.6...v0.11.7
[0.11.8]: https://github.com/tryweb/ai-engkit/compare/v0.11.7...v0.11.8
[0.11.9]: https://github.com/tryweb/ai-engkit/compare/v0.11.8...v0.11.9
[0.11.10]: https://github.com/tryweb/ai-engkit/compare/v0.11.9...v0.11.10
[0.12.0]: https://github.com/tryweb/ai-engkit/compare/v0.11.10...v0.12.0
[0.12.1]: https://github.com/tryweb/ai-engkit/compare/v0.12.0...v0.12.1
[0.12.2]: https://github.com/tryweb/ai-engkit/compare/v0.12.1...v0.12.2
[0.12.3]: https://github.com/tryweb/ai-engkit/compare/v0.12.2...v0.12.3
[0.12.4]: https://github.com/tryweb/ai-engkit/compare/v0.12.3...v0.12.4
[0.12.5]: https://github.com/tryweb/ai-engkit/compare/v0.12.4...v0.12.5
[0.12.6]: https://github.com/tryweb/ai-engkit/compare/v0.12.5...v0.12.6
[0.13.0]: https://github.com/tryweb/ai-engkit/compare/v0.12.6...v0.13.0
[0.13.1]: https://github.com/tryweb/ai-engkit/compare/v0.13.0...v0.13.1
[0.14.0]: https://github.com/tryweb/ai-engkit/compare/v0.13.1...v0.14.0
[0.15.0]: https://github.com/tryweb/ai-engkit/compare/v0.14.0...v0.15.0
[0.15.1]: https://github.com/tryweb/ai-engkit/compare/v0.15.0...v0.15.1
[0.16.0]: https://github.com/tryweb/ai-engkit/compare/v0.15.1...v0.16.0
[0.16.1]: https://github.com/tryweb/ai-engkit/compare/v0.16.0...v0.16.1
[0.16.2]: https://github.com/tryweb/ai-engkit/compare/v0.16.1...v0.16.2
[0.16.3]: https://github.com/tryweb/ai-engkit/compare/v0.16.2...v0.16.3
[0.16.4]: https://github.com/tryweb/ai-engkit/compare/v0.16.3...v0.16.4
[0.16.5]: https://github.com/tryweb/ai-engkit/compare/v0.16.4...v0.16.5
[0.17.0]: https://github.com/tryweb/ai-engkit/compare/v0.16.5...v0.17.0
[0.17.1]: https://github.com/tryweb/ai-engkit/compare/v0.17.0...v0.17.1
[1.0.0]: https://github.com/tryweb/ai-engkit/compare/v0.17.1...v1.0.0
[1.0.1]: https://github.com/tryweb/ai-engkit/compare/v1.0.0...v1.0.1
[1.0.2]: https://github.com/tryweb/ai-engkit/compare/v1.0.1...v1.0.2
[1.1.0]: https://github.com/tryweb/ai-engkit/compare/v1.0.2...v1.1.0
[1.1.1]: https://github.com/tryweb/ai-engkit/compare/v1.1.0...v1.1.1
[1.1.2]: https://github.com/tryweb/ai-engkit/compare/v1.1.1...v1.1.2
[1.1.3]: https://github.com/tryweb/ai-engkit/compare/v1.1.2...v1.1.3
[1.1.4]: https://github.com/tryweb/ai-engkit/compare/v1.1.3...v1.1.4
[1.1.5]: https://github.com/tryweb/ai-engkit/compare/v1.1.4...v1.1.5
[1.1.6]: https://github.com/tryweb/ai-engkit/compare/v1.1.5...v1.1.6
[1.1.7]: https://github.com/tryweb/ai-engkit/compare/v1.1.6...v1.1.7
[1.1.8]: https://github.com/tryweb/ai-engkit/compare/v1.1.7...v1.1.8
[1.1.9]: https://github.com/tryweb/ai-engkit/compare/v1.1.8...v1.1.9
[1.1.10]: https://github.com/tryweb/ai-engkit/compare/v1.1.9...v1.1.10
[1.1.11]: https://github.com/tryweb/ai-engkit/compare/v1.1.10...v1.1.11
[1.1.12]: https://github.com/tryweb/ai-engkit/compare/v1.1.11...v1.1.12
[1.1.13]: https://github.com/tryweb/ai-engkit/compare/v1.1.12...v1.1.13
[1.1.14]: https://github.com/tryweb/ai-engkit/compare/v1.1.13...v1.1.14
[1.1.15]: https://github.com/tryweb/ai-engkit/compare/v1.1.14...v1.1.15
[1.1.16]: https://github.com/tryweb/ai-engkit/compare/v1.1.15...v1.1.16
[1.1.17]: https://github.com/tryweb/ai-engkit/compare/v1.1.16...v1.1.17
[1.1.18]: https://github.com/tryweb/ai-engkit/compare/v1.1.17...v1.1.18
[1.1.19]: https://github.com/tryweb/ai-engkit/compare/v1.1.18...v1.1.19
[1.1.20]: https://github.com/tryweb/ai-engkit/compare/v1.1.19...v1.1.20
[1.1.21]: https://github.com/tryweb/ai-engkit/compare/v1.1.20...v1.1.21
[1.1.22]: https://github.com/tryweb/ai-engkit/compare/v1.1.21...v1.1.22
[1.1.23]: https://github.com/tryweb/ai-engkit/compare/v1.1.22...v1.1.23
[1.2.0]: https://github.com/tryweb/ai-engkit/compare/v1.1.23...v1.2.0
[1.2.1]: https://github.com/tryweb/ai-engkit/compare/v1.2.0...v1.2.1
[1.3.0]: https://github.com/tryweb/ai-engkit/compare/v1.2.1...v1.3.0
[1.4.0]: https://github.com/tryweb/ai-engkit/compare/v1.3.0...v1.4.0
[1.4.1]: https://github.com/tryweb/ai-engkit/compare/v1.4.0...v1.4.1
[1.4.2]: https://github.com/tryweb/ai-engkit/compare/v1.4.1...v1.4.2
[1.5.0]: https://github.com/tryweb/ai-engkit/compare/v1.4.2...v1.5.0
[1.5.1]: https://github.com/tryweb/ai-engkit/compare/v1.5.0...v1.5.1
[1.5.2]: https://github.com/tryweb/ai-engkit/compare/v1.5.1...v1.5.2
[1.6.0]: https://github.com/tryweb/ai-engkit/compare/v1.5.2...v1.6.0
[1.6.1]: https://github.com/tryweb/ai-engkit/compare/v1.6.0...v1.6.1
[1.6.2]: https://github.com/tryweb/ai-engkit/compare/v1.6.1...v1.6.2
[1.6.3]: https://github.com/tryweb/ai-engkit/compare/v1.6.2...v1.6.3
[1.7.0]: https://github.com/tryweb/ai-engkit/compare/v1.6.3...v1.7.0
[1.7.1]: https://github.com/tryweb/ai-engkit/compare/v1.7.0...v1.7.1
[1.7.2]: https://github.com/tryweb/ai-engkit/compare/v1.7.1...v1.7.2
[1.7.3]: https://github.com/tryweb/ai-engkit/compare/v1.7.2...v1.7.3
[1.7.4]: https://github.com/tryweb/ai-engkit/compare/v1.7.3...v1.7.4
[1.8.0]: https://github.com/tryweb/ai-engkit/compare/v1.7.4...v1.8.0
[1.9.0]: https://github.com/tryweb/ai-engkit/compare/v1.8.0...v1.9.0
[1.9.1]: https://github.com/tryweb/ai-engkit/compare/v1.9.0...v1.9.1
[1.9.2]: https://github.com/tryweb/ai-engkit/compare/v1.9.1...v1.9.2
[1.9.3]: https://github.com/tryweb/ai-engkit/compare/v1.9.2...v1.9.3
[1.9.4]: https://github.com/tryweb/ai-engkit/compare/v1.9.3...v1.9.4
[1.10.0]: https://github.com/tryweb/ai-engkit/compare/v1.9.4...v1.10.0
[1.11.0]: https://github.com/tryweb/ai-engkit/compare/v1.10.0...v1.11.0
[1.11.1]: https://github.com/tryweb/ai-engkit/compare/v1.11.0...v1.11.1
[1.11.2]: https://github.com/tryweb/ai-engkit/compare/v1.11.1...v1.11.2
[1.11.3]: https://github.com/tryweb/ai-engkit/compare/v1.11.2...v1.11.3
[1.11.4]: https://github.com/tryweb/ai-engkit/compare/v1.11.3...v1.11.4
[1.11.5]: https://github.com/tryweb/ai-engkit/compare/v1.11.4...v1.11.5
[1.11.6]: https://github.com/tryweb/ai-engkit/compare/v1.11.5...v1.11.6
[1.11.7]: https://github.com/tryweb/ai-engkit/compare/v1.11.6...v1.11.7
[1.11.8]: https://github.com/tryweb/ai-engkit/compare/v1.11.7...v1.11.8
[1.12.0]: https://github.com/tryweb/ai-engkit/compare/v1.11.8...v1.12.0
[1.12.1]: https://github.com/tryweb/ai-engkit/compare/v1.12.0...v1.12.1
[1.13.0]: https://github.com/tryweb/ai-engkit/compare/v1.12.1...v1.13.0
[1.13.1]: https://github.com/tryweb/ai-engkit/compare/v1.13.0...v1.13.1
[1.13.2]: https://github.com/tryweb/ai-engkit/compare/v1.13.1...v1.13.2
[1.14.0]: https://github.com/tryweb/ai-engkit/compare/v1.13.2...v1.14.0
[1.14.1]: https://github.com/tryweb/ai-engkit/compare/v1.14.0...v1.14.1
[1.14.2]: https://github.com/tryweb/ai-engkit/compare/v1.14.1...v1.14.2
[1.14.3]: https://github.com/tryweb/ai-engkit/compare/v1.14.2...v1.14.3
[1.14.4]: https://github.com/tryweb/ai-engkit/compare/v1.14.3...v1.14.4
[1.14.5]: https://github.com/tryweb/ai-engkit/compare/v1.14.4...v1.14.5
[1.14.6]: https://github.com/tryweb/ai-engkit/compare/v1.14.5...v1.14.6
[1.14.7]: https://github.com/tryweb/ai-engkit/compare/v1.14.6...v1.14.7
[1.14.8]: https://github.com/tryweb/ai-engkit/compare/v1.14.7...v1.14.8
[1.14.9]: https://github.com/tryweb/ai-engkit/compare/v1.14.8...v1.14.9
[1.14.10]: https://github.com/tryweb/ai-engkit/compare/v1.14.9...v1.14.10
[1.14.11]: https://github.com/tryweb/ai-engkit/compare/v1.14.10...v1.14.11
[1.14.12]: https://github.com/tryweb/ai-engkit/compare/v1.14.11...v1.14.12
[1.14.13]: https://github.com/tryweb/ai-engkit/compare/v1.14.12...v1.14.13
[1.14.14]: https://github.com/tryweb/ai-engkit/compare/v1.14.13...v1.14.14
[1.15.0]: https://github.com/tryweb/ai-engkit/compare/v1.14.14...v1.15.0
[1.15.1]: https://github.com/tryweb/ai-engkit/compare/v1.15.0...v1.15.1
[1.15.2]: https://github.com/tryweb/ai-engkit/compare/v1.15.1...v1.15.2
[1.15.3]: https://github.com/tryweb/ai-engkit/compare/v1.15.2...v1.15.3
[1.15.4]: https://github.com/tryweb/ai-engkit/compare/v1.15.3...v1.15.4
[1.15.5]: https://github.com/tryweb/ai-engkit/compare/v1.15.4...v1.15.5
[1.15.6]: https://github.com/tryweb/ai-engkit/compare/v1.15.5...v1.15.6
[1.15.7]: https://github.com/tryweb/ai-engkit/compare/v1.15.6...v1.15.7
[1.15.8]: https://github.com/tryweb/ai-engkit/compare/v1.15.7...v1.15.8
[1.16.0]: https://github.com/tryweb/ai-engkit/compare/v1.15.8...v1.16.0
[1.16.1]: https://github.com/tryweb/ai-engkit/compare/v1.16.0...v1.16.1
[1.16.2]: https://github.com/tryweb/ai-engkit/compare/v1.16.1...v1.16.2
[1.16.3]: https://github.com/tryweb/ai-engkit/compare/v1.16.2...v1.16.3
[1.16.4]: https://github.com/tryweb/ai-engkit/compare/v1.16.3...v1.16.4
[1.16.5]: https://github.com/tryweb/ai-engkit/compare/v1.16.4...v1.16.5
[1.16.6]: https://github.com/tryweb/ai-engkit/compare/v1.16.5...v1.16.6
[1.16.7]: https://github.com/tryweb/ai-engkit/compare/v1.16.6...v1.16.7
[1.16.8]: https://github.com/tryweb/ai-engkit/compare/v1.16.7...v1.16.8
[1.17.0]: https://github.com/tryweb/ai-engkit/compare/v1.16.8...v1.17.0
[1.18.0]: https://github.com/tryweb/ai-engkit/compare/v1.17.0...v1.18.0
[1.18.1]: https://github.com/tryweb/ai-engkit/compare/v1.18.0...v1.18.1
[1.18.2]: https://github.com/tryweb/ai-engkit/compare/v1.18.1...v1.18.2
[1.18.3]: https://github.com/tryweb/ai-engkit/compare/v1.18.2...v1.18.3
[1.18.4]: https://github.com/tryweb/ai-engkit/compare/v1.18.3...v1.18.4
[1.18.5]: https://github.com/tryweb/ai-engkit/compare/v1.18.4...v1.18.5
[1.18.6]: https://github.com/tryweb/ai-engkit/compare/v1.18.5...v1.18.6
[1.18.7]: https://github.com/tryweb/ai-engkit/compare/v1.18.6...v1.18.7
[1.18.8]: https://github.com/tryweb/ai-engkit/releases/tag/v1.18.8
