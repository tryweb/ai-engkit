# Admin Agent-Models Rewrite — OMO-Backed → Native OpenCode V2

> **Branch:** `trial/opencode-v2` | **Workdir:** `/home/devuser/workspace/ai-engkit` | **Date:** 2026-09-29
> **Type:** DESIGN ONLY — no source edits, no tests run, no inference.
> **Upstream contract:** `trial/B1-ROUTING-SPEC.md:§4` (chain schema, `version:1`) is the exact downstream write-format this design conforms to.
> **Scope:** Admin agent-models subsystem only. V1 line (`main`, `OMO_ENABLED=1`) keeps OMO untouched — every change below is **on the v2 line** (branch-by-config-flag `OMO_ENABLED=0` / `isOpenCodeV2`). Where code is shared, the design specifies flag gating, not shared-code mutation that alters V1.
> **Other worker:** uncommitted Admin Providers V2 work in this branch (`src/admin/views/providers.tsx` + `src/admin/routes/providers.ts` `isOpenCodeV2` banner) — this design reads it only, never edits it; overlap noted in §8.

---

## 1. Current-State Map — Every OMO Touchpoint

### 1.1 `src/admin/lib/agent-model-types.ts`

| Line | Symbol | OMO dependency | V2 fate |
|------|--------|----------------|---------|
| 72 | `OMO_CONFIG = "~/.omo/omo.jsonc"` | Literal path expanded inside `ai-dev` via `deps.exec` (`$HOME` expansion by shell). Every lib read/write uses this constant. | **Delete constant on v2 line; replace with `ROUTING_CONFIG = "~/.config/opencode/routing.json"`** (or project-local `.opencode/routing.json` per §4.1 — Admin's v2 write target is global by default; per-project override is later). Keep symbol name distinct to avoid shadowing V1 tests. |
| 73 | `MANAGED_OPENCODE_DIR = "~/.config/openchamber/managed-opencode"` | Unchanged — used for `/agent` + `/provider` live probes. | **Keep as-is** (provider/catalog probing stays). |
| 74 | `CONFIGURABLE_NATIVE_AGENTS = ["general","plan"]` | Filter in `collectAgentModelState` + reconciler `namesAndResolved` — the only native agents surfaced today. | **Expand to 12 native agents from `trial/CELL1.md:§2`** on v2 line: `plan, prometheus, explore, oracle, librarian, multimodal-looker, metis, momus, sisyphus, hephaestus, atlas, sisyphus-junior`. Gate with `isOpenCodeV2 ? NATIVE12 : ["general","plan"]` to preserve V1. |
| 75 | `VARIANTS = ["low","medium","high","xhigh","max"]` | Passed to `variantSet` in `buildJqWriteCommand`; validated in `validateFallbackModels`. | **Keep as-is** — `ChainEntry.variant` reuses same set (plus provider-specific `none/minimal/off` accepted with warning per B1 §4.4). |

### 1.2 `src/admin/lib/agent-model-config.ts`

| Line | Symbol | OMO dependency | V2 fate | Notes |
|------|--------|---------------|---------|-------|
| 55–66 | `buildJqWriteCommand(agent, entries)` | Constructs `jq --arg agent … 'del(.agents[$agent].mdl,…)' ~/.omo/omo.jsonc > /tmp/… && mv …`. Shell-quotes agent/model, deletes `models` + `fallback_models` defensively, handles clear (`del(model,variant,…)` when no primary). | **Supersede with `buildRoutingWriteCommand(agent, chainEntry)` that `jq`-patches `routing.json`** (see §3). Delete the `del(models,fallback_models)` rationale from this path — on v2 that deletion is harmless (file absent) but must not target `routing.json`. The `del` rationale itself (`docs/knowledge/patterns/omo-fallback-model-config.md` Z1 poison) stays documented; native path must prove non-repeat via per-agent isolation (§4.7). | On v2 line the function name should be renamed or forked (`buildRoutingWriteCommand`) to avoid silent cross-wire. |
| 35–53 | `validateFallbackModels(input)` | Validates `entries: {model, variant?}[]` length ≤1, `MODEL_REFERENCE_PATTERN = /^[^/\s]+\/\S+$/`, variant in `VARIANTS`. | **Keep pattern, rename to `validateChainEntry` / expand to `validateAgentChain`** — single-entry limit (≤1) is removed; chains are `1..10` entries. Per-entry validation identical; per-chain validation adds `chain.length` + numeric range checks per B1 §4.5. | Provider segment still slash-free; model segment may contain slashes (e.g. `nvidia/org/model`) — pattern already allows it via `\S+` after first slash. |
| 98–118 | `parseAgentModelsConfig(stdout)` | Parses `jq -c '.agents // {}'` JSON from `OMO_CONFIG`; maps each agent value via `toConfiguredEntries()` which merges `model` + `fallback_models` + `models` (up to 3 sources) into `models: FallbackModelEntry[]`. Sets `invalid` if unknown key in value. | **Replace with `parseRoutingConfig(stdout)`** that parses `routing.json` (`version/chains/defaults`). `toConfiguredEntries` merging disappears — each chain entry is already `ChainEntry` (`model` + `variant` + passthrough). `invalid` becomes per-chain validation result (B1 §4.5 rule 3/4). Unknown top-level/defaults keys ignored, not invalid. |
| 68–77 | `displayNameToKey(displayName, knownKeys)` | Maps `Sisyphus - ultraworker` → `sisyphus` via lowercasing + hyphen/split. Used to align `/agent` display names with config keys. | **Keep as-is** — routing lookups still need display-name → key mapping. No OMO coupling. |

**`del(models,fallback_models)` rationale (for implementer, no re-read needed):** `docs/knowledge/patterns/omo-fallback-model-config.md` proves (2026-09-14 discriminating experiment, Mechanism A) that injecting `fallback_models` into a single agent's `~/.omo/omo.jsonc` silently invalidates **every** persisted `agents.<name>.model` at OMO model resolution — all agents revert to compiled defaults. `buildJqWriteCommand` therefore deletes both `models` and `fallback_models` on every apply; that deletion is defensive and correct on V1 and must stay. On v2, `routing.json` has no `fallback_models` key by design, and per-agent error isolation (§4.1) guarantees a bad chain cannot poison other agents.

### 1.3 `src/admin/lib/agent-models.ts`

| Line | Symbol | OMO dependency | V2 fate |
|------|--------|---------------|---------|
| 53–56 | `readAgentModelsConfig()` — `jq -c '.agents // {}' ~/.omo/omo.jsonc` | Reads OMO file. | **Replace with `readRoutingConfig()`** — `jq -c '.' ~/.config/opencode/routing.json` (global) or `cat .opencode/routing.json`. Return `RoutingConfig` (B1 §4.2) not `Record<string,AgentModelConfig>`. |
| 58–67 | `writeAgentFallbackModels(agent, entries)` — `deps.exec(buildJqWriteCommand(...))` | Single-agent write. | **Replace with `writeAgentChain(agent, chain: ChainEntry[])`** — calls `buildRoutingWriteCommand`. Single-agent variant stays for center-agent single-set; batch path uses chained commands. |
| 69–87 | `snapshotAgentModelsConfig()` / `restoreAgentModelsConfig(snapshotFile)` | `cat ~/.omo/omo.jsonc > $snapshot` / `cat $snapshot > ~/.omo/omo.jsonc.tmp && mv …` | **Replace with `snapshotRoutingConfig()` / `restoreRoutingConfig()`** targeting `routing.json`. Same tmp→mv guard. See §3 for snapshot scope (routing only, no OMO). |
| 201–213 | `syncNativeAgentOverrides()` | `jq -s '.[0] as $opencode | .[1] as $omo | reduce ["general","plan"][] …'` — merges `omo.agents.general/plan.model` + `variant` into `opencode.json: .agent[general|plan]`. `tmp="$op.native-agent-overrides.tmp"` + `2>/dev/null && mv`. | **Delete on v2 line** — `merge_native_agent_overrides` goes away with OMO. Replace with direct `agent.*` writes (see §3/C4). Document read-path replacement in §4. If kept for V1 compat, gate with `if [ "$OMO_ENABLED" != "0" ]` and do not call from v2 `applyAndVerifyBatch`. |
| 215–364 | `applyAndVerifyBatch(changes, verification)` | Orchestrates `snapshot → write (| jq writes chained with &&) → nativeSync → restart → verifyAppliedAgent loop → probeFailure rollback → recovery restart`. Timeout 180s readiness / 300s inference; `timedOut` flag; per-agent error isolation only at verification, not at write (single `&&` chain). Batch write is transactional via `rollback = restoreAgentModelsConfig(snapshot)` on any write failure. | **Rewrite write phase to B1 §4.7 conformance:** per-agent error isolation (validate each agent's chain independently; failing agent does not abort other agents' writes), transactional tmp→mv per `routing.json` patch (not per-OMO), and removal of `nativeSync` step. Keep snapshot/restart/verify/rollback shape; change targets. See §3. |
| 366–369 | `applyAndVerify(agent, entries, verification)` | Single-item wrapper over batch. | **Keep wrapper** but with new types (`ChainEntry[]`). |
| 403–518 | `collectAgentModelState(lib, password)` | Reads `config = readAgentModelsConfig()` + `resolvedMap = fetchResolvedAgentModels()` + `providerSnapshot = fetchProviderSnapshot()` + `subagentNames = fetchSubagentNames()`. Merges into `AgentModelsViewState.agents[]` with `configured/resolved/requestVerified/providerConnected/source/invalid/effectiveness`. Uses `CONFIGURABLE_NATIVE_AGENTS` filter. | **Replace config source** with `readRoutingConfig()`; map `AgentChain.chain` entries to `configured: ChainEntry[]` (first entry = primary, rest = fallbacks — UI shows primary + chain length). Keep live `resolvedMap`/`providerSnapshot`/`subagentNames` unchanged (they are native OpenCode probes, not OMO). Effectiveness logic: `resolvedModel === chain[0].model` + `providerConnected` + catalog check stays; `invalid` becomes per-chain validation failure; `source: "inherited"` (prometheus←plan fallback) removed — chains are explicit per agent on v2. |

**Native override detail for audit:** `syncNativeAgentOverrides` line 202–204 — `op="$HOME/.config/opencode/opencode.json"` and `omo="$HOME/.omo/omo.jsonc"` are shell-expanded inside `deps.exec`; `reduce ["general","plan"][]` lowercases agent names; `test("^[^/[:space:]]+/[^[:space:]]+$")` mirrors `MODEL_REFERENCE_PATTERN`; `variant` branch `del(.agent[$name].variant)` on empty. Transaction `> "$tmp" 2>/dev/null && mv "$tmp" "$op"` — this exact `tmp→mv` must be replicated for every native write (§3, §4 quote).

### 1.4 `src/admin/routes/agent-models.ts`

| Line | Endpoint | Request shape (today) | OMO dependency | V2 fate |
|------|----------|----------------------|---------------|---------|
| 126–130 | `GET /api/agent-models` | → `AgentModelsViewState` (`agents/catalog/providers/hasPassword/catalogAvailable`) | `collectAgentModelState` reads OMO `config`. | **Keep shape** — see §5 C9. Only `config` source changes; response type unchanged for UI. |
| 132–173 | `POST /api/agent-models/suggestions` | `{providers?: string[], mode?: free|economy|performance}` → `{suggestions: Record<agent, ChainEntry[]>, providers, mode, sourceStatus, sourceAgeMs, warnings, metadata}` | `reconciler.suggest/suggestExplicit` reads OMO config + catalog + capabilities. | **Keep shape** — reconciler stays but reads routing chains as `current` instead of OMO. No breaking change. |
| 176–234 | `PUT /api/agent-models` (batch) | `{changes: {agent, entries: {model, variant?}[]}[], verification?: readiness|inference}` → `{results: Record<agent, ApplyResult>}`. Validates `validateFallbackModels` per change, catalog-available gate, per-model catalog + probe pre-check (inference), knownAgents check, then `applyAndVerifyBatch`. | All writes via `buildJqWriteCommand` → OMO. `knownAgents` from `state.agents` (which itself filtered via OMO config). | **Expand `entries` to `ChainEntry[]` (allow 1..10 entries, not ≤1) and rename field to `chain` in v2 (or keep `entries` alias for compat — see §5).** Validation becomes per-B1 §4.5. Catalog gate per-agent (not whole-batch). Write becomes routing patches. See §3/§5. |
| 236–290 | `PUT /api/agent-models/:agent` (single) | `{entries: {model, variant?}[], verification?}` → `ApplyResult` (single) via `reconciler.applyAgent`. | Same OMO write path via `applyAgent` → `applyAndVerify`. | **Same expansion to chain; keep route for center-agent.** Gate `knownAgents` now includes 12 native names. |
| 292–395 | `POST /api/agent-models/verify` | `{agents?: string[], verification?: readiness|inference}` → `{verification, results: Record<agent, {model, status, reason, verification}>, summary}`. Caps `MAX_VERIFY_TARGETS=12`, `VERIFY_TOTAL_DEADLINE_MS=300_000`, per-model `probeModel` + dedup cache. | Probing uses `configuredByAgent` from OMO `state.agents`. No OMO write. | **Keep shape** — `configuredByAgent` now reads `chain[0].model` from routing config. No breaking change; limits unchanged. |
| 397–406 | `GET /api/agent-models/verify-model?model=` | `?model=provider/id` → `ProbeResult` via `probeModel`. | None (pure probe). | **Keep as-is.** |
| 408–412 | `GET /agent-models` (HTML) | → `AgentModelsPage(state)` | `collectAgentModelState`. | **Keep as-is** — page will render chain length + primary. |

### 1.5 `src/admin/agent/commands.ts` — center-agent

| Line | Command | Parse / dispatch | OMO dependency | V2 fate |
|------|---------|-----------------|---------------|---------|
| 345–361 | `parseAgentModelSet(payload)` — `agent: string` (`^[a-z0-9][a-z0-9-]*$`), `validateFallbackModels(payload)` gate, `entries: FallbackModelEntry[]` from `payload.entries` | Validates ≤1 entry, `provider/model` pattern, variant allowlist. | **Expand to chain validation** (`1..10` entries, B1 §4.5). Keep `agent` pattern (already allows hyphenated `sisyphus-junior`, `multimodal-looker`). |
| 1356–1404 | `dispatchAgentModelSet(env, payload)` / `finishAgentModelSet` | Checks `knownAgents` via `readAgentModelsState()`, then `!catalog.has(model)` gate, then `deps.applyAgentModel(agent, entries)`. | Replace `readAgentModelsState` source (routing) and `applyAgentModel` target (routing + agent.*). Keep shape (single agent). |
| 1430–1431 | `agent-models.list` query | `deps.readAgentModelsState()` → masked envelope. | Replace source. |
| 1674–1681 | `agent-models.set` handler | `parseAgentModelSet` → `dispatchAgentModelSet`. | Expand validation. |
| 1690–1691 | `agent-models.list` status route | `dispatchQuery` | Replace source. |
| 1715–1863 | `createRealCommandDeps` — `agentModelsLib = createAgentModelsLib(AGENT_MODEL_REAL_DEPS)`, `readAgentModelsState = collectAgentModelState`, `applyAgentModel = applyAgent` | Wires OMO-backed lib into dispatcher. | **Wire v2 routing lib** — same `createAgentModelsLib` symbol but v2 branch reads/writes routing+agent.*. Dispatcher types `ApplyResult` unchanged. |

### 1.6 Entrypoints & startup

| File:line | Content | V2 disposition |
|-----------|---------|----------------|
| `entrypoint.d/02-init-config.sh:258–265` | `if [ "${OMO_ENABLED:-1}" = "0" ]; then PLUGINS=""` else `normalize_omo_plugin_versions` → `PLUGIN_JSON` | **Keep as-is** — already gates V2 plugin-free `opencode.json`. No change needed. |
| `entrypoint.d/02-init-config.sh:341–343` | `DEFAULT_OMO_CONFIG="/etc/opencode/omo.jsonc.default"` / `OMO_CONFIG_DIR="$HOME/.omo"` / `OMO_CONFIG_FILE="$OMO_CONFIG_DIR/omo.jsonc"` | **Gate-off on v2 line.** On `OMO_ENABLED=0` this block should not define `OMO_CONFIG_DIR/FILE` guards that downstream `if [ -f "$OMO_CONFIG_FILE" ]` relies on. Wrap in `if [ "${OMO_ENABLED:-1}" != "0" ]; then … fi` or leave definitions inert but ensure no caller expects the file. |
| `entrypoint.d/02-init-config.sh:346–348` | `source lib-omo-model-defaults.bash` + `lib-openchamber-settings.bash` + `lib-native-agent-overrides.bash` | **Gate-off `lib-omo-model-defaults.bash` on v2 line** (`source` is inert alone, but downstream `initialize_omo_permissions`/`normalize_omo_config` invocations must not run). **`lib-openchamber-settings.bash` keep-as-is** (defaultModel backfill is native). **`lib-native-agent-overrides.bash` delete-on-v2-line** — function `merge_native_agent_overrides` (36 lines, `reduce ["general","plan"]` + `tmp→mv`) is OMO→opencode bridge and goes away; replacement is direct native writes (§3/C4). |
| `entrypoint.d/02-init-config.sh:350–374` | `archive_legacy_omo_configs()` definition + `if [ "${OMO_ENABLED:-1}" = "0" ] then echo skip else archive + mkdir + initialize_omo_permissions + normalize_omo_config fi` | **Keep-as-is** — already correctly gates V1/V2. No extra change. |
| `entrypoint.d/02-init-config.sh:385–387` | `if [ "${OMO_ENABLED:-1}" != "0" ]; then merge_native_agent_overrides … fi` | **Delete-on-v2-line** — the conditional itself becomes dead once the function is removed. On v2 line remove both definition and invocation; document that `merge_native_agent_overrides` no longer exists (C4 read-path replacement is direct). |
| `entrypoint.d/lib-native-agent-overrides.bash:1–36` | `merge_native_agent_overrides(op, omo)` — `reduce ["general","plan"]` + `test("^[^/[:space:]]+/[^[:space:]]+$")` + `tmp="…native-agent-overrides.tmp"` + `jq … > "$tmp" 2>/dev/null && mv "$tmp" "$op"` | **Delete file on v2 line.** Keep in git history for V1 reference. No replacement function by this name. |
| `entrypoint.d/lib-omo-model-defaults.bash:1–104` | `normalize_omo_config` + `initialize_omo_permissions` — `jq` permission→tools conversion, `[opencode].agents` stale-layer removal, `jq -s '.[0] * .[1]'` merge | **Gate-off on v2 line** — functions gated by `OMO_ENABLED` invocations already; file may stay inert for V1. |
| `entrypoint.d/lib-openchamber-settings.bash:1–43` | `ensure_openchamber_default_settings` — backfills `defaultModel` + `showOpenCodeUpdateNotifications` | **Keep-as-is** — not OMO-specific; on v2 line still seeds OpenChamber `settings.json` (but defaultModel source changes — see C4). |
| `entrypoint.d/00-fix-perms.sh:19` | `fix_perms "$HOME"/.omo` | **Gate-off on v2 line** — V2 has no `~/.omo` volume; the line becomes `if [ "${OMO_ENABLED:-1}" != "0" ]; then fix_perms "$HOME/.omo"; fi` or harmless no-op (`[ -e "$path" ]` already guards, so leaving it is safe but wasteful — delete for cleanliness). |
| `scripts/reconcile-agent-models.sh:1–137` | `reconcile()` — `wait_for_provider` / `wait_for_lifecycle` polling, then `bun run /opt/admin/lib/agent-model-reconcile-cli.ts` with `RECONCILE_STARTUP_NO_RESTART=1`, then `sync_native_overrides` via sourced `lib-native-agent-overrides.bash`. | **Redesign** — see §6. Health probing stays; `sync_native_overrides` removed; OMO-catalog dependency replaced by routing-aware probe. |
| `src/admin/lib/agent-model-reconciler.ts:1–387` | `createAgentModelReconciler` — reads `config = readAgentModelsConfig()` (OMO), probes catalog/capabilities, computes `desired` via `sortedCandidates`/`pickFirstHealthy`, then `applyAndVerifyBatch(changed, "inference")`. | **Redesign** — see §6. Core loop stays; `readAgentModelsConfig` → `readRoutingConfig`; `desired` tailoring uses `ChainEntry` chains; `applyAgentModel` → routing writes. `fetchCapabilityCatalog` + `pruneStaleProbeCache` unchanged. |

### 1.7 Docker / persistence

| File:line | Content | V2 disposition |
|-----------|---------|----------------|
| `docker-compose.yml:14` + `:65` + `docker-compose.dev.yml:22` + `:98` | `omo-config:/home/devuser/.omo` + volume definition | **Gate-off on v2 line (compose `docker-compose.v2.yml:40/118` already does this with `omo-config-v2`).** On v2 line the named volume `omo-config(-dev)` is not mounted; data migrates one-shot via `scripts/migrate-omo-to-native.sh` (see §7) then volume becomes orphaned for pruning. |
| `docker-compose.v2.yml:6` comment | Notes all `-v2` suffixes | Keep — already documents V2 volume isolation. |

### 1.8 Tests

| Test file | Current role | V2 disposition (supersede notes, not edits) |
|-----------|-------------|--------------------------------------------|
| `test/test-agent-model-e2e.sh` (~180 lines) — proves `set → restart → live resolution → child execution → restore` via `/agent` + managed port | Asserts `~/.omo/omo.jsonc` write + `assignedModel` + delegation | **Rewrite** — new `test/test-routing-e2e.sh` that sets a `routing.json` chain → restart → `session.switchModel` live resolution → child prompt → per-agent isolation check. Old file stays for V1; do not delete until V1 EOL. |
| `test/test-omo-config-normalization.sh` (~90 lines) — verifies `normalize_omo_config` permission→tools conversion | Invokes `lib-omo-model-defaults.bash` functions | **Retire on v2 line** — no OMO file to normalize. Keep file for V1. |
| `test/test-agent-model-reconcile.sh` | Invokes `agent-model-reconciler.ts` against live catalog | **Rewrite** — new `test/test-routing-reconcile.sh` that seeds routing chains, mocks catalog gaps, asserts per-agent healing without OMO. |
| `test/test-native-agent-overrides.sh:1–68` — tests `merge_native_agent_overrides` (`reduce ["general","plan"]`, bracket-notation for hyphenated names, tmp→mv) | Direct unit for the deleted function | **Retire on v2 line** — function deleted. New test `test/test-routing-writes.sh` covers `buildRoutingWriteCommand` + transactional tmp→mv + per-agent isolation. |
| `test/test-agent-model-health.sh` + `test-agent-model-health-parallel.sh` + `test-agent-model-policy.sh` — probe/health/policy unit | Prove `probeModel` classification + policy scoring | **Keep-as-is** — provider health probing is unchanged on v2. |

### 1.9 Specs (supersede notes, not edits)

| Spec | Current content | V2 note |
|------|----------------|---------|
| `openspec/specs/omo-config-persistence/spec.md` (27 lines) — `omo-config` volume at `~/.omo`, ownership, writability | V1 persistence contract | **Superseded on v2 line by `routing-config-persistence` spec** — new named volume is `opencode-config` (`~/.config/opencode/routing.json`) + per-project `.opencode/routing.json` (bind under workspace). No new `omo-config` volume. Add note: "On v2 line this spec is superseded; see routing-config-persistence." |
| `openspec/specs/omo-unified-config/spec.md` (78 lines) — ship `/etc/opencode/omo.jsonc.default`, `initialize_omo_permissions` + `normalize_omo_config` lifecycle, `OH_MY_OPENAGENT_VERSION` pin | V1 unified config contract | **Superseded on v2 line by `native-agent-config` + `routing-config` specs.** Default ships as `routing.json.default` (optional) or no default (routing is no-op when absent). No `$schema` sync; no `lib-omo-model-defaults` lifecycle. Add note pointing to new specs. |
| `docs/knowledge/patterns/omo-fallback-model-config.md` | Documents Z1 poison + `del(models,fallback_models)` defense | **Keep** — historical record of why V1 deleted those keys. New entry `docs/knowledge/patterns/routing-per-agent-isolation.md` will document native non-repeat guarantee (B1 §4.1/§4.5 + per-agent error isolation). |
| `.opencode/omo.jsonc.default` (`$schema: https://raw.githubusercontent.com/code-yeongyu/oh-my-openagent/v4.19.4/assets/omo.schema.json`) | Ships `agents.plan/prometheus` `models[]` chains + `tools` booleans | **Gated-off on v2 line** — on `OMO_ENABLED=0` the file is not installed to the image (or installed but inert). No `$schema` sync pipeline on v2 — see disposition below. |

### 1.10 The 10 already-dirty files in this branch (read-only)

`git status` at design time shows 10 dirty files (per task: 6 `.opencode/agents/*.md`, 1 KB troubleshooting entry, 3 `src/admin/views|routes/providers*`):

```
M .opencode/agents/explore.md
M .opencode/agents/librarian.md
M .opencode/agents/metis.md
M .opencode/agents/momus.md
M .opencode/agents/multimodal-looker.md
M .opencode/agents/oracle.md
M docs/knowledge/troubleshooting/opencode-model-request-failure-classification.md
M src/admin/routes/providers.ts      # isOpenCodeV2 gate (~L313–330)
M src/admin/views/providers.tsx      # isOpenCodeV2 banner  (~L105–126)
M src/admin/views/providers.test.tsx # isOpenCodeV2 fixture
```

This design never edits them. Interface overlap with their `isOpenCodeV2` direction is noted explicitly in §8.

---

## 2. Target-State Data Flow

### 2.1 Flow diagram

```
Admin UI (agent-models page)                    Admin API (src/admin/routes/agent-models.ts)
  │  select model + variant(s) per agent         │  validate per B1 §4.5 (per-agent, not whole-file)
  │  POST/PUT /api/agent-models (+verify)        │  ┌────────────────────────────────────────┐
  └─────────────────────────────────────────────▶│  │ buildRoutingWriteCommand(agent,chain) │
                                                 │  │   jq --arg agent --argjson chain \     │
                                                 │  │   '.chains[$agent].chain = $chain' \  │
                                                 │  │   routing.json > tmp && mv tmp routing│
                                                 │  └───────────────┬────────────────────────┘
                                                                    │ transactional tmp→mv (1)
                                                                    ▼
                                                 ┌────────────────────────────────────────┐
                                                 │  ~/.config/opencode/routing.json (global) │
                                                 │  { version:1, defaults:{…}, chains:{…} }│
                                                 └───────────────┬────────────────────────┘
                                                                    │ file watcher (2)
                                                                    ▼
                                                 ┌────────────────────────────────────────┐
                                                 │  ~/.config/opencode/opencode.json      │
                                                 │  agent.<name>.model = chain[0].model   │
                                                 │  agent.<name>.variant = chain[0].var.  │
                                                 │  written per-agent via jq tmp→mv (3)   │
                                                 └───────────────┬────────────────────────┘
                                                                    │ restart ai-dev (4)
                                                                    ▼
                                              managed OpenCode 2.x (opencode serve)
                                                 /agent → reports assigned model
                                                 /provider → catalog for validation
                                                 session.prompt → routing plugin reads
                                                     routing.json chain + cursor
```

Also per-project: `.opencode/routing.json` (project-local) overrides global last-wins, same precedence as `opencode.json` per https://opencode.ai/docs/config — Admin writes global by default; project override is manual or a future `--project` flag.

### 2.2 Exact schema conformance (`trial/B1-ROUTING-SPEC.md:§4` — quote)

Implementer must not deviate — this is the downstream contract.

**Location & encoding (§4.1):** `<global> ~/.config/opencode/routing.json` OR `<project> .opencode/routing.json`, UTF-8 JSON, `$schema` optional. No `~/.omo/omo.jsonc`. Writes `tmp → mv`, never in-place. Validation errors are per-agent, not whole-file.

**Top-level (§4.2):**

```json
{
  "version": 1,
  "defaults": { "cooldownSeconds": 60, "maxFallbackAttempts": 3, "notifyOnFallback": false },
  "chains": { "<agentName>": { "chain": [ChainEntry,…], "cooldownSeconds":60, "maxFallbackAttempts":3 } }
}
```

Field table — `version: number(1)` required, must be `1`; unknown versions rejected with clear error. `defaults` optional `{}`, unknown keys inside ignored. `defaults.cooldownSeconds` `1..3600` default 60. `defaults.maxFallbackAttempts` `1..10` default 3. `defaults.notifyOnFallback` boolean default false. `chains: Record<string,AgentChain>` required, empty `chains:{}` valid (routing no-op). Unknown top-level keys besides `version/defaults/chains/$schema` ignored.

**AgentChain (§4.3):** `chain: ChainEntry[]` required `1 ≤ length ≤ 10`, ordered head=primary, empty=validation error for that agent, entries beyond 10 rejected (no truncate — fail loudly). Per-agent overrides `cooldownSeconds`/`maxFallbackAttempts`/`notifyOnFallback` inherit from `defaults`.

Agent-name keys: allowed set is the 12 native agents from `trial/CELL1.md:§2` **plus** V2 built-ins `build/plan/general/explore/scout/compaction/title/summary` — valid set `plan, prometheus, explore, oracle, librarian, multimodal-looker, metis, momus, sisyphus, hephaestus, atlas, sisyphus-junior, build, general, scout, compaction, title, summary` (case-sensitive lowercased). Unknown agent keys accepted but warned (forward-compat). Hyphenated names preserved verbatim (`multimodal-looker`, `sisyphus-junior`) — `jq` patches must use bracket notation `.chains["multimodal-looker"]`, never `.chains.multimodal-looker`.

**ChainEntry (§4.4):**

```ts
type ChainEntry = {
  model: string              // "provider/model-id", e.g. "opencode-go/kimi-k3"
  variant?: string           // "max"|"high"|"low"|"off"|"none"|"minimal"…
  reasoningEffort?: string
  textVerbosity?: string
  reasoningSummary?: string
  temperature?: number       // 0.0–2.0
  top_p?: number             // 0.0–1.0
  maxTokens?: number         // 1–200000
  thinking?: { type:"enabled"|"disabled"; budgetTokens?: number }
}
```

`model` must match `^[^/\s]+\/\S+$` — provider segment slash-free, model segment non-empty, may contain slashes (e.g. `nvidia/org/model`). `variant` unknown value accepted but warned. Numeric ranges out-of-range → reject field, use default, warn. Duplicate `provider/model` within chain allowed but warned (runtime no-op skip via `areRuntimeModelsEquivalent`). No `providers: string[]` multiplicity on MVP — each entry is single `provider/model`.

**Validation rules (§4.5 — 10 rules, enforce before `write tmp→mv`):**

1. `version` must be `1`; else reject whole file.
2. `chains` must be object; else reject whole file.
3. Per-agent `chain` must be array `1..10`; violation → reject that agent's chain only (record per-agent error), continue others.
4. Per-entry `model` must match pattern; violation → drop entry + per-agent error; if empty after drop, reject agent's chain.
5. `variant` unknown → accept but warn.
6. Numeric ranges out-of-range → reject field, use default, warn.
7. Duplicate `provider/model` within chain → allowed but warned.
8. Unknown agent keys → accept, warn.
9. Unknown top-level/defaults keys → ignore.
10. File-level JSON parse error → reject whole file, routing disabled, log, do not fall back to stale cache.

**Example (§4.6)** — normative parser validation target:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "version": 1,
  "defaults": { "cooldownSeconds": 60, "maxFallbackAttempts": 3, "notifyOnFallback": false },
  "chains": {
    "plan": { "chain": [
      { "model": "opencode-go/kimi-k3", "variant": "max" },
      { "model": "openai/gpt-5.6-sol", "variant": "high" },
      { "model": "openai/gpt-5.6-luna" }
    ]},
    "prometheus": { "chain": [
      { "model": "opencode-go/kimi-k3", "variant": "max" },
      { "model": "openai/gpt-5.6-sol", "variant": "high" },
      { "model": "openai/gpt-5.6-luna" }
    ], "maxFallbackAttempts": 5 },
    "sisyphus": { "chain": [
      { "model": "anthropic/claude-opus-5-5", "variant": "max" },
      { "model": "opencode-go/kimi-k3" },
      { "model": "opencode/big-pickle" }
    ], "cooldownSeconds": 30, "notifyOnFallback": true }
  }
}
```

### 2.3 Per-agent error isolation (quote §4.5 rules 3–4 + §4.7 checklist)

- A bad entry in `routing.json` must **not** invalidate every agent's chain, only the agent that owns the bad chain (Z1 non-repeat: `docs/knowledge/patterns/omo-fallback-model-config.md` — the V1 failure was whole-config rejection at model resolution, not migration validation).
- Implementation: Admin's batch endpoint validates each `{agent, chain}` independently, collects `perAgentErrors: Record<agent, string[]>`, writes only agents that pass, and returns `results` with per-agent `status` (`write_failed` for the bad agent, success for others). This replaces the single `&&`-chained OMO jq write which was all-or-nothing.
- At runtime, the thin routing plugin likewise isolates: `ChainEntry` with unparseable `model` invalidates only that agent's `chain` (`getFallbackChain(agent) → null`), other agents remain operable.

### 2.4 Transactional `tmp→mv` writes (quote §4.1 + §4.7)

- **Never** write `routing.json` in-place. Pattern: `tmp="$(mktemp "${routing}.tmp.XXXXXX")"` → `jq … "$routing" > "$tmp" 2>/dev/null` → `chmod 600 "$tmp"` → `mv "$tmp" "$routing"` (atomic rename — POSIX guarantees visibility as whole-file). On failure: `rm -f "$tmp"; exit`.
- **Also for `opencode.json` native agent writes (§2.1 step 3):** same `tmp→mv` (`${op}.native-agent-chain.tmp` or `${op}.tmp.$$`). Do not reuse the `*.native-agent-overrides.tmp` name after the old function is deleted, to avoid stale-file confusion.
- **No partial-file state:** a crash mid-write leaves either the old valid file or the new valid file, never a truncated half. This is the same guarantee `entrypoint.d/lib-native-agent-overrides.bash:29–35` gave (`> "$temporary_file" 2>/dev/null && mv`), replicated for both targets.

### 2.5 Hyphenated-name verbatim rule

`.agents["multimodal-looker"]` bracket notation must be used for every `jq` expression that indexes by agent name (B1 §4.3, CELL1 §2, `lib-native-agent-overrides.bash` caveat). Bare `.chains.multimodal-looker` is a parse error (dot + hyphen interpreted as subtraction). This applies to both `routing.json` and `opencode.json` patches.

---

## 3. Native Write Path — `agent.*` Model/Variant + `routing.json` Chain

### 3.1 The two files written

| File | Purpose | Written by | When |
|------|---------|-----------|------|
| `~/.config/opencode/routing.json` (global) or `.opencode/routing.json` (per-project) | Ordered chain per agent `chains[agent].chain[]` (B1 §4.2–4.4) | Admin API `PUT /api/agent-models` / `PUT /api/agent-models/:agent` + `scripts/migrate-omo-to-native.sh` one-shot | Every Admin apply; startup reconcile does **not** write chains unless healing an unreachable head |
| `~/.config/opencode/opencode.json` `agent.<name>.model` + `agent.<name>.variant` | Single-pin primary for OpenCode file-agents — the head of the chain (`chain[0]`) promoted for native startup without the routing plugin | Admin API same batch (step 3 in §2.1); reconciliation does not need a separate `merge_native_agent_overrides` — the chain head is written directly | Every Admin apply (primary only); fallbacks live only in `routing.json` |

The routing plugin at runtime reads `routing.json` for the full chain and `opencode.json` `agent.*` for the primary when no chain is present (fallback to single pin).

### 3.2 `buildRoutingWriteCommand` (replaces `buildJqWriteCommand`)

New helper `src/admin/lib/routing-config.ts` (or `agent-model-config.ts` v2 branch — see §8):

```ts
export function buildRoutingWriteCommand(
  agent: string,
  chain: readonly ChainEntry[],
  routingPath: string,
  opencodePath: string,
): string {
  // shellQuote + jq bracket-notation; transactional tmp→mv for BOTH files
}
```

Generated shell (example for `plan` with 2-entry chain):

```bash
jq --arg agent 'plan' --argjson chain '[{"model":"opencode-go/kimi-k3","variant":"max"},{"model":"openai/gpt-5.6-sol","variant":"high"}]' \
  '.chains[$agent].chain = $chain' ~/.config/opencode/routing.json > /tmp/routing.json.tmp && \
  mv /tmp/routing.json.tmp ~/.config/opencode/routing.json && \
