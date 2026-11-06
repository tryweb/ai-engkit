# Native Agent Bridge Reconcile Race (OMO → opencode.json Stale After Startup Reconcile)

> **Historical OMO-era note:** This document describes the former OMO-backed native
> bridge and is retained as incident history. The native path no longer migrates
> or syncs from `omo.jsonc`; native startup seeds agent heads from `routing.json`,
> and automatic model reconciliation is disabled in native mode.

## Context

`ai-dev` startup has two phases that must agree on native agent models (`general`, `plan`):

* `ENTRYPOINT` → `entrypoint.d/02-init-config.sh` regenerates `~/.config/opencode/opencode.json` from env defaults, initializes `~/.omo/omo.jsonc` via `initialize_omo_permissions`, normalizes it, then calls `merge_native_agent_overrides` to copy `omo.agents.<name>.model` → `opencode.json:agent.<name>.model`.
* `CMD` → `openchamber serve && /opt/ai-engkit/scripts/reconcile-agent-models.sh && exec openchamber logs` waits for `managed-opencode` lifecycle/health and runs `RECONCILE_STARTUP_NO_RESTART=1 bun run /opt/admin/lib/agent-model-reconcile-cli.ts`, which may write a new `agents.general.model` (e.g. `opencode/mimo-v2.5-free` when only `opencode` provider is connected) without restarting.

`test/run-tests.sh:633` asserts file equality:

```
OMO_GENERAL_MODEL=$(jq -r '.agents.general.model // empty' ~/.omo/omo.jsonc)
OPCODE_GENERAL_MODEL=$(jq -r '.agent.general.model // empty' ~/.config/opencode/opencode.json)
assert_eq "general native model matches persisted OMO override" "$OMO_GENERAL_MODEL" "$OPCODE_GENERAL_MODEL"
```

Admin `PUT /api/agent-models` uses the same `src/admin/lib/agent-models.ts:applyAndVerifyBatch` (snapshot → jq write → restart → verify → rollback) and previously did not touch `opencode.json`.

## Problem

* `0824697 fix(entrypoint): preserve native OMO overrides after setup` moved `merge_native_agent_overrides` after `lean-ctx setup/init` to avoid `lean-ctx init --agent opencode` clobbering `opencode.json`. It fixed the **generation order** race but not the **post-generation reconciliation** race.
* Startup reconcile runs **after** the ENTRYPOINT bridge. With `RECONCILE_STARTUP_NO_RESTART=1` it writes `~/.omo/omo.jsonc:agents.general.model = "opencode/mimo-v2.5-free"` (selected by `src/admin/lib/agent-model-reconciler.ts:score(general)` + `probeModel=healthy` on the connected catalog) and never syncs `opencode.json`. Until the next container restart `OMO="opencode/mimo-v2.5-free"` vs `opencode.json=""` → CI `FAIL general native model matches persisted OMO override (expected='opencode/mimo-v2.5-free', actual='')`.

Reproduces reliably in CI because `.github/workflows/ci.yml` override mounts only 6 volumes and omits `omo-config-dev:/home/devuser/.omo`, so every `down -v` run recreates `omo.jsonc` from `/etc/opencode/omo.jsonc.default` (which has no `general`) and reconcile always creates the divergence. The 60s `sleep` before `test/run-tests.sh` also races `PROVIDER_WAIT_SECONDS=120`.

Same divergence occurs on Admin UI apply: OMO is updated and server restarted, but `opencode.json` native section was never updated, requiring a second manual restart to become effective.

A later Admin implementation added the pre-restart sync but still produced a misleading failure. Its source path was `"~/.omo/omo.jsonc"`; POSIX shells do not expand `~` inside double quotes. The command then ended with `|| rm -f "$tmp"`, so a successful cleanup replaced the failed `jq` exit status with zero. Apply continued to restart and verify, even though the native override was stale, and returned `unverified` or `runtime_mismatch` after the OMO write had succeeded.

## Solution

Make every OMO write a single-source sync point, reuse the existing bridge implementation:

1. **`scripts/reconcile-agent-models.sh`** — add `sync_native_overrides()` that sources `lib-native-agent-overrides.bash` (probing `/entrypoint.d/`, `../entrypoint.d/`, `/opt/ai-engkit/entrypoint.d/`) and calls `merge_native_agent_overrides "$HOME/.config/opencode/opencode.json" "$HOME/.omo/omo.jsonc"`. Call it immediately after a successful `RECONCILE_STARTUP_NO_RESTART=1 bun run ...` in the main retry loop and in the deferred 60s background retry.

