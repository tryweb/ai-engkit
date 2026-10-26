# Enable-Security-Audit — Vendored Third-Party Skill Behind the Enable Gate

## Context

ai-engkit ships optional project-local skills through the `enable-xxx` pattern
(see `enable-xxx-skill-pattern.md`). A user asked whether
[`cloudflare/security-audit-skill`](https://github.com/cloudflare/security-audit-skill)
should join that set. The skill is a six-phase, coverage-led vulnerability
audit that produces `findings.json` validated against
`report-schema.json`, plus `REPORT.md` / `FINDINGS-DETAIL.md` /
`NEEDS-VALIDATION.md`.

The image already carries three security-adjacent tools, each on a different
axis:

| Tool | Scope |
|------|-------|
| `security-research` / `security-review` (built-in) | Team Mode, 3 hunters + 2 PoC, requires `team_mode.enabled: true` |
| `vuln-scan` (ai-engkit project skill) | GitHub code-scanning triage + Dockerfile pins |
| `karpathy-guidelines` | Coding discipline, not security |

None produces machine-readable, independently re-verified findings.

## Problem

Adopting the skill introduces four concrete tensions:

1. **Trigger collision.** Upstream's description matches plain "security
   review" / "vulnerability audit", overlapping `security-research`.
2. **Sandbox precondition.** Upstream only executes target-controlled builds,
   tests, browsers, or fuzzers inside an OS-enforced sandbox with networking
   disabled. ai-engkit containers do not provide one.
3. **Size.** 352 KB, 5,276 lines, 21 files including two zero-dependency
   `.cjs` validators (1,645 lines) and 1,392 lines of validator tests.
   Inlining that into a `bootstrap.sh` heredoc — the existing pattern — would
   produce an unmaintainable script.
4. **Runtime.** The image has no standalone `node`; `~/.bun/bin/node` is Bun's
   Node-compatibility shim.

## Solution

Adopt it, but vendor the tree instead of heredoc-ing it:

```
.opencode/baked-skills/enable-security-audit/
├── SKILL.md          # enable workflow, disambiguation, ai-engkit caveats
├── bootstrap.sh      # skill-version 1.0.0, copies skill/ → project
├── UPSTREAM.md       # pinned SHA, license, re-vendor procedure
└── skill/            # 21 vendored files (20 upstream + LICENSE)
    └── SKILL.md.template   # upstream SKILL.md, renamed (see below)
```

Decisions and why:

- **Vendored, not fetched.** Behavior cannot change under a project without a
  reviewed commit, and enabling works offline. `UPSTREAM.md` records commit
  `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8` (2026-09-14) and the re-vendor
  steps.
- **Upstream `SKILL.md` is stored as `SKILL.md.template`.** OpenCode skill
  discovery recurses over the config directory for any file named exactly
  `SKILL.md` (`walkSkillMdFiles` in
  `@openchamber/web/server/lib/opencode/shared.js`, and its search list
  includes the whole of `~/.config/opencode`). Baked skills are symlinked into
  `~/.config/opencode/skills/`, so a nested `skill/SKILL.md` would register
  `security-audit` as a **global** user skill in every project and silently
  defeat the opt-in gate. `bootstrap.sh` renames it back on install;
  `test/test-security-audit-skill.sh` fails if any nested `SKILL.md` reappears
  under `.opencode/baked-skills/`.
- **MIT.** `skill/LICENSE` carries Cloudflare's MIT text, satisfying
  attribution for redistribution.
- **Tree copy, all files forceable.** Every file is upstream-owned, so
  `--force` (and the entrypoint auto-upgrade) refreshes the whole tree. This
  deviates from "only `SKILL.md` is forceable" deliberately: users must not
  patch vendored prompts, because the next upgrade would silently revert them.
- **Registered in `UPGRADEABLE_SKILLS`** as `security-audit:…/enable-security-audit`.
  The entrypoint's existing path probe
  (`<project>/.opencode/skills/security-audit/SKILL.md`) matches the installed
  layout with no changes.
- **Tests included in the copy.** They are upstream dev tests, not runtime
  code, but keeping them lets any project prove the vendored validators are
  intact: `bun test validate-findings.test.cjs validate-coverage-ledger.test.cjs`.

## Why It Works

- **Opt-in isolates the trigger collision.** Nothing changes for projects that
  never run the enable skill. Once enabled, project skills outrank built-ins
  and the upstream description covers "security reviews", so plain
  "security review" lands on `security-audit`; `security-research` stays
  reachable by name or `/security-research`. The shift cannot be disabled
  without forking the vendored description, so enabling is documented as
  changing routing inside that project, with explicit-name invocation for
  both skills. Since 1.0.1 `bootstrap.sh` itself appends the
  `## Security Skill Routing` section to the project's `AGENTS.md` (once,
  outside managed markers, creating the file if absent) — it is the single
  writer for the agent flow, the dashboard button, and the entrypoint
  auto-upgrade, which also backfills previously enabled projects on the next
  version bump. Deliberately project-local, never in the shared
  `AGENTS.md.default` template: the routing shift only exists where the skill
  is enabled.
