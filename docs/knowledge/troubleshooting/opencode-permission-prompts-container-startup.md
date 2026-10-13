# Repeated OpenCode Permission Prompts After Container Startup

## Context

AI-EngKit generates the global OpenCode config at startup in `entrypoint.d/02-init-config.sh`. The dev instance investigated here ran OpenCode `1.19.0`, OMO `5.1.30`, and lean-ctx `3.11.4`.

## Problem

The persisted `~/.config/opencode/opencode.json` had `bash`, `glob`, `grep`, and `read` set to `ask`. A manual edit to this file is not durable: the entrypoint regenerates the file on each container start and previously did not emit a `permission` block. In OpenCode V1, an `Always` approval is not a substitute for a persistent config rule across server/container restarts.

## Solution

Define the permission policy in `build_opencode_permission_policy()` and include it in the entrypoint-generated `opencode.json`:

- `read`, `glob`, and `grep` are `allow` to avoid repeated confirmation for ordinary source inspection.
- `bash` defaults to `ask`; only `git status*`, `git diff --stat*`, and `git log*` are allowed.
- Do not replace the bash wildcard rule with a blanket `bash: allow`.

When repairing an already-running dev container, ensure the patched startup generator is in place and restart that container so normal startup regenerates the volume-backed config. A live edit to `opencode.json` alone will be overwritten.

## Why It Works

OpenCode reads the generated permission policy as configuration rather than relying on session-scoped `Always` approvals. Keeping `bash` defaulted to `ask` preserves confirmation for commands outside the narrow inspection allowlist.

## Side Effects / Tradeoffs

- `read`, `glob`, and `grep` are allowed globally, including for files mounted into the container. Use narrower path rules instead if agents must not inspect all files visible to `devuser`.
- The dev repair used the running container's writable layer for its startup script. It survives a restart of that same container, but a container recreation or upgrade from an unchanged GHCR image loses the patch. Build/deploy an image containing the repository change for recreation-safe rollout.
- lean-ctx MCP may remain enabled while native shell interception is absent. MCP registration does not by itself route native `bash` calls through `ctx_shell`; `permission_inheritance = "on"` can also mirror host permission rules onto lean-ctx tools.

## Evidence

- Before fix, the dev config reported `{"bash":"ask","glob":"ask","grep":"ask","read":"ask"}`.
- After restart, authenticated `GET /config` returned `read/glob/grep = allow`, bash wildcard `ask`, the three explicit Git allows, and `mcp."lean-ctx".enabled = true`.
- `bash -n entrypoint.d/02-init-config.sh`, `bash -n entrypoint.d/02-init-config.test.sh`, and `bash entrypoint.d/02-init-config.test.sh` passed; the test output included `AGENTS sync tests passed` and `Bootstrapped skill upgrade tests passed`.
- `git diff --check` passed. The source changes were not committed or baked into the GHCR image during this dev repair.

## Related Files

- `entrypoint.d/02-init-config.sh`
- `entrypoint.d/02-init-config.test.sh`
- `docs/knowledge/patterns/omo-agent-permission-defaults.md` (OMO agent tool permissions are separate from OpenCode's top-level permission policy)

## Tags

opencode, permissions, always-approval, entrypoint, container-startup, lean-ctx, troubleshooting

## Current Shell Policy

The earlier solution above describes the initial least-privilege rollout and its historical evidence. The current `build_opencode_permission_policy()` generates `bash: "allow"` so native OpenCode shell commands do not repeatedly prompt, including after a server restart. This is independent of lean-ctx's `shell_allowlist_extra`: registering its MCP does not route native bash calls through lean-ctx. Allowing all bash commands removes OpenCode's confirmation gate for arbitrary local and remote shell commands; use this only in a trusted environment. Project or agent-specific permission rules can still override this global policy. Recreate/restart the container to regenerate `opencode.json` and restart OpenCode before checking the effective policy.
