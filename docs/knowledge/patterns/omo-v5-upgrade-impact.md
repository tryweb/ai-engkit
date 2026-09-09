# OMO v5.x Upgrade Impact (assessed at 5.0.0-beta.50)

## Context

ai-engkit consumes oh-my-openagent (OMO) exclusively as an **OpenCode npm plugin** — never as a CLI:

- `opencode.json` → `plugin: ["oh-my-openagent@${OH_MY_OPENAGENT_VERSION}"]`, Dockerfile `ARG OH_MY_OPENAGENT_VERSION=4.19.4`.
- Config: `.opencode/omo.jsonc.default` (11 agents) baked to `/etc/opencode/omo.jsonc.default`, merged into `~/.omo/omo.jsonc` at startup by `entrypoint.d/02-init-config.sh`.
- Version pipeline: `.opencode/scripts/check-versions.sh` + `.github/workflows/dependency-update.yml` compare against the npm `latest` dist-tag and sync the `$schema` tag in `omo.jsonc.default` (also in `check-updates` SKILL).

OMO v5.0.0 (beta line `5.0.0-beta.1` → `5.0.0-beta.50`) is a major rewrite: native CLI `omo-agent-toolkit`, Senpi edition (`omo-ai`, `omo` command), one-way legacy-config migration, `omo` bin removed, `shared/<name>` skill names → bare names, and reasoning/model config standardization. The OpenCode plugin config remains `~/.omo/omo.jsonc` in beta.50; `~/.omo/agent` is the native/Senpi agent state directory, not a replacement for the plugin config path.

## Problem

Does upgrading to omo v5 break AI-EngKit's plugin-based consumption? Which moving parts (install path, config format, schema, CLI, CI) are affected, and are there silent failure modes?

## Solution

Verified repository baseline (2026-08-30, npm + v5.0.0-beta.30 source), supplemented by the external beta.31–beta.50 release audit below:

### Structural Safety (no changes needed)

