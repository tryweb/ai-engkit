# Enable Security Audit Skill (V2)

## Context

ai-engkit ships optional project-local skills via the `enable-xxx` baked-skill
pattern (see `enable-xxx-skill-pattern.md`). V1 added `enable-security-audit`,
vendoring Cloudflare's `security-audit-skill` as a pinned, opt-in tree. V2
has no OMO layer (`OMO_ENABLED=0`, no `~/.omo/omo.jsonc`, no `team_mode`
toggle), so the port must clarify what changes and what stays identical.

## Problem

How to bring the V1 `security-audit` enable feature to V2 without
re-litigating its decisions, while accounting for the missing OMO/team-mode
machinery and the V2 admin file layout?

## Solution

Port V1 verbatim except for the OMO surface, which is deleted rather than
replaced:

1. **Vendor the whole tree** — 21 files pinned at upstream `c1c8a8c` (MIT)
   under `.opencode/baked-skills/enable-security-audit/skill/`, with upstream
   `SKILL.md` stored as `SKILL.md.template`. `bootstrap.sh` restores the
   filename on install. Guard: `find skill -name SKILL.md` must be empty,
   otherwise OpenCode registers the vendored copy as a global skill and
   opt-in breaks.
2. **`bootstrap.sh` is the single choke point** (agent dialogue / admin
   Enable button / entrypoint auto-upgrade all run it). It writes the
   `AGENTS.md` routing note, supports `--force` full-tree refresh (hand
   edits included), and carries `<!-- skill-version: 1.0.1 -->` for the
   entrypoint upgrade detector. **Zero omo logic** — audit never needed
   team mode; V2 has no toggle to set.
3. **Routing note goes to the project `AGENTS.md` only**, never the shared
   template. V2 note names native subagents for isolated hunters/verifiers
   and documents the container `node` (Bun shim) validator invocation.
4. **Disable is true deletion** (skill tree + note segment; `AGENTS.md`
   removed when emptied). Do not copy the knowledge/maintenance no-op —
   those guard user content, while this tree is 100% upstream-regenerable.
5. **Admin capability syncs four places**: `PROJECT_FEATURES` in
   `lib/projects.ts`, marker detection in `lib/projects-overview.ts`
   (`.opencode/skills/security-audit/SKILL.md`), route types + features
   endpoint in `routes/projects.ts`, `CAPABILITIES` in
   `static/projects-page.js` plus the `views/projects.tsx` filter option.
   Missing any one leaves the feature invisible in the UI.
6. **Entrypoint**: generic symlink block needs no change; add the one-line
   `UPGRADEABLE_SKILLS` entry for `security-audit`.

## Why It Works

- The `.template` suffix is the only thing standing between "pinned vendor
  tree" and "accidentally global skill" — the guard test makes the invariant
  cheap to verify.
- One writer (`bootstrap.sh`) for the tree + note means Enable, re-Enable,
  and auto-upgrade can never drift from each other.
- `--force`-refreshes-everything keeps audits reproducible: a patched
  prompt is a different audit, so hand edits are documented as ephemeral.
- True-delete disable is safe precisely because the tree is fully owned
  upstream and one command restores it.

## Side Effects / Tradeoffs

- New image build required before the baked skill appears in containers;
  `test/run-tests.sh` docker assertions fail until the rebuild lands.
- `--force` destroys local prompt tweaks by design; projects that need a
  forked workflow should copy the tree under a different skill name.
- Validator test files run with `bun test`, not `node --test` (Bun shim).

## Evidence

- `bash test/test-security-audit-skill.sh` — 33 assertions green (tree
  shape, template guard, install/idempotency/`--force`, note
  write/preserve/refresh, validators, wiring).
- `cd src/admin && bun test lib/projects-overview.test.ts
  routes/projects.test.ts` — 51 pass, 0 fail (incl. new disable-deletion
  and marker-detection tests).
- Full `bun test` shows only pre-existing agent-model/upgrade failures
  (identical on the clean tree; verified via `git stash`).
- Upstream pin verified: `git -C /tmp/opencode/security-audit-upstream
  rev-parse HEAD` == `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8`.

## Related Files

- `.opencode/baked-skills/enable-security-audit/` (`SKILL.md`,
  `bootstrap.sh`, `UPSTREAM.md`, `skill/` × 21)
- `test/test-security-audit-skill.sh`
- `entrypoint.d/02-init-config.sh` (`UPGRADEABLE_SKILLS`)
- `src/admin/lib/projects.ts`, `src/admin/lib/projects-overview.ts`,
  `src/admin/routes/projects.ts`, `src/admin/static/projects-page.js`,
  `src/admin/views/projects.tsx`
- `docs/TOOLING.md`, `docs/CHANGELOG.md`

## Tags

- pattern
- skill-system
- security-audit
- v2-port
- opt-in
