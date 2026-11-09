# V2 Admin Model Overridden by Agent Definition

## Context

V2 Admin stores per-subagent model chains in `~/.config/opencode/routing.json` and verifies the selected model from successful assistant request metadata. Shipped agent definitions are copied from `.opencode/agents/*.md` into the runtime OpenCode config directory at container startup.

## Problem

Prometheus was configured in Admin as `openai/gpt-6-luna`, but its agent definition also pinned `model: opencode-go/kimi-k3`. The runtime `/api/agent` result and actual Prometheus responses used Kimi, so Admin reported `runtime_mismatch`. Other tested subagents had no per-agent model pin and followed the configured model.

## Solution

- Remove the `model` pin from `.opencode/agents/prometheus.md` and document that this agent must leave model selection to OpenCode/Admin routing.
- Synchronize the same change to the host agent definition and the running `ai-engkit-v2` container's persistent OpenCode config.
- When distributing the fix, rebuild from the changed project source; `entrypoint.d/02-init-config.sh` copies baked definitions into the persistent config on container startup.

## Why It Works

The explicit model in the agent definition selected Kimi independently of the Admin routing entry. Removing that pin lets Prometheus resolve and answer with the Admin-configured model. Compare both the agent-level `/api/agent` result and the model metadata on a real successful request; configured state alone is not proof of effective routing.

## Side Effects / Tradeoffs

- Prometheus now inherits the active OpenCode/Admin model configuration instead of having a baked default model.
- Native agent definitions do not encode a fallback chain; V2 fallback policy remains in the Admin-managed routing configuration.
- A container rebuilt from an image that predates the source change can copy the old pin back into its persistent config at startup.

## Evidence

- Before the fix, authenticated `GET /api/agent-models` reported Prometheus configured as `openai/gpt-6-luna`, resolved as `opencode-go/kimi-k3`, and `runtime_mismatch`.
- A pre-fix Prometheus self-test's message metadata recorded `opencode-go/kimi-k3`.
- After removing the pin, a real Prometheus self-test recorded `openai/gpt-6-luna`; the Admin API then reported configured, resolved, and request-verified models all as `openai/gpt-6-luna`, with `effective` status.
- Project fix committed as `ac5333d` (`fix(agent): let admin routing select Prometheus model`); `git diff --check` passed.

## Related Files

- `.opencode/agents/prometheus.md`
- `entrypoint.d/02-init-config.sh`
- `docs/knowledge/troubleshooting/v2-agent-model-verification-scope.md`

## Tags

- opencode-v2
- admin-agent-models
- subagent
- runtime-mismatch
- model-routing