- **Sandbox absence degrades safely.** Upstream's own rule is to keep a
  source-grounded lead as `needs_validation` when execution controls are
  unavailable. In ai-engkit that means static, source-first audits — the
  correct outcome, not a broken feature.
- **Bun covers the validator requirement.** Verified in-container:
  `node validate-findings.cjs <file>` works through the shim and all 65
  upstream tests pass under `bun test`. `node --test` does not work, which is
  why the enable skill and tests pin `bun test`.
- **The enable-xxx contract holds.** Idempotent, `--force` upgrade, markdown
  summary table, exit zero on all-skipped, self-contained (the bootstrap reads
  only from its own directory, reaching `skill/` through the baked-skill
  symlink).
- **Opt-in survives global discovery.** The vendored tree contains no file
  named `SKILL.md`, so nothing is registered for projects that did not enable
  it. This is the one non-obvious constraint in the layout; the template
  suffix exists for it and a test guards it.

## Side Effects / Tradeoffs

- **Ephemeral default output path.** Upstream defaults to
  `~/security-audit-skill/<repo>/run-<N>`; container `$HOME` does not survive
  replacement. Documented: pass an explicit directory on a mounted volume or a
  gitignored path.
- **Frozen per-project copies.** Existing projects keep their enabled version
  until the image's `skill-version` bumps; the entrypoint then refreshes every
  workspace project that has the marker file.
- **Image size.** ~352 KB added to `/opt/opencode/baked-skills`.
- **Whole-tree `--force` overwrites local edits.** Every vendored file is
  refreshed on a version bump, which is deliberate (patched prompts make audit
  results unreproducible) but means projects must keep customization in
  `AGENTS.md` or a separate skill. The auto-upgrade keys off
  `<project>/.opencode/skills/security-audit/SKILL.md` existing, with no
  per-project opt-in marker, so a tree installed by other means at that path is
  replaced on the next bump.
- **Runs are additive by design.** Re-running into the same output tree merges
  prior ledgers/findings. Use a new `run-<N>` directory for an independent pass.
- **Not a substitute for the built-in.** `security-research` performs bounded
  local execution via Team Mode; `security-audit` is conservative and will
  classify more leads as `needs_validation` in this environment.

## Evidence

- `bash test/test-security-audit-skill.sh` — 25 passed, 0 failed (contract,
  vendored-tree integrity, nested-`SKILL.md` guard, create, idempotency,
  `--force` restore, validator execution, registration).
- Upstream validator suites inside the installed tree — 65 passed, 0 failed.
- `entrypoint.d/02-init-config.test.sh` — all existing assertions still pass
  after adding the `UPGRADEABLE_SKILLS` entry.
- `node validate-findings.cjs` on `[]` → `PASS: 0 findings valid` (exit 0).

## Related Files

- `.opencode/baked-skills/enable-security-audit/{SKILL.md,bootstrap.sh,UPSTREAM.md}`
- `.opencode/baked-skills/enable-security-audit/skill/`
- `entrypoint.d/02-init-config.sh` — `UPGRADEABLE_SKILLS`
- `test/test-security-audit-skill.sh`
- `src/admin/lib/projects.ts` — `PROJECT_FEATURES`, enable/disable wiring
- `src/admin/lib/projects-overview.ts` — `ProjectFeatures`, marker detection
- `src/admin/routes/projects.ts` — features endpoints
- `src/admin/static/projects-page.js` — `CAPABILITIES` (`SA` badge)
- `docs/knowledge/patterns/enable-xxx-skill-pattern.md`
- `docs/knowledge/patterns/baked-skills-mechanism.md`

## Admin Dashboard Registration

The Projects page does not enumerate `enable-*` skills. A new capability
needs four coordinated edits or it is invisible in the UI:

1. `PROJECT_FEATURES` in `src/admin/lib/projects.ts` plus the bootstrap
   command in `enableProjectFeature`. Disable is a real removal for this
   skill (tree + routing note), not the knowledge-family no-op — those
   scaffolds hold user-authored content that Disable must not destroy,
   while the audit tree is fully upstream-owned and reproducible.
2. `ProjectFeatures` and the marker check in
   `src/admin/lib/projects-overview.ts` (marker:
   `.opencode/skills/security-audit/SKILL.md`).
3. The features typing and `/:name/features` check in
   `src/admin/routes/projects.ts`.
4. The `CAPABILITIES` array in `src/admin/static/projects-page.js`; a
   capability with no stats entry renders as "Enabled" (same as SuperPower),
   so the stats pipeline needs no change.

## Tags

- pattern
- skill-system
- security
- vendoring
- project-bootstrap
