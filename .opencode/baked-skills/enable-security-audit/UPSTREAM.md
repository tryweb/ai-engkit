# Vendored upstream: cloudflare/security-audit-skill

This directory ships a pinned, verbatim copy of the upstream skill so that
`bootstrap.sh` stays deterministic and offline-capable. Upstream is never
fetched at enable time.

| Field | Value |
|-------|-------|
| Source | https://github.com/cloudflare/security-audit-skill |
| Path | `skills/security-audit/` |
| Commit | `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8` |
| Commit date | 2026-09-14 |
| Commit subject | Clarify guidance and full audit modes |
| License | MIT (Cloudflare, Inc.) — full text in `skill/LICENSE` |
| Vendored files | 21 (`20` upstream + `LICENSE`) |

## Layout

```
skill/            # upstream tree, do not edit
```

`skill/LICENSE` is copied from the upstream repository root, which is where
MIT attribution lives upstream. One extra deviation from verbatim:
upstream's `SKILL.md` is stored here as **`SKILL.md.template`** and restored to
`SKILL.md` by `bootstrap.sh` at install time.

### Why the Template Suffix

Skill catalogs scan the whole config directory recursively for files named
exactly `SKILL.md` — verified for OpenChamber's `walkSkillMdFiles` in
`@openchamber/web/server/lib/opencode/shared.js`, and OpenCode does list
baked skills that are symlinked into that directory. A nested `skill/SKILL.md`
here would therefore likely register `security-audit` as a **global** skill for
every project, silently bypassing the opt-in gate. The suffix keeps the tree
inert until a project explicitly bootstraps it; if OpenCode's own loader turns
out not to recurse, the suffix simply costs nothing.

## Upgrade Behavior

`--force` rewrites every file in the tree, including project-local edits. That
is intentional: the prompts and validators drive sub-agents, so a silently
patched copy would make audit results unreproducible. Two consequences worth
knowing:

- Projects must not customize files under `.opencode/skills/security-audit/`.
  Put project-specific guidance in `AGENTS.md` or a separate skill.
- The entrypoint's auto-upgrade triggers on `<project>/.opencode/skills/
  security-audit/SKILL.md` existing, with no separate per-project opt-in
  marker. A tree installed by other means at that exact path will be replaced
  on the next `skill-version` bump.

`bootstrap.sh` (1.0.1+) also appends the `## Security Skill Routing` section to
the project's `AGENTS.md` — once (skipped when the section exists), outside the
`<!-- @ai-engkit -->` managed markers, creating the file when absent. It is the
single writer for the agent flow, the dashboard button, and the auto-upgrade,
so no path needs its own copy of the text.

Tradeoff stated openly: because auto-upgrade runs at container boot, a version
bump can create `AGENTS.md` in an opted-in project that never had one. This is
accepted — it only ever fires for projects that opted into the skill, the write
is guarded and outside managed markers, and the alternative (a flag splitting
explicit vs upgrade invocations) adds configurability for a case that does not
need it.

## Update Procedure

1. Re-vendor the tree at the new commit:
   ```bash
   git clone --depth 1 https://github.com/cloudflare/security-audit-skill.git /tmp/cf-sa
   rm -rf skill && mkdir skill
   cp -R /tmp/cf-sa/skills/security-audit/. skill/
   cp /tmp/cf-sa/LICENSE skill/LICENSE
   mv skill/SKILL.md skill/SKILL.md.template   # required, see "Why the Template Suffix"
   ```
2. Confirm no nested `SKILL.md` remains: `find skill -name SKILL.md` must be
   empty, or `test/test-security-audit-skill.sh` fails.
3. Diff against the old tree and review every change — this content drives
   autonomous sub-agents and is executed by the agent.
4. Run the upstream validator tests with the bundled runtime:
   ```bash
   cd skill && bun test validate-findings.test.cjs validate-coverage-ledger.test.cjs
   ```
5. Bump `<!-- skill-version: x.y.z -->` in `bootstrap.sh` (semver: patch for
   prompt edits, minor for new attack-class files, major for workflow changes).
6. Update the table above with the new commit SHA and date.
7. Rebuild the image; the entrypoint auto-upgrade refreshes enabled projects.

## Why Vendored, Not Fetched

- Deterministic: the agent's security behavior cannot change under a project
  without a reviewed commit.
- Offline-capable: no network dependency at enable time.
- Auditable: the exact prompts and validators that ran are in git history.
