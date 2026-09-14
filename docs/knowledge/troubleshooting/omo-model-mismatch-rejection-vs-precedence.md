# OMO Agent Model Runtime Mismatch: Config Rejection vs Chain Precedence

## Context

ai-engkit reconciles OMO subagent models at container startup (`scripts/reconcile-agent-models.sh`, OMO 4.19.4) because persisted `~/.omo/omo.jsonc → agents.<name>.model` values may not reach runtime resolution. When a child session resolves to a model other than the persisted one, **two distinct mechanisms produce the identical observation**, and they call for opposite fixes.

## Problem

- **Mechanism A — whole-config rejection**: the comment at `scripts/reconcile-agent-models.sh` L123-125 claims OMO 4.x agent-def schema is `.strict()` and any undeclared key (e.g. `fallback_models`) invalidates the entire config, silently dropping **every** override.
- **Mechanism B — chain precedence**: the config loads fine, but OMO's compiled `AGENT_MODEL_REQUIREMENTS` fallback chains win over persisted values during runtime resolution (documented in `troubleshooting/omo-model-default-migration-inert.md`, 2026-08-23 correction).
- The knowledge base contradicts itself on which holds: `patterns/omo-fallback-model-config.md` L30/L33 says the key is "genuinely consumed by fallback handling" and "Migration validation accepts `fallback_models`", while the script comment asserts whole-config invalidation. As of 2026-08-23 neither claim has discriminating experimental support.

## Solution

Treat "child resolved to a non-persisted model" as **ambiguous** until a discriminating check is run:

1. Persisted policy: `jq '.agents' ~/.omo/omo.jsonc`.
2. Migration log: `grep '\[config-migration\]' /tmp/oh-my-opencode.log`. If the startup error lists the suspect key under `Unrecognized key:` **and** other previously-working overrides break simultaneously → mechanism A. If only `permission` is flagged and the log shows `config handler applied {agentCount:N}` → mechanism B.
3. Execution probe: first-class `subtask` part child metadata (see `troubleshooting/omo-agent-model-verification-boundary.md`); `POST /session` with `agent:<name>` is not valid evidence.

**Discriminating experiment (RUN 2026-09-14 — Mechanism A confirmed)**: baseline reconcile → inject `fallback_models` into ONE agent entry (`agents.plan`) → start an isolated `opencode serve` instance sharing the same plugin + `~/.omo/omo.jsonc` → compare `GET /agent`. Result: injecting `fallback_models` into `plan` alone dropped **every** persisted model override — all 14 agents resolved to compiled chain defaults (plan muse-spark→kimi-k3, oracle big-pickle→gpt-5.6-sol, librarian deepseek-v4.1-flash→gpt-5.6-luna-fast, metis/momus/sisyphus-junior/explore/multimodal-looker likewise). Control run (same isolation, restored clean config) resolved every persisted override correctly; a second injection run reproduced the identical full regression. Verdict: **whole-config rejection at model resolution** (cross-agent regression = Mechanism A signal). Caveat: `[config-migration] startup completed` did **not** flag `fallback_models` — rejection happens at resolution, not migration validation — so absence of an "Unrecognized key" line does not rule out A; the cross-agent `GET /agent` regression probe is the reliable discriminator.

Evidence state at capture time (2026-08-23):

- Probes 16:08–16:20 (`six_agent_results.json`, `quick_results.json`, driver `run_agents.py`): explore/oracle/multimodal-looker children resolved to built-in chain models (`opencode/nemotron-3.5-lightning-free`, `opencode/nemotron-3-ultra-free`, `opencode-go/mimo-v2.5`), never the persisted `opencode/big-pickle`; metis/momus/sisyphus-junior produced no child sessions (`no_child_created`). Consistent with **both** mechanisms — non-discriminating.
- Prior plugin-log evidence (config handler loaded `agentCount:13`; validation error listed only `permission`) favors mechanism B.
- `test/test-agent-model-reconcile.sh` (59 lines) asserts pure functions only (connected-only catalog, `choose_model`, `needs_update`, policy candidates); **no automated assertion exists for either mechanism**.

## Why It Works

Both mechanisms terminate in the same observable (runtime uses a chain model instead of the configured one), so outcome-only probing cannot separate them. Rejection changes *which* configs take effect globally; precedence changes only resolution order — the migration log's key list and cross-agent regression are the two signals that differ.

## Side Effects / Tradeoffs

- `write_omo_model()`'s `del(.agents[$agent].fallback_models)` (script L128) is **required** — the 2026-09-14 experiment proved the key is actively harmful on 4.19.4, not merely inert: its presence drops every persisted override at resolution. The strict-schema comment's causal wording ("invalidates the WHOLE config") matches the observed behavior; what is rejected is not migration validation (no `Unrecognized key` line) but runtime model resolution.
- `omo-fallback-model-config.md` L30/L33 qualified after the experiment (2026-09-14): source-level consumption (`getRawFallbackModelsForSession` reads the key) does not mean the key is usable — configuring it inverts all overrides. Do not use `fallback_models` on 4.19.4.
- Probe coverage gap: 3 of 6 agents yielded no child sessions, so any conclusion drawn from those runs generalizes at most to explore/oracle/multimodal-looker.

## Evidence

- `scripts/reconcile-agent-models.sh` L123-125 (strict-schema comment), L128 (`del(.agents[$agent].fallback_models)`).
- `test/test-agent-model-reconcile.sh` — full text reviewed 2026-08-23; five assertions, pure functions only.
- `six_agent_results.json` (mtime 2026-08-23 16:20:25 +0800), `quick_results.json` (16:19:47), `run_agents.py` (16:08:42), `agent_results.json` (0 bytes, aborted run).
- `docs/knowledge/patterns/omo-fallback-model-config.md` L30/L33 vs counter-evidence L34-35 (file mtime 2026-08-23 11:14).
- `docs/knowledge/troubleshooting/omo-model-default-migration-inert.md` — 2026-08-23 correction block; plugin-log quotes (`agentCount:13`, `Unrecognized key: \"permission\"`).

## Related Files

- `scripts/reconcile-agent-models.sh`
- `test/test-agent-model-reconcile.sh`
- `test/test-agent-model-e2e.sh` (baseline restore already strips `fallback_models`, L170)
- `docs/knowledge/patterns/omo-fallback-model-config.md`
- `docs/knowledge/troubleshooting/omo-agent-model-verification-boundary.md`
- `docs/knowledge/troubleshooting/omo-model-default-migration-inert.md`

## Tags

oh-my-openagent, agent-model, fallback-models, schema-validation, debugging-methodology, evidence-discipline, reconcile
