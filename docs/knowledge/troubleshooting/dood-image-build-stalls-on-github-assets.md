# DooD Image Builds Fail or Stall on This Host

## Context

Building the ai-engkit image from inside the ai-engkit container (Docker-out-of-
Docker: the repo's `docker` CLI drives the host daemon) is the normal local
verification loop, and it is what CI replaces on GitHub runners.

## Problem

On this DooD host, a full `docker build` cannot complete reliably:

1. **BuildKit path fails immediately.** The first `RUN` container fails at init:
   ```
   runc run failed: unable to start container process: error during container init:
   error running prestart hook #0: exit status 127 ... Error loading shared library
   libnftables.so.1: No such file or directory (needed by libnetwork-setkey)
   ```
   This is the host daemon's `libnetwork-setkey` prestart hook failing — a host
   package problem, not the Dockerfile. Plain `docker run` on the same host works.

2. **Legacy builder (`DOCKER_BUILDKIT=0`) gets past the hook but stalls.** The
   build advances through the apt layer quickly (Ubuntu mirrors ~7 MB/s) but then
   hangs for many minutes on GitHub release downloads (`docker buildx`, and by
   extension `gh`, `marksman`, the `superpowers` clone). `--network=host` does not
   help. The build did not reach the app layers within a 30-minute budget.

A fast symptom check: `docker ps -a` shows the same intermediate container "Up N
minutes" where N keeps growing while no new step appears.

## Solution

- Use `DOCKER_BUILDKIT=0` to clear the prestart-hook failure. It is a
  workaround, not a fix (the host still cannot pull GitHub assets in build
  containers).
- For a full build, run it in CI (the `build`/`build-v2` jobs on GitHub runners)
  or on a host daemon with working GitHub CDN egress.
- To verify **only a changed layer locally**, build from the previous image and
  run just the new instructions, e.g.
  `FROM ai-engkit-ai-v2` + the new `COPY`/`RUN`. This reuses cached layers, needs
  no full rebuild, and is how the v2 plugin bake was verified.

## Why It Works

The prestart hook is host-scoped, so the builder choice changes whether the hook
runs; the GitHub stall is network-path-specific to build containers, so a
layer-scoped build (no GitHub downloads) sidesteps it.

## Side Effects / Tradeoffs

- Layer-scoped builds prove the changed instructions, not the full Dockerfile
  ordering; confirm the ordering separately (e.g. `USER root` vs `USER devuser`
  context — see `v2-plugin-bake.md`).
- The host condition may be transient (a partially upgraded daemon/nftables);
  re-check `docker run --rm ubuntu:24.04 echo ok` and a BuildKit smoke before
  assuming it is permanent.

## Evidence

- BuildKit: `libnftables.so.1` prestart hook error at the apt `RUN` (reproducible
  across repeated attempts).
- Legacy: apt layer completes in seconds; `docker buildx` step container stayed
  "Up" 7+ minutes; killed at a 30-minute timeout without reaching the app layers.
- `docker run --rm ubuntu:24.04 echo hello` and `--network=host` both succeed.
- From the ai-engkit container itself, `curl -sI https://github.com/...` returns
  302 and npm returns 200 quickly — so the stall is specific to build containers.

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
