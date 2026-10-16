# Design

## Context

See `proposal.md` for motivation. The current image pins OpenChamber `1.24.2` and OpenCode `1.19.0`, installing both into the user global Bun location (`bun install -g`). The v1.24.2 update routes acknowledge the web self-update before the detached install runs:

- `packages/web/server/lib/opencode/openchamber-routes.js:135` returns an HTTP 200 for a Docker host before scheduling the install.
- `packages/web/server/lib/package-manager.js:804` runs `executeUpdate` for the CLI path.
- `packages/web/server/lib/opencode/routes.js:236` handles the OpenChamber-managed OpenCode upgrade.

The web client reads non-2xx responses as an error (`UI web-update.ts:23`), so a synchronous refusal is visible to the user.

Two facts constrain recovery. First, `~/.bun` is not a mounted volume, so a container restart retains an in-place core mutation in the writable layer, while a container recreate restores the image binary. A previous incident left a stale persisted binary after a restart. Second, persistent config and session data live in separate volumes, so a recreate restores the binary but can leave settings pointing at a vanished CLI, and it never addresses a v2-modified database.

Startup currently loops scripts in lexical order: `01-install-packages` installs user packages, `02` generates config, `07` reconciles project registrations, then the container command runs `serve`. No runtime `OPENCODE_VERSION`/`OPENCHAMBER_VERSION` manifest exists yet.

## Goals / Non-Goals

**Goals:**

- Make the image the single authoritative source of the pinned v1 core at every startup, across both restart and recreate.
- Recover a missing, drifted, partially installed, or corrupt core offline, without network access and without touching unrelated user tools or data.
- Refuse incompatible session data read-only, before the v1 binary mutates it, and preserve that data with guidance.
- Keep the change visible to operators through existing logs, with no new runtime toggle.

**Non-Goals:**

- This is accidental-update prevention, not a security boundary. It cannot stop a deliberate `sudo` or Docker-level bypass.
- It does not migrate the deployment to v2 and does not implement a generic v2-to-v1 data downgrade.
- It does not change OpenChamber or OpenCode update checks, notifications, or notification settings.
- It does not alter the existing `admin-upgrade` or `admin-persistence` capabilities.
- It performs no live remote-host actions and modifies no runtime data during planning.

## Decisions

### D1. Bake the v1 policy; keep notification visibility separate

Update protection is a build-time property of the image, not a user-facing toggle. `showOpenCodeUpdateNotifications` and update checks remain untouched so operators still see that a newer upstream exists. Rationale: a runtime toggle can be flipped off accidentally or by a misread Admin checkbox (see `docs/knowledge/troubleshooting/openchamber-update-notification-not-suppressed.md`), which is exactly the failure mode this change removes. Alternative considered: reuse the notification setting to also gate execution. Rejected because it conflates visibility with policy and reuses a key whose semantics are already inconsistent.

### D2. Refuse updates synchronously at all three entry points

The web update-install route returns HTTP 409 with a JSON body containing an `error` field that names the core as image-managed, and returns it before any success acknowledgement or install scheduling. The `openchamber update` CLI exits nonzero with the same explanation. The OpenChamber-managed OpenCode upgrade endpoint is refused identically so the web UI cannot replace either half of the pinned core. Rationale: a non-2xx response surfaces in the web client (`web-update.ts:23`), and refusing before the acknowledged-success path removes the "accepted then silently diverged" gap documented in the self-update note. Alternative considered: disable the endpoints entirely. Rejected because a structured 409 explains why and keeps the request path observable.

### D3. Version-checked downstream patch that fails the build on mismatch

The guards are small downstream edits to the pinned v1.24.2 routes, applied at image build against the exact pinned upstream commit. If the upstream source shape or version does not match the expected anchor, the build fails rather than shipping with reduced or silently absent coverage. Update checks and notifications are left alone. Rationale: the pinned tree is known, and a mismatch is a real integration break that should stop the build, not degrade quietly.

