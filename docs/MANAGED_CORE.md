# Managed Core: Isolation, Integrity Baseline, and Offline Recovery

AI-EngKit treats OpenChamber and OpenCode as an **image-managed core**. The
image, not the running container or the user package prefix, is the single
authoritative source of the pinned v1 core. This document describes the
dedicated prefix, the dependency closure it carries, the build-time integrity
baseline, and how startup verifies and restores it.

For the update-refusal policy itself, see
[OpenChamber self-update vs the image pin](./knowledge/architecture/openchamber-self-update-vs-ai-engkit-pin.md).

## Dedicated prefix and isolation boundary

The core installs with `BUN_INSTALL` pointing at an isolated prefix, so it never
shares a directory with the user global Bun prefix:

| | Core (image-managed) | User packages |
|---|---|---|
| Prefix | `/opt/ai-engkit/core` | `/home/devuser/.bun` |
| Installed by | image build (`BUN_INSTALL=… bun install -g`) | `BUN_PACKAGES` at startup / interactive `bun install -g` |
| Owner | `root:root` | `devuser:devuser` |
| Contains | `opencode-ai`, `@openchamber/web` and their full closure | `@fission-ai/openspec`, `@comment-checker`, Playwright, CodeGraph, LSP servers, user packages |
| Docker volume | no | no |

`BUN_INSTALL` is **not** set globally, so interactive and startup user installs
keep writing to `~/.bun`; only the managed wrappers set it, and only for their
own process. The startup installer (`entrypoint.d/01-install-packages.sh`)
rejects `opencode-ai`, `@opencode/cli`, and `@openchamber/web` before installing
anything, so a mixed `BUN_PACKAGES` request cannot shadow or partially mutate
the managed core. Unrelated packages install normally, and Bun itself is not
wrapped.

## Core layout

```text
/opt/ai-engkit/core/                 root:root 0755
├── bin/opencode                     stable PATH wrapper (sets BUN_INSTALL=active)
├── bin/openchamber                  stable PATH wrapper (sets BUN_INSTALL=active)
├── active -> generations/<id>       root-owned symlink, switched atomically
└── generations/<id>/                complete installed Bun prefix
    ├── bin/opencode -> ../install/global/node_modules/opencode-ai/bin/opencode.exe
    ├── bin/openchamber -> ../install/global/node_modules/@openchamber/web/bin/cli.js
    └── install/global/…             full transitive/platform/symlinked closure

/home/devuser/.bun/bin/opencode      -> /opt/ai-engkit/core/bin/opencode
/home/devuser/.bun/bin/openchamber   -> /opt/ai-engkit/core/bin/openchamber
```

`/opt/ai-engkit/core/bin` is first in `PATH`. `~/.bun/bin` follows it and
supplies `bun` and the `node` shim (`node` → `bun`), so a core launch resolves
`bun` from the user prefix even though the core wrappers win `opencode` and
`openchamber`. The `~/.bun/bin` compatibility symlinks keep absolute-path
consumers working (the admin version probes run
`/home/devuser/.bun/bin/openchamber --version`, and OpenChamber's own resolver
falls back to `~/.bun/bin/opencode`).

### Closure

The generation is the complete post-install closure: the transitive
dependencies, the platform-specific packages resolved for `linux/amd64` glibc,
and the symlinked launchers. `opencode-ai`'s postinstall hard-links the platform
binary into `opencode-ai/bin/opencode.exe`; the unused cross-platform optional
source packages (`opencode-linux-x64-*`) are dropped without removing the
executable. The measured closure after cleanup is ~372 MB and both launchers
resolve from it.

## Offline integrity baseline

The build captures the guarded, installed generation as a root-owned baseline:

```text
/opt/ai-engkit/core-baseline/        root:root
├── core.tar.gz                      deterministic offline archive, 0444
├── manifest.json                    integrity manifest, 0444
└── metadata.json                    build metadata, 0444
```

- **`manifest.json`** is the exact path inventory: every regular file (mode,
  size, SHA-256), every directory (mode), and every symlink (target). Recovery
  compares contents, modes, link targets, and the full path set, so it detects
  missing, changed, wrong-mode, and unexpected files — not just a version string.
