# Docker Compose Dev/Production Project Isolation

## Context

AI-EngKit uses Docker-out-of-Docker (DooD): Compose commands issued from the development container operate the host Docker daemon. The repository has a production stack in `docker-compose.yml` and a development stack in `docker-compose.dev.yml`, and both can run on the same host.

## Problem

The Compose file name does not determine the project name. Without `-p dev`, Docker Compose derives the project name from the working directory, which can be `ai-engkit`.

Before this safeguard, the following command resolved to the production project and listed `ai-engkit` and `ai-engkit-admin`:

```bash
docker compose -f docker-compose.dev.yml ps
```

`container_name: ai-engkit-dev` is not a project boundary, and `docker-compose.dev.yml` does not imply a `dev` project.

## Solution

`docker-compose.dev.yml` declares `name: dev`, so its default project is safe even when a caller omits `-p`. Dev automation still passes the project explicitly:

```bash
docker compose --project-name dev --file docker-compose.dev.yml build
docker compose --project-name dev --file docker-compose.dev.yml up -d
docker compose --project-name dev --file docker-compose.dev.yml ps
```

Dev scripts must scope container discovery by both Compose project and service labels. They must not select the first container returned by an unscoped `docker ps` or `docker compose ps` query.

## Why It Works

The top-level Compose `name: dev` changes the default project identity from the directory basename to `dev`. Explicit `--project-name dev` remains the stronger command-line guarantee, while Compose labels provide a second check for container and network discovery.

Production commands remain separate and must use `docker-compose.yml` with the production project context. Do not replace production commands in `install.sh` or `upgrade.sh` with dev commands.

## Side Effects / Tradeoffs

- A dev stack created previously under the accidental `ai-engkit` project may have resources with an `ai-engkit_` prefix. Inspect containers, volumes, and networks before cleanup; never run `down -v` against an ambiguous project.
- `test/test-full.sh` intentionally cleans only the `dev` project and uses the dev image, ports, and container name.
- DooD port checks from inside the development container may require the Docker bridge gateway instead of `localhost`; see `docs/knowledge/troubleshooting/dood-subproject-host-port-unreachable.md`.

## Evidence

- `docker compose -f docker-compose.dev.yml ps` previously displayed production containers labeled `com.docker.compose.project=ai-engkit`.
- `docker compose -f docker-compose.dev.yml config --format json | jq -r '.name'` now returns `dev`.
- `./test/test-compose-isolation.sh` fails before the safeguard and passes after it.
- The dev stack is verified through `dev_default` and published ports `8001` and `8081`.

## V2 Line Isolation (guard extended 2026-10-09)

The same guard now also validates `docker-compose.v2.yml`, because the V2 line
shares no mutable state with prod/dev (`trial/DECISIONS.md` D2). It asserts:

- the project resolves to `v2`;
- every named volume used by V2 services is `-v2` suffixed and does not
  exact-name-collide with a volume defined by `docker-compose.yml` or
  `docker-compose.dev.yml`;
- no OMO runtime residue (`omo-config`, `ohmyopencode-cache`,
  `OH_MY_OPENAGENT_VERSION`) in non-comment lines;
- no V2 host port collides with a prod/dev port (`8000`/`8080`/`8001`/`8081`).

It runs in CI in both `build` and `build-v2`, so a dropped `-v2` suffix or a
re-added OMO volume fails fast before an image is built. Confirmed in CI run
`37862545802`: `compose isolation: PASS` inside the `build-v2` job.

## Related Files

- `docker-compose.dev.yml`
- `docker-compose.yml`
- `test/test-compose-isolation.sh`
- `test/test-full.sh`
- `test/test-leanctx-config-persistence.sh`
- `test/run-tests.sh`
- `test/test-admin.sh`
- `.opencode/skills/check-updates/SKILL.md`
- `docs/knowledge/tooling/run-tests-container-name.md`

## Tags

`docker` `docker-compose` `DooD` `dev` `production` `project-isolation` `container-labels`
