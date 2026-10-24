# Dockerfile VOLUME Leaks Anonymous Volumes in Production

## Context

The ai-engkit image declared persistent paths with `VOLUME` in `Dockerfile`,
while `docker-compose.v2.yml` declares all production persistence with named
volumes. The `ai-admin` service runs from the same image as `ai-dev` but only
needs host bind mounts (`./.env.v2`, `./docker-compose.v2.yml`,
`./admin-data-v2`, `./backups-v2`, `./extensions`) plus the Docker socket.

## Problem

Every `VOLUME` path the compose file does not explicitly mount makes Docker
auto-create a 64-character anonymous volume per container at creation time:

- `/home/devuser/.cache/oh-my-opencode` was still declared in `Dockerfile`
  but is obsolete on the V2 line (`OMO_ENABLED=0`), and no compose file mounts
  it — so both `ai-dev` and `ai-admin` each leaked one anonymous volume.
- `ai-admin` shares the image, so all 10 image-declared paths
  (`workspace`, `opencode` data/config/cache, `openchamber-data`, `git-config`,
  `ssh-keys`, `lean-ctx` data/state/config, `oh-my-opencode` cache) became 10
  anonymous volumes on `ai-engkit-admin-v2`, holding no production data.
- `docker compose up -d --force-recreate` **reattaches** those anonymous
  volumes instead of dropping them, and the Admin UI upgrade path
  (`src/admin/lib/upgrade.ts`) only runs `up -d --force-recreate`,
  `docker image prune -f`, and old-backup pruning — never
  `docker volume prune` or `--renew-anon-volumes`. Upgrading alone therefore
  never clears them.

## Solution

1. Remove the `VOLUME` block from `Dockerfile`; compose named volumes are the
   single source of persistence declarations.
2. Upgrade containers to an image built without `VOLUME` (e.g. v2.0.7), so the
   paths are no longer mounts and the old anonymous volumes become dangling.
3. Then run `docker volume prune -f` on the host — it only removes unused
   (dangling) volumes, so in-use `v2_*` named volumes are unaffected.
4. Order matters: prune **after** the upgrade, not before. Before the upgrade
   all 11 anonymous volumes are still mounted (`dangling=true` lists nothing);
   after the upgrade they detach and prune removes them.

## Why It Works

- With no image-level `VOLUME`, Docker has nothing to auto-provision; only
  compose-declared named volumes and bind mounts exist.
- Compose `--force-recreate` preserves anonymous volume attachments by design,
  so the leak persists across recreates until the image stops declaring the
  paths — at which point the orphaned volumes turn dangling and a single
  prune reclaims them.

## Side Effects / Tradeoffs

- `docker volume prune -f` is host-wide: it removes every dangling volume on
  that daemon, not just ai-engkit's. Verify with
  `docker volume ls -qf dangling=true` first on shared hosts.
- Containers built from a pre-fix image still leak on every fresh create;
  the fix only takes effect once all services run the post-fix image.

## Evidence

- 2026-10-24, host `192.168.11.198`: 23 volumes total — 12 `v2_*` named
  volumes (all mounted by `ai-engkit-v2`, holding `opencode.db`, `glab-config`,
  workspace, etc.) plus 11 in-use 64-character anonymous volumes
  (1 on `ai-engkit-v2` for `.cache/oh-my-opencode`, empty; 10 on
  `ai-engkit-admin-v2`, no production data).
- `docker volume ls -qf dangling=true` returned empty before the image fix
  (all anonymous volumes still mounted), confirming prune-before-upgrade is a
  no-op.
- Post-fix local gates: `test-compose-isolation.sh` + `test-check-versions.sh`
  14 passed; `test-v2.sh` cell1/2/3 all PASS; admin suite 1432 pass / 0 fail
  (serial and `--parallel=4`); `typecheck` clean; openchamber guard 21 passed.
- Released as v2.0.7 (`fix(v2): remove image VOLUME to stop anonymous volume
  leaks` + CHANGELOG entry).

## Related Files

- `Dockerfile` — `VOLUME` block removed
- `docker-compose.v2.yml` — production named volumes + `ai-admin` bind mounts
- `src/admin/lib/upgrade.ts` — upgrade path (`up -d --force-recreate`,
  `image prune -f`, backup pruning; no volume pruning)
- `docs/knowledge/troubleshooting/dockerfile-volume-disposable-harness-leak.md` — harness-scoped variant (exact cleanup list per disposable container; do not apply to production containers)

## Tags

- docker
- volumes
- anonymous-volumes
- production
- upgrade
- troubleshooting
