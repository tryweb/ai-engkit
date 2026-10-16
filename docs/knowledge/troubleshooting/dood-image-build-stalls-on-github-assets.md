# DooD Image Builds Fail or Stall on This Host

## Context

Building the ai-engkit image from inside the ai-engkit container (Docker-out-of-
Docker: the repo's `docker` CLI drives the host daemon) is the normal local
verification loop, and it is what CI replaces on GitHub runners.

## Problem

On this DooD host a full `docker build` fails at the first `RUN`, and once past
that its GitHub downloads are throttled hard enough to look like a hang:

1. **BuildKit path fails immediately.** The first `RUN` container fails at init:
   ```
   runc run failed: unable to start container process: error during container init:
   error running prestart hook #0: exit status 127 ... Error loading shared library
   libnftables.so.1: No such file or directory (needed by libnetwork-setkey)
   ```
   This is the host daemon's `libnetwork-setkey` prestart hook failing — a host
   package problem, not the Dockerfile. Plain `docker run` on the same host works.

   **Confirmed root cause (2026-10-16).** The host is Alpine; its 2026-10-01
   22:17 `apk upgrade` moved `docker*` 29.5.3-r1 → 29.8.2-r0 and in the same
   transaction **purged `nftables` 1.1.6-r1** (with `gmp`, `jansson`). Docker
   29.8.2's `libnetwork-setkey` helper links `libnftables.so.1`, so every
   in-daemon-BuildKit `RUN` container fails at the prestart hook. `/var/log/apk.log`
   shows both facts in one block (`( 4/14) Upgrading docker-engine (29.5.3-r1 ->
   29.8.2-r0)` … `(12/14) Purging nftables (1.1.6-r1)`); `find / -name
   'libnftables*'` was empty. The running `dockerd` process predates the upgrade
   (started earlier: `docker.pid` mtime), so the daemon *reports* the old version
   while the helper it execs comes from the new package.

2. **GitHub release downloads are throttled to ~0.3–1 MB/s.** Measured on
   2026-10-14, the 68 MB
   `https://github.com/docker/buildx/releases/download/v0.38.0/buildx-v0.38.0.linux-amd64`
   returned HTTP 200 but delivered only 10–22 MB in 20–30 s — from this container
   itself, and from both a host-networked and a bridge-networked throwaway
   container. An uncached build therefore spends minutes on *each* GitHub asset
   (`docker buildx`, `gh`, `marksman`, the `superpowers` clone, …). It does
   complete; it just looks stalled.

A fast symptom check: `docker ps -a` shows the same intermediate container "Up N
minutes" where N keeps growing while no new step appears.

3. **Release-asset downloads can 429 outright.** Seen 2026-10-16 at the `glab`
   step: `curl: (22) The requested URL returned error: 429` from
   `gitlab.com/gitlab-org/cli/-/releases/v1.123.0/downloads/...`. Successful
   layers stay cached, so a short retry loop resumes at the failing step; do not
   read a 429 as a Dockerfile fault.

Do not judge progress from a piped build: `docker build ... | tail -n 12`
buffers to EOF and prints nothing until the build ends, so a healthy 10-minute
build is indistinguishable from a hang. Use `--progress=plain` and redirect to a
file, then watch that file.

## Solution

- **Durable fix — restore the purged host package (fastest, keeps the build
  cache).** Run one throwaway privileged container that chroots into the host
  root and reinstalls it:
  ```bash
  cat > /tmp/fix-host-nftables.sh <<'EOF'
  #!/bin/sh
  set -e
  ls -l /host/usr/lib/libnftables* 2>/dev/null || echo 'libnftables: MISSING'
  chroot /host /sbin/apk add --no-cache nftables
  ls -l /host/usr/lib/libnftables* 2>/dev/null || echo 'libnftables: STILL MISSING'
  EOF
  docker run --rm --privileged -i -v /:/host alpine:3.24 sh -s < /tmp/fix-host-nftables.sh
  ```
  `apk add` also re-adds `nftables` to `/etc/apk/world`, so later upgrades keep
  it. **No `dockerd` restart is needed** — the hook resolves the library at exec
  time (restarting the host daemon would kill every running container, including
  this session's). Verify with a BuildKit smoke build:
  ```bash
  printf 'FROM alpine:3.20\nRUN echo BUILD_OK\n' | docker buildx build -t t-probe -
  ```
  Note: a script must be piped into `sh -s`, not bind-mounted — under DooD
  `-v /tmp/x.sh:/x.sh` resolves on the *host*, where that path does not exist.
- **Build with `--network=host` (no host change).** This clears the prestart-hook
  failure outright and gives the `RUN` steps working egress:
  ```bash
  docker build --network=host --progress=plain \
    --build-arg OPENCODE_CLI_VERSION=2.0.27 --build-arg AI_ENGKIT_VERSION=v2dev \
    -t ai-engkit-ai-v2dev -f Dockerfile .
  ```
  Verified end-to-end on 2026-10-14: the V1 dev image (`ai-engkit-ai-dev`) built
  from scratch in roughly 10 minutes, nearly all of it waiting on throttled
  GitHub assets. It is slow, not broken.
- **`docker compose build` cannot pass the flag.** Compose v5.6.0 builds through
  bake and rejects `build.network: host` with `additional privileges requested:
  pass "--allow=network.host" to grant requested privileges`, while
  `docker compose build` has no `--allow` flag. Build with plain `docker build`
  using the compose file's args and image tag, then bring the stack up with
  `docker compose up -d --no-build`.
- `DOCKER_BUILDKIT=0` also clears the hook, but the classic builder is slower and
  stalls harder on the same assets; prefer the flag above.
- For a *fast* full build, run it in CI (the `build`/`build-v2` jobs on GitHub
  runners) or on a host daemon with better GitHub CDN throughput.
- To verify **only a changed layer locally**, build from the previous image and
  run just the new instructions, e.g.
  `FROM ai-engkit-ai-v2` + the new `COPY`/`RUN`. This reuses cached layers, needs
  no full rebuild, and is how the v2 plugin bake was verified.
- Before using a local base tag for a V2 patch build, verify that it is the image
  actually running the V2 `ai-dev` container. A stale `ai-engkit-ai-v2` tag can
  point at a V1 image; derive the base image ID with
  `docker inspect ai-engkit-v2 --format '{{.Image}}'`, tag that ID locally, and
  confirm `docker exec ai-engkit-v2 opencode --version` reports V2 before
  building a COPY-only layer.

## Why It Works

`--network=host` gives the build's `RUN` containers the host network namespace,
so the `libnetwork-setkey` hook that fails while setting up a fresh bridge netns
is never exercised, and the steps inherit the host's egress. What remains is
throughput, not connectivity: GitHub release assets are throttled on this path,
so an uncached build is slow but finishes. A layer-scoped build avoids the
downloads entirely and stays the fastest way to validate one changed layer.

## Side Effects / Tradeoffs

- Layer-scoped builds prove the changed instructions, not the full Dockerfile
  ordering; confirm the ordering separately (e.g. `USER root` vs `USER devuser`
  context — see `v2-plugin-bake.md`).
- ~~The host condition may be transient (a partially upgraded daemon/nftables)~~
  Corrected 2026-10-16: it is **not** transient — it persists until the purge of
  the Alpine `nftables` package is undone (`chroot /host /sbin/apk add nftables`).
  Re-check `docker run --rm ubuntu:24.04 echo ok` and a BuildKit smoke; those
  still pass while `RUN` steps in builds fail, which is the signature of this
  host condition.
- Local image tags can drift from running container image IDs. Treat the
  running V2 container and its OpenCode version as runtime truth, not the tag
  name.
- Budget for the throttled downloads: a fully uncached build spends most of its
  wall-clock time on GitHub release assets at a few hundred KB/s. Cached rebuilds
  finish in seconds — a V2 rebuild whose only change is the entrypoint `COPY` is
  instant, while a V1 rebuild (different build args) is not.

## Evidence

- BuildKit: `libnftables.so.1` prestart hook error at the apt `RUN` (reproducible
  across repeated attempts).
- Legacy: apt layer completes in seconds; `docker buildx` step container stayed
  "Up" 7+ minutes; killed at a 30-minute timeout without reaching the app layers.
- 2026-10-16 (durable fix verified): host Alpine `/var/log/apk.log` block at
  `Running /sbin/apk upgrade at 2026-10-01 22:17:24` upgraded `docker-engine`/
  `docker`/`docker-cli` 29.5.3-r1 → 29.8.2-r0 and purged `nftables` 1.1.6-r1 at
  `(12/14)`. `chroot /host /sbin/apk add --no-cache nftables` restored
  `/usr/lib/libnftables.so.1 -> libnftables.so.1.1.0` and pulled `gmp`/`jansson`
  back; `docker buildx build` then passed both smoke builds (`FROM alpine` +
  `RUN echo`, and `FROM ubuntu:24.04` + `RUN apt-get update`). `docker buildx ls`
  showed only the broken in-daemon `default` builder at that moment, which is why
  `docker compose build` hit the hook instead of a container-driver builder.
- `docker run --rm ubuntu:24.04 echo hello` and `--network=host` both succeed.
- On 2026-10-12, the local `ai-engkit-ai-v2` tag pointed to an image where
  `opencode --version` was `1.18.32`, while the running `ai-engkit-v2` container
  used image `sha256:fb3e40bc1dc30cab9f4f31267a037ea5ad56ea5f28560404f12fb590fc70dc9f`
  and reported `opencode v2.0.24`. A V2 dev patch image built from the running
  image ID reported V2 and served the updated Providers UI.
- From the ai-engkit container itself, `curl -sI https://github.com/...` returns
  302 and npm returns 200 quickly, but downloading a GitHub release asset's
  *body* is throttled (~0.3–1 MB/s). The slowness is the asset CDN's throughput
  on this path, not a build-container-only fault.
- 2026-10-14: `docker build --network=host` completed both dev images.
  - V1 dev `ai-engkit-ai-dev`: full build from scratch, `V1-STATUS=0`, image
    `8ba8403e40e2`, ~10 min wall clock; step 6/46 (the buildx asset) alone took
    several minutes.
  - V2 dev `ai-engkit-ai-v2dev`: every layer cached, `V2-STATUS=0`, image
    `84f4684ae73a` unchanged, finished in seconds.
  - Throttle measurement for the 68 MB buildx asset: 22.4 MB / 19.7 s (from this
    container), 9.9 MB / 30 s (host-networked container), 14.2 MB / 30 s
    (bridge-networked container); HTTP 200 in all three.
- `docker compose -f docker-compose.dev.yml -f <override with build.network:host>
  build ai-dev` fails with bake's `additional privileges requested: pass
  "--allow=network.host"`; `docker compose build --allow=network.host` is an
  unknown flag.
- Revalidation (2026-10-15, V2 dev image): a full local rebuild could not
  complete. The default `docker` driver builder had no reusable cache (only
  `FROM` was `CACHED`; every `RUN` re-executed) and died at step 19/46 — the
  Playwright Chromium download (`bunx playwright@1.64.1 install --with-deps
  chromium`) — with `Failed to download Chrome for Testing 156.0.8078.4 …
  Download failure, code=1`; `curl -sI https://cdn.playwright.dev/` returned
  HTTP 400 from this container. Retrying with
  `docker buildx build --builder v2-b --network=host --allow network.host
  --load` also rebuilt from step 1/46 (the old builder cache did not match the
  current Dockerfile) and then hit `No space left on device` at step 8
  (Homebrew), taking the host root to 100% (73G total, 179M free).
  `docker builder prune -f` + `docker buildx prune --builder v2-b -f`
  reclaimed ~14G. A one-file change (`Dockerfile:295` `AGENTS.md.default`) was
  therefore verified with the layer-scoped build instead:
  `FROM ai-engkit-ai-v2dev:latest` + the single `COPY`, run as `USER root`
  then restored to `USER devuser` — completed in under 1s with no network, and
  produced the same corrected file the full build would have.

## Related Files

- `Dockerfile`
- `docs/knowledge/troubleshooting/dood-relative-workspace-path.md`
- `.github/workflows/ci.yml` (`build`, `build-v2` jobs)

## Tags

- dood
- docker-build
- buildkit
- github-cdn
- environment
- ci