1. **Plugin load path unchanged**: root package is `oh-my-opencode` with `main: ./dist/index.js`; `exports` map identical between v4.19.4 and v5. `plugin: ["oh-my-openagent@<v>"]` loads v5 exactly like v4.
2. **Config surface remains plugin-compatible**: AI-EngKit writes `~/.omo/omo.jsonc` with top-level `agents`, and beta.50 still uses that path for the OpenCode plugin. Per-agent keys in `assets/omo.schema.json` are identical between v4.19.4 and v5.0.0-beta.9 (16 keys, `additionalProperties: false`). Note: `permission`/`fallback_models` are absent from the *assets* schema in **both** versions — they live in the runtime dist schema and are genuinely consumed (`omo-fallback-model-config.md`).
3. **`omo` bin removed** (new: `omo-agent-toolkit`) — irrelevant here; the repo never invokes the CLI.
4. **OpenCode requirement ≥1.4.0**; AI-EngKit pins 1.18.18.
5. **Skill names** `shared/<name>` → bare names; repo already uses bare names.
6. **One-way legacy migration** on first v5 run (`~/.omo/migration-backup-*`, `_migrations` markers). AI-EngKit's entrypoint already archives legacy `oh-my-openagent.json*` / `oh-my-opencode.json*` to `.ai-engkit-legacy-backup`, deliberately preempting OMO's cross-volume migration.
7. **New memory subsystem is Senpi-only**: `memory-core`, `omo-memory-mcp.js`, `OMO_MEMORY_HOME`, `~/.omo/memory`, `memory.enabled` are wired into `packages/omo-senpi` **only**. `packages/omo-opencode` (AI-EngKit's harness) does not import/register/read any of it. The `memory` block in the unified schema is harness-neutral; only the Senpi adapter acts on it. → No interaction with lean-ctx (paths disjoint: `~/.omo/memory` vs lean-ctx XDG dirs; volumes `omo-config` vs `lean-ctx-data`/`lean-ctx-state`).

### Breaking Changes Requiring Migration (identified in beta.8)

8. **Config path correction**: beta.50 still uses `~/.omo/omo.jsonc` for the OpenCode plugin config. `~/.omo/agent` is the native/Senpi agent state directory, not a replacement path for AI-EngKit's plugin config. Do not change the entrypoint or Admin constant based on the earlier, unverified path-migration claim.
9. **`/omo-telemetry` command removed** — replaced by built-in parallelism telemetry. Remove any references.
10. **Schema URL update**: `omo.jsonc.default` must point to `v5.0.0` schema.

### New Capabilities (beta.8)

11. **Mass parallel agent orchestration**: large tasks fan out into parallel waves automatically.
12. **Grok 4.6 as default for quick tasks**: `unspecified-low` category defaults to `xai/grok-4.6 xhigh`.
13. **Planning constraint derivation**: planning infers budget/stack/scale/audience instead of asking.
14. **Cursor sign-in support**: `/login cursor` for Cursor Pro/Ultra/Teams subscription auth.
15. **Frontend design routing enforcement**: agents must load design references before writing UI code.
16. **Memory reliability fixes**: disk usage bounded, infinite retry loop fixed (5 root causes).

### Beta.9 Stability Fixes (no new breaking changes)

17. **Senpi engine 2026.8.17**: cursor-cli-oauth fallback, tool-call loop hard-stop, retry-exhausted steering resume, `-fast` codex variants.
18. **Explicit beta publishes**: `/publish` accepts exact semver, no accidental stable bumps.
19. **Memory reflection fixes**: entries render as senpi notices, stale failure streaks stop alerting.
20. **Codex spawn fix**: callee boundary anchored, on-complete hooks inject correct shell platform.

### Beta.10 Reliability Hardening (no new breaking changes)

21. **Installer timeouts**: ast-grep provisioning has bounded timeout (30s), child processes no longer hang indefinitely.
22. **Release gate reuse**: publish workflow reuses exact-SHA CI instead of rerunning full matrix.
23. **Credential isolation**: release PAT only in push/PR step, EXIT trap restores token-free URL.
24. **CI fast path**: generated release merges and web/docs-only changes skip full matrix.
25. **Windows validation**: Bun 1.3.14 pinned, PowerShell replaces Git Bash for root tests.

### Beta.11 Memory System Upgrade (no new breaking changes)

26. **Memory pressure awareness**: agent knows when memory is getting full, dream runs launch automatically.
27. **Memory token budgets**: enforced per-file estimates, dream tier rebalancing driven by evidence.
28. **Memory-file access ledger**: records which files get read, drives tier adjustments.
29. **Memory children spawn fix**: CLI entry forwarded to reflection/fork/people-ask (was broken on npm installs).
30. **Reflection provider fallback**: retries through provider outages instead of dying on 500.
31. **mass-ulw dag boundary**: planning discipline, spawn policy, reload guard during DAG runs.
32. **Team widget fix**: completed resident members no longer vanish.
33. **Category chain availability**: fallback chain advances when model unavailable.
34. **permission.task on main agents**: now respected on OpenCode side (positive impact for AI-EngKit).
35. **Senpi 2026.8.18-3**: paste images in TUI, Cursor context windows fixed, goals resume, retries use full budget, compaction stops eating typing, headless OAuth, Linux glibc binary priority.
36. **Windows memory-file path normalization**: ledger keys normalized, dream tier counts work.
37. **LSP out-of-CWD fix**: read-only LSP tools resolve paths outside working directory (positive impact for AI-EngKit).

### Beta.13 DAG Recovery + Side Conversations (no new breaking changes)

38. **DAG `retry`/`send`/`amend`**: failed/cancelled nodes retry with cached results kept; steer into running children; amend re-runs only changed nodes + dependents. Explicit no-break guarantee — `schemaVersion` stays 1.
39. **`/btw` (alias `/side`) side conversations**: temporary session on same model/agent; main context visible read-only (64 msg / 64 KiB cap); Q&A never enters main transcript. UX feature, not plugin API.
40. **Model fallback dedupe fix** (#6579/#6611): retry-dedupe key now includes failing model; same error on a *different* model no longer dropped. Model identity travels as provider/model **plus variant** through the whole fallback path. Directly relevant to AI-EngKit's fallback model usage.
41. **Shared agent-dir reload fix**: routine-preference saves from another session no longer cascade a reload.
42. **Bun 1.4.0 graduation started**: CI/publish/platform workflows moved 1.3.14 → 1.4.0; AI-EngKit Dockerfile still pins `BUN_VERSION=1.3.14` — plugin loads inside opencode so not directly dependent, but watch on upgrade.

### Beta.16 Plugin-Side Behavior Changes (no new breaking changes)

43. **init-deep → DAG map-reduce**: discovery/generation replaced with bounded DAG (400 KB source chunks, quick scanner nodes → unspecified-high writer nodes → root writer → verify gate); main session reads only the verify verdict. `AGENTS.md` scoring/templates/Phase-5 contract preserved. Positive for large-repo init-deep runs.
44. **ULW keyword table consolidation**: `mass-ulw` + `ulw-skill-pointers` merged into one `skill-pointers` component; "mass ulw-loop" now loads all named skills. **Flag rename**: `omo-senpi-mass-ulw-disabled` + `omo-senpi-ulw-skill-pointers-disabled` → single `omo-senpi-skill-pointers-disabled`. AI-EngKit repo sets none of these — zero impact.
45. **mass-ULW grain-based wave sizing**: `task.dag.max_nodes_per_run` / `max_runs_per_session` reframed as config defaults. AI-EngKit doesn't override `task.*` — defaults apply.
46. **Senpi 2026.8.22**: Cursor stream heartbeat recovery, shutdown with pending permission prompts, Ruby/Julia kernel boot under load. Senpi-only.

### Beta.17 Small Release (no new breaking changes)

47. **`task.global_concurrency` schema + default** (omo-config-core + omo-opencode).
48. **`0` as unlimited sentinel** for task concurrency/residency caps (omo-config-core + omo-opencode).
49. **Launcher re-exec under bun** for bun-installed users (omo-native only).

### Beta.31–Beta.50 Cumulative Risks (external release audit)

The following items were identified by reviewing the upstream beta.31–beta.50 release history. They are not all represented in this repository's source tree, so each item must be confirmed against the selected beta before implementation.

56. **Model configuration convergence**: `variant`, `fallback_models`, and related reasoning fields increasingly converge on the canonical `models[]` chain. AI-EngKit Admin currently writes `model` + `variant` and deletes `models`/`fallback_models`; this can erase a v5 fallback chain on every apply.
57. **New model identities and routing**: beta.43–beta.50 introduce or reprioritize Astra/Fable and fast model variants. The Admin catalog, probe, canonicalization, and replacement policy must recognize these IDs before treating them as unavailable.
58. **Permission and tool routing changes**: eval-only routing, tool-search capability gating, skill normalization, and removal of legacy `network_access`/`memory.tool_exposure` fields require a v5 permission smoke test.
59. **CodeGraph packaging**: OMO's packaged CodeGraph integration was removed, but AI-EngKit's independently configured CodeGraph MCP must remain verified as a separate integration.
60. **Runtime and packaging floor**: beta.36–beta.50 move native packaging toward Bun 1.4.x and compiled workers; the Dockerfile's Bun pin requires a canary check before any OMO beta upgrade.
61. **Background and compaction state**: delegation defaults, fallback chains, and variants now persist across background wake and compaction boundaries; `/agent` output alone is insufficient evidence for model correctness.

### Beta.30 Senpi-Only Hotfix (no new breaking changes)

50. **No omo-side commits**: beta.30 only advances Senpi from `2026.8.30-2` to `2026.8.30-3`; no `omo-opencode` logic, plugin entrypoint, agent config, schema, or CLI changes.
51. **RPC disconnect recovery**: typed `RpcTransportGoneError`, deferred rebind, and reconnect-or-fallback behavior prevent steering messages from being lost when the interactive host socket disconnects.
52. **PTY/terminal reliability**: serialized screen writes and bounded backlog prevent queued writes/resizes from splitting or dropping during replay.
53. **Compaction safety**: deterministic tool admission, structured-result/lane ownership preservation, retry-safe reminders, and multipart-result caps.
54. **Model downswitch admission**: target usable-budget checks, equal-budget provider switching, and invalid-selection rollback.
55. **AI-EngKit impact**: all beta.30 changes are Senpi/native engine internals; AI-EngKit's OpenCode plugin integration, container startup flow, and Admin `agents.<name>.model` + `variant` write contract are unchanged.

## Why It Works

- Plugin identity and entry (`main`/`exports`) are unchanged, so opencode loads v5 identically to v4.
- The `agents` key and `~/.omo/omo.jsonc` plugin path remain compatible with the OpenCode integration; do not infer a path migration from the native/Senpi `~/.omo/agent` directory.
- Harness isolation keeps memory dormant in AI-EngKit's runtime — no double memory layer with lean-ctx.

## Side Effects / Tradeoffs

- **CI blind spots (fix before adopting)**:
  - `check-versions.sh` `get_npm_latest` reads the npm `latest` dist-tag → betas are **never** flagged as outdated; upgrading to v5 requires a manual Dockerfile ARG bump.
  - `dependency-update.yml` + `check-updates` schema-sync `sed` pattern `v[0-9.]*/assets/...` succeeds on the first bump (`v4.19.4` → `v5.0.0-beta.3`) but **silently no-ops on subsequent beta bumps** (hyphen breaks the `[0-9.]` char class). Widen to e.g. `v[0-9][0-9A-Za-z.-]*`.
- **Downgrade is one-way**: v5 rewrites config into its unified format; v4 may reject v5-only keys. Volumes (`omo-config`) already back up `~/.omo`.
- **Open items needing a smoke test** (beta): whether v5's opencode plugin still registers all 11 agents, enforces `permission`, and discovers skills; whether `~/.cache/oh-my-opencode` legacy cache dir is still used by v5.
- **`fallback_models` migration opportunity**: v5's canonical chain key is `models` (present in both v4/v5 schemas). Move `plan`/`prometheus` fallbacks when bumping.
- **Admin writes only primary model**: `src/admin/lib/agent-model-config.ts` `buildJqWriteCommand` writes `.agents[$agent].model` + `.variant` and **deletes** `models`/`fallback_models` on every apply. So the Admin "SubAgent 預設模型" never expresses a fallback chain — fallback comes from OMO's built-in `AGENT_MODEL_REQUIREMENTS` chains. If v5 should carry chains via `models`, this write logic must change (write `models` array instead of deleting). The `model`+`variant` keys themselves are v5-native and need no migration.

## Migration Checklist (for stable v5.0.0)

```
Pre-upgrade (before v5 stable):
☐ Update .opencode/scripts/check-versions.sh sed pattern (widen hyphen support)
☐ Update .github/workflows/dependency-update.yml schema-sync pattern
☐ Smoke test v5 beta as plugin load (all 11 agents registered)
☐ Confirm the selected beta still reads plugin config from ~/.omo/omo.jsonc
☐ Remove any /omo-telemetry references

Upgrade:
☐ Dockerfile ARG OH_MY_OPENAGENT_VERSION=5.0.0
☐ .opencode/omo.jsonc.default schema URL → v5.0.0
☐ Do not change OMO_CONFIG_FILE, OMO_CONFIG, or model-default paths unless upstream source proves a plugin-path migration
☐ Update Admin model writes to preserve the canonical v5 models[] chain (application-code follow-up)

Post-upgrade:
☐ Smoke test: all 11 agents registered and permissions enforced
☐ Verify fallback_models work under v5 format
☐ Verify ~/.cache/oh-my-opencode legacy cache still used by v5
☐ Confirm lean-ctx and OMO memory no conflict
```

## Evidence

- npm registry 2026-08-10: dist-tags `latest=4.19.4`, `beta=5.0.0-beta.3`.
- npm registry 2026-08-17: dist-tags `latest=4.19.4`, `beta=5.0.0-beta.9`.
- npm registry 2026-08-19: dist-tags `latest=4.19.4`, `beta=5.0.0-beta.11`.
- npm registry 2026-08-22: dist-tags `latest=4.19.4`, `beta=5.0.0-beta.17`.
- npm registry 2026-08-30: dist-tags `latest=4.19.4`, `beta=5.0.0-beta.30`.
- package.json v4.19.4 vs v5.0.0-beta.30: beta.30 release reports no omo-side commits; plugin entrypoint/config contract is unchanged.
- `assets/omo.schema.json` v4.19.4 vs v5.0.0-beta.30: no beta.30 omo-side schema change was reported; existing per-agent/config migration assessment remains applicable.
- beta.3→beta.8: major feature release (parallel orchestration, Grok 4.6, memory fixes, config path change).
- beta.8→beta.9: stability-only (Senpi engine 2026.8.17, publish flow fixes, memory reflection fixes).
- beta.9→beta.10: reliability hardening (installer timeout, CI gate reuse, credential isolation).
- beta.10→beta.11: memory system upgrade (pressure awareness, token budgets, access ledger, Senpi 2026.8.18-3).
- beta.11→beta.13: DAG recovery (`dag retry`/`send`/`amend`), `/btw` side conversations, model fallback dedupe fix, Bun 1.4 graduation started.
- beta.13→beta.16: init-deep DAG map-reduce, ULW skill-pointers consolidation (flag rename), Senpi 2026.8.22.
- beta.16→beta.17: `task.global_concurrency` + 0-as-unlimited sentinel; launcher bun re-exec (native only).
- beta.17→beta.30: beta.30 is Senpi `2026.8.30-3` hotfix only; release explicitly reports `No omo-side commits`.
- beta.31→beta.50: external release audit identified model-chain convergence, Astra/Fable catalog changes, tool/permission changes, CodeGraph packaging removal, Bun 1.4.x packaging, and background/compaction state changes; these require upstream-source confirmation before implementation.
- `packages/omo-opencode/src/index.ts` + `create-plugin-module.ts` (beta.17): no memory imports; memory `memory.enabled` consumed only in `packages/omo-senpi/src/components/memory/wiring.ts`.
- beta.11 adds `permission.task` respect on OpenCode side (item 34) and LSP out-of-CWD fix (item 37) — both positive for AI-EngKit.
- `src/admin/lib/agent-model-config.ts` `buildJqWriteCommand`: writes `model`+`variant`, deletes `models`/`fallback_models` — Admin never writes a fallback chain.

## Related Files

- `Dockerfile` (`ARG OH_MY_OPENAGENT_VERSION`)
- `.opencode/omo.jsonc.default`
- `entrypoint.d/02-init-config.sh`
- `entrypoint.d/lib-omo-model-defaults.bash`
- `entrypoint.d/lib-native-agent-overrides.bash`
- `src/admin/lib/agent-model-types.ts`
- `src/admin/lib/agent-model-config.ts`
- `src/admin/lib/agent-models.ts`
- `.opencode/scripts/check-versions.sh`
- `.github/workflows/dependency-update.yml`
- `.opencode/skills/check-updates/SKILL.md`
- `docs/knowledge/patterns/omo-fallback-model-config.md`
- `docs/knowledge/patterns/omo-agent-permission-defaults.md`
- `docs/knowledge/patterns/version-management-pipeline.md`

## Tags

- oh-my-openagent
- omo-v5
- upgrade-impact
- dependency-pinning
- opencode-plugin
- lean-ctx
- breaking-change
- config-migration
