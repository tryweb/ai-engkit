# Native Agent Model Override Bridge

> Historical V1-to-native transition record; current V2 model routing is native
> and must not depend on the legacy plugin config.

## Context

ai-engkit regenerates `~/.config/opencode/opencode.json` from environment defaults on every `ai-dev` start. Admin Agent Models persists selections in the `omo-config` volume at `~/.omo/omo.jsonc`.

OpenCode's `general` agent is native (`GET /agent` reports `native: true`, `mode: "subagent"`). Its model belongs under `opencode.json → agent.general.model`, not only under OMO's `agents.general.model`.

## Problem

Admin successfully wrote:

```json
{"agents":{"general":{"model":"opencode/big-pickle"}}}
```

The write and restart appeared successful, but a real child session ran on `ollama/qwen3-coder:latest`. The parent session used `opencode/big-pickle`; the child session database row and completed assistant message both recorded the Ollama model.

Writing `agent.general.model` directly to `opencode.json` was also ineffective because `entrypoint.d/02-init-config.sh` replaced the file on the next container start.

## Solution

Use OMO config as the persistent source, then bridge allowlisted native-agent fields into the generated OpenCode config during startup:

1. Generate `opencode.json` normally.
2. Initialize or load `~/.omo/omo.jsonc`.
3. Run `merge_native_agent_overrides`.
4. Copy only `agents.general.model` and optional `variant` into `agent.general`.

The merge is atomic, accepts only `provider/model`, preserves unrelated OpenCode settings, ignores non-allowlisted agents, removes stale `general` overrides when the persistent model is cleared, and fails soft when OMO config is invalid.

## Why It Works

OpenCode resolves native agent models from `agent.<name>.model`. Running the bridge after both config generation and OMO initialization places the persisted Admin selection at that exact runtime boundary on every restart.

Verification must exercise execution, not only configuration acceptance. The E2E creates parent and child sessions through the managed OpenCode API, prompts `general` without an explicit request model, waits for a completed assistant message, and asserts its `providerID/modelID` is `opencode/big-pickle`.

## Side Effects / Tradeoffs

- The native-agent allowlist currently contains `general` and `plan`; adding another native agent requires an explicit code and test change. This bridge does not control OMO's other built-in agents such as `librarian`.
- A container restart is required before a persisted native override reaches `opencode.json`.
- The E2E performs a real model request. It must delete both sessions and restore the byte-identical OMO baseline even on failure.
- `GET /agent` is useful but insufficient by itself; only completed child-message metadata proves the execution model.
- The current persistent dev OMO volume has unrelated missing permission blocks, so `test/run-tests.sh` reports 29 existing permission failures. The two native override assertions pass.

## Evidence

- `docker-compose.dev.yml` image build and `ai-dev`/`ai-admin` recreate succeeded.
- Generated config: `.agent.general.model = "opencode/big-pickle"`.
- Live agent: `general`, `native: true`, model `opencode/big-pickle`.
- Native override unit test: all cases passed, including variant merge, clear, allowlist, invalid model, and corrupt JSON.
- Real child-session E2E: native `general` completed with `opencode/big-pickle`. Direct child-session probes for OMO `librarian` are not valid delegation evidence because they bypass OMO's resolver.
- E2E cleanup query returned zero `agent-model-e2e-*` sessions.
- Admin test suite: 279/279 passed.

## Related Files

- `entrypoint.d/lib-native-agent-overrides.bash`
- `entrypoint.d/02-init-config.sh`
- `src/admin/lib/agent-models.ts`
- `src/admin/routes/agent-models.ts`
- `test/test-native-agent-overrides.sh`
- `test/test-agent-model-e2e.sh`
- `test/run-tests.sh`
- `.github/workflows/ci.yml`
- `docs/knowledge/troubleshooting/omo-model-default-migration-inert.md`

## Tags

- native-agent
- general-agent
- opencode
- oh-my-openagent
- model-override
- entrypoint
- persistence
- child-session
- e2e
