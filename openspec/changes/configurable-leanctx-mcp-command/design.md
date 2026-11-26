# Design

## Context

`entrypoint.d/02-init-config.sh` owns the generated `opencode.json`; it rebuilds the MCP map on every `ai-dev` start. `docker-compose.yml` passes host `.env` entries through the `ai-dev` service's `env_file`, while `ai-admin` has a separate process environment and an existing `.env` file mount for its own administration code. See proposal.md for motivation and `specs/opencode-mcp-integration/spec.md` for the required behavior.

## Goals / Non-Goals

**Goals:**

- Expose one stable AI-EngKit-owned environment contract for a consumer-supplied LeanCTX wrapper executable.
- Preserve the existing LeanCTX initialization behavior when the setting is unset.
- Validate the opt-in path before config generation so a typo cannot silently disable the protection or produce a malformed config.
- Preserve image ownership of generated `opencode.json` and all unrelated MCP/LSP/plugin/provider entries.

**Non-Goals:**

- Shipping or installing an application-specific wrapper; downstream releases own the wrapper bytes and persistent config-volume installation.
- Editing `opencode.json` directly from Admin routes or downstream install/upgrade scripts.
- Supporting arbitrary shell command strings, arguments, or multiple LeanCTX executables; the contract is one absolute executable path.
- Restarting OpenCode from the entrypoint; the normal container lifecycle loads the generated configuration.

## Decisions

### Use a dedicated path-valued environment variable

Add `LEANCTX_MCP_WRAPPER` to `ai-dev`'s Compose environment and `.env.example`. Empty/unset selects the existing `lean-ctx` binary. A non-empty value is serialized as a one-element JSON command array via `jq --arg` (never shell-evaluated), preserving spaces and shell metacharacters as path bytes rather than executable syntax.

**Alternative rejected:** accept a free-form JSON command array. The wrapper requires no arguments, so a one-path interface is sufficient and avoids turning deployment configuration into a command-injection surface.

### Validate in a dedicated hard preflight before config generation

Add `entrypoint.d/00-leanctx-mcp-wrapper.sh` and include it in `entrypoint.sh`'s existing signal-responsive `block_startup` preflight cases. If unset, it is a no-op. If set, it requires an absolute path, a regular non-symlink file, and execute permission. This runs before `02-init-config.sh` writes `opencode.json`.

**Alternative rejected:** validate only inside the config generator and exit nonzero. The container's restart policy could turn a malformed opt-in value into an opaque rapid restart loop; the explicit startup block leaves a running, inspectable container and clear operator remediation path.

### Compose passes the value only to ai-dev

Add an explicit `LEANCTX_MCP_WRAPPER: ${LEANCTX_MCP_WRAPPER:-}` entry to `ai-dev.environment`; do not add it to `ai-admin.environment` or change its existing `.env` file mount. Keep an example in `.env.example` commented out and describe the required container-visible path, ownership, executable bit, and restart behavior in README.

### Entrypoint preserves the generated-config lifecycle

`02-init-config.sh` computes a validated `LEANCTX_MCP_COMMAND_JSON` (`["lean-ctx"]` by default, `["<absolute wrapper path>"]` when configured) and injects it only into `.mcp["lean-ctx"].command`. On first boot, the later `lean-ctx init --agent opencode` command can normalize/rewrite that MCP command. Therefore, after all startup configuration writers have run, the entrypoint atomically reapplies `.mcp["lean-ctx"].command` only when `LEANCTX_MCP_WRAPPER` is non-empty. This ensures the explicit override wins without changing the unset path's pre-existing `lean-ctx init` behavior. The final update changes no other OpenCode config keys; validation still occurs in the hard preflight before initial config generation.

## Risks / Trade-offs

- [The configured path may not exist inside the named volume at startup] → Fail in the dedicated preflight before writing `opencode.json`; document install-wrapper-first, then set `.env`, then recreate `ai-dev`.
- [The value is only applied when `ai-dev` is recreated] → Document restart as part of the operator integration sequence; changing `.env` alone does not alter the running MCP child.
- [A wrapper executable may be incompatible or fail after passing file checks] → AI-EngKit validates path shape and permissions; the consuming integration's canary must speak MCP through the wrapper before accepting the deployment.
- [An invalid explicit override blocks `ai-dev` startup] → Entrypoint uses the existing signal-responsive preflight block with a clear diagnostic, not a Docker restart loop or silent fallback.

## Migration Plan

1. Upgrade AI-EngKit with the optional variable unset; the generated command remains `lean-ctx`.
2. Install the consumer-owned wrapper into the existing `opencode-config` named volume with owner `devuser` and executable mode.
3. Set `LEANCTX_MCP_WRAPPER` in the AI-EngKit host `.env` to the absolute path inside `ai-dev`, then recreate `ai-dev` using the normal Compose/upgrade lifecycle.
4. Verify generated `opencode.json`, `opencode mcp list`, and repeated MCP calls; on rollback unset the variable and recreate `ai-dev` (no migration or named-volume mutation is required).

## Open Questions

None. The interface is intentionally limited to one executable path; argument arrays and broader MCP overrides require a separate capability and threat-model review.