### D4. Dedicated core prefix, fully isolated from user packages

The managed core installs into an isolated build prefix under `/opt/ai-engkit/core` instead of the user global Bun location. `active` selects a complete installed generation; launch wrappers resolve that generation rather than depending on the user's package-manager metadata. The install carries the full transitive, platform-specific, and symlinked dependency closure. Existing PATH and `~/.bun/bin/opencode` / `~/.bun/bin/openchamber` consumers retain compatible wrappers. Wrappers use the image's existing absolute Bun executable path, without changing the user's global package prefix.

User global packages under `~/.bun` are untouched, and `BUN_PACKAGES` continues to install into the user prefix. The AI-EngKit startup package installer rejects `opencode-ai`, `@opencode/cli`, and `@openchamber/web` before installing anything in a conflicting request. Normal unrelated Bun installs remain available. Arbitrary direct package-manager commands with shell/sudo access remain outside the accidental-update guarantee; no global Bun command interception is introduced. Rationale: a separate installation closure makes recovery bounded without wiping user tools. Moving all of `~/.bun` or copying only two top-level package directories is rejected.

### D5. Root-owned pristine archive plus integrity manifest, offline exact-tree recovery

The image ships a root-owned pristine core archive and an explicit pin and integrity manifest under `/opt/ai-engkit/core-baseline`. Capture the baseline after applying and testing the update guards, so recovery restores the guarded version, not unpatched upstream files. Record regular-file contents and modes, symlink targets, executable launchers and the complete allowed path inventory. Detect missing, changed and unexpected files, not just version mismatches. Baseline paths must be excluded from recursive devuser ownership changes.

Verify the archive against its baked digest before extracting; a missing or invalid archive/manifest blocks startup without replacing the core. If the archive is valid but the active installation has drifted, extract into a sibling staging generation, validate containment, dependency links and the full manifest, then atomically switch `active`. Use a narrowly scoped startup recovery helper with the permissions needed for the root-owned core, never world-writable destinations. Interrupted staging is not launched; the next startup revalidates and safely retries. No partially restored tree is active and no network reinstall is used. Rationale: version strings do not detect partial corruption, while network reinstall reintroduces runtime dependency drift.

### D6. Recovery runs first in the startup sequence and not for ai-admin

Verification and recovery run at startup before `01-install-packages`, before config generation and application, and before the application starts. The path is not activated for the `ai-admin` command. Rationale: recovering after user installs or config application could race with or invalidate those steps, and the admin service shares the image but does not run the v1 core.

### D7. Expected versions come from build metadata, not runtime repo parsing

Expected core versions and identifiers are derived from Docker build arguments and emitted as build metadata. The runtime reads that metadata and does not parse the repository to determine expected versions. Rationale: the runtime container has no source checkout guarantee, and pins must reflect the exact image that was built.

### D8. Narrow, atomic managed CLI selection repair

Treat an unset selection as managed PATH lookup, and the previous image path `~/.bun/bin/opencode` as a compatibility wrapper. Repair a missing legacy `~/.opencode/bin/opencode` or an explicitly recorded image-managed path to the current managed launcher. An existing unowned custom binary is not silently replaced; a custom executable with a non-v1 version blocks v1 startup with guidance while preserving its selection. Validate versions without opening session data. An unknown missing custom path is an explicit startup error.

Use a protected backup and same-directory atomic write; preserve unrelated fields, ownership and permissions, refuse symlinked/malformed settings rather than replacing them, and do not create repeated backups on clean boots. Perform any settings write only after data compatibility checks have passed and before the server loads settings. Rationale: the observed stale path can be repaired without clobbering custom configuration. Rewriting every missing selection is rejected.

### D9. Read-only data compatibility gate before the v1 binary touches state

