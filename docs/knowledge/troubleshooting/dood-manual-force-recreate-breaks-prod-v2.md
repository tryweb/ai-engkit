# Manual `docker compose --force-recreate` on the V2 prod stack breaks the environment

## Context

The V2 production stack on `192.168.11.198` runs as Compose project `v2`
from `/opt/ai-engkit-v2/docker-compose.v2.yml`, with the image pinned through
`AI_ENGKIT_VERSION` in `/opt/ai-engkit-v2/.env.v2`
(`image: ghcr.io/tryweb/ai-engkit:${AI_ENGKIT_VERSION:-v2}`).

All shell sessions are **DooD**: the `docker` CLI inside the ai-engkit dev
container talks to the host daemon over `/var/run/docker.sock`. The host is
reached from such a session with `ssh root@192.168.11.198`, but `docker compose`
still executes against the host daemon and resolves the prod compose file's
host bind mounts against the **host** filesystem.

The `ai-admin` service bind-mounts host files that it also rewrites at boot:

```yaml
- ./.env.v2:/opt/ai-engkit/.env.v2:rw
- ./docker-compose.v2.yml:/opt/ai-engkit/compose.yml:rw
- ./admin-data-v2:/opt/ai-engkit/admin-data:rw
- ./admin-data-v2/upgrade-base.yml:/opt/ai-engkit/compose-upgrade-base.yml:rw
```

## Problem

A version bump from `v2.0.22` to `v2.0.23` was attempted by hand: edit
`AI_ENGKIT_VERSION=v2.0.23` in `.env.v2`, then run, twice:

```bash
docker compose -p v2 -f docker-compose.v2.yml --env-file .env.v2 \
  up -d --force-recreate --pull never
```

The first recreate was interrupted mid-flight. The second one was issued while
that half-finished state existed. Resulting state on the host:

```
NAMES                             IMAGE                              STATUS
ai-engkit-v2                      ghcr.io/tryweb/ai-engkit:v2.0.23   Up ...
94ceb40196bc_ai-engkit-admin-v2   ghcr.io/tryweb/ai-engkit:v2.0.23   Up (healthy)
ai-engkit-admin-v2                ghcr.io/tryweb/ai-engkit:v2.0.22   Exited (137) 18 minutes ago
```

- A **temporary-name container** (`94ceb40196bc_ai-engkit-admin-v2`) held the
  canonical service slot, while the canonical `ai-engkit-admin-v2` sat stopped
  on the old image. Compose had renamed the old container and stopped it, then
  was interrupted before the new container took the canonical name.
- Port `8082` was held by the temporary container, so a plain `up -d` could not
  cleanly restore the expected topology.
- The hand-run compose command itself created no backup, and `--pull never`
  skipped image pull/verification, so no tested rollback path existed for that
  recreate. Copies left on disk (`backups-v2/pre-2026-11-17T00-12-10-288Z/`
  from an earlier Admin UI step, plus a manual `.env.v2.bak-pre-v2.0.23`) were
  not tied to any recreate procedure.
- The environment had to be recovered from a separate v1 AI-EngKit environment.

## Solution

Use one of the **two supported upgrade paths** instead of hand-rolling
`force-recreate`. Neither is a file that already sits in the prod install
directory: `/opt/ai-engkit-v2` contains only `docker-compose.v2.yml`, `.env.v2`,
`admin-data-v2/`, `backups-v2/`, and `extensions/`. There is **no
`upgrade-v2.sh`** in that directory, so `cd /opt/ai-engkit-v2 && ./upgrade-v2.sh`
fails with `No such file or directory`.

### Option A — `upgrade-v2.sh` from the repo (recreates every service)

`upgrade-v2.sh` lives in the repository (branch `v2`); `install-v2.sh` points
operators at it with `curl -fsSL .../upgrade-v2.sh | bash`. The script works on
the **current working directory**, so `cd` into the host install dir first:

```bash
# on the Docker HOST, not from inside an ai-engkit container
cd /opt/ai-engkit-v2
curl -fsSL https://raw.githubusercontent.com/tryweb/ai-engkit/v2/upgrade-v2.sh | bash
```

It reads `./docker-compose.v2.yml`, `./.env.v2`, and
`./admin-data-v2/upgrade-base.yml`, and writes its backup beside them as
`./backup_v2_<YYYYmmdd_HHMMSS>/` (not into `backups-v2/`, which belongs to the
Admin UI path).

Keeping a copy of the script in the install directory is **optional** — only the
working directory matters. The piped form above leaves no file behind and
silently skips `self_update`, because `[ -f "$0" ]` is false when `$0` is
`bash`. If a persistent copy is preferred:

```bash
cd /opt/ai-engkit-v2
curl -fsSLO https://raw.githubusercontent.com/tryweb/ai-engkit/v2/upgrade-v2.sh
chmod +x upgrade-v2.sh && ./upgrade-v2.sh
```

Then `self_update` applies: it downloads the upstream copy, replaces that file
when the content differs, and re-execs (`UPGRADE_SELF_UPDATED=1` guards the
loop). Running it from elsewhere (`bash /tmp/upgrade-v2.sh` with CWD still in
the install dir) works too, as long as the host check passes.

Order of operations, from `main()`: `require_host` (refuses inside a container —
`Docker-out-of-Docker cannot resolve this install directory's host file bind
mounts; Docker would auto-create empty directories and break ai-admin`) →
hardware and Docker checks → `guard_line` (fails if `docker-compose.v2.yml` is
absent in CWD, i.e. wrong directory) → `backup_files` → `update_compose`
(**downloads the upstream compose file and overwrites the local one**) →
`merge_env` (merge-only: appends only keys missing from `.env.v2`) → `apply`
(`docker compose pull`, then a single `up -d --force-recreate`) → `retention`
(prunes old `backup_v2_*` dirs by `BACKUP_RETENTION`) → prints rollback
commands.

