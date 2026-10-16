# Proposal

## Why

OpenChamber self-updates can replace the AI-EngKit v1 core with incompatible v2 components independently of the image pins. A normal container restart retains those replacements, while recreation restores the image binaries but can leave persistent settings pointing at a vanished CLI; neither operation guarantees that v2-modified user data remains compatible with v1.

## What Changes

- Reject OpenChamber web self-update requests before acknowledging success or scheduling installation, with a visible managed-install explanation; reject `openchamber update` with a nonzero exit status.
- Reject the OpenChamber-managed OpenCode upgrade endpoint as well, so the web UI cannot independently replace either half of the pinned core. Keep notification visibility separate from execution policy.
- Isolate the managed core installation and its complete dependency closure from user-installed Bun packages. Bake an explicit v1 policy, expected versions, integrity manifest, and root-owned offline recovery artifact into the image.
- Verify and recover the managed core before user package installation, configuration generation, or application startup. Handle version drift, partial installation, and same-version corruption without network access or deletion of unrelated tools.
- Reconcile known AI-EngKit-managed stale CLI selections narrowly and atomically before startup, preserving custom binary selections and unrelated settings.
- Gate v1 startup on a conservative, read-only data-compatibility check; preserve unknown or incompatible data and report recovery guidance instead of automatically rolling back SQLite or overwriting user state.
- Add isolated regression/integration coverage and document restart versus recreate behavior and the supported image-based upgrade path.

## Capabilities

### New Capabilities

- `managed-core-runtime`: Image-controlled core update policy, integrity verification, offline startup recovery, managed CLI selection repair, and data-preserving startup refusal for AI-EngKit v1.

### Modified Capabilities

None. Existing `admin-upgrade` image/overlay upgrade requirements and `admin-persistence` Admin-state requirements remain unchanged.

## Impact

- Image build and runtime packaging: `Dockerfile`, managed-core build/patch helpers, startup scripts, executable wrappers, and existing package/version smoke checks.
- Pinned upstream OpenChamber v1.24.2 update routes and CLI execution require small, version-checked downstream guards; unexpected upstream source shapes must fail the build rather than silently lose coverage.
- Persistent OpenChamber settings may receive a targeted managed-path repair with a protected backup; projects, credentials, sessions, database contents, and unrelated Bun/LSP packages must not be reset.
- Existing installations acquire protection only after deployment of an image containing this change. This is accidental-update prevention, not a security boundary against sudo/Docker access. It does not migrate the deployment to v2, implement arbitrary v2-to-v1 data conversion, or modify live environments during planning.
