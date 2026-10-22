# LeanCTX LK Unknown from Duplicate Project Stores

## Context

OpenCode Projects page (`src/admin/`) shows per-project badges `K M OS SP CG LK`. `LK` is LeanCTX Knowledge (project-scoped), not the repo `docs/knowledge/` marker (`K`). The `LK` value comes from `GET /api/projects/overview` field `leanctx`, produced by a batched scan of `~/.local/share/lean-ctx/knowledge/*/knowledge.json` inside ai-dev, matched by exact `project_root`.

## Problem

Two projects showed `LK unknown` while others showed `LK`:

- `ai-engkit` (`/home/devuser/workspace/ai-engkit`) had 2 matching stores: `00e284d4a74b77be` (2026-08-08, `f=1`) + `4ab5badcd75082bf` (2026-10-22, `f=30`).
- `everplast-it` (`/home/devuser/workspace/everplast-it`) had 2 matching stores: `29f7bb7d6dbf710f` (2026-10-22, `f=85`) + `e919741a476b7e4e` (2026-07-18, `f=192`).
- An additional store `a8c310cd6fe7f8e9` had `project_root=""`, setting the global `bad=1` / `unreadable=1` flag.

Scan logic (`buildLeanCtxProjectScanCommand`) returns `{state:"unknown"}` when matches `>1`, or when matches `==0` and `unreadable==1`. The parser maps `unknown` to `null`, and the frontend `leanctxState()` renders `null` as `LK unknown`. Git remote and `docs/knowledge/` presence are irrelevant. `Sync` / `Re-scan` does not fix it because it never touches the LeanCTX store.

## Solution

Quarantine (move, never delete) the stale and empty-root store dirs, then invalidate the 5-minute probe cache:

1. Backup: `cp -a` the 5 dirs to `/tmp/lk-unknown-backup-20261023/`.
2. Move aside: `00e284d4a74b77be`, `e919741a476b7e4e` (older `updated_at`), and `a8c310cd6fe7f8e9` (empty root) out of `knowledge/` into `quarantine/<timestamp>-<hash>/`. Keep the newest `updated_at` per root (`4ab5badc`, `29f7bb7d`).
3. Re-run the scan: both roots return single match with `hash_ok:true` (`ai-engkit [30,27,0,97]`, `everplast-it [85,22,0,94]`), `bad=0`.
4. Productized as `POST /api/projects/leanctx/repair` (`src/admin/routes/projects.ts`): validates `project` against `^[a-zA-Z0-9_-]+$` and workspace dir existence, runs `buildLeanCtxRepairCommand()` in ai-dev via `execInAiDev`, only `mv` when `project_hash == dirname`, refuses otherwise with `retry:true`, then calls `toolStatus.invalidate()` to clear `leanCtxCache`. Frontend drawer shows a `Repair` button only when `leanctxState()==="unknown"` (`src/admin/static/projects-page.js`).

## Why It Works

Duplicate `project_root` entries are ambiguous: the overview cannot pick which fact set to project, so `unknown` is the only honest state. Keeping the newest `updated_at` preserves the actively written store (Oct 22 writes go to the new hashes). The `hash == dirname` guard prevents quarantining a record whose directory was renamed by hand. Empty-root records can never match a real root but still poison the `unreadable` flag, so isolating them restores correct `empty` vs `unknown` for zero-match projects.

## Side Effects / Tradeoffs

- `e919741a` held 192 facts vs 85 in the kept `29f7bb7d`; the 107 older facts remain in quarantine (`/tmp/lk-unknown-quarantine-20261023/`), not merged. Restore by moving the dir back if the old facts are needed, then decide on a manual merge.
- Repair does not merge fact arrays, only quarantines. Merging requires dedup by `key`+`value`+`source_session` (facts have no `id` field).
- Admin probe cache TTL is 300s; UI stays `unknown` until `invalidate()` runs (repair does it) or TTL expires.
- `quarantine/` under `~/.local/share/lean-ctx/` grows over time; prune after confirming the kept store stays `available`.

## Evidence

- Pre-fix reproduction: `matches:2` for both roots, `bad=1 unreadable=1` (`/tmp/leanctx-verify-$$.jsonl` script mirroring `buildLeanCtxProjectScanCommand`).
- Post-fix: single match, `hash_ok:true`, `bad=0`; `bun -e parseLeanCtxProjectScan` returns `available` for both roots.
- `bun test src/admin/lib/leanctx-project-status.test.ts src/admin/lib/project-tool-status.test.ts src/admin/routes/projects.test.ts`: 108 pass, 0 fail.
- `git diff --check`: clean. `tsc --noEmit --skipLibCheck`: no errors in touched files. `projects-page.js` has one pre-existing `forEach` return-value diagnostic at line 125, untouched by this change.

## Related Files

- `src/admin/lib/leanctx-project-status.ts` (`buildLeanCtxProjectScanCommand`, `buildLeanCtxRepairCommand`, `parseLeanCtxProjectScan`)
- `src/admin/lib/project-tool-status.ts` (`probeLeanCtx`, `invalidate`, `leanCtxCache`, `DEFAULT_TTL_MS=300_000`)
- `src/admin/routes/projects.ts` (`POST /api/projects/leanctx/repair`, `DEFAULT_WORKSPACE_ROOT`)
- `src/admin/static/projects-page.js` (`leanctxState`, `appendLeanCtxBadge`, `renderLeanCtxSection`, `repairLeanCtx`)
- `src/admin/lib/leanctx-project-status.test.ts` (duplicate-keeps-newest, empty-root, single-untouched)

## Tags

leanctx, admin, troubleshooting, knowledge-store, quarantine