- **`metadata.json`** carries the expected pins read from Docker build arguments
  (`opencode_version`, `openchamber_version`, `bun_version`,
  `ai_engkit_version`), the content-derived generation id, and the archive
  SHA-256. The runtime reads this file and never parses the repository or
  fetches packages.
- **`core.tar.gz`** is created by GNU `tar` with sorted entries, normalized
  owner/timestamps, and POSIX format, so the same tree produces the same
  archive.

Build metadata comes from the Dockerfile pins; the image baseline is captured
**after** the update guards are applied, so a restore re-applies the guarded
package, not unpatched upstream files.

## Recovery contract

`entrypoint.d/00-core-recovery.sh` runs first, before package installation,
configuration generation, and application startup, using
`scripts/ai-engkit-core.py`. Recovery is idempotent, offline, and fail-closed:

1. Load and validate `metadata.json` and `manifest.json`; recompute the
   manifest's generation id and verify the archive digest against
   `metadata.archive_sha256`. A missing, unreadable, schema-mismatched, or
   digest-mismatched baseline **refuses** before touching the active core.
2. If `active` already matches the manifest exactly, report clean and change
   nothing.
3. Otherwise extract the archive into a sibling staging directory, then verify
   the staged tree against the manifest — including that every symlink target
   stays inside the tree. A staged mismatch, an absolute link, or an escaping
   link refuses.
4. Move the verified staging directory to `generations/<id>` and switch the
   `active` symlink atomically, so no partially restored core is ever active.
   Interrupted staging is never launched; the next startup revalidates and
   retries.

Recovery uses only image-local artifacts and performs no network access. Root
ownership of `/opt/ai-engkit/core` and `/opt/ai-engkit/core-baseline` is applied
at build and is intentionally absent from `entrypoint.d/00-fix-perms.sh`, so it
survives startup permission fixing. A refusal prevents the application from
launching.

## Database compatibility gate

Immediately after core recovery, `entrypoint.d/00-db-compat-gate.sh` runs
`scripts/ai-engkit-db-compat.py` against
`/home/devuser/.local/share/opencode/opencode.db` and the image-owned
`/opt/ai-engkit/core-baseline/opencode-v1-db.json`. It runs before user-package
installation and configuration generation, and never starts OpenCode to probe
the database.

An absent or fresh database and a recognized v1 schema are allowed. A v2,
unknown, locked, corrupt, unstable, or otherwise uninspectable database blocks
the ai-dev startup with a reason and operator guidance. The gate inspects only
a private, stable copy of the database and matching SQLite sidecars; it does
not write, checkpoint, back up, restore, or delete anything in the data volume.
In particular, it does not provide a generic downgrade for a database already
migrated by OpenCode v2.

## Startup ordering and ai-admin

```text
entrypoint.sh
└── entrypoint.d/
    ├── 00-core-recovery.sh      verify / restore the managed core   ← skipped for ai-admin
    ├── 00-db-compat-gate.sh     allow only absent/fresh/recognized v1 data
    ├── 00-fix-perms.sh
    ├── 00-opencode-selection-repair.sh repair the stale managed CLI selection
    ├── 01-install-packages.sh   user APT/BREW/BUN packages
    ├── 02-init-config.sh        configuration generation
    ├── 06-setup-opencode-path.sh add the managed CLI wrappers to interactive PATH
    └── …                        then the container command
```

`entrypoint.sh` exports only `AI_ENGKIT_BOOT_ROLE` (`ai-dev` or `ai-admin`), not
the container command. It identifies both the production direct Bun command and
the development shell command used by ai-admin. The core recovery and database
gate skip ai-admin because that service shares the image but does not run the v1
core or access the OpenCode session database.

## Managed CLI selection repair

Before package installation and configuration generation,
`entrypoint.d/00-opencode-selection-repair.sh` checks the optional
`opencodeBinary` value in
`/home/devuser/.config/openchamber/settings.json`. An absent, empty, or
non-string selection continues to use managed PATH lookup. A missing known
image-managed path (`~/.opencode/bin/opencode`, `~/.bun/bin/opencode`, or the
current managed launcher) is repaired to `/opt/ai-engkit/core/bin/opencode`.
The previous image's `~/.bun/bin/opencode` compatibility wrapper is left
unchanged when it resolves.

