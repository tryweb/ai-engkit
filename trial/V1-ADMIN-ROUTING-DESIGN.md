# V1 Admin Agent Models: OMO to Native Routing

**Branch:** `trial/v1-native-agents-poc`  
**Scope:** Admin backend design and minimum implementation sequence for 12 native agents.  
**Compatibility constraint:** Do not change the existing Admin UI or the JSON response shape of `GET /api/agent-models`.  
**Out of scope:** entrypoint changes, agent markdown, commits, pushes, and validation on `.61`.

## 1. Decision and minimum path

The v2 design in `origin/v2:trial/ADMIN-NATIVE-DESIGN.md` is the source for the routing schema and write discipline. Its directly reusable decisions are:

- §1: replace the OMO config source with `~/.config/opencode/routing.json`; preserve the existing live `/agent` and `/provider` probes; expose the 12 native names; keep the Admin view's existing fields.
- §3: store ordered chains under `chains[agent].chain`, use jq bracket lookup (`.chains[$agent]`) for hyphenated names, write through a same-directory temporary file then atomic rename, and snapshot all files touched for rollback.
- §4: the old OMO-to-OpenCode native override sync is not part of the native path. OpenChamber's existing model selection reads OpenCode agent configuration, not OMO; preserve OMO synchronization only on V1.
- §5: accept `chain` as the new request field and `entries` as a compatibility alias; keep the GET payload and apply-result envelopes stable. The first configured entry remains the primary model.

The smallest safe deliverable is a focused backend migration across types, config helpers, agent-model library, and route parsing. It is not a one-function patch: a reader-only or writer-only change would make Admin display stale state or write data it cannot subsequently read. Implement those seams together, and defer reconciler behavior, center-agent protocol, startup migration, and UI polish.

## 2. Runtime gate and retained V1 behavior

Use the explicit `OMO_ENABLED` feature gate already used by the runtime: unset/`1` selects the existing OMO path; exactly `0` selects native routing. Do not silently infer the backend from an OpenCode version probe: this trial targets OpenCode 1.19.x Server API behavior, and version detection would create an unrequested implicit migration. Evaluate the gate in the Admin backend factory/configuration seam once and route all agent-model reads and writes through that selection.

V1 (`OMO_ENABLED` unset or `1`) retains `OMO_CONFIG`, `buildJqWriteCommand`, `readAgentModelsConfig`, `validateFallbackModels`, and `syncNativeAgentOverrides` behavior. V1's existing `general`/`plan` allowlist and tests stay unchanged. Native (`OMO_ENABLED=0`) uses the routing path and 12-agent allowlist. The flag is the single branch point; do not mix OMO reads with routing writes or call the OMO sync function on the native branch.

## 3. Native data contract

Path: `~/.config/opencode/routing.json`.

```json
{
  "version": 1,
  "chains": {
    "plan": {
      "chain": [
        { "model": "provider/model", "variant": "high" },
        { "model": "provider/backup-model" }
      ]
    }
  }
}
```

The configurable native set is exactly `plan`, `prometheus`, `explore`, `oracle`, `librarian`, `multimodal-looker`, `metis`, `momus`, `sisyphus`, `hephaestus`, `atlas`, and `sisyphus-junior`. Preserve spelling/case and use key-indexed jq expressions, never interpolated jq paths. Validate model references using the existing provider/model rule and variants against `VARIANTS`.

Chains contain 1–10 entries when configured. An empty array remains the existing clear operation; reject more than 10. Accept `chain` preferentially when present, otherwise accept `entries` as an alias. If both are supplied, reject the ambiguous body rather than guessing. Keep the legacy `entries` response property in GET: it is currently `agents[].configured`, an array of `{model, variant?}` values, not an input-field reflection. Populate it with the entire chain in order. Existing consumers reading `[0]` continue to see the primary.

## 4. API compatibility and apply semantics

`GET /api/agent-models` remains `{agents, catalog, providers, hasPassword, catalogAvailable, historyTruncated?, historyWarning?}`. Do not add required fields, rename `configured`, or modify `src/admin/views/agent-models.tsx` for this PoC.

