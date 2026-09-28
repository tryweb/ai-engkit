# Cell 2B — #8768 Fork Load Test on OpenCode 2.0.15

> Branch: `trial/opencode-v2` | Date: 2026-09-28 | Env: `ai-engkit-v2` (OpenCode 2.0.15 + OpenChamber 2.0.0, plugin-free, no `~/.omo/omo.jsonc`)
> Deliverable: this notes file only. All experiment artifacts live inside the trial container (`/tmp/omo-v2-fork/`, workspace volume `workspace-v2`) or the disposable `-v2` volumes. No repo source files touched.

## 1. Source & Build

| Item | Fact |
|---|---|
| Upstream PR | `code-yeongyu/oh-my-openagent#8768` `feat(opencode-v2): full V2 runtime over V1 assembly` — OPEN, author `airshakur88` (3rd iteration after #8766/#8767), CI green, zero maintainer reviews |
| Tested ref | Fork `Hallaxius/oh-my-openagent` branch `Hallaxius/feat/opencode-v2-runtime`, pinned commit `aada48e7a3c59009a3dc4ddc8995f86a12b8309b` (2026-09-23, "Merge branch 'dev' (root @opencode/plugin v2 upgrade)"). Note: branch name carries the `Hallaxius/` prefix; bare `feat/opencode-v2-runtime` does not resolve |
| Dual export | `packages/omo-opencode/src/index.ts`: default export spreads `Plugin.define({ id: "oh-my-openagent", setup: createV2Setup() })` plus legacy `server` — one bundle loads on V1 (`server()`) and V2 (`setup()`) |
| Bundle build | `bun build packages/omo-opencode/src/index.ts --outdir dist --target bun --format esm --external zod --external @opencode/plugin` → `dist/index.js` 6.0 MB, 2037 modules, builds clean in trial container |
| Unit tests | `bun test packages/omo-opencode/src/v2/` → 0 pass / 9 fail — **environment, not code**: global `test-setup.ts` calls `ensureVendoredLspDaemonBuilt` which shells `npm ci`, and the trial image has no `npm` binary. Verdict on test claims (354 pass upstream) could not be reproduced here; needs an image with npm or a setup bypass |

## 2. Registration (Local Plugin Path)

- Bundle copied to trial workspace `/home/devuser/workspace/.opencode/plugins/omo-fork.js` (+ `node_modules` symlink → fork `node_modules` for externals `zod`, `@opencode/plugin`).
- V2 auto-discovery picked it up with no config entry (`opencode.json` keeps `plugin: []`, `plugins: null`): `loading plugin id=.../omo-fork.js` + file watcher subscribed.
- `opencode plugin list` (cwd=workspace) confirms: `oh-my-openagent  local  /home/devuser/workspace/.opencode/plugins/omo-v2.js`.
- `opencode plugin check` reports "No package plugins found" — it only audits npm packages, not local files. Expected, not a failure.

## 3. Two Loader Traps Found (Both Reproducible)

**T1 — Assets must exist at FIRST discovery.** The bundle reads `skills/<name>/SKILL.md` relative to its own location at import time. First load (assets absent) correctly failed ENOENT. Fix used here: `skills/` staged next to the bundle (real copy of `packages/shared-skills/skills/`, 7.2 MB; a symlink works identically — verified readable). Proper install procedure must stage assets *before* the loader first sees the file.

**T2 — ESM failed-evaluation cache replays the first error.** After staging assets, touching the same filename re-triggered `loading plugin` but returned the *identical* ENOENT three times in a row, although the file verifiably existed (direct `head`/`cat` in-container succeeded). Control experiment: minimal `probe.js` plugin reading a sibling file in the same directory returned `read-ok` — so no filesystem sandbox is involved. Copying the byte-identical bundle to a **new filename** (`omo-v2.js`) loaded clean immediately. Conclusion: the failed first evaluation is cached per module URL; filename change (or server restart) is required after fixing the underlying cause. Do not debug "persistent ENOENT" on a poisoned path — rename and re-observe.

## 4. Setup Report (Decisive Evidence)

The fork logs to its own file (`oh-my-opencode.log`, `LOG_FILENAME`; not `opencode.log`), found at `/tmp/oh-my-opencode.log`. On the fresh-discovery load, `setup()` ran to completion with defaults (no `omo.jsonc` anywhere — `loadOmoConfig` merges `DEFAULT_RAW_CONFIG`):

| Step | Result |
|---|---|
| config, i18n, stores, compat-client, event-bus, managers, tools-assemble, hooks-assemble, v1-surface, dispose-wired | ok |
| tools-register | ok, `registered=14` (registry built with `teamModeEnabled: false`, `teamToolCount: 0`) |
| hooks-register | ok, `deferred=command.execute.before,tool.definition` |
| commands-register | ok, `registered=7` |
| skills-register | ok, `registered=0` |
| providers | ok, `deferred: opengateway injection is installer-level, host providers used as-is` |

Totals: `toolsRegistered: 14`, `commandsRegistered: 7`, `skillsRegistered: 0`. Zero ERROR/WARN in `opencode.log` after load.

Notable honest skips (logged by the fork itself, matching known V2 constraints): `chat.params` (model readonly in V2 context hook), `tool.definition` (descriptions fixed at `tool.add`), `command.execute.before` (guards live in V2 command bodies). `directory-agents-injector` auto-disabled on 2.0.15 (native agent support). `nativeSkills` unavailable (no generated client).

## 5. Verdict

- **Discovery: YES.** V2 lists the fork as a loaded local plugin.
- **Import: YES**, subject to T1 (stage assets first) + T2 (fresh filename after any failed load).
- **Setup: YES**, all steps green with zero config — 14 tools + 7 commands registered, no crash, no warnings.
- **Not proven here:** hook-bridge *true behavior* (compaction, context rewrite under real sessions), the 11-agent OMO roster (agents come from `omo.jsonc`, absent by design in Cell 1 baseline; Cell 1 native agents cover that axis separately), and any inference round-trip (no model call made — provider quota untouched).
- **Unit-test claims:** not reproducible in this image (missing `npm`); needs follow-up, not a code verdict.

## 6. Next

- Cell 5 fork decision now has load-level evidence: the bridge is real, maintained-by-community, loads+setups clean. Remaining risks are upstream-merge uncertainty (unchanged) and behavioral depth (needs an inference session: OMO hook firing, subagent routing, fallback).
- If the fork is adopted even transitionally, package it properly (npm tarball with staged `skills/` + deps, installed via `plugins: [{package, options}]`) instead of the file-copy used here — the file-copy was a test harness, not an install method.
- Suggested immediate follow-up (cheap, no inference): restart managed `opencode serve` once and confirm the plugin loads from cold start with assets pre-staged (validates the T1 procedure end-to-end).
- Suggested deferred follow-up (spends quota): one minimal prompt session in trial, then grep `/tmp/oh-my-opencode.log` + `opencode.log` for hook firing (`session.hook("context")`, tool bridges) — that is the true Cell 2b completion criterion for hook-bridge claims including compaction.

## 7. Technical Line: Failed Inference as Probe (2026-09-28)

Three `opencode run` attempts (default model, `openrouter/...:free`, `opencode/big-pickle`) all died pre-inference: expired keys ×2, Console free-tier gate ×1 (`docker exec` CLI counts as outside OpenCode). Zero quota spent. The failures still drove real prompt flows — and the hooks fired:

- `[omo-v2][hook-bridge] context bridge failed` ×2 on real session IDs — wiring confirmed live, but the error object is empty (`{}`), so failure mode is opaque.
- `[todo-continuation-enforcer] session.error`, `[auto-compact] session.error`, `[atlas] session.error` + `session.idle` (then skipped, not in boulder) — error/idle fan-out works.
- **DEFECT 1 (blocking): all 14 bridged tools rejected server-side**: `Skipping invalid tool registration ... Invalid tool definition <name>: undefined is not an object (evaluating 'seen.ref')` (seen for `call_omo_agent`, `look_at`, `task`, `skill_mcp`, `skill`, `interactive_bash`, `grep`, `glob`, …). Fork-side "tools-register ok (14)" ≠ server-accepted. Effective usable fork tools on 2.0.15: **0**. The `tool-bridge` does not satisfy the V2 tool identity contract.
- **DEFECT 2 (unisolated): context bridge failed on both real sessions.** Possibly fallout of immediate provider-auth failure rather than bridge bug — cannot distinguish without one successful inference. The fork's empty error object makes this permanently undecidable from logs alone; needs either a working key or fork-side error transparency.

Updated verdict: load + setup green stands; hook **wiring** confirmed firing; hook **fidelity** fails on open evidence — tools unusable as-bridged, context bridge errors on real flow. As a transitional carrier, #8768 needs fork fixes (tool-definition `seen.ref` contract first, error transparency second) or an explicit scope cut to commands-only (7 registered, server-accepted — the only contribution verified end-to-end loadable).

Standing blocker: one working provider key in trial. All three trial keys are dead (openrouter/nvidia/google present-but-expired per smoke tests; big-pickle gated to in-OpenCode UI sessions). Key refresh belongs to whoever holds the billing — not touched here. With a live key, the next probe is single-prompt + grep both logs for `context` success and tool execution; that closes hook fidelity, compaction stays deferred (needs long session).

## 8. Key Chase: Trial Has No Billable Inference Path (2026-09-29)

Metadata-endpoint probes (zero spend, secrets never printed): **openrouter 401** (dead), **google 401** (dead), **nvidia 200** on `/v1/models` (81 models listed) but **403 on every invoke** (`gemma-3-4b-it`, `gemma-3-12b-it`); `dbrx-instruct` / `nemotron-70b` aren't even in opencode's nvidia catalog ("Model unavailable"). `opencode/big-pickle` has no key and Console free tier rejects `docker exec` CLI sessions. Net: **no working inference in trial; everything failed pre-inference, zero quota spent.**

Rotation runbook (for billing owner): keys live in trial `auth.json` (`opencode-data-v2` volume) fed by the Admin provider-keys registry (`admin-data/provider-keys.json`) + `.env` `OPENCODE_PROVIDER`. Rotate via Admin Providers page (registry → auth store → container restart) or direct volume edit. What unblocks M2 E2E + M3 live probes + hook fidelity: any ONE key with inference entitlement, or opencode Console OAuth via UI (free tier passes parent sessions per 09-25 evidence).
