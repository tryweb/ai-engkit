# OMO Fallback Model Config (v4.19.4 and v5 migration note)

## Context

ai-engkit uses oh-my-openagent (OMO) 4.19.4. The plugin assigns default models to its 11+ registered agents via built-in fallback chains. To steer `plan` and `prometheus` toward the desired models and provide fallbacks on provider saturation, the config file needs a `fallback_models` key per agent.

## Problem

- The previous 4.19.3-era model-default migration (`apply_omo_model_defaults`) was verified inert — see `troubleshooting/omo-model-default-migration-inert.md`.
- The plugin source accepts and consumes `agents.<name>.model` and `fallback_models`, but live `/agent` and direct child-session probes can still show the compiled OMO fallback chain instead of the persisted model.

## Solution

For OMO 4.19.4, set `fallback_models` under `agents.plan` and `agents.prometheus` in both `.opencode/omo.jsonc.default` and `~/.omo/omo.jsonc`:

```jsonc
"plan": {
  "fallback_models": [
    { "model": "opencode-go/kimi-k3", "variant": "max" },
    { "model": "openai/gpt-5.6-sol", "variant": "high" },
    { "model": "openai/gpt-5.6-luna" }
  ]
}
```

Keep the live `$schema` pin at v4.19.4 and treat persisted config, `/agent`, and executed delegation as separate observations.

## Why It Works

- `getRawFallbackModelsForSession` reads `pluginConfig.agents.<name>.fallback_models` directly — the key is genuinely consumed by fallback handling.
- `collectPendingBuiltinAgents` passes `pluginConfig.agents` into `applyModelResolution`, whose `userModel` path accepts `agents.<name>.model`.
- Runtime schema `AgentOverrideConfigSchema` (dist/index.js ~26808) defines both `fallback_models` and `permission` fields for each known agent.
- Migration validation accepts `fallback_models` (neither `plan` nor `prometheus.fallback_models` appear in the startup validation error), while `permission` is flagged — see Side Effects.
- Runtime probing on 192.168.11.195 with OMO 4.19.4 persisted `opencode/big-pickle` for all tested OMO agents, but live results remained `plan=opencode-go/kimi-k3` and `librarian=opencode-go/qwen3.7-plus`; do not call this configuration effective without matching runtime evidence.
- First-class `subtask` delegation reproduced the same mismatch: completed `plan` and `librarian` children used those fallback models, with non-zero token usage.

For the v5 migration, treat `models[]` as the canonical fallback-chain direction and preserve it during Admin Apply. The current Admin command writes only `model` + `variant` and deletes both `models` and `fallback_models`; therefore an Admin Apply can silently erase a manually configured chain. This is an application-code follow-up, not a documentation-only migration step.

## Side Effects / Tradeoffs

- **Admin "SubAgent 預設模型" wipes fallback chains on apply**: `src/admin/lib/agent-model-config.ts` `buildJqWriteCommand` writes `.agents[$agent].model` + `.variant` and **deletes** `models`/`fallback_models` every time the Admin UI applies a model. So a manually configured `fallback_models` chain under `agents.plan`/`prometheus` survives until the next Admin apply, then is removed. The Admin UI has no fallback-chain editor — it only sets the primary.
- **v5 migration risk**: v5's canonical chain key is `models` (array of `{model, variant?}`). Adopting v5 chains requires changing `buildJqWriteCommand` to preserve or write `models` instead of deleting it (see `omo-v5-upgrade-impact.md`).
- **Startup migration validation error (pre-existing noise)**: the migration schema `OmoAgentDefInputSchema` has no `permission` field, so 11 agents' `permission` blocks produce `Unrecognized key: "permission"` in `[config-migration] startup completed`. This predates the fallback_models change (admin's original permission-only config triggered it), does not block runtime config loading, and is harmless — but appears at every startup.
- Restart required for config changes to take effect.
- A direct `POST /session` with `agent:<name>` bypasses OMO's `delegate-task`/`call_omo_agent` resolver and is not valid evidence for OMO delegation.
- The startup reconciler validates OMO targets against the connected catalog but only performs child-request verification for native `general`.
- All fallback models must exist on connected providers or fallback resolution returns empty (log: `connected providers unknown, returning empty set for fallback resolution`).

## Evidence

- Plugin log `/tmp/oh-my-opencode.log` (2026-08-08 restart):
  - `config-handler agents loaded` + `config handler applied {agentCount:13}` — config loads.
  - `[config-migration] startup completed {"error":"Migration validation failed ... Unrecognized key: \"permission\" ..."}` — 11 agents flagged for `permission` only; `plan` and `fallback_models` not flagged.
- Provider cache `/home/devuser/.cache/oh-my-opencode/provider-models.json` (17:19 refresh): `opencode-go` has `kimi-k3`; `openai` has `gpt-5.6-sol`, `gpt-5.6-luna`. `connected-providers.json`: opencode-go, openai, opencode, nvidia connected.
- Schema validation: SCHEMA-OK against `oh-my-opencode.schema.json` v4.19.4 for both config files.
- Code references: `getRawFallbackModelsForSession`, `collectPendingBuiltinAgents`, `resolveSubagentModel`, and `AgentOverrideConfigSchema` in OMO 4.19.4 `dist/index.js`.

## Related Files

- `.opencode/omo.jsonc.default`
- `~/.omo/omo.jsonc`
- `src/admin/lib/agent-model-config.ts` (`buildJqWriteCommand` — deletes `models`/`fallback_models` on apply)
- `src/admin/lib/agent-models.ts`
- `docs/knowledge/troubleshooting/omo-model-default-migration-inert.md`
- `docs/knowledge/patterns/omo-agent-permission-defaults.md`
- `docs/knowledge/patterns/omo-v5-upgrade-impact.md`

## Tags

- oh-my-openagent
- fallback-models
- model-config
- config-driven
