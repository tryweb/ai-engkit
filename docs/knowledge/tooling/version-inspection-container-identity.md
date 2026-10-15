# Version inspection: resolve container identity and the pin baseline before comparing

## Context

One host runs several co-existing ai-engkit stacks, each with its own image
(`docker-compose.v2.dev.yml` header states the layout: V1 prod 8000/8080,
V1 dev 8001/8081, V2 prod 8002/8082, V2 dev 8003/8083). Agents are regularly
asked version questions — "what versions does this environment run", "is any
pin outdated" — and the answer depends entirely on **which container** is being
inspected and **which pin source** is the correct baseline.

## Problem

Two independent mistakes silently produce a wrong answer:

1. **Container identity inferred from files instead of the daemon.**
   `/opt/ai-engkit/VERSION` is *baked into the image* at build time; it is not a
   statement about the running stack. On 2026-10-15 this file contained `v2dev`
   inside a container whose compose project was `v2` (the V2 **prod** stack),
   because the `:v2` image had been built with `AI_ENGKIT_VERSION=v2dev`. A
   repo checkout present in the workspace (e.g. `docker-compose.v2.dev.yml`)
   is equally not evidence — the workspace volume is shared by design.

2. **Pins read from the current working tree while versions are read from a
   container image built earlier.** Every difference then measures "the repo
   moved on since the image was built", not "this environment is misconfigured".
   The same 2026-10-15 session reported 7 pins "behind upstream" in
   `ai-engkit-v2` by comparing in-container versions against
   `docker-compose.v2.dev.yml` HEAD values, when the image had been built six
   days earlier and every single difference was explained by three later pin
   bumps (`418a083`, `723f69c`, `e527dce`).

Two questions must therefore be kept separate:

- **(a) pins vs upstream latest** — a repository question, answered by the
  authoritative script.
- **(b) in-container versions vs the image's own pins** — an environment
  question, answered from the image that is actually running.

## Solution

**Step 1 — resolve identity from the daemon, never from files.**

```bash
docker inspect "$(cat /etc/hostname)" --format '{{.Name}} | {{.Config.Image}} | created={{.Created}}'
docker inspect "$(cat /etc/hostname)" --format \
  'project={{index .Config.Labels "com.docker.compose.project"}}
service={{index .Config.Labels "com.docker.compose.service"}}
config_files={{index .Config.Labels "com.docker.compose.project.config_files"}}
env_file={{index .Config.Labels "com.docker.compose.project.environment_file"}}'
docker inspect "$(cat /etc/hostname)" --format '{{range .Mounts}}{{.Name}} -> {{.Destination}}{{"\n"}}{{end}}'
```

**Step 2 — take the pin baseline from the image build time.**

```bash
IMAGE=$(docker inspect "$(cat /etc/hostname)" --format '{{.Config.Image}}')
CREATED=$(docker image inspect "$IMAGE" --format '{{.Created}}')
git log --until="$(date -d "$CREATED" -d '+1 min' '+%Y-%m-%d %H:%M %z')" -1 --format='%h %ad %s' --date=iso
git show <commit>:Dockerfile | grep -E '^ARG [A-Z_]+_VERSION='
git show <commit>:docker-compose.v2.dev.yml | grep -E 'OPENCODE_CLI_VERSION=|OPENCHAMBER_VERSION='
```

Compare each in-container version against that commit's pins, per pin.

**Step 3 — for question (a), use the repo's script, not a hand-rolled grep.**
On the V2 line the effective pins live in the compose build args, so V2 mode is
required:

```bash
CHECK_V2_LINE=1 .opencode/scripts/check-versions.sh outdated   # exit 1 = something newer upstream
```

## Why It Works

- `com.docker.compose.*` labels are written by the engine at container-create
  time and `/etc/hostname` is the container ID short form, so the pair
  identifies the stack and the exact compose file that produced it.
- Using the image's own `Created` timestamp to bound the build-time commit
  removes the "the repo moved on" false positives: the image cannot contain
  pins newer than its build.
- `check-versions.sh` already encodes what a hand-rolled grep misses: the V2
  pin-source switch (`CHECK_V2_LINE`/`CHECK_COMPOSE_FILE`), derived pins
  (`BUN_VERSION` derives from the `packageManager` field of the pinned
  `OPENCHAMBER_VERSION` tag), the OpenCode/OpenChamber locked-pair rule, the
  OMO exclusion on the V2 line, and `--latest` tracking
  (`codegraph`, `openspec`).

