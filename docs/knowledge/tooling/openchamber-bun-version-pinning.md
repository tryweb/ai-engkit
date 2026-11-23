# OpenChamber Upgrades Require a Pinned Bun Toolchain

> Status: the retired `.github/workflows/dependency-update.yml` was removed in
> 2026-11. The derived `BUN_VERSION` contract below now applies only to
> `.opencode/scripts/check-versions.sh` and `test/test-check-versions.sh`.

## Context

The ai-engkit image installs Bun before globally installing `opencode-ai` and
`@openchamber/web`. OpenChamber v1.18.0 declares `bun@1.3.14` as its package
manager and its upstream Dockerfile uses `oven/bun:1.3.14`.

## Problem

Installing Bun from the moving `latest` channel makes otherwise identical
Dockerfile builds produce different images. Bun releases are frequent, and
unreviewed runtime changes can affect dependency resolution, lifecycle scripts,
native modules, or lockfile behavior.

## Solution

Keep Bun pinned to an exact installer tag in `Dockerfile`:

```dockerfile
ARG BUN_VERSION=1.3.14
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"
```

Update the pin deliberately through the version-management workflow, followed
by a no-cache image build and runtime verification.

## Why It Works

The exact `bun-v1.3.14` installer tag reproduces the toolchain used and tested
by OpenChamber v1.18.0. It also gives the image a stable audit trail and makes
rollback comparisons meaningful.

## Side Effects / Tradeoffs

- Bun `1.3.14` is the upstream-tested baseline, not proven to be a hard runtime
  minimum.
- Tracking `latest` may work for disposable experiments, but is unsuitable for
  release or persistent development images without automated rebuild and full
  smoke-test coverage.
- `BUN_VERSION` is a Dockerfile pin registered in
  `.opencode/scripts/check-versions.sh`; that is the single source of truth for
  monitoring it.

## Evidence

- OpenChamber v1.18.0 upstream `package.json` specifies `packageManager:
  bun@1.3.14`.
- OpenChamber v1.18.0 upstream Dockerfile uses `oven/bun:1.3.14`.
- Local no-cache image build succeeded with `BUN_VERSION=1.3.14`.
- Runtime verification returned `bun=1.3.14`, `openchamber=1.18.0`, and
  `opencode=1.18.11`.

## Related Files

- `Dockerfile`
- `.opencode/scripts/check-versions.sh`
- `test/test-check-versions.sh`
- `docs/knowledge/patterns/version-management-pipeline.md`

## Tags

`bun` `openchamber` `version-pinning` `docker` `reproducible-builds`
