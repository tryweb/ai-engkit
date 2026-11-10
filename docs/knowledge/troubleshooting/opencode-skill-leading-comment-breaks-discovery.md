# Leading Content Before Frontmatter Silently Drops an OpenCode Skill

## Context

On `ai-engkit-215` (`ai-engkit:v1.24.4`, OpenCode `1.19.5`), the project-local
`knowledge-capture` skill vanished from every session's skill list right after
the Nov 9 auto-upgrade. An earlier broken-symlink theory (stale global
`~/.config/opencode/skills/knowledge-capture` link left over from the 1.18.10
baked-skill removal) turned out to be a red herring: deleting it changed
nothing because the skill had moved to project scope by design.

## Problem

The bootstrap template emitted the version marker as **line 1** of the
generated `SKILL.md`, ahead of the frontmatter:

```markdown
<!-- skill-version: 1.1.0 -->
---
name: knowledge-capture
...
```

OpenCode only parses frontmatter when the file **starts with `---`**. A leading
HTML comment causes the whole file to be silently skipped: the skill never
appears, and nothing is logged (no WARN/ERROR in `opencode.log`). Same flaw
existed in the `finalize-maintenance` template (`1.0.0`). The
`security-audit` template was unaffected (clean `---` start).

A second trap compounded diagnosis: the long-lived managed `opencode serve`
process scans project skills once and holds the result, so fixing the file on
disk did **not** make the skill appear in new sessions until the backend was
restarted. Brand-new project directories scanned fine, which made the stale
cache look like a per-file problem.

## Solution

1. Move the version marker below the closing `---` so line 1 is `---`:

```markdown
---
name: knowledge-capture
description: ...
---

<!-- skill-version: 1.1.1 -->
```

2. Bump the template version (`knowledge-capture` `1.1.0` → `1.1.1`,
   `finalize-maintenance` `1.0.0` → `1.0.1`) so
   `upgrade_bootstrapped_skills` rewrites affected projects on next restart.
3. For immediate unblock, delete the first line of affected project
   `SKILL.md` files (reversible one-line change; back up first).
4. Restart the managed OpenCode backend (`kill <opencode-serve-pid>`; it
   respawns on demand) after confirming no session is `busy`, then verify with
   a brand-new session in the project root.

## Why It Works

- Controlled A/B in a scratch project on the target host: `SKILL.md` starting
  with `---` was listed, the identical file with a leading `<!-- -->` was
  not. The fixed `knowledge-capture` content listed under a fresh project
  directory, proving the bytes were fine and the old project view was stale.
- After the backend restart, a new `marketing` session listed
  `knowledge-capture` among project skills.

## Side Effects / Tradeoffs

- The version bump triggers a `--force` rewrite of every project with the
  skill enabled on next container start; content is template-identical apart
  from the marker move, but review the diff if projects customized the file.
- Backend restart briefly disrupts in-flight agent runs — verify all sessions
  are `idle` first (`openchamber session list --with-status`).
- The `<!-- skill-version -->` grep in `upgrade_bootstrapped_skills` reads the
  bootstrap script, not the generated file, so moving the marker inside the
  heredoc keeps version tracking working.

## Evidence

- Template origin: commit `3947373` (Sep 10) added `<!-- skill-version: ... -->`
  as generated line 1; Nov 9 `--force` upgrade propagated it to
  `Everplast-IT` and `marketing` (dirs dated Nov 9 11:23/17:10).
- Probe sessions on `.215`: `ses_e3cf3f63` (aaa-clean listed, bbb-commented
  missing), `ses_e3ceaa4f` (fixed content listed), `ses_e3ce7903` (post-restart
  `marketing` lists `knowledge-capture`).
- `entrypoint.d/02-init-config.test.sh` passes after template edits.
- No skill parse errors in `~/.local/share/opencode/log/opencode.log` — the
  skip is silent, which is why file-by-file A/B was needed.

## Related Files

- `.opencode/baked-skills/enable-project-knowledge/bootstrap.sh`
- `.opencode/baked-skills/enable-finalize-maintenance/bootstrap.sh`
- `.opencode/skills/knowledge-capture/SKILL.md`
- `entrypoint.d/02-init-config.sh` (`prune_stale_baked_skill_symlinks`)
- `docs/knowledge/troubleshooting/opencode-project-skill-discovery.md`
- `docs/knowledge/patterns/enable-xxx-skill-pattern.md`

## Tags

`#opencode` `#openchamber` `#skills` `#frontmatter` `#troubleshooting`