Batch PUT accepts either `{changes:[{agent, chain:[...] }]}` or the existing `{changes:[{agent, entries:[...] }]}`. Single PUT accepts either `{chain:[...]}` or `{entries:[...]}`. `results: Record<agent, ApplyResult>` and the single `ApplyResult` remain unchanged. Verification continues to compare the resolved runtime model against chain entry zero; fallback entries are persisted, not independently declared applied.

Keep request shape errors (wrong/missing fields, malformed entry, >10) as 400. Keep live-agent, catalog, and server-password gates. For a valid batch, report write/verification outcomes per agent in the existing `results` object; one invalid/unwritable agent must not prevent valid agents from being attempted. Do not claim native fallback execution is verified by `/agent`: it only verifies the primary assignment. The live fallback runtime remains dependent on the routing consumer/plugin, outside this Admin-only increment.

## 5. Exact implementation sequence by symbol

These are the minimum code changes required before enabling `OMO_ENABLED=0`; the current multi-file snapshot/restart/verify flow makes a smaller partial patch unsafe.

1. `src/admin/lib/agent-model-types.ts`
   - Add `ChainEntry`/routing config types and `ROUTING_CONFIG`.
   - Add the 12-name constant without changing the V1 `CONFIGURABLE_NATIVE_AGENTS` value used by OMO mode.
   - Keep `FallbackModelEntry` compatible as the UI-facing `{model, variant?}` shape or make it a structurally compatible alias.
2. `src/admin/lib/agent-model-config.ts`
   - Keep `validateFallbackModels` and `buildJqWriteCommand` intact for V1.
   - Add chain validation (0–10 for PUT clear semantics; configured routing-file chains must be 1–10), routing JSON parsing, and `buildRoutingWriteCommand`.
   - The writer must preserve unrelated top-level fields, set/delete `.chains[$agent]`, shell-quote path/agent inputs, and use `mktemp` in the target directory, `jq`, restrictive permissions, cleanup-on-error, and `mv`.
3. `src/admin/lib/agent-models.ts`
   - In `createAgentModelsLib`, branch `readAgentModelsConfig` to a routing reader when native mode is selected and map each `chains[name].chain` to the existing config/view representation.
   - Branch `writeAgentFallbackModels` and the write section of `applyAndVerifyBatch` to routing writes.
   - Replace the single OMO snapshot with snapshots for every native file written; rollback restores each snapshot atomically and performs the existing recovery restart after a failed restart/verification.
   - `syncNativeAgentOverrides` remains exclusively in the OMO branch. Native mode must not read OMO or invoke it. Native chain head is not separately copied to `opencode.json` in this increment; the routing consumer owns chain selection. If the consumer requires a static OpenCode pin, that is a separate, explicit follow-up rather than an implicit second source of truth.
   - Update `collectAgentModelState` to use the selected backend's agent allowlist and expose the full chain as `configured`; leave all other response properties and the effective/resolved calculation intact.
4. `src/admin/routes/agent-models.ts`
   - Update `validateBatchBody` and the single PUT parser to normalize `chain`/legacy `entries` to the existing internal `entries` array (no route/UI payload churn).
   - Apply the 10-entry bound and use the selected native-agent allowlist in native mode. Keep GET response fields unchanged.
   - Ensure every change passed to `applyAndVerifyBatch` preserves the full ordered chain.
5. `src/admin/lib/agent-model-reconciler.ts`
   - For this minimal PoC, do not auto-heal/write chains from the reconciler. Its OMO-dependent suggestions/reconcile behavior must be disabled or explicitly kept on the OMO branch while native mode is active; never allow a periodic OMO reconciliation to overwrite a native chain. Full routing-aware healing is a later increment.
6. Do not modify `src/admin/agent/commands.ts` in this increment. Center-agent `agent-models.set` stays OMO/V1 until its request parser and dependency factory receive the same alias and gate treatment; do not claim it supports native chains yet.

## 6. `syncNativeAgentOverrides` decision

