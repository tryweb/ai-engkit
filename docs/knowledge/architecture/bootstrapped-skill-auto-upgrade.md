# Bootstrapped Skill Auto-Upgrade Mechanism

## Context

ai-engkit ships baked skills (like `enable-project-knowledge`) that bootstrap project-local skills (like `knowledge-capture`) into user projects via admin UI. Once bootstrapped, these skills were static — updates to the template never propagated to existing projects.

## Problem

When the template skill in `/opt/opencode/baked-skills/` was updated, already-bootstrapped projects kept the old version. There was no mechanism to detect template changes and push updates to projects.

Manual approach (delete + re-enable) was error-prone and required admin intervention.

## Solution

A three-part auto-upgrade mechanism triggered at container start:

1. **Version marker** — `<!-- skill-version: x.y.z -->` embedded in SKILL.md template
2. **Upgrade function** — `upgrade_bootstrapped_skills()` in entrypoint compares template version vs last-upgraded version
3. **Force flag** — `bootstrap.sh --force` overwrites only the SKILL.md (not README/_template) via `forceable` parameter

Flow:
```
Container start → entrypoint
  → Read template version from bootstrap.sh
  → Compare with $HOME/.config/opencode/.skill-versions
  → If different: scan workspace for projects with skill
  → Run bootstrap.sh --force on each
  → Only write version marker if ≥1 project upgraded & 0 failed
  → Failed upgrades retry on next container start
```

## Why It Works

- **Idempotent** — Same version = no-op, safe to run every container start
- **Non-destructive** — Only SKILL.md is force-overwritten; README.md and _template.md preserved
- **Self-healing** — Partial failures don't update version marker, so retries happen automatically
- **Zero admin action** — Fully automatic once image is rebuilt with new template version

## Side Effects / Tradegrades

- Container startup takes ~50ms per project being upgraded (negligible for typical project counts)
- Version marker file (`~/.config/opencode/.skill-versions`) must persist across restarts (lives on Docker volume)
- If admin manually edits SKILL.md in a project, the auto-upgrade will overwrite it on next template update

## Evidence

- **E2E test verified**: v1→v2→v3 sequential upgrades work correctly
- **Unit tests**: `entrypoint.d/02-init-config.test.sh` — 3 test cases (upgrade/skip-unchanged/skip-no-projects)
- **All existing tests pass**: `bash entrypoint.d/02-init-config.test.sh` → EXIT: 0

## Related Files

- `.opencode/baked-skills/enable-project-knowledge/bootstrap.sh` — Template with version marker and `--force` support
- `entrypoint.d/02-init-config.sh` — `upgrade_bootstrapped_skills()` function (lines 405-460)
- `entrypoint.d/02-init-config.test.sh` — Test coverage

## Tags

`#skills` `#auto-upgrade` `#entrypoint` `#bootstrap` `#versioning` `#docker`
