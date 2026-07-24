# OMO Agent Permission Defaults via Standalone File

## Context

ai-engkit uses oh-my-openagent (OMO) which registers 11 agents (explore, oracle, librarian, sisyphus, etc.). Each agent needs explicit permission configuration to access lean-ctx tools (`ctx_shell`, `ctx_search`, `ctx_read`). Previously, agent permissions were embedded inline in the Dockerfile and entrypoint script's jq templates, making maintenance difficult — any permission change required a full image rebuild.

The container entrypoint (`entrypoint.d/02-init-config.sh`) already had a proven pattern for default configuration files: `AGENTS.md.default` is shipped to `/etc/opencode/` during build and merged into the user's config directory at runtime.

## Problem

- Agent permissions embedded in Dockerfile jq template: ~68 lines of inline JSON, hard to edit
- Agent permissions embedded in entrypoint jq template: ~120 lines inline, same maintenance pain
- The `explore` agent lacked explicit permission configuration, causing `ctx_*` tool failures
- Any permission change required: edit Dockerfile → rebuild image → restart container
- No test coverage for agent permission correctness

## Solution

Extract agent permissions into a standalone file following the `AGENTS.md.default` pattern:

1. **Create** `.opencode/oh-my-openagent.json.default` — the single source of truth for all 11 agent permissions, using OMO's `agents` (plural) JSON format with `$schema` reference
2. **Build-time** (`Dockerfile`): `COPY .opencode/oh-my-openagent.json.default /etc/opencode/` — ships the default into the image
3. **Runtime** (`entrypoint.d/02-init-config.sh`): if the user's `oh-my-openagent.json` doesn't exist or lacks an `agents` key, copy/merge the default
4. **Test** (`test/run-tests.sh`): section 8.3 verifies all 11 agents, their tool permissions, and that `opencode.json` has no inline agent section

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

- The standalone file uses OMO schema `"$schema": "https://raw.githubusercontent.com/code-yeongyu/oh-my-openagent/dev/assets/oh-my-opencode.schema.json"` and the `"agents"` (plural) key, which is the OMO plugin's config format — different from OpenCode's native `"agent"` (singular) key
- The file is project-scoped (`.opencode/`), not user-scoped — means it ships with the repo and applies to all containers built from this repo
- Merge uses shallow merge (`jq -s '.[0] * .[1]'`) — nested objects are replaced, not deep-merged
- Agent names with hyphens (`multimodal-looker`, `sisyphus-junior`) require jq bracket notation for queries: `.agents["multimodal-looker"]` not `."multimodal-looker"` (dot notation interprets `-` as subtraction)

## Evidence

- Build: `docker compose -f docker-compose.dev.yml build` — COPY step completed
- Runtime: `Creating oh-my-openagent.json with default agent permissions` logged in entrypoint
- Test: 142/143 tests pass (1 pre-existing Web UI HTML check failure unrelated)
- OMO tests: all 53 assertions pass across 8 sub-sections
- Validated: `bash -n entrypoint.d/02-init-config.sh` — shell syntax clean
- Validated: `jq . oh-my-openagent.json.default` — JSON valid
- Validated: `opencode.json` has no `agent` key (`jq 'has("agent")'` → `false`)

## Related Files

- `.opencode/oh-my-openagent.json.default` — agent permission default file
- `Dockerfile` — COPY to `/etc/opencode/` (after AGENTS.md.default line)
- `entrypoint.d/02-init-config.sh` — runtime merge logic (after OPENCODE_PROVIDER section)
- `test/run-tests.sh` — test section 8.3 (OMO Agent Permissions)
- `test/test-full.sh` — full integration test entry point

## Tags

omo, oh-my-openagent, agent-permissions, lean-ctx, entrypoint, docker, configuration-defaults, test-coverage
