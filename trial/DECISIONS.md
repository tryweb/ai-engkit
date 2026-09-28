# Phase A Decisions (trial/opencode-v2)

> Status: **PROPOSED** (both items) — authored 2026-09-29 on branch `trial/opencode-v2`. Nothing below is ratified until sign-off; implementation (Phase B+) is gated on D1 + D2.
> Evidence index: `trial/CELL1.md` (no-OMO baseline), `trial/CELL2.md` + `trial/CELL3.md` (diagnostics track), `trial/CELL2B.md` (fork load test), `trial/TODO-SPEC.md` (todo-enforcer self-build spec), `docs/knowledge/tooling/opencode-v2-migration-watch.md` (V2 watch + gate rescope).

## D1 — OMO Route for the V2 Line

### Context (one line)

`oh-my-openagent@4.19.4` (V1 plugin API) cannot load on OpenCode 2.x; upstream has no V2 timeline, so the V2 line must define its agent/hook/model-fallback story without it.

### Options evaluated (all with live evidence, Sep 2026)

| # | Option | Verdict | Evidence |
|---|---|---|---|
| A | Wait for official OMO V2 line | **Rejected** | #6169 stale since 08-25; beta.88 zero V2 work; ROADMAP de-centers OpenCode |
| B | Adopt #8768 community fork (transitional carrier) | **Rejected** | CELL2B: loads + setup green (14 tools + 7 commands), BUT all 14 tools rejected server-side (`seen.ref` contract), context bridge errors on real flow, zero maintainer review, withdraw-precedent (#7104/#7570). Verdict recorded as negative result, not wasted work |
| C | slim (`oh-my-opencode-slim`) on V2 | **Rejected for V2** | Repo-verified 2026-09-29: `master`/`v2.2.25`/`v3.0.0-beta.13` all pin V1 `@opencode-ai/*@1.18.x`; real V2 support is shim-based with an open v2 bug queue (#1247/#1255/#1335). Viable product, wrong contract for a clean V2 line |
| D | Swap to a V2-native plugin | **Rejected** | Ecosystem scan: no mature OMO replacement (only ★1 POCs; high-star orchestration plugins stuck on V1). Usable fragments only (permissions, gateways) |
| E | **Native + self-built thin mechanisms** | **Proposed** | Mechanism matrix: M1 self-config (~0 cost), M2 native agents (built, Cell 1), M3 enforcer self-build (spec ready, `trial/TODO-SPEC.md`), M4 routing/fallback plugin + Admin port (scoped, unstarted). OMO's effectively-used surface is C1–C4 + Admin API; ~40% is zombie (zero prod traffic) |

### Decision (proposed)

- The V2 line carries **no OMO-family runtime**: neither `oh-my-openagent` nor `oh-my-opencode-slim` ships in the v2 image or config.
- Explicitly **out of scope**: slim's fate on the **V1 axis** (paused evaluation per 09-15 disposition — separate decision, undecided here).
- The #8768 evaluation is closed as a negative result; do not revisit without new upstream facts (merge, or fork fix of the `seen.ref` contract + error transparency).

### Consequences (v2 line only; V1 line untouched)

- Keep: 12 native agents, Session Goals/Loops, Code Mode, native permissions/skills, self-configured MCPs (codegraph/lean-ctx/playwright), comment-checker bake.
- Delete: `plugin: ["oh-my-openagent@…"]` generation, `omo.jsonc.default`, `lib-omo-model-defaults.bash`, OMO-side of `lib-native-agent-overrides.bash`, OMO-catalog reconcile paths, 11-agent assertions, `$schema` sync, `OH_MY_OPENAGENT_VERSION`, `omo-config` volume definition.
- Migrate (one-shot, no compat layer): user model choices in `omo-config` volume → native `agent.*`; `OPENCHAMBER_VERSION` 1.x→2.x settings carry-over per OpenChamber's own 1.x→2 path.
- Must-build (gating v2 usability, not optional): B1 routing + fallback plugin (plan/prometheus are single-model single-points-of-failure today), Admin agent-models native rewrite, M3 enforcer MVP per `trial/TODO-SPEC.md` (after M2 E2E proves the live-key path).
- Retire: `slim` branch disposition → superseded (archive preserved); OMO V2 watch items (#6169, beta line) → closed.

### Acceptance

- [ ] User sign-off on this file (status → ACCEPTED, dated).
- [ ] M2 E2E (native subagent delegation, one live-key task) green — proves the line can do work before anything is deleted.
- [ ] B1 routing + fallback green — proves no reliability regression vs V1.

## D2 — Release Lines (v1.x maintenance + v2.x trial)

### Decision (proposed)

- **Two coexisting lines.** `v1.x` (current `main`, OpenCode 1.18.x + OMO 4.19.4) stays the production line with patch maintenance. `v2.x` (this trial, rebased) becomes the breaking line: OpenCode 2.0.x + OpenChamber 2.0.x, no OMO family. AI-EngKit major version follows the break (`2.0.0` for the v2 line).
- **No shared mutable state between lines.** Per opencode #42260 (V2 migrates the shared `opencode.db` in place and breaks V1): v2 uses disjoint volumes/profiles (`-v2` suffixes already in `docker-compose.v2.yml`) AND disjoint XDG/data dirs for any host-side tooling. Never mount a v1 `opencode-data` volume into a v2 container or vice versa.
- **User upgrade path (v1→v2, one-shot, forward-only):** fresh `-v2` volumes + settings carry-over (providers/keys via Admin export, agent model choices via the M-migration above, OpenChamber projects re-registered — registry format differs, do not copy `openchamber-data` across). No V1-history import dependency (V2's own `migration.v1-v2` is best-effort, not a product contract). No downgrade path (documented, not built).
- **Version pipeline:** extend `check-versions.sh` + `dependency-update.yml` for cross-major pin sources (`opencode-ai` → `@opencode/cli`, `bun install -g` → `bun install -g --trust` for the postinstall binary select). The v1→v2 flip for each pin becomes a config change, not a pipeline rewrite.
- **Upgrade/rollback mechanics:** reuse existing image-pull + container-recreate + settings-snapshot flow; add a pre-upgrade guard that refuses v1→v2 (or v2→v1) volume reuse (fail closed on `-v2` suffix mismatch). Rollback = recreate from the other line's image + its own volumes (both lines' volumes retained until the user prunes).

### Acceptance

- [ ] User sign-off on this file.
- [ ] Trial stack rebuilds from scratch (`down -v` + build + Cell 1 green) proving volume independence.
- [ ] One documented v1→v2 settings carry-over dry run (no prod volumes touched).

## Sign-off

| Item | Status | Date | By |
|---|---|---|---|
| D1 OMO route | PROPOSED | 2026-09-29 | Sisyphus (evidence pack attached) |
| D2 Release lines | PROPOSED | 2026-09-29 | Sisyphus (evidence pack attached) |
