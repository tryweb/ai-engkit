# OpenCode Project Skill Discovery Format

## Context

OpenChamber 1.16.3 delegates project skill discovery to the OpenCode 1.18.5
backend. A project-local skill was created in
`/home/devuser/workspace/MyTest-01` but did not appear in the `/` autocomplete.

## Problem

The flat file format below is not discovered by the current OpenCode loader:

```text
.opencode/skills/finalize-maintenance.md
```

Creating a new session or reloading the browser does not make an incorrectly
structured skill appear.

## Solution

Use a directory containing an uppercase `SKILL.md` file:

```text
.opencode/skills/finalize-maintenance/SKILL.md
```

The file must contain valid frontmatter, including `name` and `description`:

```markdown
---
name: finalize-maintenance
description: Finalize maintenance work and generate the maintenance report.
---
```

OpenChamber exposes the current project skill discovery result through:

```text
GET /api/config/skills?directory=<project-directory>
```

For example:

```text
/api/config/skills?directory=/home/devuser/workspace/MyTest-01
```

## Why It Works

The loader scans skill directories for `**/SKILL.md`. After the standard
directory structure was added, the API returned the skill with
`scope: "project"` and the path ending in
`.opencode/skills/finalize-maintenance/SKILL.md`.

The OpenChamber `/` autocomplete then displayed:

```text
/finalize-maintenance
```

## Side Effects / Tradeoffs

- Existing flat `.md` files are not automatically migrated.
- The old flat file can be retained temporarily for comparison, but the
  canonical project skill should use the directory/`SKILL.md` structure.
- The `enable-finalize-maintenance` bootstrap documentation currently creates
  the obsolete flat format and should be updated separately.
- Newer OpenCode versions may provide `reload_skills` or `/reload`; these were
  not present in the target OpenCode 1.18.5 command list.

## Evidence

- Target host: `192.168.11.195` (`ai-engkit-195`)
- OpenCode: `1.18.5`
- OpenChamber: `1.16.3`
- Before conversion: `/api/config/skills` returned 23 skills and no
  `finalize-maintenance` entry.
- After adding `finalize-maintenance/SKILL.md`: the API returned 24 skills and
  the project skill with `scope: "project"`.
- The OpenChamber UI displayed `/finalize-maintenance` in slash autocomplete.

## Related Files

- `docs/knowledge/patterns/enable-xxx-skill-pattern.md`
- `.opencode/baked-skills/enable-finalize-maintenance/SKILL.md`
- `.opencode/baked-skills/enable-finalize-maintenance/bootstrap.sh`

## Legacy Flat File Is Skipped by Auto-Upgrade (added 2026-11)

A project that was bootstrapped **before** the folder migration keeps a flat
file that is never loaded and never upgraded:

```text
<project>/.opencode/skills/knowledge-capture.md        # legacy, not loaded
<project>/.opencode/skills/knowledge-capture/SKILL.md  # missing → auto-upgrade skips it
```

- `upgrade_bootstrapped_skills` (`entrypoint.d/02-init-config.sh`) only upgrades
  projects where `.opencode/skills/<skill>/SKILL.md` already exists. A
  flat-file-only project is silently skipped on every container start, even
  after the template version is bumped.
- Fix: move the flat file to the folder form (`git mv` keeps history), then
  put the version marker after the closing `---`:

```bash
mkdir -p .opencode/skills/knowledge-capture
git mv .opencode/skills/knowledge-capture.md .opencode/skills/knowledge-capture/SKILL.md
# then insert "<!-- skill-version: 1.1.1 -->" after the closing "---"
```

- Verify against the backend, not a model's self-report: an agent answering
  "list your skills" can only see what its session loaded, so it cannot prove
  the file is loadable. Query
  `GET /skill?directory=<project>` on the managed `opencode serve` with
  `OPENCODE_SERVER_PASSWORD` basic auth, or compare against a freshly created
  probe directory containing the same file.
- The managed backend caches a project's skill scan. A fixed file is invisible
  until the backend process restarts (see
  `opencode-skill-leading-comment-breaks-discovery.md`). Confirm no session is
  `busy` before restarting.

Evidence (`ep-design` workspace, OpenCode `1.19.5`, ai-engkit `v1.24.4` host):

- Legacy file introduced in commit `cc54d89` (`建立知識庫結構與 knowledge-capture skill`).
- Before restart, `/skill?directory=ep-design` returned 18 skills without
  `knowledge-capture`; a fresh probe directory with the same fixed file returned
  21 including it.
- After backend restart, `ep-design` returned 19 skills including
  `knowledge-capture`. The user confirmed a new session lists the skill.
- Not covered here: six other `ep-design` project skills lack frontmatter
  entirely and remain unloaded; they need a separate fix.

## Tags

`#opencode` `#openchamber` `#skills` `#discovery` `#troubleshooting` `#auto-upgrade`
