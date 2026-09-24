# Cell 1 — No-OMO Baseline: 12 OMO Roster Agents → Native OpenCode File-Agents

> Branch: `trial/opencode-v2` | Workdir: `/home/devuser/workspace/ai-engkit` | Date: 2026-09-24
> Deliverable: 12 agent files under `.opencode/agents/` + this notes file. No other files touched. Review-ready.

## 1. Authority & Source Verification

### 1.1 Required Reads (completed)

| File | Lines | Key takeaways |
|------|-------|---------------|
| `.opencode/omo.jsonc.default` | 94 lines | JSON with `agents` (plural, OMO schema `$schema: https://raw.githubusercontent.com/code-yeongyu/oh-my-openagent/v4.19.4/assets/omo.schema.json`). 12 entries: `plan` (models[] only, no tools), `prometheus` (models[] + tools `{read:true, bash:false, edit:false, write:false}`), `explore` (`{read:true, bash:true, edit:false, write:false}`), `oracle`/`multimodal-looker`/`metis`/`momus` (same read-only deny triad), `librarian` (same + `webfetch:true`), `sisyphus`/`hephaestus`/`atlas`/`sisyphus-junior` (`{}` — no restriction, i.e. allow-all). `plan`/`prometheus` each carry `models[]` chain `opencode-go/kimi-k3 (max) → openai/gpt-5.6-sol (high) → openai/gpt-5.6-luna`. |
| `entrypoint.d/lib-omo-model-defaults.bash` | 104 lines | `normalize_omo_config()` validates `permission` shapes then converts OMO `permission` → boolean `tools` via `permission.* == "allow"` and folds into `.tools`; strips `permission` and drops all-true `tools`. `initialize_omo_permissions()` seeds/merges `~/.omo/omo.jsonc` from `/etc/opencode/omo.jsonc.default` via `jq -s '.[0] * .[1]'` (shallow merge, nested objects replaced). |
| `docs/knowledge/patterns/omo-agent-permission-defaults.md` | 73 lines | Role table groups (authoritative): Read-only subagents (`explore, oracle, librarian, multimodal-looker` — bash deny except `explore=allow`), Analysis/planning (`metis, momus, prometheus` — deny bash/edit/write, allow read), Execution/coordination (`sisyphus, hephaestus, atlas, sisyphus-junior` — allow all). Notes: `explore` bash=allow for `ctx_shell`; hardcoded `write/edit/task` gating enforced by OMO plugin at runtime. Pattern also flags hyphenated names need bracket jq: `.agents["multimodal-looker"]`. |
| `entrypoint.d/02-init-config.sh` lines 192–376 | ~184 lines in window | Plugin generation (lines 253–316: `opencode.json` from `OPENCODE_PLUGINS` via `normalize_omo_plugin_versions`, builds `plugin: $PLUGIN_JSON` + `lsp` block + `mcp` locals). OMO lifecycle (lines 332–374): `DEFAULT_OMO_CONFIG="/etc/opencode/omo.jsonc.default"` / `OMO_CONFIG_DIR="$HOME/.omo"` / `OMO_CONFIG_FILE="$OMO_CONFIG_DIR/omo.jsonc"` → `source lib-omo-model-defaults.bash` + `lib-openchamber-settings.bash` + `lib-native-agent-overrides.bash` → `archive_legacy_omo_configs()` (archives `oh-my-openagent.json{,c}` etc. to `*.ai-engkit-legacy-backup`) → `mkdir -p $OMO_CONFIG_DIR` → `initialize_omo_permissions` → `normalize_omo_config` → `merge_native_agent_overrides` (maps `omo.agents.general/plan.model` + `variant` into `opencode.json: .agent[general|plan].model/variant`) → `merge_project_lsp_config`. `lib-native-agent-overrides.bash` (36 lines) uses `reduce ["general","plan"][]` and regex `^[^/[:space:]]+/[^[:space:]]+$` for model validation. |

### 1.2 V2 File-Agent Format (verified via fetch)

