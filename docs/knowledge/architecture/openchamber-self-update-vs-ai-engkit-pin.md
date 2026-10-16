# OpenChamber Self-Update Versus the AI-EngKit Image Pin

## Context

AI-EngKit runs the web runtime with `openchamber serve` inside the `ai-dev` Docker container. The image installs an exact package version from `Dockerfile:ARG OPENCHAMBER_VERSION` using `bun install -g @openchamber/web@${OPENCHAMBER_VERSION} --trust`.

OpenChamber v1.22.2 also provides a web `Update Now` action and an `openchamber update` CLI command. These are different from the AI-EngKit image upgrade workflow.

## Problem

An operator may treat OpenChamber's own update dialog as equivalent to updating the AI-EngKit image. It is not equivalent:

- The OpenChamber web updater installs `@openchamber/web@latest` inside the running container.
- AI-EngKit upgrades by building or pulling a new image and recreating the container from the Dockerfile pin.
- The default Compose files do not mount `~/.bun`, so the package-manager installation is not a named volume.

## Solution

Use the AI-EngKit pin/image workflow for supported upgrades:

1. Update `OPENCHAMBER_VERSION` in `Dockerfile`.
2. Re-check the derived `BUN_VERSION` with `.opencode/scripts/check-versions.sh`.
3. Build or pull the image and recreate the `ai-dev` container.
4. Run the OpenChamber integration and settings-preservation checks.

Do not use OpenChamber's `Update Now` or `openchamber update` as the normal AI-EngKit upgrade path. Those commands use the detected package manager to run `bun add -g @openchamber/web@latest` in this image.

## Why It Works

The v1.22.2 web endpoint `POST /api/openchamber/update-install` detects Docker and returns `autoRestart: false`, then starts the global package-manager command in a detached child process. The HTTP success response means that the update was accepted and scheduled; it does not mean that installation completed successfully.

The installed files can remain in the current container's writable layer across a process restart or `docker restart`, but they are discarded when Docker recreates the container from an image. The image-based workflow therefore remains the only reproducible and pin-controlled path.

The AI-EngKit admin only displays the result of `openchamber --version`. Its update check compares the AI-EngKit image digest, not the running OpenChamber binary against `OPENCHAMBER_VERSION`; there is currently no component-level drift warning.

`showOpenCodeUpdateNotifications` is unrelated to OpenChamber self-updates. It controls the OpenCode update notification toast only; it does not disable the OpenChamber update check or `Update Now` action.

## Side Effects / Tradeoffs

- A successful in-container self-update can create a version difference between the running container filesystem and the image/Dockerfile pin.
- A process restart can continue using files from that same container layer; a container recreate restores the image contents and may appear to revert the self-update.
- The web updater does not run AI-EngKit's `check-versions.sh`, derived Bun-version validation, image build, or integration tests.
- The upstream update API can be configured with `OPENCHAMBER_UPDATE_API_URL`, but that variable is not a documented disable switch; the updater falls back to npm metadata when the primary API does not provide a usable result.
- `packageManager: bun@1.3.14` is the upstream toolchain declaration used by AI-EngKit's pin validation. It does not by itself prove that every other Bun version is incompatible.

## AI-EngKit v1 managed-update guard

AI-EngKit v1.20.2 pins OpenChamber `1.24.2` and OpenCode `1.19.0`. The image applies `scripts/patch-openchamber-update-guard.py` to the installed OpenChamber package at build time. The patcher verifies the package version and each exact source anchor; a changed or ambiguous anchor fails the image build rather than silently omitting a guard.

- `GET /api/openchamber/update-check` remains available, so OpenChamber can still show that an update exists.
- `POST /api/openchamber/update-install` is rejected synchronously with HTTP 409 and a JSON `error` before the container-mode route can return success or spawn the detached installer.
- `openchamber update` returns a failed result and a nonzero CLI exit without invoking the package manager.
- OpenChamber's separate `POST /api/opencode/upgrade` is also rejected before forwarding to OpenCode `/global/upgrade`.
- The `showOpenCodeUpdateNotifications` preference remains independent; it controls the OpenCode update toast, not OpenChamber's package self-update.