2. **`src/admin/lib/agent-models.ts`** — `syncNativeAgentOverrides()` executes the same `jq -s '.[0] as $opencode | .[1] as $omo | reduce ["general","plan"][] ...'` via `deps.exec` (inside `ai-dev` via `execInAiDev`). Use `"$HOME/.omo/omo.jsonc"`, never a quoted `~`, and preserve the failing command status across cleanup (`code=$?; rm -f "$tmp"; exit "$code"`). Call it after the OMO write and before restart. If sync fails, restore the OMO snapshot, skip restart, and return `write_failed` or `rollback_failed`; do not continue into runtime verification with divergent files.

3. **`test/run-tests.sh:631`** — make `G1` eventual-consistent: retry 60×5s (300s, `for _ in $(seq 1 60); do ... [ "$OMO" = "$OPCODE" ] && break; sleep 5; done`, logging `waiting for native bridge sync: OMO='...' OPCODE='...' (attempt $_/60)`) before `assert_eq`, documenting `provider 120s + lifecycle 120s + 3×30s retry + deferred 60s = 9m43s observed in CI (33217760918: OMO ready 22:48:32, reconciled 22:51:16, 150s window missed by 15s)` vs startup race. Initially 6×5s then 30×5s (150s) still failed; 60×5s (300s) finally covered the 9m43s total from container start (22:41:33) to reconciled.

Do not add new allowlists, new env vars, or new config keys. Keep the bridge jq (`^[^/[:space:]]+/[^/[:space:]]+$`, variant handling, `del(.agent[$name])` on clear) as the single truth.

## Why It Works

* `openchamber serve` reads native models from `opencode.json:agent.<name>.model`. The bridge is the only translation of persisted `omo:agents.<name>.model` to that boundary. Running it once at ENTRYPOINT is necessary but not sufficient — any later OMO mutation (startup reconcile or Admin apply) must re-run the same translation before the next health check or test observation.
* Startup reconcile is intentionally `NO_RESTART` to avoid the `managed-opencode health timeout` (`e08fc5d` 180s lifecycle race). Syncing the file without restarting gives `G1` file equality now; runtime `G2` (actual `general` child `providerID/modelID`) still requires a restart, which the eventual-consistency test correctly separates from file equality.
* The TS-side sync via `deps.exec` guarantees Admin apply (which runs in `ai-admin` but mutates `ai-dev` via `execInAiDev`) also converges without requiring the caller to know the shell path.

## Side Effects / Tradeoffs

* File sync without restart means `G1` passes but managed server still serves the previous native model until next restart. This is intentional for `NO_RESTART` startup; document as `G1 ≠ G2`.
* Double sync (TS `deps.exec` + shell `sync_native_overrides`) is idempotent; no harm if CLI is invoked outside the shell wrapper.
* Native sync failure is now blocking for Admin Apply. This avoids false verification results but means a missing/corrupt native config prevents Apply until the bridge can complete.
* Restart or probe-recovery rollback currently restores OMO but does not immediately re-sync the native file. This is not a false success—the result remains failed—but can leave transient OMO/native divergence until the next successful apply or startup bridge.
* Test retry masks a 0-300s window where OMO has been written but shell sync hasn't yet run. If retry still fails after 300s, the sync itself has failed or provider wait exceeded 300s, not the race. 30×5s (150s) was still 15s short of the 9m43s total (22:48:32→22:51:16) in 33217760918.
* The startup shell bridge still soft-fails with a warning. Admin Apply deliberately differs: its API result must reflect native sync failure. Loop variable `$_` in `for _ in $(seq ...)` expands to last arg, so log shows `attempt ]/60` — harmless, but prefer `i` for readability.

## Evidence

