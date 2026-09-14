# OMO Fallback Model Config (v4.19.4 and v5 migration note)

## Context

ai-engkit uses oh-my-openagent (OMO) 4.19.4. The plugin assigns default models to its 11+ registered agents via built-in fallback chains. To steer `plan` and `prometheus` toward the desired models and provide fallbacks on provider saturation, the config file needs a `fallback_models` key per agent.

## Problem

- The previous 4.19.3-era model-default migration (`apply_omo_model_defaults`) was verified inert — see `troubleshooting/omo-model-default-migration-inert.md`.
- The plugin source accepts and consumes `agents.<name>.model` and `fallback_models`, but live `/agent` and direct child-session probes can still show the compiled OMO fallback chain instead of the persisted model.

## Solution

**Do NOT set `fallback_models` on OMO 4.19.4.** The 2026-09-14 discriminating experiment proved that adding `fallback_models` to a single agent (schema-legal object form) silently invalidates **every** persisted `agents.<name>.model` override at model resolution: all agents fall back to compiled chain defaults, including agents that never received the key (see `troubleshooting/omo-model-mismatch-rejection-vs-precedence.md`). Migration validation accepts the key (no `Unrecognized key` line), so the early symptom is not a startup error — it is silent cross-agent regression in `GET /agent`.

The repo default template (`.opencode/omo.jsonc.default`) ships v5-style `models[]` (not 4.19.4's `fallback_models`) under `agents.plan`/`agents.prometheus`. `models` is not among the 4.19.4 agents-override keys verified in the runtime schema (`model`, `fallback_models`), so it belongs to the same hazard class — unverified by experiment; treat as suspect until tested. The reconciler's `del(.agents[$agent].models, .agents[$agent].fallback_models)` on apply is the correct defensive behavior.

Keep the live `$schema` pin at v4.19.4 and treat persisted config, `/agent`, and executed delegation as separate observations.

## Why It Works

Source-level consumption is confirmed but does NOT translate to a usable configuration on 4.19.4:

- `getRawFallbackModelsForSession` reads `pluginConfig.agents.<name>.fallback_models` directly — the key **is** parsed and consumed by the fallback resolution layer.
- `collectPendingBuiltinAgents` passes `pluginConfig.agents` into `applyModelResolution`, whose `userModel` path accepts `agents.<name>.model`.
- Runtime schema `AgentOverrideConfigSchema` (dist/index.js ~26808) defines both `fallback_models` and `permission` fields for each known agent.
- Migration validation accepts `fallback_models` (neither `plan` nor `prometheus.fallback_models` appear in the startup validation error), while `permission` is flagged — see Side Effects.
- **However (2026-09-14 experiment):** injecting `fallback_models` into a single agent's config (`agents.plan`) caused **every** agent's persisted `model` override to be dropped at resolution — all 14 agents reverted to compiled chain defaults. A clean-config control run on the same environment confirmed the overrides worked without `fallback_models`; a re-injection replication reproduced the regression identically. The cross-agent regression is the Mechanism A signature (whole-config rejection at model resolution, not migration validation). See `troubleshooting/omo-model-mismatch-rejection-vs-precedence.md` for the discriminating experiment details.
- Runtime probing on 192.168.11.195 with OMO 4.19.4 persisted `opencode/big-pickle` for all tested OMO agents, but live results remained `plan=opencode-go/kimi-k3` and `librarian=opencode-go/qwen3.7-plus`; do not call this configuration effective without matching runtime evidence.
- First-class `subtask` delegation reproduced the same mismatch: completed `plan` and `librarian` children used those fallback models, with non-zero token usage.

For the v5 migration, treat `models[]` as the canonical fallback-chain direction and preserve it during Admin Apply. The current Admin command writes only `model` + `variant` and deletes both `models` and `fallback_models`; therefore an Admin Apply can silently erase a manually configured chain. This is an application-code follow-up, not a documentation-only migration step.

## Side Effects / Tradeoffs

- **Admin `buildJqWriteCommand` deletes `models`/`fallback_models` on apply — this is now proven CORRECT and DEFENSIVE**: `src/admin/lib/agent-model-config.ts` `buildJqWriteCommand` writes `.agents[$agent].model` + `.variant` and **deletes** `models`/`fallback_models` every time the Admin UI applies a model. The 2026-09-14 experiment proved that the presence of `fallback_models` in `~/.omo/omo.jsonc` invalidates every agent's persisted override at resolution (Mechanism A), so the Admin's deletion behavior prevents this regression. Do not change this deletion to preserve-chain behavior until a working fallback mechanism is verified on a version that supports it.
- **v5 migration risk**: v5's canonical chain key is `models` (array of `{model, variant?}`). Adopting v5 chains requires changing `buildJqWriteCommand` to preserve or write `models` instead of deleting it (see `omo-v5-upgrade-impact.md`).
- **Startup migration validation error (pre-existing noise)**: the migration schema `OmoAgentDefInputSchema` has no `permission` field, so 11 agents' `permission` blocks produce `Unrecognized key: "permission"` in `[config-migration] startup completed`. This predates the fallback_models change (admin's original permission-only config triggered it), does not block runtime config loading, and is harmless — but appears at every startup.
- Restart required for config changes to take effect.
- A direct `POST /session` with `agent:<name>` bypasses OMO's `delegate-task`/`call_omo_agent` resolver and is not valid evidence for OMO delegation.
- The startup reconciler validates OMO targets against the connected catalog but only performs child-request verification for native `general`.
- All fallback models must exist on connected providers or fallback resolution returns empty (log: `connected providers unknown, returning empty set for fallback resolution`).

## Evidence

- **2026-09-14 discriminating experiment (Mechanism A confirmed):**
  - Baseline on managed server (port 42885): all 14 agents resolve to persisted models (plan=muse-spark-1.3-contributor, oracle=big-pickle, librarian=deepseek-v4.1-flash, etc.).
  - Inject `fallback_models` into ONE agent (`agents.plan`, object form with `model` + `variant`) in `~/.omo/omo.jsonc`: all 14 agents regress to compiled chain defaults (plan→kimi-k3, oracle→gpt-5.6-sol, librarian→gpt-5.6-luna-fast, metis→kimi-k3, momus→gpt-5.6-terra, etc.).
  - Control run (same isolation environment, clean config): all persisted overrides effective.
  - Replication (re-injected): identical full regression reproduced.
  - Migration log: `[config-migration] startup completed` shows no error for `fallback_models` — the key passes validation silently; rejection happens at model resolution, not migration.
  - `.opencode/omo.jsonc.default` ships v5-style `models[]` (not `fallback_models`) under `agents.plan`/`agents.prometheus`; `models` is not in the 4.19.4 agents-override schema (`model`/`fallback_models` only) — same hazard class.
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