Keep `syncNativeAgentOverrides()` and its call only in the V1/OMO apply path. Its data source is `omo.jsonc`; invoking it after a native routing write would either reintroduce an OMO read or erase/replace native state. Do not broaden it to 12 agents: it is a compatibility bridge for V1's two-name behavior, not a native routing writer. On native mode, routing chain persistence is authoritative, and the `/agent` check covers the primary only. `opencode.json`/agent markdown mutation is intentionally not included.

## 7. Atomic writes and rollback

Native apply sequence: validate all request data; snapshot `routing.json`; write each valid agent's chain via an atomic same-directory temporary file and rename; restart once; verify each chain head using the existing readiness/inference path. A write failure restores the snapshot and returns `write_failed` (or `rollback_failed` if restoration fails). Restart failure restores and restarts the prior config. A hard verification failure follows the existing rollback policy. Do not rollback merely for quota warnings or an unverifiable timeout that may still be running; preserve the existing timeout result semantics and make the final state explicit.

Routing-only rollback is sufficient because this increment deliberately does not write `opencode.json`, agent markdown, or entrypoint state. Snapshotting/restoring just one file avoids a cross-file partial commit. A future implementation that adds native pin writes must expand the transaction to snapshot and restore both files before shipping that path.

Rollback to V1 is operational: set `OMO_ENABLED=1` (or unset it), restart Admin/ai-dev, and use the untouched OMO store. Native routing data is left intact and ignored by V1. Do not auto-convert routing chains back into OMO; do not prune the OMO volume. This gives a reversible flag rollback without lossy chain-to-single-model conversion.

## 8. Tests to add/update

Add routing-focused shell tests; keep all existing OMO tests and assertions intact for V1.

- `test/test-routing-config.sh`: parse valid chains, reject malformed model entries, configured chain lengths 0/11, accept exactly 1/10, preserve unknown fields, and round-trip `multimodal-looker`/`sisyphus-junior` keys.
- `test/test-routing-writes.sh`: write and clear through temp+rename; verify unrelated chains survive; force jq/write failure and verify original routing file remains parseable and unchanged.
- `test/test-routing-api.sh`: GET response top-level and per-agent keys remain UI-compatible; single and batch PUT accept both `chain` and legacy `entries`; confirm 10 accepted/11 rejected and `results` envelope remains unchanged.
- `test/test-routing-rollback.sh`: inject write/restart/verification failure and verify the routing snapshot is restored; include one successful and one failing batch agent to protect per-agent isolation.
- Keep `test/test-agent-model-e2e.sh`, `test/test-native-agent-overrides.sh`, `test/test-omo-config-normalization.sh`, and existing OMO tests unchanged and runnable under V1. Do not rename or repurpose them.
- No `.61`/live-provider assertion is part of this task. Run only local checks and report them accurately.

## 9. Explicit later work / risk register

- **Fallback execution:** Admin can store/display a chain, but live failover is not proven until the native routing consumer reads it and handles failure events. The Admin's primary `/agent` check is not proof of fallback execution.
- **Reconciler:** disabling its OMO-backed write path in native mode is required to avoid clobbering; native-aware healing/suggestions are deferred.
- **Center-agent:** `commands.ts` does not gain native support until separately migrated; direct Admin HTTP endpoints are the supported path in this PoC.
- **Per-agent batch isolation:** current route validates a whole batch before apply, while current library writes as one `&&` transaction. Changing that to independent outcomes touches request types, snapshots, and result semantics; test it before enabling it.
- **Catalog availability:** retain current catalog hard gates initially. An empty-at-boot catalog can reject a model that would otherwise work; soft-warning behavior needs a separate product decision.
- **Native pin precedence:** no writes to `opencode.json` or `.opencode/agents/*.md` avoids stomping the CELL1 agent definitions, but means runtime chain-head behavior depends on the routing consumer being loaded in the 1.19.x trial image.

## 10. Acceptance gate

Before setting `OMO_ENABLED=0` in a trial deployment, require the routing config/write/rollback/API tests above, TypeScript diagnostics for touched files, and the Admin test target. Preserve old OMO tests. Validate runtime behavior on the intended trial host in the next track; this design records no `.61` validation result.
