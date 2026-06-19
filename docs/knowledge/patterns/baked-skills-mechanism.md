# Baked Skills — Shipping Global Skills in the Docker Image

## Context

Codeforge ships as a Docker image. Users mount `~/.config/opencode` as a Docker volume, so any skill written to that directory at build time is lost at runtime. Skills are discovered from `~/.config/opencode/skills/`, which lives on that volume.

The project needed a way to ship global skills (available to all users without manual install) that survive container rebuilds.

## Problem

- `~/.config/opencode` is a Docker volume — build-time writes to it do not persist.
- Skills must reside under `~/.config/opencode/skills/<name>/SKILL.md` to be auto-discovered.
- Bundling skill files under `~/.config/opencode/skills/` in the Dockerfile was attempted but lost on the first `docker compose down -v`.

## Solution

A three-layer mechanism:

1. **Build layer** — Skill files live in the repo under `.opencode/baked-skills/<name>/SKILL.md`. The Dockerfile copies this entire directory into the image:
   ```
   COPY .opencode/baked-skills /opt/opencode/baked-skills
   RUN chown -R ${USERNAME}:${USERNAME} /opt/opencode/baked-skills
   ```

2. **Runtime layer** — The entrypoint script (`entrypoint.d/02-init-config.sh`) scans `/opt/opencode/baked-skills/` at container start and symlinks each skill subdirectory into `~/.config/opencode/skills/`:
   ```bash
   BAKED_SKILLS_DIR="/opt/opencode/baked-skills"
   if [ -d "$BAKED_SKILLS_DIR" ]; then
     mkdir -p "$SKILLS_ROOT"
     find "$BAKED_SKILLS_DIR" -mindepth 1 -maxdepth 1 -type d -exec test -f '{}/SKILL.md' ';' -print | sort
     # each → ln -s "$skill_dir" "$SKILLS_ROOT/$skill_name"
   fi
   ```

3. **Agent config layer** — The agent's available-skills list in `~/.config/opencode/agents/Sisyphus - Ultraworker.md` must include the skill name so the orchestrator knows to offer it during delegation.

## Why It Works

- **Survives rebuilds**: `/opt/opencode/baked-skills` is inside the image. Rebuilds, `docker compose down -v`, even full image pulls include it.
- **Zero setup**: Entrypoint runs unconditionally on every container start. No user action needed.
- **No duplication**: The symlink is skipped (`[ ! -e "$target" ]`) if already present, so restarts don't accumulate broken links.
- **Transparent to OpenCode**: OpenCode sees `~/.config/opencode/skills/<name>/SKILL.md` just like any user-installed skill.

## Side Effects / Tradeoffs

- Skills baked this way are **read-only** at `~/.config/opencode/skills/<name>` (symlink to the image). Users who want to modify them must copy and replace the symlink manually.
- A new Docker image build is required to update baked skills. For development iteration, a bind mount or diret `~/.config/opencode/skills/` edit is faster.
- The entrypoint symlink logic is idempotent but adds ~10ms per baked skill to container startup.

## Evidence

- `v0.13.0` — First baked skills shipped: `enable-project-knowledge`, `knowledge-capture`
- `v0.14.0` — Added `karpathy-guidelines` (86-line SKILL.md, MIT-licensed, from `multica-ai/andrej-karpathy-skills`)
- Verified in container: symlink resolves correctly, SKILL.md frontmatter is readable
- All 48 tests pass, 0 fail

## Related Files

- `.opencode/baked-skills/karpathy-guidelines/SKILL.md` — Example baked skill file
- `Dockerfile` (lines ~184-186) — `COPY .opencode/baked-skills /opt/opencode/baked-skills`
- `entrypoint.d/02-init-config.sh` — Runtime symlink logic for baked skills
- `docker-compose.dev.yml` — Used for build verification

## Tags

`#infrastructure` `#docker` `#skills` `#entrypoint` `#opencode`