jq --arg agent 'plan' --arg model 'opencode-go/kimi-k3' --arg variant 'max' \
  '.agent[$agent].model = $model | .agent[$agent].variant = $variant' \
  ~/.config/opencode/opencode.json > /tmp/opencode.json.tmp && \
  mv /tmp/opencode.json.tmp ~/.config/opencode/opencode.json
```

Clear path (`chain.length === 0`): `del(.chains[$agent])` + `del(.agent[$agent])`.

Batch chains `N` agents with `&&` between per-agent pairs, but **per-agent errors do not abort later agents** — each pair reports its own exit code and collects errors; the batch `results` map records per-agent success/failure (per-agent isolation §2.3). Implementation: per-agent `jq` calls are separate `deps.exec` segments or a single script that traps per-agent exit codes, not a single `&&`-collapsed line where one `jq` failure kills the rest.

### 3.3 Snapshot/rollback scope

- **Snapshot:** `cat routing.json > $snapshot.routing` plus `cat opencode.json > $snapshot.opencode` (two files, two snapshots, or one combined tar). Minimal: snapshot `routing.json` only; `opencode.json` rollback is to re-apply the previous head — but snapshotting both is cleaner.
- **Rollback:** on any `jq` failure, `native write failure`, or verification `probe_failed` / `runtime_mismatch` (same policy as current `applyAndVerifyBatch` line 323–347), restore both files from snapshots (`cat $snapshot > target.tmp && mv target.tmp target && rm -f $snapshot`) and re-`restartAiDev`.
- **Timeout:** keep `180s readiness / 300s inference` deadlines and `timedOut` flag unchanged.

### 3.4 Restart + verification unchanged (reuse)

- `restart = deps.restart()` (Docker `restartManagedOpenCode` → container recreate) stays.
- `verifyAppliedAgent` loop stays but verification target is now `routing.json chain[0]` (not `omo.jsonc model`) vs `/agent` resolved model — same comparison (`configuredActual === configured`).
- Quota caching (`quotaModels` dedup, `probeModel` cache, `fetchProviderSnapshot` connected set) stays.

### 3.5 Z1 non-repeat proof

Current V1 `buildJqWriteCommand` does `del(.agents[$agent].models, .agents[$agent].fallback_models)` — this *prevented* Z1 by deleting the poison keys. Native path proves non-repeat differently:

- `routing.json` has no `fallback_models` key at all — schema §4.4 `ChainEntry` is `model/variant/...` only, no `fallback_models` alias.
- Per-agent error isolation (§2.3) means a malformed `chain` for agent `plan` (e.g. bad `model` pattern) is dropped for that agent only; `chains["sisyphus"]` remains operable. V1's whole-config rejection at resolution is structurally impossible because resolution reads per-agent chains, not a single `agents` blob where one bad key poisons others.
- `opencode.json` `agent.*` entries are independent keys — a bad `agent.plan.model` never affects `agent.sisyphus.model`.

Document this proof in the implementer's PR description; add `docs/knowledge/patterns/routing-per-agent-isolation.md` as the forward pointer.

---

## 4. C4 Preservation — `general`/`plan` → OpenChamber `resolveDefaultSelection`

### 4.1 What V1 did

On V1, `entrypoint.d/lib-native-agent-overrides.bash:3–36` `merge_native_agent_overrides($opencode, $omo)` ran at startup (`02-init-config.sh:386`) and inside `reconcile-agent-models.sh:sync_native_overrides` after every reconciler run. It did:

```bash
jq -s '.[0] as $opencode | .[1] as $omo |
  reduce ["general","plan"][] as $name ($opencode;
    ($omo.agents[$name] // {}) as $override |
    if (($override.model | type)=="string" and test("^[^/[:space:]]+/[^[:space:]]+$")) then
      .agent = (.agent//{}) | .agent[$name].model = $override.model |
      if (($override.variant|type)=="string" and length>0) then .agent[$name].variant=$override.variant
      else del(.agent[$name].variant) end
    else del(.agent[$name]) end
  )' "$opencode" "$omo" > "$tmp" && mv "$tmp" "$opencode"
```

OpenChamber's `resolveDefaultSelection` (client-side) then read `opencode.json: .agent[general] ?? .agent[plan] ?? settings.defaultModel` to seed the new-session model picker — so `general`/`plan` overrides set via Admin propagated to the default model of fresh OpenChamber sessions.

`lib-openchamber-settings.bash:ensure_openchamber_default_settings` also backfilled `settings.json: defaultModel = "opencode/big-pickle"` as a fallback when no agent pin existed — this is **not** the C4 path (it is the `general`/`plan`-absent fallback), but it must stay because it seeds the first-boot default.

### 4.2 What V2 must do (read path replacement)

`merge_native_agent_overrides` goes away with OMO. The replacement is the **direct native write** in §3.2 — Admin already writes `agent.<name>.model/variant` for the chain head into `opencode.json` (§2.1 step 3), so no startup merge is needed. The exact read paths become:

| Reader | Old path | New path |
|--------|----------|----------|
| Admin startup `02-init-config.sh` | `merge_native_agent_overrides $OPCODE $OMO` after OMO lifecycle | **No startup merge.** `opencode.json` `agent.*` is already authoritative from the last Admin apply; startup leaves it untouched. If a chain's head was changed via manual `routing.json` edit, the next Admin read will show the drift — a future "sync native head from routing" button can be added but is not MVP. |
| Reconciler `reconcile-agent-models.sh:sync_native_overrides` | Sourced `lib-native-agent-overrides.bash`, called `merge_native_agent_overrides "$op" "$omo"` | **Delete `sync_native_overrides` function entirely.** The reconciler already writes `routing.json` + `opencode.json` via `buildRoutingWriteCommand`; no post-reconcile sync needed. |
| OpenChamber `resolveDefaultSelection` (client JS, not server) | `opencode.json: .agent["general"].model` (written by merge) else `.agent["plan"].model` | **Same JSON path, different writer.** `resolveDefaultSelection` reads `opencode.json: .agent[general].model` and `.agent[plan].model` exactly as before — but the writer is now Admin's direct `agent.*` patch ( §3.2 ), not the merge. No code change in OpenChamber; prove by reading `openchamber-web` `resolveDefaultSelection` source and noting it never read `~/.omo/omo.jsonc` directly — it always read `opencode.json`. |
| `ensure_openchamber_default_settings` fallback | `settings.json: defaultModel = "opencode/big-pickle"` when absent | **Keep.** When no `agent.general/plan` pin exists (fresh v2 install before first Admin set), this still seeds `"opencode/big-pickle"` as the OpenChamber default. On v2 line the value could be updated to the routing default chain head if desired, but `big-pickle` is safe to keep. |

**Preservation proof for reviewer:**

1. `resolveDefaultSelection` must keep returning `general.model` → `plan.model` → `settings.defaultModel` in that order on v2 — verify by checking `opencode.json` after one Admin apply (`PUT /api/agent-models {"changes":[{"agent":"plan","chain":[{"model":"opencode-go/kimi-k3","variant":"max"}]}]}`) and confirming `jq '.agent.plan.model'` equals the chain head.
2. No `merge_native_agent_overrides` call remains on v2 line — `grep -r merge_native_agent_overrides` on v2 must return 0 hits (or only in archived V1 docs).
3. Startup log on v2 must not contain `Native agent overrides skipped` warnings — those came from the deleted merge.

---

## 5. C9 API Compatibility — Four Endpoints

### 5.1 Contract table

| Endpoint | Method | Request shape (today) | Response shape (today) | V2 shape | Breaking? | Migration note |
|----------|--------|----------------------|------------------------|----------|-----------|----------------|
| `GET /api/agent-models` | GET | — | `{agents, catalog, providers, hasPassword, catalogAvailable, historyTruncated?, historyWarning?}` | **Same.** `agents[].configured` entries now carry `ChainEntry` (still `{model, variant?}` plus future passthrough — see below). No field removed. | **No** — additive: `chain.length` visible as `configured.length` (same array). Consumers that assumed `configured.length ≤1` must tolerate `>1` but still read `configured[0]` as primary. |
| `PUT /api/agent-models` | PUT (batch) | `{changes: {agent, entries: {model, variant?}[]}[], verification?: readiness|inference}` | `{results: Record<agent, ApplyResult>}` | **Expand `entries` to `chain` (or keep both).** Recommended: accept `{agent, chain: ChainEntry[]}` and keep `{agent, entries: ChainEntry[]}` as alias for one release (check both, prefer `chain`). Validation: `entries.length` previously `≤1` → now `1..10` per chain. Return `results` unchanged. | **Soft break if consumers send `entries` with `>1` items and old server rejects `>1` as `entries must be at most one`** — on v2 they will succeed. Consumers that validated `entries.length ≤1` client-side must relax. No wire break if both names accepted. Document `entries` → `chain` rename with alias window. |
| `PUT /api/agent-models/:agent` | PUT (single) | `{entries: {model, variant?}[], verification?}` | `ApplyResult` (`{ok, status, resolved, requestVerified, error?, warning?}`) | **Same expansion** — accept `chain` alias, validate `1..10`. Return `ApplyResult` unchanged. | **Soft break** as above. Center-agent `agent-models.set` command (see §5.2) also moves to chain. |
| `POST /api/agent-models/verify` | POST | `{agents?: string[], verification?: readiness|inference}` | `{verification, results: Record<agent, {model, status, reason?, verification}>, summary}` | **Same.** Verification still probes `chain[0].model` per agent. No shape change. | **No.** |
| `POST /api/agent-models/suggestions` | POST | `{providers?: string[], mode?: free|economy|performance}` | `{suggestions: Record<agent, …>, providers, mode, sourceStatus, …}` | **Same.** | **No.** |
| `GET /api/agent-models/verify-model` | GET | `?model=provider/id` | `ProbeResult` | **Same.** | **No.** |
| `GET /agent-models` (HTML) | GET | — | HTML | **Same.** | **No.** |

### 5.2 Center-agent compatibility

`src/admin/agent/commands.ts:345–361` `parseAgentModelSet(payload)` expects `payload.entries` (array) and validates via `validateFallbackModels`. On v2 line:

- Accept both `payload.entries` and `payload.chain` (alias), normalize to `chain`, validate with expanded `1..10` rule.
- Keep `agent` pattern `^[a-z0-9][a-z0-9-]*$` — already handles hyphenated names verbatim.
- `dispatchAgentModelSet` result shape (`ApplyResult`) unchanged — center `agent-models.set` ACK payload identical.

### 5.3 UI behavior note

`src/admin/views/agent-models.tsx` already renders `configured[0]` as "Configured model" and shows `effectiveness` vs `resolved`/`requestVerified`. On v2, `configured.length` could be `>1` (chain depth) — UI should show `primary (chain 3)` or similar, but old UI that reads `configured[0]` still works. No breaking JS API — `window.agentModelsState` JSON keeps same keys.

---

## 6. Reconcile Flow Redesign

### 6.1 What stays (connected-catalog health probing)

- **Probing pipeline** `src/admin/lib/model-probe.ts:probeModel` — `buildProbeScript` creates throwaway `POST /session` + `POST /session/{id}/prompt_async` with `{"model":{"providerID","modelID"}}`, polls `session/status` + `message`, classifies `healthy/retired/wrong_endpoint/unavailable/retryable/unreachable/mismatch/quota_exceeded/timeout/aborted`, caches in `~/.cache/openchamber/agent-model-health.json` with `retryAfter` TTLs. **Keep entire file as-is** — provider availability detection is independent of OMO.
- **Polling shell** `scripts/reconcile-agent-models.sh:wait_for_provider` / `wait_for_lifecycle` — polls `managed-opencode *.json` → `/provider` + `/global/health` via `curl -H "Authorization: Basic $auth"` for `PROVIDER_WAIT_SECONDS=120`. **Keep as-is**, only remove the `sync_native_overrides` call at lines 104/121.
- **Deferral + lock** `src/admin/lib/agent-model-reconciler.ts:349–363` `withLock` via `agent-model-reconcile.lock` directory, `pending` queuing, `reconcileAll` loop. **Keep.**
- **Capability catalog** `fetchCapabilityCatalog` / `capabilityScore` / `suggestForMode` / `metadata` freshness. **Keep.**

### 6.2 What goes (OMO-catalog dependency)

- **`readAgentModelsConfig()` on `~/.omo/omo.jsonc`** — line 184 `const config = await lib.readAgentModelsConfig()` reads OMO `agents`. Replace with `readRoutingConfig()` (`~/.config/opencode/routing.json`).
- **`sync_native_overrides`** — lines 13–26 definition + lines 104/121 call sites. **Delete.**
- **`toConfiguredEntries` fallback_models/models merging** — gone; chains are explicit `ChainEntry[]`.
- **`OMO_CONFIG_DIR` volume read in reconciler** — no longer touched.

### 6.3 What replaces it — routing-aware healing

**New `src/admin/lib/routing-config.ts` (or extend `agent-model-config.ts:routing`):**

- `ROUTE_CONFIG_PATH = "~/.config/opencode/routing.json"` (global) constant.
- `validateRoutingConfig(json): { ok, errors: PerAgentError[], config: RoutingConfig }` implementing B1 §4.5 per-agent isolation.
- `parseRoutingConfig(stdout): RoutingConfig` plus `readRoutingConfig(): Promise<RoutingConfig>` via `deps.exec`.
- `buildRoutingWriteCommand(...)` (§3.2).

**New reconciler loop (`src/admin/lib/agent-model-reconciler.ts:runOnce` v2 branch):**

```ts
// pseudocode — what the implementer codes
const password = lib.getServerPassword(); if (!password) return noOp;
const routing = await readRoutingConfig();               // was readAgentModelsConfig()
const [snapshot, state] = await Promise.all([
  lib.fetchProviderSnapshot(password),                     // connected catalog — stays
  namesAndResolved(password, routing),                     // was namesAndResolved(..., config)
]);
// pruneStaleProbeCache unchanged, capabilities unchanged
for (const agent of state.names) {
  const chain = routing.chains[agent]?.chain ?? [];
  const head = chain[0];
  const resolved = state.resolved.get(agent);
  // 1) if chain empty and resolved healthy → keep (no desire to invent a chain)
  // 2) if head exists and !connected.has(head.provider) or probe(head) ∈ {unavailable, retired, wrong_endpoint} → find replacement via sortedCandidates → desired = [replacement] (or heal tail: [replacement, …fallbacks])
  // 3) if head probe ∈ {healthy} or retryable → keep head
  // 4) independent per-agent; failure of one agent never skips another
}
await routingLib.applyAndVerifyBatch(changed, "inference"); // now targets routing+opencode
```

Key differences from OMO reconciler:

- **Healing is per-agent chain head only** — tail fallbacks preserved; only the head is replaced if unreachable. This matches B1 semantics: the chain is ordered and only the primary matters for proactive routing.
- **No `fallback_models`/`models` deletion** — native chains have no poison key.
- **No `sync_native_overrides` post-step** — the `opencode.json` head is written as part of the batch itself (`§3.2` second `jq`).
- **Catalog-empty handling** (`§4.1` — catalog EMPTY at setup): if `snapshot.connectedProviders` is empty, `runOnce` skips healing (no connected set to gate against), same as OMO path. The routing plugin's file-cache async population warning applies identically.

**`scripts/reconcile-agent-models.sh` changes:**

- Lines 11–26 `sync_native_overrides()` definition **deleted**.
- Lines 98–104 `if … bun run …; then sync_native_overrides; return 0` → `if … bun run …; then return 0`.
- Lines 120–121 same removal in background deferred retry block.
- All other logic (lock rm, lifecycle wait, provider wait, 3-attempt retry, 60s background retry) kept.

---

## 7. One-Shot User Migration — `omo-config` Volume → Native

### 7.1 Goal

Forward-only, one-shot migration of user model choices persisted in the `omo-config` volume (`~/.omo/omo.jsonc: agents.<name>.model + .variant`) into native `routing.json` + `opencode.json` `agent.*`. After migration, the `omo-config` volume is inert (no reads) and may be pruned.

### 7.2 When it runs

- **Trigger:** first `ai-dev` boot on v2 line where `~/.omo/omo.jsonc` exists and `~/.config/opencode/routing.json` does not yet exist (or is empty `chains:{}`). Gate: `[ -f ~/.omo/omo.jsonc ] && [ ! -f ~/.config/opencode/routing.json ]` (or `jq -e '.chains | length > 0' routing.json` fails).
- **Location:** new script `scripts/migrate-omo-to-native.sh` (invoked from `entrypoint.d/02-init-config.sh` inside an `if [ "${OMO_ENABLED:-1}" = "0" ]` branch, before `merge_project_lsp_config`). Alternative: run once from Admin migration endpoint — but entrypoint is simpler (runs before OpenCode starts, so routing file is ready for the first `opencode serve`).
- **Idempotency:** if `routing.json` already exists with `chains` non-empty, migration is skipped (forward-only). Re-running on a migrated host is a no-op.

### 7.3 What it migrates

- For each agent where `omo.jsonc: agents.<name>.model` is a valid `provider/model` string (`test("^[^/[:space:]]+/[^[:space:]]+$")`), emit a chain with single entry `{model, variant?}` (variant only if non-empty string and in `VARIANTS` — else omit). Example:

  ```bash
  jq -s '.[0] as $omo |
    { version:1, defaults:{cooldownSeconds:60,maxFallbackAttempts:3,notifyOnFallback:false},
      chains: ( reduce ($omo.agents | to_entries[]) as $e ({}; 
        if ($e.value.model | type)=="string" and ($e.value.model|test("^[^/[:space:]]+/[^[:space:]]+$"))
        then .[$e.key] = { chain: [ {model:$e.value.model} + (if ($e.value.variant|type)=="string" and ($e.value.variant|length)>0 then {variant:$e.value.variant} else {} end) ] }
        else . end
      ))
    }' ~/.omo/omo.jsonc ~/.config/opencode/routing.json.tmp
  ```

  Then `mv tmp → routing.json` (transactional).
- **Do not migrate** `models[]` / `fallback_models` chains — those keys are the Z1 poison surface and are intentionally dropped. Only the single `model` pin is migrated; users who manually edited `models[]` in `omo.jsonc` will need to re-configure chains via Admin (document as known limitation — such manual chains were never honored on V1 anyway per KB pattern).
- **Do not migrate** `permission`/`tools` — those are OMO tool restrictions, now represented by `.opencode/agents/*.md` `permission:` (CELL1). Migration is model-only.
- **Also seed `opencode.json` heads:** for each migrated agent, emit `jq '.agent[$agent].model = $head.model | if $head.variant then .agent[$agent].variant=$head.variant else del(.agent[$agent].variant) end'` into `opencode.json` (same `tmp→mv`).

### 7.4 Agents covered

All 12 native agents from `trial/CELL1.md:§2`. In practice only agents with a persisted `model` in `omo.jsonc` appear — typically `plan`, `prometheus`, `explore`, `librarian`, etc. where users changed models. But migration enumerates **all** `agents` keys in `omo.jsonc` (not just `general/plan`) — the old `merge_native_agent_overrides` only synced `general`/`plan`, but migration should preserve every user's override, else their chain choices for `sisyphus` etc. would be silently dropped even though they were persisted (just not applied natively).

### 7.5 Failure semantics

| Failure | Behavior |
|---------|----------|
| `~/.omo/omo.jsonc` missing or invalid JSON | Skip migration, log `no OMO config to migrate`, continue boot — fresh v2 install has no history to carry. |
| `routing.json` already exists with chains | Skip migration, log `routing already present, skipping migration`. |
| `jq` write fails (bad model pattern, disk full) | Abort migration, keep `routing.json` absent, log error, continue boot — Admin UI will show empty chains; user can set them manually. Do not block container startup. |
| `opencode.json` write fails | Log error, but `routing.json` already written — Admin will reconcile heads on next apply. Continue boot. |
| `omo.jsonc` contains `fallback_models`/`models` chains | Ignore them (do not migrate) — they were never effective on V1 (Z1). Document in migration log `ignored OMO chain keys for <agent>`. |
| Post-migration `omo-config` volume | Left mounted but unused on v2 line; migration log prints `OMO volume retained for rollback; prune with docker volume rm omo-config-v2 after verifying routing`. No automatic deletion. |

### 7.6 Forward-only, no compat layer

- No read fallback that re-checks `omo.jsonc` if `routing.json` is missing after migration — after migration, `omo.jsonc` is never consulted again.
- No downgrade path (`routing.json` → `omo.jsonc`) built — documented as one-way (DECISIONS.md D2 already notes no downgrade, forward-only).
- V1 branch (`main`, `OMO_ENABLED=1`) never invokes this script — gated by `OMO_ENABLED=0` check, so V1 behavior untouched.

---

## 8. File-by-File Change List (Future Implementer Execution Order)

**Ordering rationale:** types → config helpers → lib (read/write/verify) → reconciler → routes → entrypoints → migration → docs → tests.

| Order | File | Action | Estimated size | Shared-code gating note |
|-------|------|--------|---------------|------------------------|
| 1 | `src/admin/lib/agent-model-types.ts` | **Modify** — delete `OMO_CONFIG` const (or keep for V1 via `#if OMO_ENABLED`), add `ROUTING_CONFIG = "~/.config/opencode/routing.json"`, `OPENCODE_JSON = "~/.config/opencode/opencode.json"`, add `ChainEntry` / `RoutingConfig` / `AgentChain` / `PerAgentError` types per B1 §4. Expand `CONFIGURABLE_NATIVE_AGENTS` to 12 native names, gated with runtime flag `isV2 = process.env.OMO_ENABLED === "0" \|\| isOpenCodeV2()` (reuse Providers' `isOpenCodeV2` probe pattern). Keep `VARIANTS`. | ~60 lines | **Flag-gated:** V1 retains old constants via conditional; imports unchanged. |
| 2 | `src/admin/lib/agent-model-config.ts` | **Modify** — keep `validateFallbackModels` for V1 compat (unused on v2), add `validateChainEntry` + `validateAgentChain` + `validateRoutingConfig` per B1 §4.5 (per-agent isolation). Add `buildRoutingWriteCommand` (replaces `buildJqWriteCommand` on v2 path; old function kept for V1). Add `parseRoutingConfig` (replaces `parseAgentModelsConfig` on v2). Keep `displayNameToKey` + `isRecord` unchanged. | ~120 lines | **Flag-gated:** new functions are v2-only; old functions kept for V1. Dispatch in lib chooses branch. |
| 3 | `src/admin/lib/agent-models.ts` | **Major modify** — replace `readAgentModelsConfig` → `readRoutingConfig` (branch), `writeAgentFallbackModels` → `writeAgentChain`, `snapshotAgentModelsConfig`/`restoreAgentModelsConfig` → `snapshotRoutingConfig`/`restoreRoutingConfig` (two-file version), **delete** `syncNativeAgentOverrides` (or gate as no-op on v2), rewrite `applyAndVerifyBatch` write phase to B1 per-agent isolation + dual-file `tmp→mv`, update `collectAgentModelState` to read `routing.json` chains (map `ChainEntry[]` to `configured`), expand `CONFIGURABLE_NATIVE_AGENTS` set to 12 on v2, adjust `source`/`effectiveness` mapping for chain depth. Keep `verifyAppliedAgent`, `probeModel`/`fetchProviderSnapshot` integration. | ~180 lines net | **Flag-gated at lib entry:** `if (isV2) { routing path } else { omo path }` keeps V1 behavior identical. No shared-code mutation that alters V1. |
| 4 | `src/admin/lib/agent-model-reconciler.ts` | **Modify** — `readAgentModelsConfig` → `readRoutingConfig`, `sync_native` removed, `runOnce` healing tailors chain head via `sortedCandidates` against `routing.json` (see §6.3). Keep `MAX_PROBES=12`, `withLock`, `fetchCapabilityCatalog`, `pruneStaleProbeCache` unchanged. | ~90 lines | Flag-gated similarly; V1 path untouched. |
| 5 | `src/admin/routes/agent-models.ts` | **Modify** — add `chain`/`entries` alias handling, relax `validateFallbackModels` length check to `1..10` on v2, per-agent catalog + `probeModel` gates (per-agent, not whole-batch), `collectAgentModelState` source change propagates automatically. Keep `POST /verify` / `GET /verify-model` as-is. | ~80 lines | Flag-gated validation; response shape unchanged (C9). |
| 6 | `src/admin/agent/commands.ts` | **Modify** — `parseAgentModelSet` → chain validation (`1..10`), `dispatchAgentModelSet` → routing writes, `readAgentModelsState` source change via deps wiring; `createRealCommandDeps` wires v2 lib when `OMO_ENABLED=0`. | ~60 lines | Flag-gated; protocol types `APPLY`/`LIST` unchanged. |
| 7 | `src/admin/lib/agent-model-live.ts` | **No change** — `/agent` + `/provider` probes are native. | 0 | — |
| 8 | `src/admin/lib/model-probe.ts` | **No change.** | 0 | — |
| 9 | `entrypoint.d/lib-native-agent-overrides.bash` | **Delete file on v2 line** (remove from git on v2 branch; keep in `main` history). | −36 lines | Delete-on-v2-line — V1 line retains it. |
| 10 | `entrypoint.d/02-init-config.sh` | **Modify** — gate `DEFAULT_OMO_CONFIG`/`OMO_CONFIG_DIR`/`OMO_CONFIG_FILE` definitions behind `OMO_ENABLED!=0`, delete `source lib-native-agent-overrides.bash` + `merge_native_agent_overrides` invocation on v2 line, add call to `scripts/migrate-omo-to-native.sh` inside `OMO_ENABLED=0` block. Keep `ensure_openchamber_default_settings` + `merge_project_lsp_config` unconditionally. | ~20 lines | V1 `else` path untouched. |
| 11 | `entrypoint.d/00-fix-perms.sh` | **Minor modify** — gate `fix_perms "$HOME"/.omo` behind `OMO_ENABLED!=0`, or leave safe (already `[ -e ]` guarded) but add comment. | ~3 lines | No V1 change. |
| 12 | `entrypoint.d/lib-omo-model-defaults.bash` | **No change on v2 line** (inert, not sourced when `OMO_ENABLED=0`). Optionally add header comment `V1 only`. | 0 | Keep file for V1. |
| 13 | `entrypoint.d/lib-openchamber-settings.bash` | **No change.** | 0 | Keep as-is. |
| 14 | `scripts/reconcile-agent-models.sh` | **Modify** — delete `sync_native_overrides` definition (lines 13–26) + call sites lines 104/121. Keep waits + retry + background defer. | −26 lines | — |
| 15 | `scripts/migrate-omo-to-native.sh` | **New file** — one-shot `omo→routing` migration per §7, `chmod +x`, `jq` with bracket-notation + `tmp→mv`. | ~90 lines | New, v2-only. |
| 16 | `src/admin/views/agent-models.tsx` | **Minor modify** (future, optional polish) — render chain depth (`configured.length` fallback count), show per-agent `PerAgentError` banner. Not required for MVP (old UI still works via `configured[0]`). | ~40 lines if done | Additive; no V1 break. |
| 17 | `docker-compose.v2.yml` | **Verify** — `omo-config-v2` volume already distinct; no change unless migration needs a new volume (it uses `opencode-config` + workspace, not a new volume). | 0 | — |
| 18 | `docker-compose.yml` / `docker-compose.dev.yml` | **No change on v2 line** (V1 volumes untouched). On v2 compose the omitted mount already handles it. | 0 | — |
| 19 | `.opencode/omo.jsonc.default` | **Gate on v2 line** — do not bake into v2 image (or bake but inert). | 0 | Build arg `OMO_ENABLED` could conditionally `COPY`. Simpler: keep file in repo, gate entrypoint install. |
| 20 | `docs/knowledge/patterns/omo-fallback-model-config.md` | **No change** — historical record. | 0 | — |
| 21 | `docs/knowledge/patterns/routing-per-agent-isolation.md` | **New KB entry** — documents native per-agent isolation proof, Z1 non-repeat, bracket-notation rule, tmp→mv discipline. | ~70 lines | New. |
| 22 | `openspec/specs/omo-config-persistence/spec.md` + `omo-unified-config/spec.md` | **No edits now** — add supersede notes to design only; future spec files `routing-config-persistence/spec.md` + `native-agent-config/spec.md` will supersede them (design labels them superseded, does not patch them). | 0 | — |

**Order for implementer:** 1→2→3 (types/config/lib are the spine), then 4→5→6 (consumers), then 7–14 (entrypoints/scripts), then 15 (migration), then polish 16/21. Tests ( §10 ) run after 1–6.

**Interface overlap with sibling's `isOpenCodeV2` work (read-only, not edited):**

- `src/admin/routes/providers.ts:316` `const isOpenCodeV2 = /(?:^|\s)v?2\.\d+\.\d+\b/.test(runtime.stdout)` — they gate Providers page to a "Temporarily unsupported" banner on v2.
- `src/admin/views/providers.tsx:114` `if (isOpenCodeV2) return <banner>`.
- This design **reuses that same signal** for agent-models: the implementer should probe `opencode --version` identically (or share a helper `src/admin/lib/opencode-version.ts:isOpenCodeV2()`) and branch `CONFIGURABLE_NATIVE_AGENTS` + `validate*` + `read*` accordingly. Do not duplicate the regex — import a shared helper. Note overlap in the document so the second merger resolves the shared `isOpenCodeV2` helper without conflict.

---

## 9. `$schema`, `OMO_CONFIG_DIR`, `00-fix-perms`, Tests, Specs — Explicit Dispositions

### `$schema` sync pipeline

- **Today:** `.opencode/omo.jsonc.default` carries `$schema: https://raw.githubusercontent.com/code-yeongyu/oh-my-openagent/v4.19.4/assets/omo.schema.json`, pinned to `OH_MY_OPENAGENT_VERSION=4.19.4` in `Dockerfile` + entrypoint `normalize_omo_plugin_versions`. `check-versions.sh` verifies the pin.
- **On v2 line:** **Deleted.** No `$schema` sync for `routing.json` until a schema registry exists (B1 §4.1 notes `$schema` optional, no registry yet). The `$schema` key, if present in `routing.json`, is tolerated as an unknown top-level key (ignored per §4.5 rule 9) — not validated. Future schema sync could publish `https://opencode.ai/config/routing.json` but is not MVP. `OH_MY_OPENAGENT_VERSION` pin disappears from `Dockerfile` on v2 line (D1 consequence).

### `OMO_CONFIG_DIR` volume

- **Today:** named volumes `omo-config` (`docker-compose.yml:14,65`) and `omo-config-dev` (`docker-compose.dev.yml:22,98`) mounted at `/home/devuser/.omo`.
- **On v2 line:** **Not mounted** — `docker-compose.v2.yml:40` already mounts `omo-config-v2` as a disposable v2 volume, but after one-shot migration the `~/.omo` path is never read again. The volume becomes orphaned; document `docker volume rm omo-config-v2` as optional post-verification pruning. No new `routing-config` volume needed — `routing.json` lives in the existing `opencode-config` volume (`~/.config/opencode`) + per-project workspace.

### `00-fix-perms.sh` `~/.omo` line (line 19)

- **Today:** `fix_perms "$HOME"/.omo` ensures `devuser` ownership for OMO migration lock.
- **On v2 line:** **Gate-off or delete** — `if [ "${OMO_ENABLED:-1}" != "0" ]; then fix_perms "$HOME"/.omo; fi`. Leaving it is harmless (the function `[ -e "$path" ]` guards) but wasteful; delete for cleanliness once V1 is archived.

### Tests — rewrite vs retire per test

| Test | Rewrite or retire | Rationale |
|------|-------------------|-----------|
| `test/test-agent-model-e2e.sh` | **Rewrite → `test/test-routing-e2e.sh`** | New E2E proves `routing.json` chain set → restart → `/agent` resolved + `/session` child prompt model. Keep old file for V1. |
| `test/test-omo-config-normalization.sh` | **Retire on v2 line** | No OMO file to normalize. File stays for V1. |
| `test/test-native-agent-overrides.sh` | **Retire on v2 line** | Function deleted. Superseded by `test/test-routing-writes.sh`. |
| `test/test-agent-model-reconcile.sh` | **Rewrite → `test/test-routing-reconcile.sh`** | New reconciler heals routing chains, not OMO. |
| `test/test-agent-model-health*` + `test-agent-model-policy.sh` | **Keep** | Probing is unchanged. |

### Specs — supersede notes, not edits

- `openspec/specs/omo-config-persistence/spec.md` — superseded on v2 line by `routing-config-persistence` (new spec to author in Phase B, not this design).
- `openspec/specs/omo-unified-config/spec.md` — superseded on v2 line by `native-agent-config` + `routing-config` (new specs).
- This design **does not edit** spec files — it only states supersede notes above for the future implementer to act on.

---

## 10. Verification Plan — Split (No-Key vs Live-Key)

### 10.1 No-key checks (CI-able without provider credentials)

Schema validation, jq/write unit behavior, API shape tests — all runnable offline.

| # | Check | Command / assertion | Pass criterion |
|---|-------|--------------------|----------------|
| 1 | Routing schema validates | `jq -e '.version==1 and (.chains|type=="object")' ~/.config/opencode/routing.json` + per-agent `chain.length 1..10` + `model` regex `^[^/[:space:]]+/\S+$` | Exit 0 on golden example §4.6; exit non-zero on injected bad model (`no-slash`, whitespace) |
| 2 | `tmp→mv` atomicity | `grep -n 'mktemp.*routing.*tmp.*&&.*mv' src/admin/lib/agent-models.ts` + `entrypoint log` contains `routing.json` write without truncated half | File always parseable as JSON after kill during write (chaos test) |
| 3 | Per-agent error isolation | Seed `routing.json` with 2 agents: `plan` valid chain, `bad` invalid (`model:"nope"`); `PUT /api/agent-models` with both; assert `results.plan.ok==true` and `results.bad.ok==false` and `plan` chain persisted while `bad` rolled back | No whole-file rejection |
| 4 | Hyphenated-name verbatim | `jq` patch for `multimodal-looker` and `sisyphus-junior` uses `.chains["…"]` bracket notation; test fixture with hyphenated key round-trips via `buildRoutingWriteCommand` | `routing.json` keys preserved verbatim |
| 5 | `jq` write unit — `buildRoutingWriteCommand` | Dedicated unit `src/admin/lib/routing-config.test.ts` calls `buildRoutingWriteCommand(plan, [{model:"a/b",variant:"max"}])` and asserts string contains `--arg agent 'plan'` + `--argjson chain` + `> /tmp/…tmp && mv` + bracket-notation | String contains all guards; shell-quoting escapes `'` via `'\"'\"'` pattern |
| 6 | Live-probe health classification | Reuse existing `test/test-agent-model-health.sh` fixtures (`410 retired`, `404 wrong_endpoint`, quota, mismatch) — unchanged | Same pass rates |
| 7 | API shape — GET list | `GET /api/agent-models` → `{agents,catalog,providers,hasPassword,catalogAvailable}` shape unchanged; `agents[].configured.length` may be `>1` | Old UI still renders `configured[0]` |
| 8 | API shape — PUT batch | `PUT /api/agent-models {changes:[{agent:"plan", chain:[{model:"a/b"}]}]}` → `{results:{plan:{ok:true}}}`; also accepts legacy `{entries:[{model:"a/b"}]}` alias | Both spellings succeed |
| 9 | API shape — PUT single + POST verify | `PUT /api/agent-models/plan {chain:[{model:"a/b"}]}` and `POST /api/agent-models/verify {agents:["plan"], verification:"readiness"}` succeed without key | 200 with expected fields |
| 10 | Center-agent `agent-models.set`/`list` | Mock dispatcher test `src/admin/agent/commands.test.ts` — `handle({payload:{type:"agent-models.set", agent:"plan", entries:[{model:"a/b"}]}})` validates chain `1..10` and returns `ApplyResult` | Pass |
| 11 | V1 regression guard | On host where `OMO_ENABLED=1`, `buildJqWriteCommand` + `readAgentModelsConfig` + `syncNativeAgentOverrides` still pass existing `test/test-omo-config-normalization.sh` + `test/test-native-agent-overrides.sh` | No shared-code break |
| 12 | C4 defaultModel | `grep -c merge_native_agent_overrides` on v2 line == 0; `cat ~/.config/opencode/opencode.json | jq '.agent.plan.model'` after one Admin apply equals `routing.json chains.plan.chain[0].model` | Head promoted |
| 13 | LSP/diagnostics clean | `bun run typecheck` / `bunx tsc --noEmit` (per CELL2 `bunx tsc` mapping) and `bun test` (admin unit) | Zero errors on changed files |

### 10.2 Live-key checks (require `OPENCODE_SERVER_PASSWORD` + connected providers)

Set-model-takes-effect E2E — proves the native write path is honored at runtime.

| # | Check | How | Pass criterion |
|---|-------|-----|---------------|
| 1 | Single-chain apply (readiness) | `PUT /api/agent-models/plan {chain:[{model:"opencode-go/kimi-k3","variant":"max"}]}` → wait for restart (30–60s) → `GET /agent` shows `plan.mode=="subagent"` + `model.modelID=="kimi-k3"` + `model.providerID=="opencode-go"` | `resolved` matches `chain[0]` |
| 2 | Multi-entry chain + fallback liveness (readiness) | `PUT /api/agent-models {changes:[{agent:"plan", chain:[{model:"opencode-go/kimi-k3",variant:"max"},{model:"openai/gpt-5.6-sol",variant:"high"}]}]}` → `/agent` still primary; verify `routing.json` retains second entry | Chain persisted; plugin would walk on `session.execution.failed` (not proven without real failure — log chain instead) |
| 3 | Batch apply (two agents, single restart) | `PUT /api/agent-models {changes:[{agent:"plan", chain:[{model:"opencode/big-pickle"}]},{agent:"sisyphus", chain:[{model:"opencode-go/qwen3…"}]}]}` → verify both resolved | One restart, both effective |
| 4 | Clear path | `PUT /api/agent-models/plan {chain:[]}` (or `entries:[]`) → `status:"cleared"` and `opencode.json: .agent.plan` removed, fallback to `opencode/big-pickle` or `routing defaults` | No error, automatic model restored |
| 5 | Inference verification (quota-aware) | `PUT … {chain:[{model:"opencode-go/kimi-k3"}], verification:"inference"}` — `probeModel` sends `prompt_async` throwaway `Reply with exactly OK.` and classifies `healthy`/`quota_exceeded` | `verified` or `applied_with_quota_warning` (quota warning keeps config — not a failure) |
| 6 | Reconcile healing (unreachable head) | Seed `routing.json` with unreachable head (`provider/model` not in connected catalog), run `bun run /opt/admin/lib/agent-model-reconcile-cli.ts`, assert head replaced with healthy candidate and `opencode.json` head updated | Health probing path exercised |
| 7 | OpenChamber default model | After Admin set `plan` chain head, fresh OpenChamber session `resolveDefaultSelection` shows that model as default (check `settings.json` + `opencode.json` `agent.plan.model`) | C4 preserved |
| 8 | Center-agent live | `agent-models.set {agent:"plan", entries:[{model:"opencode-go/kimi-k3"}]}` via center WS → ACK `applied` | Dispatcher delegates to v2 lib |

---

## 11. "On the v2 Line" Framing — Branch-by-Config-Flag Discipline

Every shared-code change above is specified as **branch-by-config-flag**:

```ts
const isV2 = process.env.OMO_ENABLED === "0" || isOpenCodeV2();
if (isV2) { /* routing path */ } else { /* omo path (V1 unchanged) */ }
```

Where `isOpenCodeV2` is the version-probe helper from the sibling's Providers V2 work (`src/admin/routes/providers.ts:316` regex `/(?:^\s)v?2\.\d+\.\d+\b/` on `opencode --version`). The implementer should factor a shared helper `src/admin/lib/opencode-version.ts:export const isOpenCodeV2 = async () => …` and reuse it — **not** duplicate the regex. This keeps V1 behavior byte-identical when the flag is unset (default `OMO_ENABLED=1`).

Entrypoints use the same flag: `if [ "${OMO_ENABLED:-1}" = "0" ]; then … v2 …; else … v1 …; fi` — already present for `PLUGINS=""` and `OMO lifecycle` (02-init-config.sh:258/364/385). No shared-code line may alter V1 output when `OMO_ENABLED` is unset.

---

## 12. Top 3 Design Uncertainties

### U1 — `opencode.json` `agent.*` vs `.opencode/agents/*.md` `model:` — which is the single-pin canonical for the chain head?

B1 §4.1 says routing is `<project>/.opencode/routing.json` **or** `~/.config/opencode/routing.json`, and §1.3 notes `No mutation of opencode.json or .opencode/agents/*.md at runtime — the chain lives in its own config file`. Yet §3 proposes writing the chain head into `opencode.json: agent.<name>.model`. The spec's "no mutation" line is about the **routing plugin** not mutating at runtime — Admin writing at apply time is allowed. But OpenCode 2.0.15 also supports per-agent single pin in either `opencode.json: agent.*` **or** `.opencode/agents/<name>.md: model:` (CELL1 maps 12 agents to file-agents). The implementer must decide: does the head go to `opencode.json` `agent.*` (global, precedence over file-agent) or to the file-agent `model:` (per-project, visible in workspace)? Current design chooses `opencode.json` `agent.*` because Admin already writes there via the old merge; but `.opencode/agents/*.md` is the CELL1-native surface — a write to file-agents would be more visible. Needs a one-paragraph choice with precedence citation from https://opencode.ai/docs/config before coding.

### U2 — Per-agent numeric overrides (`cooldownSeconds` / `maxFallbackAttempts`) — Admin UI or routing-only?

B1 §4.3 allows per-`AgentChain` overrides of `cooldownSeconds`/`maxFallbackAttempts`/`notifyOnFallback` inheriting from `defaults`. The Admin UI currently has no controls for those — the design defers them to "future polish" (§8 row 16). But if the routing plugin's file watcher honors per-agent overrides immediately, and Admin never exposes them, users cannot tune fallback behavior without hand-editing `routing.json`. The uncertainty is whether MVP must add at least a raw-JSON fallback editor for those fields (like Providers' raw-JSON fallback) or whether hard defaults (`60s` / `3`) are sufficient for trial. The answer hinges on whether the fallback plugin's defaults are tuned enough for `plan`/`prometheus` quota bursts — unclear without live fallback load.

### U3 — `catalog.updated` async population vs Admin validation timing

B1 §2.6 notes `catalog.updated` is UNCONFIRMED and the real behavior is empty-at-setup via file caches (`connected-providers.json`/`provider-models.json`). The design's batch validation gate `if (!catalogAvailable && entries.length>0) → 409` (§5, route lines 203–204) and reconciler's `if connectedSet===null → allowAll` (§2.6) interact: Admin may reject a valid `model` because the catalog is transiently empty at boot, while the plugin would have allowed it and let `switchModel` fail fast. The no-key verification plan (§10.1 #1) will be flaky if it runs before the managed `opencode` has populated `opencode-data`. The implementer must decide whether Admin should soft-warn (allow write, surface warning) vs hard-reject (409) when catalog is empty — and whether to add a one-shot `setTimeout 2s` re-check before rejecting, as B1 §3.6 suggests.

---

## 13. Created File Path

```
trial/ADMIN-NATIVE-DESIGN.md
```

Absolute: `/home/devuser/workspace/ai-engkit/trial/ADMIN-NATIVE-DESIGN.md`

Branch `trial/opencode-v2` at design time: `git status --short` shows this new untracked file plus the 10 pre-existing dirty files listed in §1.10 — no source files, entrypoints, tests, specs, or `.opencode/omo.jsonc.default` were modified.

---

## Appendix — Line-Anchor Index (for auditor)

| Concept | File:line |
|---------|-----------|
| `OMO_CONFIG` literal | `src/admin/lib/agent-model-types.ts:72` |
| `MANAGED_OPENCODE_DIR` | `src/admin/lib/agent-model-types.ts:73` |
| `CONFIGURABLE_NATIVE_AGENTS` | `src/admin/lib/agent-model-types.ts:74` |
| `VARIANTS` | `src/admin/lib/agent-model-types.ts:75` |
| `buildJqWriteCommand` body + shellQuote + `del(models,fallback_models)` | `src/admin/lib/agent-model-config.ts:55–66` |
| `validateFallbackModels` + `MODEL_REFERENCE_PATTERN` + `entries.length>1` | `src/admin/lib/agent-model-config.ts:35–53` |
| `parseAgentModelsConfig` + `toConfiguredEntries` | `src/admin/lib/agent-model-config.ts:79–118` |
| `readAgentModelsConfig` `jq -c '.agents // {}'` | `src/admin/lib/agent-models.ts:53–56` |
| `snapshot`/`restore` `cat > tmp && mv` | `src/admin/lib/agent-models.ts:69–87` |
| `syncNativeAgentOverrides` `reduce ["general","plan"]` + `tmp…native-agent-overrides.tmp` + `jq -s … && mv` | `src/admin/lib/agent-models.ts:201–213` |
| `applyAndVerifyBatch` `snapshot→write→nativeSync→restart→verify→probeFailure rollback` | `src/admin/lib/agent-models.ts:215–364` |
| `collectAgentModelState` `CONFIGURABLE_NATIVE_AGENTS` filter + `source`/`effectiveness` | `src/admin/lib/agent-models.ts:403–518` |
| `GET /api/agent-models` | `src/admin/routes/agent-models.ts:126` |
| `POST /suggestions` + `PUT /api/agent-models` batch | `src/admin/routes/agent-models.ts:132,176` |
| `PUT /:agent` single + `POST /verify` | `src/admin/routes/agent-models.ts:236,292` |
| `parseAgentModelSet` + `AGENT_MODEL_KEY_PATTERN` | `src/admin/agent/commands.ts:345–361` |
| `dispatchAgentModelSet` / `finishAgentModelSet` | `src/admin/agent/commands.ts:1356–1404` |
| `agent-models.list` query | `src/admin/agent/commands.ts:1430–1431` |
| `archive_legacy_omo_configs` definition | `entrypoint.d/02-init-config.sh:350–362` |
| `OMO_ENABLED=0` PLUGINS gate | `entrypoint.d/02-init-config.sh:258–265` |
| `DEFAULT_OMO_CONFIG`/`OMO_CONFIG_DIR`/`OMO_CONFIG_FILE` | `entrypoint.d/02-init-config.sh:341–343` |
| `merge_native_agent_overrides` invocation | `entrypoint.d/02-init-config.sh:386` |
| `merge_native_agent_overrides()` body | `entrypoint.d/lib-native-agent-overrides.bash:3–36` |
| `normalize_omo_config` / `initialize_omo_permissions` | `entrypoint.d/lib-omo-model-defaults.bash:3–104` |
| `ensure_openchamber_default_settings` `defaultModel`/`showOpenCodeUpdate…` | `entrypoint.d/lib-openchamber-settings.bash:15–43` |
| `fix_perms "$HOME"/.omo` | `entrypoint.d/00-fix-perms.sh:19` |
| `wait_for_provider` + `wait_for_lifecycle` + `sync_native_overrides` | `scripts/reconcile-agent-models.sh:41–126` |
| `reconciler runOnce` + `suggestExplicit` + `MAX_PROBES=12` + `withLock` | `src/admin/lib/agent-model-reconciler.ts:110–387` |
| `probeModel` + `classifyProbeResponse` + `HEALTH_CACHE_PATH` + TTLs | `src/admin/lib/model-probe.ts:170–474` |
| `isOpenCodeV2` regex on `opencode --version` | `src/admin/routes/providers.ts:316` |
| `isOpenCodeV2` banner | `src/admin/views/providers.tsx:114–126` |
| B1 schema `version:1`, `chains`, `ChainEntry`, `version:1` reject, per-agent isolation, `tmp→mv`, hyphenated verbatim | `trial/B1-ROUTING-SPEC.md:§4.1–4.7` (lines ~266–423) |
| 12 native agents | `trial/CELL1.md:§2` table (12 rows: plan, prometheus, explore, oracle, librarian, multimodal-looker, metis, momus, sisyphus, hephaestus, atlas, sisyphus-junior) |
| Z1 poison proof | `docs/knowledge/patterns/omo-fallback-model-config.md:§Solution` (2026-09-14 Mechanism A) |
| `omo-config` volume `:/home/devuser/.omo` | `docker-compose.yml:14,65` and `docker-compose.dev.yml:22,98` |
| Specs to supersede | `openspec/specs/omo-config-persistence/spec.md` + `openspec/specs/omo-unified-config/spec.md` |

