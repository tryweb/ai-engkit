# Routing Per-Agent Isolation — Native V2 Fallback

## Context
Admin agent-models moves from `~/.omo/omo.jsonc` (single `agents` blob) to native `~/.config/opencode/routing.json` (`version:1` + `chains[agent].chain[]`) and `~/.config/opencode/opencode.json` `agent.<name>.model` head. Writes use `tmp→mv` atomic rename and bracket-notation `jq` for hyphenated names. See `trial/B1-ROUTING-SPEC.md:§4`.

## Problem
OMO V1's single-key-poisons-all failure (`omo-fallback-model-config.md`, Mechanism A 2026-09-14): injecting `fallback_models` into one agent's `omo.jsonc` silently invalidates every persisted `agents.<name>.model` at resolution — all agents revert to compiled defaults. A bad entry is not isolated.

## Solution
Native path proves non-repeat by construction:
- `routing.json` has no `fallback_models` key; `ChainEntry` is `model/variant/...` only. The poison key cannot be emitted.
- Per-agent error isolation (`B1 §4.5` rules 3–4): validation rejects a bad chain for that agent only; `chains["sisyphus"]` remains operable. Admin batch writes validate each `{agent, chain}` independently, write only passing agents, and return per-agent `results`.
- `opencode.json` heads are independent keys: `agent.plan.model` never affects `agent.sisyphus.model`.
- Writes are `tmp→mv` per file (`mktemp` → `jq … > tmp` → `chmod 600 tmp` → `mv tmp target`) — crash leaves old valid or new valid file, never a truncated half.
- Hyphenated names use bracket notation `.chains["multimodal-looker"]` (bare `.chains.multimodal-looker` is a `jq` parse error).

## Why It Works
Resolution reads per-agent chains, not a single blob: a malformed `chain` entry dropped for `plan` invalidates only that agent's `chain` (`getFallbackChain(agent)→null`), others remain routed. The file-level whole-config rejection path is structurally absent. The `del(models,fallback_models)` defense on V1 remains correct but is no longer needed on V2 because the poison surface was removed.

## Side Effects / Tradeoffs
- `routing.json` `$schema` is optional/tolerated as unknown top-level key until a registry exists; not validated.
- Empty `chains:{}` is valid (routing no-op) — fresh installs show no overrides until first Admin apply.
- Unknown agent keys accepted but warned (forward-compat).

## Evidence
- Spec: `trial/B1-ROUTING-SPEC.md:§4.7` checklist, `trial/ADMIN-NATIVE-DESIGN.md:§3.5` Z1 proof.
- Code: `src/admin/lib/agent-model-config.ts:buildRoutingWriteCommand` (tmp→mv + bracket), `src/admin/lib/agent-models.ts:applyAndVerifyBatch` v2 branch (per-agent validation), `scripts/migrate-omo-to-native.sh` (ignores `models`/`fallback_models`).

## Related Files
- `src/admin/lib/agent-model-types.ts` (`ROUTING_CONFIG`, `ChainEntry`, `RoutingConfig`)
- `src/admin/lib/agent-model-config.ts` (`validateAgentChain`, `parseRoutingConfig`, `buildRoutingWriteCommand`)
- `src/admin/lib/agent-models.ts` (`readRoutingConfig`, `writeAgentChain`, `applyAndVerifyBatch`)
- `trial/B1-ROUTING-SPEC.md:§4`

## Tags
- routing
- per-agent-isolation
- tmp-mv
- bracket-notation
- v2-migration