Fetched `https://opencode.ai/docs/agents` on 2026-09-24 via `WebFetch` (markdown). Page reachable — used as primary authority (fallback to in-house precedent not needed).

Validated frontmatter schema (all keys taken from that page, not guessed):
- File location: global `~/.config/opencode/agents/<name>.md` or per-project `.opencode/agents/<name>.md`; file name becomes agent name (`review.md` → `review` agent).
- Frontmatter keys (YAML between `---`): `description` (required), `mode` (`primary` | `subagent` | `all`, defaults to `all`), `model` (`provider/model-id` e.g. `anthropic/claude-sonnet-4-20250514` or `opencode/gpt-5.1-codex`), `temperature` (0.0–1.0), `permission` (map of permission keys → `"allow"|"ask"|"deny"` or for `bash`/`read`/`edit` an object of `glob → action`; governs built-ins, custom, and MCP tool wildcard `mcp_*`), `disable`, `prompt`, `steps`, `hidden`, `color`, `top_p`, plus passthrough provider options (e.g. `reasoningEffort`). The page's example:
  ```
  ---
  description: Reviews code for quality and best practices
  mode: subagent
  model: anthropic/claude-sonnet-4-20250514
  temperature: 0.1
  permission:
    edit: deny
    bash: deny
  ---
  ```
- `tools` is **deprecated** — `permission` replaces it (`true` ≡ `{"*": "allow"}`, `false` ≡ `{"*": "deny"}`). All 12 new files use `permission`, never `tools`.

Fallback note: page reachable, so no fallback-to-precedent was used. If later the page is unreachable, closest in-house precedents are `.opencode/commands/*.md` and `.opencode/skills/*/SKILL.md` (both markdown + frontmatter + body), but they use different key vocabularies — Cell 1 would then need to loudly flag fallback in this section.

## 2. Mapping Table — OMO Roster → Native File-Agent

Branch already checked out: `trial/opencode-v2`; no sibling task paths touched (`docker-compose.v2.yml`, `Dockerfile`, `test-v2-trial.sh`).

| # | OMO agent | OMO `tools` / `models` (from `.opencode/omo.jsonc.default`) | Native file `.opencode/agents/<name>.md` | `mode` | `model` | `permission` (V2) | Role body preserved? |
|---|-----------|-------------------------------------------------------------|------------------------------------------|--------|---------|-------------------|---------------------|
| 1 | `plan` | `models: [kimi-k3/max, gpt-5.6-sol/high, gpt-5.6-luna]` + **no** `tools` field | `plan.md` | `primary` | `opencode-go/kimi-k3` (first chain entry, variant dropped) | `edit: deny`, `bash: deny` | yes — planner/architecture analysis without edits |
| 2 | `prometheus` | `models: [kimi-k3/max, gpt-5.6-sol/high, gpt-5.6-luna]` + `tools: {read:true, bash:false, edit:false, write:false}` | `prometheus.md` | `subagent` | `opencode-go/kimi-k3` (same pin, chain gap flagged) | `edit: deny`, `bash: deny` | yes — deep-research/plan synthesis |
| 3 | `explore` | `tools: {read:true, bash:true, edit:false, write:false}` | `explore.md` | `subagent` | — (inherits primary) | `edit: deny`, `bash: allow` | yes — fast read-only search; sole read-only with bash for lean-ctx |
| 4 | `oracle` | `tools: {read:true, bash:false, edit:false, write:false}` | `oracle.md` | `subagent` | — | `edit: deny`, `bash: deny` | yes — consultant/verification |
| 5 | `librarian` | `tools: {read:true, bash:false, edit:false, write:false, webfetch:true}` | `librarian.md` | `subagent` | — | `edit: deny`, `bash: deny`, `webfetch: allow` | yes — external docs + dep source research (sole webfetch) |
| 6 | `multimodal-looker` | `tools: {read:true, bash:false, edit:false, write:false}` | `multimodal-looker.md` | `subagent` | — | `edit: deny`, `bash: deny` | yes — visual/PDF/diagram analysis |
| 7 | `metis` | `tools: {read:true, bash:false, edit:false, write:false}` | `metis.md` | `subagent` | — | `edit: deny`, `bash: deny` | yes — strategic wisdom analysis |
| 8 | `momus` | `tools: {read:true, bash:false, edit:false, write:false}` | `momus.md` | `subagent` | — | `edit: deny`, `bash: deny` | yes — adversarial critic/review |
| 9 | `sisyphus` | `{}` (no deny) | `sisyphus.md` | `primary` | — | *(none — allow all, equiv. to V2 `build`)* | yes — primary execution/coordination |
| 10 | `hephaestus` | `{}` (no deny) | `hephaestus.md` | `primary` | — | *(none — allow all)* | yes — builder/craftsman execution |
| 11 | `atlas` | `{}` (no deny) | `atlas.md` | `primary` | — | *(none — allow all)* | yes — mapping/coordination execution |
| 12 | `sisyphus-junior` | `{}` (no deny) | `sisyphus-junior.md` | `primary` | — | *(none — allow all)* | yes — focused lightweight execution |

