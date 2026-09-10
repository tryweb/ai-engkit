# Updating AI-EngKit Built-in Skills

## Context

AI-EngKit ships baked skills (e.g. `enable-project-knowledge`, `enable-finalize-maintenance`) that bootstrap project-local skills into user projects. The auto-upgrade mechanism (added in v1.19+) requires specific scaffolding in each bootstrap skill to enable version propagation from template to existing projects.

## Problem

When updating or adding a built-in skill, modifying only the skill content is insufficient. Without also updating the entrypoint registration and bootstrap scaffolding, the skill won't participate in auto-upgrade, and existing projects will keep stale versions.

## Solution

### Updating an Existing Skill (Content Change Only)

When modifying skill content (e.g. `knowledge-capture` SKILL.md template):

1. Edit the template content in `.opencode/baked-skills/<bootstrap-name>/bootstrap.sh`
2. Bump the version in `<!-- skill-version: x.y.z -->` (follow semver)
3. Rebuild Docker image

The auto-upgrade mechanism handles propagation automatically at container start.

### Adding a New Bootstrappable Skill

When creating a new skill that should support auto-upgrade:

**Step 1: Create the bootstrap script** at `.opencode/baked-skills/<bootstrap-name>/bootstrap.sh`

Must include these three elements:

```bash
#!/usr/bin/env bash
set -euo pipefail

# 1. --force flag parsing (allows overwriting during upgrade)
FORCE=0
if [ "${1:-}" = "--force" ]; then
  FORCE=1
  shift
fi

# 2. put() with forceable parameter
put() {
  local dest="$1"
  local forceable="${2:-0}"
  if [ -f "$dest" ]; then
    # Only overwrite if FORCE=1 AND forceable=1
    if [ "$FORCE" != "1" ] || [ "$forceable" != "1" ]; then
      SKIPPED+=("$dest")
      return
    fi
  fi
  mkdir -p "$(dirname "$dest")"
  cat > "$dest"
  CREATED+=("$dest")
}

# 3. SKILL.md with version marker (forceable=1)
put "$ROOT/.opencode/skills/<skill-name>/SKILL.md" 1 <<'SKILL'
<!-- skill-version: 1.0.0 -->
---
name: <skill-name>
description: ...
---

# Skill Content
SKILL

# Other files use forceable=0 (default) — preserved across upgrades
put "$ROOT/docs/knowledge/README.md" <<'README'
README_CONTENT
```

**Step 2: Register in entrypoint** at `entrypoint.d/02-init-config.sh`

Add to the `UPGRADEABLE_SKILLS` array:

```bash
UPGRADEABLE_SKILLS=(
  "knowledge-capture:$SKILLS_ROOT/enable-project-knowledge"
  "finalize-maintenance:$SKILLS_ROOT/enable-finalize-maintenance"
  "<new-skill>:$SKILLS_ROOT/<new-bootstrap>"  # ← add this line
)
```

**Step 3: Add tests** in `entrypoint.d/02-init-config.test.sh`

Follow the pattern of `assert_upgrade_when_version_changes` for the new skill.

## Why It Works

- **Version detection** — entrypoint reads `<!-- skill-version: x.y.z -->` from `bootstrap.sh`
- **Idempotent** — same version = no-op, safe to run every container start
- **Non-destructive** — only `SKILL.md` (marked `forceable=1`) is overwritten; user modifications to `README.md` or `_template.md` are preserved
- **Self-healing** — partial failures don't update the version marker, so retries happen automatically

## Side Effects / Tradeoffs

- Skills not following the `bootstrap.sh + SKILL.md` pattern (e.g. `superpowers` via symlink, `openspec` via CLI) cannot use this mechanism
- The version marker file (`~/.config/opencode/.skill-versions`) lives on the Docker volume and persists across restarts
- If a user manually edits `SKILL.md` in a project, the auto-upgrade will overwrite it on the next template update

## Evidence

- **Unit tests**: `entrypoint.d/02-init-config.test.sh` — 4 test cases covering upgrade, skip-unchanged, skip-no-projects, and multi-skill
- **E2E verified**: Both `knowledge-capture` and `finalize-maintenance` upgrade correctly in container environment

## Related Files

- `.opencode/baked-skills/enable-project-knowledge/bootstrap.sh` — Reference implementation
- `.opencode/baked-skills/enable-finalize-maintenance/bootstrap.sh` — Second example
- `entrypoint.d/02-init-config.sh` — `upgrade_bootstrapped_skills()` function + `UPGRADEABLE_SKILLS` registration
- `entrypoint.d/02-init-config.test.sh` — Test coverage
- `docs/knowledge/architecture/bootstrapped-skill-auto-upgrade.md` — Architecture overview

## Tags

`#skills` `#auto-upgrade` `#bootstrap` `#docker` `#entrypoint` `#maintenance`