The repair writes through a same-directory temporary file and atomic replace,
preserving the settings file mode and all unrelated JSON values. Before the
first repair it saves the original bytes to
`settings.json.ai-engkit-backup` with mode `0600`; this is first-wins and is not
overwritten on later boots. Valid custom v1 selections remain unchanged.
Malformed or symlinked settings, an unrecognized missing custom path, and a
custom executable reporting a non-v1 major version are refused without
rewriting the selection. The missing-custom-path diagnostic says the path is
“missing and unrecognized” and advises installing the CLI or clearing
`settings.opencodeBinary`.

This repair runs only for `ai-dev`; `ai-admin` skips it so the dashboard remains
available for remediation. A refusal enters the same blocked startup state as a
core or database refusal, before user package installation and config
generation.

## Blocked startup and operator recovery

If either preflight refuses, `entrypoint.sh` logs the stage failure and remains
in a signal-responsive blocked state. It does not proceed to package installation,
configuration generation, or application launch, and it does not repeatedly
exit under Compose `restart: unless-stopped`. The ai-dev container may therefore
show as running while OpenChamber is unavailable; the application cannot report
healthy because it was never launched. The ai-admin service remains available
for diagnosis.

For a base-only deployment, inspect the ai-dev logs and explicitly restart after
remediation:

```bash
docker compose logs --tail=100 ai-dev
```

```bash
docker compose restart ai-dev
```

For an overlay deployment, use the same project directory and base-plus-overlay
files that started the service (replace `<name>` with the configured overlay):

```bash
docker compose --project-directory . \
  -f docker-compose.yml -f extensions/<name> logs --tail=100 ai-dev
docker compose --project-directory . \
  -f docker-compose.yml -f extensions/<name> restart ai-dev
```

Use the normal image upgrade/recreate flow to deploy a different pinned core;
a container restart alone does not replace its image. From the deployment
directory, use the supported upgrade script so its `.env` and any configured
overlay remain the effective inputs:

```bash
./upgrade.sh
```

For a v2 or unknown
database, preserve the data and choose a compatible recovery path for that data.
Do not attempt an automatic volume rollback or start the v1 binary against a
database the gate refused. Managed-core recovery is an accidental-drift guard,
not a security boundary: a user with `sudo` or Docker access can deliberately
bypass it, and no generic v2-to-v1 downgrade is provided.

## Boundary

Managed-core isolation and recovery protect the image pin from accidental
replacement and from in-place drift or partial edits. They are not a security
boundary: a user with shell, `sudo`, or Docker access can still replace files
directly. They do not provide a generic v2 downgrade; an operator upgrades by
deploying a new AI-EngKit image.

## Related files

- `Dockerfile` — isolated core install, guard patching, baseline build, wrappers, root hardening
- `scripts/ai-engkit-core.py` — build-baseline / verify / recover / status CLI
- `scripts/ai_engkit_core_lib.py` — tree inventory, hashing, archive, and baseline primitives
- `scripts/ai-engkit-core-wrapper.sh` — stable PATH wrapper
- `entrypoint.d/00-core-recovery.sh` — startup recovery stage
- `scripts/ai-engkit-db-compat.py` — read-only database compatibility check
- `scripts/db-compat-baseline.json` — pinned v1 schema and migration identities
- `entrypoint.d/00-db-compat-gate.sh` — startup database preflight stage
- `entrypoint.d/lib-opencode-selection-repair.bash` — narrow atomic selection repair
- `entrypoint.d/00-opencode-selection-repair.sh` — pre-package CLI selection stage
- `entrypoint.d/lib-reserved-bun-packages.bash` — reserved package-name guard
- `test/test-managed-core-recovery.sh` — deterministic isolation/recovery tests
- `test/test-db-compat-gate.sh` — read-only database-gate tests
- `test/test-opencode-selection-repair.sh` — CLI selection repair tests

## Tags

`managed-core` `isolation` `bun` `recovery` `integrity-manifest` `offline` `docker`