Because it overwrites the compose file from upstream and recreates both
services, it is the right path for any change touching `ai-admin` or the compose
file itself.

`guard_line` ends in `verify_bind_sources 1`, which fails if
`docker-compose.v2.yml`, `.env.v2`, or `admin-data-v2/upgrade-base.yml` is
missing **or is a directory** — a directory there means an earlier DooD run
auto-created it from a missing bind source, and `ai-admin` will then fail with
`EISDIR`.

### Option B — Admin UI upgrade (recreates only `ai-dev`)

The Admin UI path writes `pre-<timestamp>/` under host `./backups-v2/`
(bind-mounted to `/opt/ai-engkit/backups` inside `ai-admin`) before issuing
`up -d --force-recreate ai-dev`. It never recreates `ai-admin`, so it cannot
apply an `ai-admin` compose or bind-mount change.

Both paths take the target version from `AI_ENGKIT_VERSION` in
`/opt/ai-engkit-v2/.env.v2`, because the compose file pins
`image: ghcr.io/tryweb/ai-engkit:${AI_ENGKIT_VERSION:-v2}`.

If a stale temporary-name container is ever observed mid-recreate, finish or
abort that recreate **to completion on the host** before issuing another
`--force-recreate`; do not stack recreates on a half-finished state.

## Why It Works

- `upgrade-v2.sh` runs on the host, so the admin service's host bind mounts
  resolve against the real install directory rather than being auto-created as
  empty dirs by the daemon.
- The backup + explicit pull + single force-recreate sequence has a defined
  rollback path, printed at the end of the run:
  `cp backup_v2_<ts>/docker-compose.v2.yml .`, `cp backup_v2_<ts>/.env.v2 .`,
  then `docker compose --env-file .env.v2 -f docker-compose.v2.yml up -d
  --force-recreate`.
- Avoiding a second recreate while one is in flight prevents the
  temp-name/canonical-name split that leaves the service unreachable by its
  expected container name and port.

## Side Effects / Tradeoffs

- `upgrade-v2.sh` recreates **all** services in the project. The Admin UI
  upgrade recreates only `ai-dev` (see `compose-change-upgrade-checklist.md`),
  so pick the path that matches the change: an env/compose change that affects
  `ai-admin` needs the host script, not the UI path.
- A raw `docker compose up -d` does not always settle on the expected image tag
  in this project; always verify the resolved image after the upgrade
  (`docker inspect --format '{{.Config.Image}}'`) and the in-container
  `/opt/ai-engkit/VERSION`.

## Evidence

Observed during the incident (read-only verification afterwards):

```bash
# temporary-name container holding the slot
docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
# ai-engkit-v2                      ...v2.0.23   Up 2 minutes
# 94ceb40196bc_ai-engkit-admin-v2   ...v2.0.23   Up About a minute (healthy)
# ai-engkit-admin-v2                ...v2.0.22   Exited (137) 18 minutes ago

# canonical container was stopped on the old image
docker inspect ai-engkit-admin-v2 --format '{{.Config.Image}}|{{.State.Status}}'
# ghcr.io/tryweb/ai-engkit:v2.0.22|exited
```

After recovery, verified healthy:

```bash
docker exec ai-engkit-v2 cat /opt/ai-engkit/VERSION        # v2.0.23
docker exec ai-engkit-admin-v2 cat /opt/ai-engkit/VERSION  # v2.0.23
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8002/        # 200
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8082/healthz # 200
curl -s -b <cookie> http://localhost:8082/api/upgrade/versions
# {"current_version":"v2.0.23","configured_version":"v2.0.23",...}
```

Data volumes were **not** recreated: `v2_workspace-v2`, `v2_opencode-data-v2`,
and `v2_openchamber-data-v2` still report `CreatedAt 2026-10-16T15:08:07+08:00`,
and the workspace still contains its projects.

Guardrails already in the repo:

```bash
# upgrade-v2.sh refuses inside a container
grep -n "Running inside a container" upgrade-v2.sh
# backup-first + single recreate
grep -nE "backup_files|dc pull|up -d --force-recreate" upgrade-v2.sh
```

The prod install dir does not ship the upgrade script (operator's listing on
`192.168.11.198`, which corrected an earlier draft of this entry):

```bash
ls -lt /opt/ai-engkit-v2
# admin-data-v2  backups-v2  docker-compose.v2.yml
# docker-compose.v2.yml.bak-20261023  deploy.log  extensions
# -> no upgrade-v2.sh; run it from the repo (Option A) or use the Admin UI
```

## Related Files

- `upgrade-v2.sh` (repo, branch `v2`, not shipped into the install dir) — supported host-side V2 upgrade: backup-first, pull, single recreate, rollback hints
- `install-v2.sh` — V2 install; recommends `curl -fsSL .../upgrade-v2.sh | bash` for later upgrades
- `docker-compose.v2.yml` — V2 prod compose (host bind mounts on `ai-admin`)
- `.env.v2` — pins `AI_ENGKIT_VERSION`
- `docs/knowledge/troubleshooting/dood-bindmount-admin-override.md` — why host bind mounts break from DooD
- `docs/knowledge/patterns/compose-change-upgrade-checklist.md` — different blast radius per upgrade path
- `docs/knowledge/patterns/upgrade-script-pattern.md` — upgrade script design properties
- `docs/knowledge/troubleshooting/upgrade-engine-sse-and-compose-pitfalls.md` — Admin UI upgrade internals

## Tags

docker, compose, dooD, force-recreate, upgrade, v2, prod, incident, bind-mount
