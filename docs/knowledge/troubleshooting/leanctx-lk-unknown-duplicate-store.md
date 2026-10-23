# LeanCTX LK Unknown from Duplicate Project Stores (Quarantine Repair)

## Context

Projects page `LK` badge reflects a LeanCTX project-scoped scan over
`~/.local/share/lean-ctx/knowledge/*/knowledge.json` inside ai-dev, matched by
exact canonical `project_root` (`workspaceRoot=/home/devuser/workspace`).
`Sync`/`Re-scan` cannot fix `unknown` because they never touch the store.

## Problem

- `unknown` when one root matches **>1 stores**, zero matches with a global
  unreadable/empty-root record, or hash/count validation fails
  (`src/admin/lib/leanctx-project-status.ts`).
- Observed: `ai-engkit` had 2 stores, `everplast-it` had 2 stores, plus one
  `project_root=""` record polluting the global `unreadable` flag.

## Solution

- `POST /api/projects/leanctx/repair` with `{ "project": "<name>" }` (omit for
  full sweep): quarantine-only repair, never delete or merge facts.
- Keeps the `updated_at` newest duplicate; moves the rest to
  `$base/quarantine/<timestamp>-<hash>/` via `mv`.
- Hash guard: move only when `project_hash == directory basename`, else refuse
  with `retry:true`.
- Empty/non-string `project_root` records are always isolated.
- Clears the 300s `leanCtxCache` via `toolStatus.invalidate()` after repair.
- Drawer shows `Repair` only when LeanCTX state is `unknown`; UI stays
  English-only (`Repair` / `Repairing...` / `LeanCTX repair failed`).

## Why It Works

- Old stores may hold facts the new store lacks, so quarantine preserves data
  while restoring a single exact-match hit (`hash_ok:true, bad=0`).
- The scan derives `unknown` from match count and the global unreadable flag,
  so removing the extra/empty records flips `unknown -> available` without
  touching facts.

## Side Effects / Tradeoffs

- Repair is diagnose-and-isolate, not merge: rescued facts need a separate
  key+value dedup (facts have no id field).
- Full sweep repairs every workspace root; single-project mode still clears
  global empty-root pollution.

## Evidence

- Before: double match `matches:2, bad=1` -> after: single match
  `hash_ok:true, bad=0`, `parseLeanCtxProjectScan` returns `available`.
- `bun test` 108 pass; `tsc --skipLibCheck` no new errors; synthetic temp-HOME
  double-store e2e `before:unknown -> after:available`.

## Related Files

- `src/admin/lib/leanctx-project-status.ts` — `buildLeanCtxRepairCommand`
- `src/admin/routes/projects.ts` — route, validation, `invalidate()`
- `src/admin/static/projects-page.js` — `renderLeanCtxSection` / `repairLeanCtx`
- `src/admin/lib/leanctx-project-status.test.ts` — duplicate-newest, empty-root, single-untouched
- `docs/knowledge/patterns/admin-ui-english-only.md` — English-only UI policy

## Tags

`leanctx` `lk-badge` `duplicate-store` `quarantine` `repair` `projects-page`
