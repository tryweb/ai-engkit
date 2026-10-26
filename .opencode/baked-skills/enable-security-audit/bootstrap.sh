#!/usr/bin/env bash
# bootstrap.sh — install the vendored security-audit skill into a project
# <!-- skill-version: 1.0.1 -->
#
# Upstream:      https://github.com/cloudflare/security-audit-skill
# Pinned commit: c1c8a8c1471069fb0e188eeaff69b8e8db6564a8
# License:       MIT (see skill/LICENSE)
#
# Usage: bootstrap.sh [--force] <project-root>
#
# Existing files are left alone. --force rewrites the whole tree, including
# project-local edits; the entrypoint uses it after a skill-version bump.
# Also appends the skill-routing note to <project-root>/AGENTS.md once
# (outside managed markers; the file is created if absent).
set -euo pipefail

FORCE=0
if [ "${1:-}" = "--force" ]; then
  FORCE=1
  shift
fi

if [ $# -lt 1 ]; then
  echo "Usage: bootstrap.sh [--force] <project-root>" >&2
  exit 1
fi

ROOT="${1%/}"
if [[ ! -d "$ROOT" ]]; then
  echo "Error: not a directory: $ROOT" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$SCRIPT_DIR/skill"
SKILL_NAME="security-audit"
DEST_DIR="$ROOT/.opencode/skills/$SKILL_NAME"

if [[ ! -f "$SOURCE_DIR/SKILL.md.template" ]]; then
  echo "Error: vendored skill tree is missing at $SOURCE_DIR" >&2
  exit 1
fi

CREATED=()
SKIPPED=()
FAILED=()

copy_tree() {
  local src rel dest
  while IFS= read -r -d '' src; do
    rel="${src#"$SOURCE_DIR"/}"
    # The vendored template is suffixed so OpenCode's recursive skill discovery
    # does not register it as a global skill from the baked-skills directory.
    [[ "$rel" = "SKILL.md.template" ]] && rel="SKILL.md"
    dest="$DEST_DIR/$rel"
    if [[ -f "$dest" ]] && [[ "$FORCE" != "1" ]]; then
      SKIPPED+=("$rel")
      continue
    fi
    mkdir -p "$(dirname "$dest")"
    if cp "$src" "$dest"; then
      CREATED+=("$rel")
    else
      FAILED+=("$rel")
    fi
  done < <(find "$SOURCE_DIR" -type f -print0 | sort -z)
}

NOTE_WRITTEN=0

record_routing_note() {
  local agents_md="$ROOT/AGENTS.md"
  if [[ -f "$agents_md" ]] && grep -q '^## Security Skill Routing' "$agents_md"; then
    return 0
  fi
  # Single writer for this section: bootstrap is the common path of the agent
  # flow, the dashboard button, and the entrypoint auto-upgrade.
  if [[ -s "$agents_md" ]] && [[ -n "$(tail -c 1 "$agents_md")" ]]; then
    echo >> "$agents_md"
  fi
  cat >> "$agents_md" <<'NOTE_EOF' || { echo "Error: cannot write $agents_md" >&2; return 1; }
## Security Skill Routing (project-local)

- This project has the `security-audit` project skill enabled. Plain
  "security review" wording resolves to it (project skills outrank built-ins).
- For Team Mode (3 hunters + 2 PoC engineers, exploitability-proven), invoke
  `security-research` or `/security-research` explicitly. Requires
  `"team_mode": { "enabled": true }` in `~/.omo/omo.jsonc` plus an opencode restart.
NOTE_EOF
  NOTE_WRITTEN=1
}

copy_tree

echo ""
echo "| Path | Status |"
echo "|------|--------|"
for rel in "${CREATED[@]:-}"; do
  [[ -n "$rel" ]] && echo "| .opencode/skills/$SKILL_NAME/$rel | created |"
done
for rel in "${SKIPPED[@]:-}"; do
  [[ -n "$rel" ]] && echo "| .opencode/skills/$SKILL_NAME/$rel | skipped (exists) |"
done
for rel in "${FAILED[@]:-}"; do
  [[ -n "$rel" ]] && echo "| .opencode/skills/$SKILL_NAME/$rel | FAILED |"
done
echo ""

printf 'Created: %d, Skipped: %d, Failed: %d\n' \
  "${#CREATED[@]}" "${#SKIPPED[@]}" "${#FAILED[@]}"

if [[ "${#FAILED[@]}" -gt 0 ]]; then
  exit 1
fi

record_routing_note

echo ""
echo "Next steps:"
if [[ "$NOTE_WRITTEN" = "1" ]]; then
  echo "  - Skill routing recorded in AGENTS.md (project-local)"
fi
echo "  - Ask the agent: \"security audit this codebase\" (full audit mode)"
echo "  - Validate artifacts: node .opencode/skills/$SKILL_NAME/validate-findings.cjs <findings.json>"
echo "  - In ai-engkit, pass an explicit output dir outside the repo; ~ is ephemeral per container."