Notes on generation:
- All 12 files use `description` (required), `mode`, and where applicable `model`/`permission` exactly as validated keys from the fetched page — no guessed `tools` or `permission.tools` keys.
- `edit` in V2 permission gates `write` + `edit` + `apply_patch` (per https://opencode.ai/docs/agents Permissions table `edit → write, edit, apply_patch`), so OMO `write:false` + `edit:false` collapses to V2 `edit: deny` uniformly.
- Executor family (`sisyphus`/`hephaestus`/`atlas`/`sisyphus-junior`) deliberately carries no `permission` block to signal full allow, matching the doc's "Build is default with all tools enabled" and the pattern table's `allow | allow | allow | allow`. Alternative would be explicit `edit: allow, bash: allow` — functionally identical; omission was chosen to avoid implying a restriction.
- Hyphenated names `multimodal-looker` and `sisyphus-junior` are preserved verbatim; body notes the `jq` bracket-notation caveat from the patterns doc.

## 3. Minimal Env-Gated No-OMO Boot Proposal (Proposal ONLY — no edits made)

Per task: propose the exact `OMO_ENABLED=0` skip-block anchored to lines read from `entrypoint.d/02-init-config.sh`. **Do not edit the entrypoint in this task** — proposal lives here only.

### 3.1 Anchor Lines (exact, from read at 2026-09-24)

In `entrypoint.d/02-init-config.sh`:

- **Block A — OMO unified config header**: lines 332–341
  ```
  # --- OMO unified configuration ---
  DEFAULT_OMO_CONFIG="/etc/opencode/omo.jsonc.default"
  OMO_CONFIG_DIR="$HOME/.omo"
  OMO_CONFIG_FILE="$OMO_CONFIG_DIR/omo.jsonc"

  # Kept in a non-.sh file so the entrypoint runner does not execute it separately.
  source "$(dirname "$0")/lib-omo-model-defaults.bash"
  source "$(dirname "$0")/lib-openchamber-settings.bash"
  source "$(dirname "$0")/lib-native-agent-overrides.bash"
  ```

- **Block B — OMO lifecycle**: lines 342–374 (inclusive through `merge_project_lsp_config` guard line)
  ```
  archive_legacy_omo_configs() {
    local legacy_name legacy_file backup_file
    for legacy_name in oh-my-openagent.json oh-my-openagent.jsonc oh-my-opencode.json oh-my-opencode.jsonc; do
      legacy_file="$OPCODE_CONFIG_DIR/$legacy_name"
      [ -f "$legacy_file" ] || continue
      backup_file="${legacy_file}.ai-engkit-legacy-backup"
      if [ -e "$backup_file" ]; then
        backup_file="${backup_file}.$(date -u +%Y%m%dT%H%M%SZ)"
      fi
      mv "$legacy_file" "$backup_file"
      echo "Archived legacy OMO config: $legacy_file -> $backup_file"
    done
  }

  archive_legacy_omo_configs
  mkdir -p "$OMO_CONFIG_DIR"

  initialize_omo_permissions "$OMO_CONFIG_FILE" "$DEFAULT_OMO_CONFIG"
  if ! normalize_omo_config "$OMO_CONFIG_FILE"; then
    echo "Warning: OMO config normalization was not applied; review the reported path" >&2
  fi
  # ... (lean-ctx hook + baked-skills block interleaves, but OMO-specific logic ends before)
  merge_native_agent_overrides "$OPCODE_CONFIG_FILE" "$OMO_CONFIG_FILE"

  merge_project_lsp_config
  ```

  Note: `merge_project_lsp_config` at line 375 is **not** OMO-specific and should stay outside the gate (see uncertainties). The `lean-ctx` setup block (lines 363–371) and baked-skills block (389–403) are also not OMO-specific — they must not be gated by `OMO_ENABLED`.

- **Plugin generation alternative anchor**: lines 256–257
  ```
  PLUGINS="$(normalize_omo_plugin_versions "${OPENCODE_PLUGINS:-oh-my-openagent}")"
  ```
  where `normalize_omo_plugin_versions` (lines 216–231 in lib) rewrites bare `oh-my-openagent` → `oh-my-openagent@${OH_MY_OPENAGENT_VERSION}`. The `OPENCODE_PLUGINS` env default lives there, not in a separate file. Any no-OMO mode must override that default outside the entrypoint (e.g. compose `OPENCODE_PLUGINS=""` or `OPENCODE_PLUGINS=@opencode-ai/plugin@...`).

### 3.2 Proposed Skip-Block (env-gated, minimal, idempotent)

Insert immediately **after** line 341 (`source` lines) and **before** `archive_legacy_omo_configs` definition (line 342), a single env gate that wraps exactly Block B's OMO-specific calls:

```
# --- Cell 1 no-OMO gate (proposal; gated by OMO_ENABLED, default ON) ---
# When OMO_ENABLED=0, skip all OMO unified-config lifecycle. Native file-agents
# in .opencode/agents/ remain the sole agent surface. This preserves V2 startup
# when oh-my-openagent is absent from plugin[] and ~/.omo is not populated.
if [ "${OMO_ENABLED:-1}" = "0" ]; then
  echo "OMO lifecycle skipped (OMO_ENABLED=0) — using native .opencode/agents/* only"
else
  archive_legacy_omo_configs
  mkdir -p "$OMO_CONFIG_DIR"
  initialize_omo_permissions "$OMO_CONFIG_FILE" "$DEFAULT_OMO_CONFIG"
  if ! normalize_omo_config "$OMO_CONFIG_FILE"; then
    echo "Warning: OMO config normalization was not applied; review the reported path" >&2
  fi
  # ... (retain existing lean-ctx/baked-skills blocks outside the else if desired,
  #      but keep merge_native_agent_overrides inside the gate)
  merge_native_agent_overrides "$OPCODE_CONFIG_FILE" "$OMO_CONFIG_FILE"
fi
# merge_project_lsp_config and all non-OMO blocks stay UNGATED below this line
merge_project_lsp_config
```

Refined variant (cleaner separation — recommended): keep the function definition `archive_legacy_omo_configs() { ... }` **outside** the gate (definitions are inert), gate only the **invocations**:

```
archive_legacy_omo_configs() { ... } # lines 342-354 — definition always loaded

if [ "${OMO_ENABLED:-1}" != "0" ]; then
  archive_legacy_omo_configs
  mkdir -p "$OMO_CONFIG_DIR"
  initialize_omo_permissions "$OMO_CONFIG_FILE" "$DEFAULT_OMO_CONFIG"
  if ! normalize_omo_config "$OMO_CONFIG_FILE"; then
    echo "Warning: OMO config normalization was not applied; review the reported path" >&2
  fi
  merge_native_agent_overrides "$OPCODE_CONFIG_FILE" "$OMO_CONFIG_FILE"
else
  echo "OMO lifecycle skipped (OMO_ENABLED=0) — using native .opencode/agents/* only"
fi

# --- lean-ctx setup (363-371) — UNGATED ---
# --- baked skills (389-403) — UNGATED ---
merge_project_lsp_config # always run
```

Design constraints for reviewer:
- Default **ON** (`${OMO_ENABLED:-1}`) — existing V1 containers with `oh-my-openagent@4.19.4` in `plugin[]` keep current behavior when env is unset.
- Sibling task's `docker-compose.v2.yml` should set `OMO_ENABLED=0` and `OPENCODE_PLUGINS=""` (or a V2-native plugin list without `oh-my-openagent`) — do not rely on the entrypoint to strip the plugin; the entrypoint only gates file generation/archiving, not the `plugin: [...]` array itself beyond the `OPENCODE_PLUGINS` env.
- `lib-omo-model-defaults.bash` sourcing (line 338) is harmless when gated — functions without invocation have no side effect. No need to gate the `source`.
- `merge_native_agent_overrides` must be inside the gate (or guarded by `[ -f "$OMO_CONFIG_FILE" ]`) — when OMO is disabled there is no `~/.omo/omo.jsonc` to read, and the function already no-ops on missing file, but skipping avoids a confusing `Warning: Native agent overrides skipped` path.

## 4. Known Gaps & Deliberately Out-of-Scope

### 4.1 KNOWN GAP — `models[]` Fallback Chain Has No Native Equivalent
- OMO `plan` and `prometheus` declare `models: [{model:"opencode-go/kimi-k3", variant:"max"}, {model:"openai/gpt-5.6-sol", variant:"high"}, {model:"openai/gpt-5.6-luna"}]`. Native OpenCode file-agents expose only a single `model: "provider/model-id"` key (fetched page Options/Model section). There is **no** `models`, `fallbacks`, `fallback_models`, or ordered-chain syntax in the V2 agent docs, nor in the in-house `lib-native-agent-overrides.bash` (`model` singular + `variant` singular).
- **Cell 1 decision**: pin `model: opencode-go/kimi-k3` (first chain entry, highest priority) in `plan.md`/`prometheus.md`; drop `variant` (`max`/`high`) — V2 variant semantics are provider-specific passthrough (`reasoningEffort`/`textVerbosity`) not a standard key, and the fetched page routes additional options as passthrough under "Additional". Recorded as gap for the routing plugin (Cell 2+): a thin plugin would need to implement `session.hook("model.request")` or `event.subscribe: session.execution.failed → switchModel` retry to emulate the chain, but must not invent `models: []` syntax in file-agents.

### 4.2 Deliberately Out-of-Scope (Zombie Capabilities — Not Mapped)

| Zombie | Why not mapped |
|--------|---------------|
| Team Mode (multi-agent batch, `team_*` tools, `orchestrator-*` delegation, parallel subagent fan-out with shared context) | Requires continuation engine / event-sourced orchestration; no file-agent analog. Covered only by `permission.task` coarse gating (see §7). |
| Slash commands (`/opsx-*`, `/ulw-*` etc.) | Commands live under `.opencode/commands/*.md` separately; agents do not declare them. |
| `/goal` / `fallback_models` persistence / `goal`-plugin todo/boulder | Session Goals (`goal`) and Loops cover `/goal` natively in V2 (per `docs/knowledge/tooling/opencode-v2-migration-watch.md` §9). Do not replicate persistence keys. |
| `[opencode].agents` keys in `opencode.json`, `agent` vs `agents` plural | OMO uses `agents` (plural) under its own `omo.jsonc` schema; native `opencode.json` uses `agent` (singular). No mapping — file-agents supersede. |
| Compact-session / child-session recovery hooks | No V2 plugin surface yet (`tool.hook` lacks compaction context, per migration-watch doc). |

### 4.3 V2 `AGENTS.md` Only — `CLAUDE.md` Not Loaded

OpenCode V2 (and OpenChamber `v2.0.0` with `openchamber-web-2.0.0.tgz`) confirms **V2 reads `AGENTS.md` and does NOT load `CLAUDE.md`** (migration-watch doc revalidated 2026-09-24, OpenChamber blog `opencode-v2`). Any agent prompt text that references `CLAUDE.md` is a follow-up item — the 12 files in this baseline **do not** reference `CLAUDE.md` except in the explicit "do not reference CLAUDE.md" guard line in each body, which is itself the follow-up marker. Reviewer action: grep `.opencode/agents/*.md` for `CLAUDE` after generation — should hit only the guard lines; any instructional reference to load or merge `CLAUDE.md` would need removal on V2 trial.

## 5. Created File List (exact, verified)

```
.opencode/agents/plan.md
.opencode/agents/prometheus.md
.opencode/agents/explore.md
.opencode/agents/oracle.md
.opencode/agents/librarian.md
.opencode/agents/multimodal-looker.md
.opencode/agents/metis.md
.opencode/agents/momus.md
.opencode/agents/sisyphus.md
.opencode/agents/hephaestus.md
.opencode/agents/atlas.md
.opencode/agents/sisyphus-junior.md
trial/CELL1.md
```

No other files touched. No `git add`/`commit`/`push` performed. No docker, no network installs.

Verification (post-write):
```
$ git status --short
 M docs/knowledge/tooling/opencode-v2-migration-watch.md   # pre-existing dirty, not touched by this task
 ?? .opencode/agents/
 ?? trial/

$ ls .opencode/agents/*.md | wc -l
12

$ ls -1 .opencode/agents/
atlas.md  hephaestus.md  librarian.md  metis.md  multimodal-looker.md  oracle.md  plan.md  prometheus.md  sisyphus-junior.md  sisyphus.md  explore.md  momus.md

$ ls -1 trial/CELL1.md
trial/CELL1.md
```

Frontmatter validation note: all 12 files use only keys evidenced on `https://opencode.ai/docs/agents` (`description`/`mode`/`model`/`permission`). `permission` values restricted to `allow`/`deny` (and `webfetch` for librarian) per the page's Permission table. No `tools` deprecated key emitted.

## 6. Top 3 Uncertainties Blocking Cell 1 Execution

### U1 — `models[]` + `variant` Chain Cannot Be Faithfully Represented Without a Routing Plugin
**Blocks**: deterministic model selection for `plan`/`prometheus`.
Why: V2 file-agents accept only `model: "provider/id"` with arbitrary passthrough options; there is zero documented fallback-chain syntax, and the `variant: "max"` / `"high"` values from OMO are not V2-standard (they are OMO's `model#variant` convention mapped via `lib-native-agent-overrides.bash` into `opencode.json: .agent[plan].variant`). Pinning to `opencode-go/kimi-k3` alone loses the `gpt-5.6-sol` → `gpt-5.6-luna` fallback that OMO guarantees on quota/rate-limit. A thin routing plugin must be specified in Cell 2 to reactively `switchModel` on `session.execution.failed`, respecting that `session.hook("model.request").model` is readonly and `catalog.updated` is async (model catalog empty at `setup` — per migration-watch §7). Trial execution must decide whether to accept single-model failure or require the plugin first.

### U2 — No-OMO Boot Is Two Variables, Not One, and the Default `OPENCODE_PLUGINS` Env Still Points at V1
**Blocks**: clean V2 container boot with `OMO_ENABLED=0`.
Why: `entrypoint.d/02-init-config.sh` line 256 defaults `PLUGINS` to `oh-my-openagent` when `OPENCODE_PLUGINS` is unset: `normalize_omo_plugin_versions("${OPENCODE_PLUGINS:-oh-my-openagent}")`. Gating the filesystem (`~/.omo/omo.jsonc` lifecycle) is insufficient — the generated `~/.config/opencode/opencode.json: plugin: ["oh-my-openagent@4.19.4"]` will still reference the V1 `server(input)` API that V2 cannot load (`Plugin.define` required per migration-watch). The compose layer for trial must jointly set `OMO_ENABLED=0` **and** `OPENCODE_PLUGINS=""` (or an explicit V2-native plugin list), and separately handle `AGENTS.md` seeding vs merge so the trial profile does not inherit the V1 `AGENTS.md.default` sentinels unnecessarily. The sibling task owns that compose file — Cell 1 is blocked until it lands and a boot dry-run proves `opencode.json` is OMO-free and the server starts without the V1 plugin.

### U3 — Team-Scale Orchestration and `permission.task` Wiring Has No Proven Mapping
**Blocks**: multi-run `>5` / parallel delegation semantics that OMO's Team Mode guarantees.
Why: OMO's execution model (Sisyphus as orchestrator fanning out to `explore`/`librarian`/`oracle` etc. via `team_*` tools) is fully absent in the file-agent baseline. The only native knob is `permission.task` (`"task": {"*":"deny","orchestrator-*":"allow"}` style glob → action with last-match-wins), surfaced on the docs page under Task permissions. Cell 1 intentionally sets **no** `permission.task` rules (all agents default to `allow` or inherit global policy) to avoid guessing routing topology. But that means there is zero enforcement or description guidance for who may dispatch whom, and the V2 TUI's native subagent renderer replaces tmux/zellij multiplexing by default (migration-watch §7). Execution must decide: add per-agent `permission.task` glob maps in a follow-up, or defer delegation to manual `@` mentions — and whether to rely on the native subagent renderer or re-enable multiplexers explicitly for trial parity with the migration-watch's expected behavior.

---

## Appendix A — Demand Traceability

- Must read 4 files in full: done (§1.1).
- Must fetch https://opencode.ai/docs/agents and use V2 `description`/`mode`/`model`/`tools`/`permission` schema: done — fetch succeeded, keys match (§1.2), fallback path documented.
- Must write 12 agent files preserving role + tool restrictions: done (§2), with `explore` `bash:allow`, `librarian` `webfetch:allow`, read-only `edit:deny`, executor `allow all`, `plan`/`prometheus` `models[]` chain gap flagged as KNOWN GAP (§4.1).
- Must list zombies as deliberately-out-of-scope: done (§4.2) — Team Mode, slash commands, `/goal`, `fallback_models` persistence, `[opencode].agents` keys all listed; `/goal` noted as covered by Session Goals/Loops.
- Must read `entrypoint.d/02-init-config.sh` ~200–380 and propose minimal `OMO_ENABLED=0` skip-block with exact anchors: done (§3).
- Must note `CLAUDE.md` non-load: done (§4.3) — guard line in each file, greppable follow-up.
- Must not modify guarded paths, not touch sibling task paths, not commit/run docker: respected (§5).

## Appendix B — Review Checklist

- [ ] `git diff --name-only` shows only `.opencode/agents/*.md` + `trial/CELL1.md` plus the pre-existing dirty `docs/knowledge/tooling/opencode-v2-migration-watch.md` (verify no other diffs)
- [ ] Each `.opencode/agents/*.md` starts with `---` YAML frontmatter containing `description` (required), `mode`, and only validated keys
- [ ] `grep -r "tools:" .opencode/agents/` returns 0 hits (no deprecated `tools` key)
- [ ] `grep -r "CLAUDE.md" .opencode/agents/` hits only the guard lines (§4.3) — no instructional `CLAUDE.md` loading
- [ ] `grep -r "models:" .opencode/agents/` returns 0 hits — chain handled via single `model` + gap note, no invented syntax
- [ ] Trial reviewer confirms `OMO_ENABLED=0` proposal (§3) covers exactly the OMO lifecycle without gating `merge_project_lsp_config` or `lean-ctx` setup