* CI failures: `FAIL general native model matches persisted OMO override (expected='opencode/mimo-v2.5-free', actual='')` at `test/run-tests.sh:633` — `33212331089` (21:32:10, no retry) and `33217760918` (22:51:06, 30×5s=150s still 15s short; waiting 22:48:32→22:51:01 with `OPCODE=''` all 30 attempts, `reconciled: changed=9 applied=5 failed=4` at 22:51:16).
* CI success: `33218488569` (22:53:26→23:03:40, 60×5s=300s) — `PASS general native model matches persisted OMO override` with `130 passed, 0 failed`; waiting 23:00:36→23:03:25 (~174s) then `PASS` at 23:03:30; `reconciled: changed=9 applied=5 failed=4` still at 22:51:16-equivalent but now within window.
* Local dev `ai-engkit-dev` after `docker compose build/up`: `docker exec` shows `OMO=opencode/mimo-v2.5-free` / `OPCODE=opencode/mimo-v2.5-free` and `plan=opencode/big-pickle`; `test/run-tests.sh` local `130 passed`.
* Local `test/test-native-agent-overrides.sh` — 11/11 pass after change (general/plan merge, variant, clear, allowlist, invalid model, corrupt JSON).
* `entrypoint.d/02-init-config.test.sh` — `AGENTS sync tests passed`, `exit 0` after change (lite migration tests also pass).
* `bun test src/admin/lib/agent-models.test.ts` — 31 pass, 0 fail.
* `bun test src/admin/lib/agent-model-reconciler.test.ts` — 6 pass, 0 fail (decisions: `configure_candidate` for `general`/`plan` when catalog `opencode/mimo-v2.5-free` healthy).
* Regression verification after making Admin sync failure blocking: 70 pass, 0 fail across `src/admin/lib/agent-model-config.test.ts`, `src/admin/lib/agent-models.test.ts`, `src/admin/routes/agent-models.test.ts`, and `src/admin/routes/agent-models-list.test.ts`. The failure-path test asserts `write_failed`, no restart, and snapshot restore when native sync fails.
* Authenticated dev batch Apply for `general → opencode/mimo-v2.5-free` returned `status: "verified"`; both `resolved` and `requestVerified` were `opencode/mimo-v2.5-free`. `docker exec` confirmed the same model in `~/.omo/omo.jsonc:agents.general` and `~/.config/opencode/opencode.json:agent.general`.
* `git show 0824697` — prior fix moved merge after `lean-ctx init`; `git show e08fc5d` — added `RECONCILE_STARTUP_NO_RESTART=1` + 3×30s retry + deferred 60s retry.
* New diffs: `7c525c2` (+23/+10/+9) then `c14a6bf` (6→30×5s) then `aef82be` (30→60×5s=300s) — final `test/run-tests.sh` 60×5s window covers observed 9m43s total (22:41:33 start → 22:51:16 reconciled).

## Related Files

* `entrypoint.d/lib-native-agent-overrides.bash` — single-source `merge_native_agent_overrides` (allowlist `["general","plan"]`, `provider/model` regex, variant handling).
* `entrypoint.d/02-init-config.sh:338` — ENTRYPOINT bridge call site (now correctly after `lean-ctx init` per 0824697).
* `scripts/reconcile-agent-models.sh:10-27` — `sync_native_overrides()` helper and post-CLI calls.
* `src/admin/lib/agent-models.ts` — checked `syncNativeAgentOverrides()` and the snapshot/write/sync/restart/verify flow in `applyAndVerifyBatch`.
* `src/admin/lib/agent-models.test.ts` — quoted-tilde and native-sync failure regressions.
* `src/admin/routes/agent-models-test-support.ts` — route fixture support for the native sync command.
* `src/admin/lib/agent-model-types.ts:59` — `OMO_CONFIG="~/.omo/omo.jsonc"`, `CONFIGURABLE_NATIVE_AGENTS=["general","plan"]`.
* `src/admin/lib/agent-model-reconciler.ts:183` — `selectCandidate` capability scoring for `general`.
* `test/run-tests.sh:631` — eventual-consistency retry for `general native model` assertion.
* `test/test-native-agent-overrides.sh` — unit coverage for merge.
* `Dockerfile:285,345` — `COPY scripts/reconcile-agent-models.sh` + `CMD openchamber serve && ...reconcile... && exec logs`.
* `.github/workflows/ci.yml` — override missing `omo-config-dev` volume (amplifies reproduction).
* `docs/knowledge/patterns/native-agent-model-override-bridge.md` — original bridge design.
* `docs/knowledge/architecture/connected-provider-model-reconciliation.md` — connected catalog + readiness.
* `docs/knowledge/troubleshooting/managed-opencode-health-timeout-during-reconciliation.md` — why `NO_RESTART` exists.

## Tags

* native-agent
* general
* plan
* OMO
* opencode.json
* bridge
* reconcile
* startup-race
* eventual-consistency
* RECONCILE_STARTUP_NO_RESTART
* health-timeout
* CI