The guard is part of the AI-EngKit image, not an in-place setting. It becomes active only after deploying an image containing the patch. It prevents accidental UI/CLI update attempts; a user with shell, `sudo`, or Docker access can still bypass it by directly changing files or invoking a package manager.

### Post-update client/server version mismatch

In a pre-guard container, the detached web updater can replace the package on
disk without restarting the already-running server process (`autoRestart: false`
in container mode). A newer frontend may then load from disk while `/api/version`
still reports the old version frozen in the running process, producing the
“Server update required” screen. Compare the installed `openchamber --version`
with `/api/version`; a mismatch is not by itself evidence of database loss.

Before restarting or recreating, inspect the OpenCode DB with the read-only
compatibility gate, including WAL/SHM sidecars. Do not start a v2 binary against
unclassified v1 data or attempt an automatic DB rollback. Recreating from the
pinned v1 image restores the image's package files but resets the unmounted
`~/.bun` writable layer, so manually installed user packages may be lost; named
data/config volumes remain separate.

## Guard verification

- The deterministic fixture harness covers HTTP 409 before the original detached handler, the `executeUpdate` failure result without `spawnSync`, the managed OpenCode upgrade refusal, the still-available update check, idempotent patching, and fail-closed version/source-anchor mismatches.
- `test/test-openchamber-update-guard.sh`: **21 passed, 0 failed**.
- An isolated Bun 1.4.2 global prefix installed OpenChamber `1.24.2` and OpenCode `1.19.0`; applying the patcher to that exact installed package succeeded and a second run was idempotent. The disposable image build and authenticated browser test passed; the real install POST returned HTTP 409, the installer process count remained zero, and the managed core stayed manifest-clean.

## Evidence

- OpenChamber v1.22.2 source: `packages/web/server/lib/opencode/openchamber-routes.js` implements `POST /api/openchamber/update-install`, Docker detection, `autoRestart: false`, and detached installation.
- OpenChamber v1.22.2 source: `packages/web/server/lib/package-manager.js` implements `getUpdateCommand()` as `bun add -g @openchamber/web@latest` for Bun and falls back from the update API to npm metadata.
- OpenChamber v1.24.2 pinned source commit `614d7f76e581a132a86575c03d3fa9aad5e624b6`: `packages/web/server/lib/opencode/openchamber-routes.js` registers the update-install route at line 135 and sends the container-mode HTTP 200 before scheduling the detached install at lines 192-215; `packages/web/server/lib/package-manager.js` implements `executeUpdate` at lines 804-821; `packages/web/server/lib/opencode/routes.js` handles the managed OpenCode upgrade at line 236.
- AI-EngKit `Dockerfile:9,155-156,345` pins and installs OpenChamber during image build, then starts `openchamber serve`.
- AI-EngKit `docker-compose.yml:7-22` and `docker-compose.dev.yml:15-30` mount OpenChamber settings at `/home/devuser/.config/openchamber`, but do not mount `~/.bun` or `~/.bun/install/global`.
- AI-EngKit `src/admin/routes/versions.ts`, `src/admin/agent/heartbeat.ts`, and `src/admin/server.ts` read `openchamber --version` for display; the update check is image-digest based.
- AI-EngKit `src/admin/lib/upgrade.ts` and `upgrade.sh` pull images, recreate containers, snapshot settings, and reconcile project registrations.
- The pin was updated from 1.22.1 to 1.22.2 in commit `eb29735`; the rebuilt image reported OpenChamber 1.22.2 and `./test/run-tests.sh` passed 133 tests with 0 failures.

## Related Files

- `Dockerfile`
- `docker-compose.yml`
- `docker-compose.dev.yml`
- `src/admin/routes/versions.ts`
- `src/admin/lib/upgrade.ts`
- `upgrade.sh`
- `docs/knowledge/tooling/openchamber-upgrade-integration-verification.md`
- `docs/knowledge/troubleshooting/openchamber-update-notification-not-suppressed.md`

## Tags

`openchamber` `self-update` `docker` `version-pin` `image-upgrade` `bun` `drift`
