# Enable-XXX Skill Pattern

## Context

ai-engkit ships optional project-local skills that users can opt into per project. Each such feature follows a consistent two-layer pattern so the codebase is portable (project skill lives in git) but the bootstrap mechanism is centrally maintained.

## Problem

How to structure a project-local skill so that:
- It's available for any project that wants it.
- The project-local copy is tracked in git (works outside ai-engkit).
- Enabling it is a single deterministic action.
- The pattern scales to N skills without duplication.

## Solution

Each feature gets **two artifacts**:

```
Global (installed):
  ~/.config/opencode/skills/enable-xxx/
    ├── SKILL.md        # Agent-invocable enable workflow
    └── bootstrap.sh    # Deterministic scaffold + project-skill creation

Source (ai-engkit repo):
  .opencode/baked-skills/enable-xxx/
    ├── SKILL.md        # Copy installed globally
    └── bootstrap.sh    # Copy installed globally

=>

Project (after enable):
  <project-root>/
    ├── .opencode/skills/xxx.md           # Project-local skill (git-tracked)
    └── docs/knowledge/xxx/               # Optional scaffold
        ├── README.md
        └── _template.md
```

### `bootstrap.sh` Contract

| Property | Behavior |
|----------|----------|
| Idempotent | Never overwrites existing files. Second run = all skipped. |
| Output | Markdown table with `created` / `skipped (exists)` per path. |
| Exit | Zero even when all files skipped. |
| Self-contained | No dependencies outside `~/.config/opencode/skills/enable-xxx/`. |

### `SKILL.md` Structure

The enable workflow mirrors `enable-project-knowledge`:

1. **Step 1** — Determine project root (`git rev-parse --show-toplevel`)
2. **Step 2** — Check if already enabled (two marker files must both exist)
3. **Step 3** — Run `bootstrap.sh <project-root>`
4. **Step 4** — Report results

### Auto-Dependency Provisioning

If the enable skill depends on another enable-xxx being present first (e.g. `enable-finalize-maintenance` needs `enable-project-knowledge`), the `bootstrap.sh` checks for the prerequisite marker file and auto-invokes the dependency's bootstrap:

```bash
if [[ ! -f "$ROOT/docs/knowledge/README.md" ]]; then
  ENABLE_SCRIPT="$HOME/.config/opencode/skills/enable-project-knowledge/bootstrap.sh"
  if [[ -x "$ENABLE_SCRIPT" ]]; then
    "$ENABLE_SCRIPT" "$ROOT"
  fi
fi
```

## Why It Works

- **Separation of concerns**: Global skill is the installer; project skill is the user-facing tool. Changing the workflow (SKILL.md) or scaffold (bootstrap.sh) is a single update in the ai-engkit repo.
- **Git portability**: The project-local `.opencode/skills/xxx.md` file means CI and other agents in that project can use the skill without depending on ai-engkit being installed.
- **Idempotency guarantees safety**: Running the enable workflow on an already-configured project is a no-op.
- **Baked-skills as source of truth**: `baked-skills/enable-xxx/` is the canonical copy — installing globally is just copying these files.

## Side Effects / Tradeoffs

- Two files to maintain per feature (SKILL.md + bootstrap.sh).
- The project-local skill definition is frozen at enable-time; updates to the ai-engkit version won't retroactively update already-enabled projects.
- bootstrap.sh uses heredocs for the project-local skill content — large skill files make the script bulky.

## Evidence

- `enable-project-knowledge` — first implementation, defines the pattern.
- `enable-finalize-maintenance` — second implementation, validates the pattern and adds auto-dependency provisioning.

## Related Files

- `.opencode/baked-skills/enable-project-knowledge/`
- `.opencode/baked-skills/enable-finalize-maintenance/`
- `~/.config/opencode/skills/enable-project-knowledge/`
- `~/.config/opencode/skills/enable-finalize-maintenance/`

## Tags

- pattern
- skill-system
- project-bootstrap
- opencode
