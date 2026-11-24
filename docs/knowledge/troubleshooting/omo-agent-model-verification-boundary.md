# OMO Agent Model Verification Boundary

> Historical V1-only investigation; the V2 runtime does not load this plugin.
> Keep for migration archaeology, not as current V2 operational guidance.

## Context

ai-engkit runs OpenCode with oh-my-openagent 4.19.4 and persists agent selections in `~/.omo/omo.jsonc`.

## Problem

A direct OpenCode child-session probe can report an OMO fallback model even when the OMO config contains an explicit `agents.<name>.model` or `fallback_models` value.

## Solution

Keep these checks separate:

1. Persisted policy: inspect `~/.omo/omo.jsonc`.
2. Advertised assignment: inspect authenticated `GET /agent`.
3. OMO execution: submit a first-class OpenCode `subtask` part (`agent`, `description`, `prompt`) so the plugin's `delegate-task` path creates the child, then inspect completed child message metadata.
4. Native execution: create a child session through OpenCode with the native agent and inspect completed message metadata.

Do not use `POST /session` with `agent:<omo-agent>` as proof of OMO delegation; that path creates an OpenCode session directly and bypasses the OMO resolver.

## Why It Works

OMO 4.19.4 passes `pluginConfig.agents` through `collectPendingBuiltinAgents` and `resolveSubagentModel`, while direct OpenCode session creation uses OpenCode's own agent model path. The two paths can therefore resolve different models.

## Side Effects / Tradeoffs

- `/agent` mismatch remains meaningful runtime evidence, but it does not identify whether an actual OMO tool delegation would resolve differently.
- Startup reconciliation validates OMO targets against the live connected catalog and performs completed child-request verification only for native `general`.
- A deterministic OMO execution probe requires the first-class `subtask` part or another supported tool-execution API; merely embedding the tool name in text is not deterministic.

## Evidence

- The remote process loaded `oh-my-openagent@4.19.4`.
- Persisted OMO models were `opencode/big-pickle`.
- Direct probes returned `plan=opencode-go/kimi-k3`, `librarian=opencode-go/qwen3.7-plus`, and `general=opencode/big-pickle`.
- First-class OMO subtask probes created completed children and returned `plan=opencode-go/kimi-k3` (29,261 total tokens) and `librarian=opencode-go/qwen3.7-plus` (30,223 total tokens), while persisted config remained `opencode/big-pickle` for both.
- OMO 4.19.4 `dist/index.js` contains `collectPendingBuiltinAgents`, `resolveModelPipeline`, and `resolveSubagentModel` user-override paths.
- `test/test-agent-model-reconcile.sh` passes; native child execution tests pass for `general`.
- Probe cleanup left zero sessions titled `real-omo-delegate-probe-*`.

## Related Files

- `scripts/reconcile-agent-models.sh`
- `test/test-agent-model-e2e.sh`
- `src/admin/lib/agent-model-live.ts`
- `entrypoint.d/lib-native-agent-overrides.bash`
- `docs/knowledge/patterns/omo-fallback-model-config.md`

## Tags

- oh-my-openagent
- agent-model
- delegation
- verification
- opencode
