# OMO Unified Agent Permission Defaults

> Historical V1-only implementation record; V2 agent permissions are defined
> in `.opencode/agents/*.md` and OpenCode configuration.

## Context

ai-engkit uses oh-my-openagent (OMO) which registers 11 agents (explore, oracle, librarian, sisyphus, etc.). Each agent needs explicit permission configuration to access lean-ctx tools (`ctx_shell`, `ctx_search`, `ctx_read`). Previously, agent permissions were embedded inline in the Dockerfile and entrypoint script's jq templates, making maintenance difficult — any permission change required a full image rebuild.

The container entrypoint (`entrypoint.d/02-init-config.sh`) ships the same permission defaults into OMO's unified user configuration at runtime.

## Problem

- Agent permissions embedded in Dockerfile jq template: ~68 lines of inline JSON, hard to edit
- Agent permissions embedded in entrypoint jq template: ~120 lines inline, same maintenance pain
- The `explore` agent lacked explicit permission configuration, causing `ctx_*` tool failures
- Any permission change required: edit Dockerfile → rebuild image → restart container
- No test coverage for agent permission correctness

## Solution

Extract agent permissions into OMO's unified configuration:

1. **Create** `.opencode/omo.jsonc.default` — the single source of truth for all 11 agent permissions, using OMO's `agents` (plural) JSON format with a version-pinned `$schema`
2. **Build-time** (`Dockerfile`): `COPY .opencode/omo.jsonc.default /etc/opencode/` — ships the default into the image
3. **Runtime** (`entrypoint.d/02-init-config.sh`): archive recognized legacy `oh-my-openagent` / `oh-my-opencode` filenames inside `~/.config/opencode`, then create or merge `~/.omo/omo.jsonc`
4. **Test** (`test/run-tests.sh`): section 8.3 verifies all 11 agents, their tool permissions, and that `opencode.json` has no inline agent section

Legacy settings are preserved under an `.ai-engkit-legacy-backup` suffix but are not imported. This deliberately prevents OMO's cross-volume legacy migration from running after `~/.omo` moves to its own named volume.

### Permission Groups

| Group | Agents | bash | read | edit | write |
|-------|--------|------|------|------|-------|
| Read-only subagents | explore, oracle, librarian, multimodal-looker | deny/allow | allow | deny | deny |
| Analysis/planning | metis, momus, prometheus | deny | allow | deny | deny |
| Execution/coordination | sisyphus, hephaestus, atlas, sisyphus-junior | allow | allow | allow | allow |

Note: `explore` gets `bash=allow` to support `ctx_shell` for lean-ctx codebase searches. Hardcoded tool restrictions (`write`, `edit`, `task`) are enforced by OMO plugin at runtime and cannot be overridden.

## Why It Works

- Follows the existing `AGENTS.md.default` pattern — no new infrastructure
- The default file is a plain JSON file, editable without touching Docker or shell scripts
- Runtime merge via `jq -s '.[0] * .[1]'` preserves user customizations while applying defaults
- The `opencode.json` generation stays clean (no agent section) — separation of concerns
- Tests catch regressions: 53 assertions cover all agents, permission values, and file existence

## Side Effects / Tradeoffs

- The standalone file uses OMO's version-pinned `omo.schema.json` and the `"agents"` (plural) key, which is the OMO plugin's config format — different from OpenCode's native `"agent"` (singular) key
- The file is project-scoped (`.opencode/`), not user-scoped — means it ships with the repo and applies to all containers built from this repo
- Merge uses shallow merge (`jq -s '.[0] * .[1]'`) — nested objects are replaced, not deep-merged
- Agent names with hyphens (`multimodal-looker`, `sisyphus-junior`) require jq bracket notation for queries: `.agents["multimodal-looker"]` not `."multimodal-looker"` (dot notation interprets `-` as subtraction)

## Evidence

- Build: `docker compose -p dev -f docker-compose.dev.yml build` — COPY step completed
- Runtime: `Creating omo.jsonc with default agent permissions` logged in entrypoint
- Test: 142/143 tests pass (1 pre-existing Web UI HTML check failure unrelated)
- OMO tests: all 53 assertions pass across 8 sub-sections
- Validated: `bash -n entrypoint.d/02-init-config.sh` — shell syntax clean
- Validated: `jq . omo.jsonc.default` — JSON valid
- Validated: `opencode.json` has no `agent` key (`jq 'has("agent")'` → `false`)

## Related Files

- `.opencode/omo.jsonc.default` — unified agent permission default file
- `Dockerfile` — COPY to `/etc/opencode/` (after AGENTS.md.default line)
- `entrypoint.d/02-init-config.sh` — runtime merge logic (after OPENCODE_PROVIDER section)
- `test/run-tests.sh` — test section 8.3 (OMO Agent Permissions)
- `test/test-full.sh` — full integration test entry point

## Tags

omo, omo-jsonc, oh-my-openagent, agent-permissions, lean-ctx, entrypoint, docker, configuration-defaults, test-coverage
