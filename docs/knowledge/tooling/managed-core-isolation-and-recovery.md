# Managed Core Isolation and Offline Recovery

## Context

AI-EngKit pins OpenChamber (`ARG OPENCHAMBER_VERSION`) and OpenCode
(`ARG OPENCODE_VERSION`) and originally installed both with `bun install -g`
into the user global prefix `/home/devuser/.bun`. That prefix is not a Docker
volume, so an in-container self-update mutated the writable layer, a restart
retained the mutation, and a recreate silently reverted it — the drift this
change removes.

## Problem

Two facts make in-place protection insufficient: `~/.bun` is not mounted (so a
restart keeps a mutation while a recreate discards it), and user `BUN_PACKAGES`
installs share the same prefix as the core, so a package operation can overwrite
core files. A version string cannot detect partial corruption, and a network
reinstall reintroduces runtime dependency drift.

The offline baseline build also needs a writable parent directory while it
creates `manifest.json` and `metadata.json`. A nested Docker `COPY --chmod=0444`
can create its missing parent directories with mode `0444`, which remains
unchanged by a later `chown`.

## Solution

- Install the core into an isolated image-owned prefix with an explicit
  `BUN_INSTALL` (`/opt/ai-engkit/core`), leaving `~/.bun` for user packages.
  BUN 1.4.2 resolves global packages to `<BUN_INSTALL>/bin` and
  `<BUN_INSTALL>/install/global/node_modules`.
- Keep stable PATH wrappers in `/opt/ai-engkit/core/bin` that set
  `BUN_INSTALL=<core>/active` for their own process only, plus `~/.bun/bin`
  compatibility symlinks for absolute-path consumers (admin version probes,
  OpenChamber's `~/.bun/bin/opencode` fallback).
- Reject `opencode-ai`, `@opencode/cli`, and `@openchamber/web` in a
  `BUN_PACKAGES` request before any install; do not wrap Bun.
- Bake a root-owned offline baseline (`core.tar.gz`, `manifest.json`,
  `metadata.json`) under `/opt/ai-engkit/core-baseline`, captured after the
  update guards are applied, and restore it at startup via a staging directory
  and an atomic `active` symlink switch. Manifest verification covers contents,
  modes, link targets, and the exact path inventory, and refuses on a
  missing/corrupt archive or an escaping staged link.
- Before build-time baseline capture, restore `/opt/ai-engkit/core-baseline` to
  mode `0755` after ownership changes. The manifest, archive, and metadata
  files themselves are hardened read-only after capture.

## Why It Works

A separate prefix makes recovery bounded: restoring one directory cannot touch
user tools, and the user prefix still supplies `bun`/`node`. The integrity
manifest verifies the exact tree (contents, modes, links, inventory), so
same-version corruption is detected where a version check would pass. Staging
plus an atomic symlink switch means the active generation is always a
previously verified tree, and the whole path is image-local and offline.
Explicitly setting the baseline directory mode is necessary because ownership
changes do not restore execute/write permission lost when Docker creates the
nested `COPY --chmod=0444` destination.

## Side Effects / Tradeoffs

- The core is root-owned read-only, so a package that expects to write into its
  own install directory would fail; writable state belongs in the mounted
  volumes (`~/.config/openchamber`, `~/.cache/opencode`, and similar).
- Startup verifies the tree on every boot; a clean core short-circuits after the
  manifest comparison, but a drifted core pays a staging extract.
- Protection is accidental-update prevention, not a security boundary, and does
  not provide a generic v2 downgrade.

## Evidence

- `opencode-ai@1.19.0` postinstall hard-links the platform binary into
  `opencode-ai/bin/opencode.exe`; the unused `opencode-linux-x64-*` optional
  source packages can be deleted without losing the executable. After dropping
  them and the Bun cache, the closure is ~372 MB and both `opencode` and
  `openchamber` still launch.
- Isolated-prefix experiment (Bun 1.4.2): `BUN_INSTALL=/tmp/ai-engkit-core-bun-prefix
  bun install -g opencode-ai@1.19.0 @openchamber/web@1.24.2 --trust` produced
  `bin/` symlinks resolving into `install/global/node_modules`; both launchers
  reported `1.19.0` and `1.24.2`.
- `test/test-managed-core-recovery.sh` covers drift/partial/extra/mode restore,
  corrupt/missing/unsafe baseline refusal, interrupted staging, offline +
  idempotent recovery, real-closure PATH launch with `bun` from the user prefix,
  reserved-name rejection before mutation, and ai-admin exclusion.
- A minimal Docker build reproduced `COPY --chmod=0444` creating the baseline
  directory as `0444`; after chown, devuser still could not traverse it. With
  the real existing `/opt/ai-engkit` parent and an explicit `chmod 0755` on the
  baseline directory, the devuser `manifest.json` write succeeded.
- `docker build --progress=plain -t ai-engkit-guard-v1:test --build-arg
  AI_ENGKIT_VERSION=guard-v1-test .` completed after the mode fix; the image's
  pinned DB-baseline capture and managed-core recovery checks passed.

## Related Files

- `docs/MANAGED_CORE.md`
- `scripts/ai-engkit-core.py`
- `scripts/ai_engkit_core_lib.py`
- `scripts/ai-engkit-core-wrapper.sh`
- `entrypoint.d/00-core-recovery.sh`
- `Dockerfile`

## Tags

`managed-core` `isolation` `bun` `recovery` `integrity-manifest` `offline` `docker`