Before the v1 binary touches session state, a read-only gate checks schema and migration identifiers against a pinned-v1 baseline captured from a disposable v1 fixture at build or test time. Absent or fresh databases and recognized v1 databases are allowed; v2 or unknown schemas block startup with the data files left untouched and operator guidance, and the old binary is never started just to probe the database. The gate is WAL-aware: it does not ignore write-ahead log or shared-memory files and never writes, checkpoints, or mutates the database; locked, corrupt, or unknown databases block with guidance. No database backup is restored automatically and no newly created session is deleted. Rationale: the real hazard is a v2 binary migrating the shared database in place and breaking v1 (see `docs/knowledge/tooling/opencode-v2-migration-watch.md` #42260). A conservative read-only gate avoids both the migration and any destructive automatic rollback. Alternative considered: open the database with the CLI to detect compatibility. Rejected, since running the old binary against unexpectedly-new data is itself a mutation risk.

Use a private temporary inspection copy of a stable database plus its matching WAL/SHM sidecars, with source consistency checked before and after copying; inspect only that copy with SQLite and discard it afterward. Never use `immutable=1` on the live database to skip its WAL, and never checkpoint or repair the original. If a stable snapshot cannot be established, block conservatively. Compare schema/migration identity, not database content hashes: normal session inserts must remain compatible. Include supported older v1 fixtures in the compatibility allowlist; a single freshly created schema is not sufficient evidence that all existing v1 installations remain supported. A database absent with unexplained remaining sidecars is not treated as a clean first boot. The gate is a compatibility screen, not proof that arbitrary v2 state can be downgraded.

### D10. Startup failure logs clearly without destructive retries

A blocked ai-dev startup writes one structured reason and recovery guidance, skips package installation/configuration/application launch, and remains in a signal-responsive, non-mutating blocked state. It does not repeatedly exit under Compose `restart: unless-stopped`, retry restoration, or rewrite settings. Admin remains available and application health cannot report success. An explicit operator restart retries preflight after remediation. Successful startup follows the normal command path. Rationale: immediate repeated exits would let Docker turn a safe refusal into a restart storm. No Compose restart-policy changes are required.

### D11. Bypass boundary and rollback scope are documented

The change documents that protection prevents accidental updates and cannot stop a deliberate sudo or Docker bypass, and that no generic v2 downgrade is guaranteed. Rationale: operators must not mistake this for a security control or a migration tool.

## Risks / Trade-offs

- Upstream source drift in a future OpenChamber release → the version-checked patch fails the build on mismatch (D3), so coverage loss is visible at build time rather than silent at runtime.
- The compatibility gate could block a healthy v1 install on a false positive → the baseline identifiers come from a real disposable v1 fixture, and the gate is additive: fresh and recognized v1 pass, only v2 or unknown schema blocks.
- A locked database during startup could block boot → the gate reports locked/corrupt/unknown with guidance and leaves files untouched, and the failure path is logged without a destructive retry loop (D9, D10).
- Recovery runs on every start, adding startup work → verification is a hash comparison against the manifest, and a clean core short-circuits without a restore.
- Because `~/.bun` is not a volume, a restart retains an in-place mutation while a recreate removes it → recovery runs first on every startup and restores the exact pinned tree in both cases, which is precisely why recovery, not a mount fix, is the mechanism.
- A dedicated prefix could break wrappers that assume the user location → launch wrappers are kept compatible with the existing PATH and current script consumers (D4), and reserved-name rejection prevents shadows.

## Migration Plan

1. Build the image; the core is installed into the dedicated prefix, the pristine archive and manifest are baked, build metadata is emitted, and the version-checked update guards are applied during the build.
2. Deploy by the normal image upgrade path (pull or build plus container recreate). Protection applies only after an image containing this change is deployed; there is no in-place migration for a running container.
3. On each subsequent start, recovery verifies and, if needed, restores the core before user packages, config, and startup; the compatibility gate runs before the v1 binary touches state.
4. Verify with the regression and integration coverage in `tasks.md`, including restart versus recreate behavior on disposable volumes.
5. Rollback is a redeploy of the previous image pin. No v2 downgrade path is provided or implied.
