#!/usr/bin/env bash
# bootstrap.sh — Deterministic enable-security-audit bootstrap (v2)
#
# Installs the pinned Cloudflare `security-audit` skill tree into a project
# and writes the AGENTS.md routing note. Single choke point: agent dialogue,
# admin Projects page Enable button, and entrypoint auto-upgrade all run this.
#
# <!-- skill-version: 1.0.1 -->
#
# Usage: bootstrap.sh [--force] <project-root>
#
# Without --force: never overwrites an existing file (idempotent).
# With --force: full tree refresh — overwrites all 21 vendored files,
#   including hand edits (policy: prompts must stay reproducible; see UPSTREAM.md).
#   The AGENTS.md routing note is refreshed in place, never duplicated.
#
# V2 note: no omo/team_mode handling. Audit never required team mode; on the
# V2 line there is no `~/.omo/omo.jsonc` at all. Isolated hunters/verifiers
# run as native subagents under the skill's write-isolation boundaries.
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

ROOT="$1"
if [[ ! -d "$ROOT" ]]; then
  echo "Error: not a directory: $ROOT" >&2
  exit 1
fi

ROOT="${ROOT%/}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$SCRIPT_DIR/skill"

if [[ ! -d "$SRC_DIR" ]]; then
  echo "Error: vendored skill tree missing: $SRC_DIR" >&2
  exit 1
fi
if [[ ! -f "$SRC_DIR/SKILL.md.template" ]]; then
  echo "Error: SKILL.md.template missing in $SRC_DIR (upstream SKILL.md must be stored as .template; see UPSTREAM.md)" >&2
  exit 1
fi
# Guard: the vendored tree must never contain a live SKILL.md — OpenCode
# recursively scans config dirs, and a nested SKILL.md would register as a
# global skill and break opt-in.
if find "$SRC_DIR" -mindepth 1 -name 'SKILL.md' -print -quit | grep -q .; then
  echo "Error: vendored tree contains SKILL.md (must be SKILL.md.template only)" >&2
  exit 1
fi

SKILL_VERSION="1.0.1"
DEST_DIR="$ROOT/.opencode/skills/security-audit"

CREATED=()
SKIPPED=()

mk() {
  local dir="$1"
  if [[ -d "$dir" ]]; then
    SKIPPED+=("$dir/")
  else
    mkdir -p "$dir"
    CREATED+=("$dir/")
  fi
}

# put_file <dest-rel-path> <src-absolute-path> <forceable:0|1>
# Without --force (or forceable=0): existing files are never overwritten.
# With --force + forceable=1: existing files are refreshed from vendor.
put_file() {
  local rel="$1"
  local src="$2"
  local forceable="${3:-1}"
  local dest="$DEST_DIR/$rel"
  if [[ -f "$dest" ]]; then
    if [[ "$FORCE" != "1" || "$forceable" != "1" ]]; then
      SKIPPED+=("$dest")
      return
    fi
  fi
  mkdir -p "$(dirname "$dest")"
  if [[ "$rel" == "SKILL.md" ]]; then
    # Installed copy carries the skill-version marker so upgrade state is
    # visible in place; upstream template itself stays pristine.
    {
      printf '<!-- skill-version: %s -->\n' "$SKILL_VERSION"
      cat "$src"
    } > "$dest"
  else
    cp -p "$src" "$dest"
  fi
  # Keep validator entrypoints executable after copy.
  if [[ "$rel" == "validate-findings.cjs" || "$rel" == "validate-coverage-ledger.cjs" ]]; then
    chmod +x "$dest"
  fi
  CREATED+=("$dest")
}

mk "$ROOT/.opencode/skills"
mk "$DEST_DIR"

# Vendored tree: SKILL.md.template -> SKILL.md, everything else same name.
while IFS= read -r src_file; do
  rel="${src_file#$SRC_DIR/}"
  if [[ "$rel" == "SKILL.md.template" ]]; then
    put_file "SKILL.md" "$src_file" 1
  else
    put_file "$rel" "$src_file" 1
  fi
done < <(find "$SRC_DIR" -mindepth 1 -type f | sort)

# --- AGENTS.md routing note (project-local only; never the shared template) ---
AGENTS_FILE="$ROOT/AGENTS.md"
NOTE_BEGIN="<!-- security-audit-routing -->"
NOTE_END="<!-- /security-audit-routing -->"
read -r -d '' NOTE_BODY <<'NOTE' || true
<!-- security-audit-routing -->
## Security Audit Skill (opt-in, project-local)

This project has the Cloudflare `security-audit` skill enabled at `.opencode/skills/security-audit/SKILL.md` (pinned upstream; see ai-engkit `.opencode/baked-skills/enable-security-audit/UPSTREAM.md`).

- For security questions, focused reviews, or methodology help: load the skill in guidance mode (relevant sections only, no file creation).
- For explicit audit / pen-test / full-review / report-artifact requests: run the full six-phase workflow; write output outside the target repo (default `~/security-audit-skill/<repo>/run-<N>`), inside the target only when the user explicitly selects an ignored directory.
- Validators: `node .opencode/skills/security-audit/validate-findings.cjs`, `node .opencode/skills/security-audit/validate-coverage-ledger.cjs` (container `node` is a Bun shim: `node <file>.cjs` works, `node --test` does not — run validator tests with `bun test`).
- V2 note: no `team_mode` toggle exists on this line (no `~/.omo/omo.jsonc`); audit never required it. Use native subagents for isolated hunters/verifiers under the skill's write-isolation boundaries.
<!-- /security-audit-routing -->
NOTE

if [[ ! -f "$AGENTS_FILE" ]]; then
  printf '%s\n' "$NOTE_BODY" > "$AGENTS_FILE"
  CREATED+=("$AGENTS_FILE")
else
  if grep -qF "$NOTE_BEGIN" "$AGENTS_FILE"; then
    # Refresh the note segment in place when --force; otherwise keep as-is.
    if [[ "$FORCE" == "1" ]]; then
      tmp="$(mktemp)"
      awk -v begin="$NOTE_BEGIN" -v end="$NOTE_END" -v body="$NOTE_BODY" '
        BEGIN { in_note = 0 }
        index($0, begin) && !in_note { print body; in_note = 1; next }
        in_note && index($0, end) { in_note = 0; next }
        in_note { next }
        { print }
      ' "$AGENTS_FILE" > "$tmp"
      mv "$tmp" "$AGENTS_FILE"
      CREATED+=("$AGENTS_FILE (routing note refreshed)")
    else
      SKIPPED+=("$AGENTS_FILE (routing note exists)")
    fi
  else
    # Pre-existing user content is preserved; note is appended exactly once.
    if [[ -s "$AGENTS_FILE" ]]; then
      printf '\n%s\n' "$NOTE_BODY" >> "$AGENTS_FILE"
    else
      printf '%s\n' "$NOTE_BODY" > "$AGENTS_FILE"
    fi
    CREATED+=("$AGENTS_FILE (routing note appended)")
  fi
fi

echo ""
echo "| Path | Action |"
echo "|------|--------|"
for p in "${CREATED[@]}"; do
  echo "| \`$p\` | **created** |"
done
for p in "${SKIPPED[@]}"; do
  echo "| \`$p\` | skipped (exists) |"
done
echo ""

if [[ ${#CREATED[@]} -eq 0 ]]; then
  echo "Security audit skill already enabled. Nothing changed."
fi
