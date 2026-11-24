# OMO Model-Default Migration Is Inert Against the Plugin

> Historical V1-only investigation; the V2 runtime does not load this plugin.
> Keep for migration archaeology, not as current V2 operational guidance.

> **Status (2026-07-31): the feature was removed from the repo.** `apply_omo_model_defaults`, `.opencode/omo-model-defaults.json`, the `AI_ENGKIT_APPLY_OMO_MODEL_DEFAULTS` flag, and `test/test-omo-model-default-migration.sh` were deleted because the mechanism cannot work with plugin 4.19.3. This entry documents why, and what actually controls agent models.

> **Update (2026-08-15):** ai-engkit now supports the OpenCode-native `general` agent through an explicit startup bridge from `~/.omo/omo.jsonc` to generated `opencode.json → agent.general`. This does not revive the removed generic migration. See `../patterns/native-agent-model-override-bridge.md`.

> **Correction (2026-08-23):** OMO 4.19.4 source accepts `agents.<name>.model` and `fallback_models`, but first-class OMO `subtask` delegation on 192.168.11.195 still resolved `plan` and `librarian` through the compiled fallback chain. Treat the override as persisted configuration, not effective runtime assignment.

## Current 4.19.4 Resolution Contract

Admin-managed OMO subagent primary models are persisted at:

```text
~/.omo/omo.jsonc → agents.<name>.model
```

Two legacy conditions can prevent that value from taking effect together:

1. An agent-level `permission` field fails the pinned 4.19.4 migration schema. Direct tool allow/deny values must be represented as `tools.<name>: boolean`; unsupported nested or deny-all policies must be retained and reported for manual migration rather than deleted.
2. A stale `[opencode].agents` model layer can shadow the top-level Admin value. Startup normalization removes that agent layer while preserving unrelated `[opencode]` settings.

The startup normalization in `entrypoint.d/lib-omo-model-defaults.bash` is atomic and idempotent. It preserves top-level models and unrelated user settings, converts known direct permission values, removes redundant allow-all permission maps, and leaves the original file byte-identical when conversion is unsafe.

Verification must distinguish three observations:

1. Persisted config: `jq -r '.agents.librarian.model' ~/.omo/omo.jsonc` reports the selected `provider/model` and no agent entry contains `permission`.
2. Advertised runtime: authenticated `GET /agent` reports the runtime model, which may still be the compiled OMO fallback for OMO agents.
3. OMO execution: a first-class `subtask` part invokes the actual OMO `delegate-task` path; creating a child with `POST /session` and `agent:<name>` bypasses that resolver.

`test/test-agent-model-e2e.sh` currently proves native `general` execution and restores the baseline file byte-for-byte. OMO child execution is intentionally not asserted through the direct `/session` API.

## Context

ai-engkit ships an opt-in migration, gated by `AI_ENGKIT_APPLY_OMO_MODEL_DEFAULTS=1` in the compose `.env`, that fills missing model keys under `[opencode].agents` and `[opencode].categories` in `~/.omo/omo.jsonc` with the low-cost `opencode/deepseek-v4-flash`. It exists to cap model cost across the 11 OMO agents and 7 delegation categories. The dev stack (`docker-compose.dev.yml`) runs with the flag enabled.

## Problem

Enabling the migration appears to do nothing: agent models in the live system stay on the models the oh-my-openagent plugin (4.19.3) assigns via its built-in `AGENT_MODEL_REQUIREMENTS` fallback chains (e.g. `opencode-go/kimi-k3`, `opencode-go/glm-5.2`, `opencode-go/minimax-m3`), never on `opencode/deepseek-v4-flash`.

## Solution

For plugin 4.19.3, no config-level solution was found. For 4.19.4, source-level support exists, but live OMO assignment remains unproven and was mismatched on 192.168.11.195:

1. Removed the one-time marker `~/.omo/.ai-engkit-omo-model-defaults-v1` and recreated the container with `AI_ENGKIT_APPLY_OMO_MODEL_DEFAULTS=1`.
2. Confirmed the migration re-ran: `jq '.["[opencode]"].agents.sisyphus.model' ~/.omo/omo.jsonc` → `opencode/deepseek-v4-flash`, marker recreated.
3. Confirmed the fresh opencode server (new PID/port in `~/.config/openchamber/managed-opencode/`) still returns plugin-assigned models for every agent via `GET /agent` — zero migration values present.

All four candidate config layers were tested and are inert for agent model assignment:

| Config layer | Tested via | Result |
|---|---|---|
| `[opencode].agents.<name>.model` (migration target, harness layer) | migration re-run + container recreate | overridden |
| omo.jsonc native `agents.<name>.model` (schema-supported) | direct edit + container recreate | persisted; live OMO result mismatched in observed run |
| opencode.json native `agent.<name>.model` | direct edit + container recreate | stripped by openchamber rewrite, and overridden |
| agent frontmatter `model:` in `~/.config/opencode/agents/*.md` | /agent vs frontmatter diff | overridden |

## Why It Works (the actual mechanism)

The plugin's config schema accepts `[opencode]` as a free-form harness layer (`OmoOpenCodeHarnessConfigSchema = z9.record(z9.string(), z9.unknown())`) and merges it into the resolved config view, so the migration's values do reach `agents.<name>.model` in OMO's resolved config. However, agent model resolution runs through `AGENT_MODEL_REQUIREMENTS` (`packages/model-core/src/agent-model-requirements.ts`, inlined in `dist/index.js`): each agent gets the best model from its `fallbackChain` whose provider is connected, and this result is what the opencode server reports. The harness-layer config values are observably not part of the final agent definitions.

When no effective user override reaches the runtime boundary, the `fallbackChain` × connected-provider mechanism decides agent models, and it is cache- and credential-driven:

- Connected providers come from the plugin's probe of real credentials: the `opencode auth` store (`~/.local/share/opencode/auth.json`) plus env vars (`OPENCODE_PROVIDER`, API keys). Not necessarily `.env` keys — `opencode auth logout <provider>` is the removal lever.
- Provider state is cached in `~/.cache/oh-my-opencode/{connected-providers,provider-models,model-capabilities}.json`, written lazily. With no cache (`isFirstRunNoCache`), `getFirstFallbackModel` assigns each agent the **first** (top-tier) chain entry; with a stale cache it reflects the old provider set; with a fresh cache it reflects real credentials.
- Observed model tiers per connected set: anthropic+openai → `claude-opus-5` / `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.4-mini-fast` (top tier); only `opencode-go` → `kimi-k3` / `glm-5.2` / `minimax-m3` (low-cost tier); only `opencode` → `big-pickle` (cheapest).

If the goal is cost control, the effective levers are:

- **Credentials**: `opencode auth logout openai` / `opencode auth logout anthropic` (and moonshotai/nvidia if undesired) so the fallback chains land on the low-cost `opencode-go` tier. Verified by contrast: prod (openai authenticated) runs oracle on `gpt-5.6-sol`; dev (only opencode-go) runs the same agents on `kimi-k3`/`glm-5.2`/`minimax-m3`.
- `settings.json` → `defaultModel` in OpenChamber (governs the new-session picker only — verified working).
- Native OpenCode agents can be pinned through the explicit `opencode.json → agent.<name>.model` bridge; this is proven for `general` and is allowlisted with `plan` in ai-engkit.

## Side Effects / Tradeoffs

- The migration is one-time via a marker file; once the marker exists, later boots skip it. If the config is later regenerated without the `[opencode]` section, the marker still blocks re-application — the effect is lost but the migration believes it already ran.
- Enabling the flag is harmless but misleading: it creates the impression that low-cost defaults are active when they are not.
- The dev stack `.env` (`~/workspace/ai-engkit/.env` on the host) has the flag at `1`; the prod stack (`~/.env`) has it at `0`.
- Any future plugin version that respects user-supplied agent models would make the migration effective without ai-engkit changes.

## Evidence

- Live 2026-08-23 probe with OMO 4.19.4: persisted `big-pickle` for OMO agents, `/agent` reported `plan=opencode-go/kimi-k3` and `librarian=opencode-go/qwen3.7-plus`, and first-class OMO subtask children completed on those same fallback models; `general` reported `opencode/big-pickle` through the native bridge.
- `jq '.["[opencode]"].agents.sisyphus.model' ~/.omo/omo.jsonc` → `opencode/deepseek-v4-flash` while the live model is `kimi-k3`.
- Plugin source: `oh-my-openagent@4.19.4` `dist/index.js` — `AGENT_MODEL_REQUIREMENTS`, `collectPendingBuiltinAgents`, `resolveModelPipeline`, and `resolveSubagentModel`.
- Marker mtime 2026-07-31 10:41 on the dev volume predates the container start 12:15 — the config was already written before the server booted, and the server still ignored it.

## Related Files

- `entrypoint.d/lib-omo-model-defaults.bash`
- `entrypoint.d/02-init-config.sh` (line ~223, `apply_omo_model_defaults` gate)
- `.opencode/omo-model-defaults.json`
- `docker-compose.dev.yml` (via `.env` flag)
- `docs/knowledge/troubleshooting/openchamber-default-model-not-applied.md`

## Tags

- omo
- oh-my-openagent
- model-defaults
- migration
- deepseek-v4-flash
- agent-model
- cost-control
- troubleshooting