## Side Effects / Tradeoffs

- **Timestamp → commit is a heuristic, so verify per pin.** A build from a
  dirty working tree, or from a commit outside the current branch history,
  breaks the attribution. Observed exception: the running `:v2` image
  (`Created 2026-10-10T12:59:32Z`, build-time commit `9105dd3`) matches 12 of
  13 pins exactly but ships `glab 1.121.0`, a value that appears in **no
  commit** (`GLAB_VERSION` went `1.120.0` → `1.122.0`). The image is therefore
  not reproducible from any commit; per-pin comparison is authoritative and the
  timestamp is only a starting point.
- `git log -S'ARG FOO_VERSION='` does **not** detect pin-value changes (the
  substring occurrence count is unchanged by an edit). Use
  `git log -G'^ARG FOO_VERSION='`.
- `docker image inspect` of a *different* image tag (e.g. the dev tag
  `ai-engkit-ai-v2dev`) is not evidence about the running container's contents;
  it produced a phantom "`LEANCTX_VERSION=3.11.4` ENV vs 3.10.5 binary"
  mismatch in the 2026-10-15 session.
- Dockerfile ARG defaults are not the V2 line's effective pins
  (`OPENCODE_VERSION=1.18.32`, `OPENCHAMBER_VERSION=1.24.2` are V1 values; V2
  overrides them through compose build args). Reading the Dockerfile alone
  answers the wrong-track question.
- `LEANCTX_VERSION` is exported as an image ENV, so it reflects the *pin*; the
  installed binary (`lean-ctx --version`) is the *observation*. They can drift
  independently of the pin baseline (self-update, volume-mounted state).

## Evidence

- Identity: `/etc/hostname` = `33082e57985d` = container `ai-engkit-v2`;
  the sibling `ai-engkit-v2dev` is `38954d0ee09e`. Labels:
  `project=v2`, `service=ai-dev`,
  `config_files=.../docker-compose.v2.yml`, `environment_file=.../.env.v2`.
- Image: `ghcr.io/tryweb/ai-engkit:v2`, `Created 2026-10-10T12:59:32Z`
  (= 20:59:32 +0800); `/opt/ai-engkit/VERSION` = `v2dev`, mtime Oct 10 20:59.
- Build-time commit: `9105dd3 2026-10-10 20:57:13 +0800` — pins
  `DOCKER 29.8.2`, `COMPOSE 5.6.0`, `GLAB 1.120.0`, `PLAYWRIGHT 1.63.0`,
  `PLAYWRIGHT_MCP 0.0.83`, `BUN 1.4.2`, `GH 2.102.0`, `LEANCTX 3.10.5`,
  `OPENSPEC 1.14.1`, `CODEGRAPH 1.6.2`, `OPENCODE_CLI 2.0.24`,
  `OPENCHAMBER 2.1.1`.
- In-container observed: `opencode 2.0.24`, `openchamber 2.1.1`,
  `lean-ctx 3.10.5`, `playwright 1.63.0`, `bun 1.4.2`, `openspec 1.14.1`,
  `docker 29.8.2`, `compose v5.6.0`, `gh 2.102.0`, `codegraph 1.6.2`,
  `chromium rev 1243` — matching, **except** `glab 1.121.0` (see tradeoffs).
- Later pin movements explaining the gaps: `723f69c` (2026-10-13) CLI
  2.0.24→2.0.27, Chamber 2.1.1→2.3.0, glab→1.122.0, docker→29.8.2→29.9.0;
  `e527dce` (2026-10-15) CLI→2.0.29, Chamber→2.3.3, glab→1.123.0,
  playwright→1.64.1, bun→1.4.3, openspec→1.14.2, lean-ctx→3.11.4.
- Authoritative check: `CHECK_V2_LINE=1 .opencode/scripts/check-versions.sh outdated`
  → `DOCKER_VERSION 29.9.0 → 29.9.1`, exit 1; every other pin current.
  Hand-rolled ARG grep reported all of the above as "outdated" instead.

## Related Files

- `.opencode/scripts/check-versions.sh`
- `.opencode/skills/check-updates/SKILL.md`
- `docs/knowledge/patterns/version-management-pipeline.md`
- `docker-compose.v2.yml`, `docker-compose.v2.dev.yml`, `docker-compose.yml`
- `Dockerfile`
- `/opt/ai-engkit/VERSION` (image-baked, not a stack identifier)

## Tags

- docker
- compose
- version-inspection
- container-identity
- pin-baseline
- check-versions
- v2
