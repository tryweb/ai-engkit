#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENTRYPOINT_FILE="$SCRIPT_DIR/02-init-config.sh"

# Robust function extraction using awk (counts braces, works across all sed versions)
extract_function() {
  local func_name="$1"
  local src_file="$2"
  awk -v fn="$func_name" '
    $0 ~ "^"fn"\\(\\) \\{" { found = 1; depth = 0 }
    found {
      # Count opening and closing braces
      for (i = 1; i <= length($0); i++) {
        c = substr($0, i, 1)
        if (c == "{") depth++
        else if (c == "}") depth--
      }
      print
      if (depth == 0 && NR > 1) exit
    }
  ' "$src_file"
}

run_sync() {
  local root="$1"
  local sync_source="$root/sync.sh"
  extract_function "sync_ai_engkit_agents_md" "$ENTRYPOINT_FILE" > "$sync_source"
  source "$sync_source"
  sync_ai_engkit_agents_md "$root/default.md" "$root/AGENTS.md"
}

run_migration() {
  local root="$1"
  local migration_source="$root/migrate.sh"
  extract_function "migrate_leanctx_compression_level" "$ENTRYPOINT_FILE" > "$migration_source"
  LEANCTX_RUNTIME_CONFIG="$root/config.toml" bash "$migration_source"
}

run_ensure() {
  local root="$1"
  local ensure_source="$root/ensure.sh"
  extract_function "leanctx_runtime_config_is_malformed" "$ENTRYPOINT_FILE" > "$ensure_source"
  printf '%s\n' 'ensure_leanctx_config' >> "$ensure_source"
  LEANCTX_BASELINE_CONFIG="$root/default.toml" LEANCTX_RUNTIME_CONFIG="$root/config.toml" bash "$ensure_source"
}

run_upgrade() {
  local root="$1"
  local skill_name="${2:-knowledge-capture}"
  local bootstrap_dir="${3:-$root/skills/enable-project-knowledge}"
  local upgrade_source="$root/upgrade.sh"
  extract_function "upgrade_bootstrapped_skills" "$ENTRYPOINT_FILE" > "$upgrade_source"
  printf '%s\n' "upgrade_bootstrapped_skills \"$skill_name\" \"$bootstrap_dir\" \"$root/workspace\" \"$root/.skill-versions\"" >> "$upgrade_source"
  # shellcheck disable=SC1091
  source "$upgrade_source"
}

assert_migration_backup_and_marker_boundary() {
  local root
  root="$(mktemp -d)"
  printf '%s\n' 'compression_level = "off"' 'shell_write_policy = "disabled"' > "$root/config.toml"
  cp "$root/config.toml" "$root/before.toml"
  run_migration "$root"
  grep -Fxq 'compression_level = "lite"' "$root/config.toml"
  grep -Fxq 'shell_write_policy = "disabled"' "$root/config.toml"
  cmp -s "$root/before.toml" "$root/config.toml.pre-migration-v2"
  test -f "$root/config.toml.migration-v2"
  cp "$root/config.toml.pre-migration-v2" "$root/config.toml"
  run_migration "$root"
  grep -Fxq 'compression_level = "off"' "$root/config.toml"
  test -f "$root/config.toml.migration-v2"
  rm -rf "$root"
}

assert_off_config_still_recovers_malformed_toml() {
  local root backups
  root="$(mktemp -d)"
  printf '%s\n' 'compression_level = "off"' > "$root/default.toml"
  printf '%s\n' 'compression_level = "off"' 'broken = [' > "$root/config.toml"
  cp "$root/config.toml" "$root/before.toml"
  run_ensure "$root"
  cmp -s "$root/default.toml" "$root/config.toml"
  backups=("$root"/config.toml.malformed.*)
  test -f "${backups[0]}"
  cmp -s "$root/before.toml" "${backups[0]}"
  rm -rf "$root"
}

assert_malformed_backup_preserves_original_bytes() {
  local root backups
  root="$(mktemp -d)"
  printf '%s\n' 'compression_level = "off"' > "$root/default.toml"
  printf '%s\n' \
    'compression_level = "off"' \
    'tools.profile = "legacy"' \
    'budget.information_gate.enabled = true' \
    'broken = [' > "$root/config.toml"
  cp "$root/config.toml" "$root/before.toml"
  run_ensure "$root"
  backups=("$root"/config.toml.malformed.*)
  test -f "${backups[0]}"
  cmp -s "$root/before.toml" "${backups[0]}"
  ! grep -Fq 'tool_profile' "${backups[0]}"
  rm -rf "$root"
}

assert_malformed_backup_names_are_unique() {
  local root backups first_backup second_backup="" backup
  root="$(mktemp -d)"
  printf '%s\n' 'compression_level = "off"' > "$root/default.toml"
  printf '%s\n' 'compression_level = "off"' 'broken = [' > "$root/config.toml"
  run_ensure "$root"
  backups=("$root"/config.toml.malformed.*)
  first_backup="${backups[0]}"
  printf '%s\n' 'compression_level = "off"' 'broken = [' > "$root/config.toml"
  run_ensure "$root"
  backups=("$root"/config.toml.malformed.*)
  test "${#backups[@]}" -eq 2
  for backup in "${backups[@]}"; do
    if [ "$backup" != "$first_backup" ]; then
      second_backup="$backup"
      break
    fi
  done
  test -n "$second_backup"
  test "$first_backup" != "$second_backup"
  rm -rf "$root"
}

assert_migration_marker_is_atomic_and_private() {
  local root marker mode
  root="$(mktemp -d)"
  printf '%s\n' 'compression_level = "off"' > "$root/config.toml"
  run_migration "$root"
  marker="$root/config.toml.migration-v2"
  test -f "$marker"
  mode="$(stat -c '%a' "$marker" 2>/dev/null || stat -f '%A' "$marker")"
  test "$mode" = "600"
  ! compgen -G "$root/config.toml.migration-v2.tmp.*" >/dev/null
  rm -rf "$root"
}

assert_off_config_backfills_missing_baseline_keys() {
  local root
  root="$(mktemp -d)"
  printf '%s\n' \
    'compression_level = "off"' \
    'graph_index_max_files = 9999' \
    'savings_footer = "auto"' > "$root/default.toml"
  printf '%s\n' 'compression_level = "off"' > "$root/config.toml"
  run_ensure "$root"
  grep -Fxq 'graph_index_max_files = 9999' "$root/config.toml"
  grep -Fxq 'savings_footer = "auto"' "$root/config.toml"
  test "$(grep -cE '^[[:space:]]*compression_level[[:space:]]*=' "$root/config.toml")" -eq 1
  rm -rf "$root"
}

assert_lite_config_is_valid_and_idempotent() {
  local root baseline_before
  root="$(mktemp -d)"
  printf '%s\n' \
    'compression_level = "off"' \
    'graph_index_max_files = 9999' > "$root/default.toml"
  printf '%s\n' \
    'compression_level = "lite"' \
    'graph_index_max_files = 5000' > "$root/config.toml"
  cp "$root/default.toml" "$root/baseline-before.toml"
  run_ensure "$root"
  run_ensure "$root"
  grep -Fxq 'compression_level = "lite"' "$root/config.toml"
  test "$(grep -cE '^[[:space:]]*compression_level[[:space:]]*=' "$root/config.toml")" -eq 1
  cmp -s "$root/baseline-before.toml" "$root/default.toml"
  rm -rf "$root"
}

assert_valid_config_cleans_inert_keys_and_backfills_dotted_baseline_keys() {
  local root
  root="$(mktemp -d)"
  printf '%s\n' \
    'compression_level = "off"' \
    'secret_detection.enabled = true' \
    'secret_detection.redact = true' > "$root/default.toml"
  printf '%s\n' \
    'compression_level = "off"' \
    'cognitive_mode = "full"' \
    'loop_detection.enabled = false' \
    'proxy.enabled = false' \
    'secret_detection.redact_in_archive = false' \
    'search.candidate_count = 100' \
    'loop_detection.max_calls_per_tool = 50' \
    'loop_detection.max_total_calls = 200' \
    'boundary_policy.universal_gotchas = false' \
    'proxy.port = 4444' \
    'tools.profile = "legacy"' \
    'budget.information_gate.enabled = true' \
    'graph_index_max_files = 5000' > "$root/config.toml"
  run_ensure "$root"
  ! grep -Eq '^(cognitive_mode|search\.candidate_count|loop_detection\.(enabled|max_calls_per_tool|max_total_calls)|boundary_policy\.universal_gotchas|proxy\.(enabled|port)|secret_detection\.redact_in_archive)[[:space:]]*=' "$root/config.toml"
  ! grep -Fq 'tools.profile' "$root/config.toml"
  ! grep -Fq 'budget.information_gate.enabled' "$root/config.toml"
  grep -Fxq 'tool_profile = "legacy"' "$root/config.toml"
  grep -Fxq 'secret_detection.enabled = true' "$root/config.toml"
  grep -Fxq 'secret_detection.redact = true' "$root/config.toml"
  rm -rf "$root"
}

assert_malformed() {
  local name="$1"
  local content="$2"
  local root
  root="$(mktemp -d)"
  printf '%s\n' '<!-- @ai-engkit -->' default '<!-- /@ai-engkit -->' > "$root/default.md"
  printf '%s\n' "$content" > "$root/AGENTS.md"
  cp "$root/AGENTS.md" "$root/before.md"
  run_sync "$root" > "$root/stdout" 2> "$root/stderr"
  cmp -s "$root/before.md" "$root/AGENTS.md"
  grep -Fq 'Warning: malformed @ai-engkit marker order' "$root/stderr"
  rm -rf "$root"
}

make_bootstrap_script() {
  local dest="$1"
  local version="$2"
  local skill_name="${3:-knowledge-capture}"
  mkdir -p "$(dirname "$dest")"
  # Use a quoted heredoc to prevent variable expansion, then substitute version and skill name
  cat > "$dest" <<'SCRIPT_TEMPLATE'
#!/usr/bin/env bash
FORCE=0
if [ "$1" = "--force" ]; then
  FORCE=1
  shift
fi
ROOT="$1"
SKILL_DIR="$ROOT/.opencode/skills/__SKILL_NAME__"
SKILL_FILE="$SKILL_DIR/SKILL.md"
if [ -f "$SKILL_FILE" ] && [ "$FORCE" != "1" ]; then
  echo "SKIPPED"
  exit 0
fi
mkdir -p "$SKILL_DIR"
cat > "$SKILL_FILE" <<'SKILL_CONTENT'
<!-- skill-version: __VERSION__ -->
---
name: __SKILL_NAME__
---
# __SKILL_NAME__ v__VERSION__
SKILL_CONTENT
SCRIPT_TEMPLATE
  sed -i "s/__VERSION__/$version/g; s/__SKILL_NAME__/$skill_name/g" "$dest"
  chmod +x "$dest"
}

assert_upgrade_when_version_changes() {
  local root project_dir
  root="$(mktemp -d)"
  project_dir="$root/workspace/proj-a"
  mkdir -p "$project_dir/.opencode/skills/knowledge-capture"
  printf '%s\n' '<!-- skill-version: 1.0.0 -->' '---' 'name: knowledge-capture' '---' '# Old' > "$project_dir/.opencode/skills/knowledge-capture/SKILL.md"
  make_bootstrap_script "$root/skills/enable-project-knowledge/bootstrap.sh" "1.1.0"
  run_upgrade "$root"
  grep -q 'skill-version: 1.1.0' "$project_dir/.opencode/skills/knowledge-capture/SKILL.md"
  grep -q 'Knowledge Capture v1.1.0' "$project_dir/.opencode/skills/knowledge-capture/SKILL.md"
  grep -q 'knowledge-capture=1.1.0' "$root/.skill-versions"
  rm -rf "$root"
}

assert_skip_when_version_unchanged() {
  local root project_dir
  root="$(mktemp -d)"
  project_dir="$root/workspace/proj-a"
  mkdir -p "$project_dir/.opencode/skills/knowledge-capture"
  printf '%s\n' '<!-- skill-version: 1.0.0 -->' '---' 'name: knowledge-capture' '---' '# Content' > "$project_dir/.opencode/skills/knowledge-capture/SKILL.md"
  make_bootstrap_script "$root/skills/enable-project-knowledge/bootstrap.sh" "1.0.0"
  echo "knowledge-capture=1.0.0" > "$root/.skill-versions"
  run_upgrade "$root"
  grep -q '# Content' "$project_dir/.opencode/skills/knowledge-capture/SKILL.md"
  rm -rf "$root"
}

assert_skip_projects_without_skill() {
  local root project_dir
  root="$(mktemp -d)"
  project_dir="$root/workspace/proj-b"
  mkdir -p "$project_dir/.opencode/skills/other-skill"
  make_bootstrap_script "$root/skills/enable-project-knowledge/bootstrap.sh" "1.1.0"
  run_upgrade "$root"
  test ! -f "$root/.skill-versions"
  rm -rf "$root"
}

assert_upgrade_multiple_skills_independently() {
  local root project_dir
  root="$(mktemp -d)"
  project_dir="$root/workspace/proj-multi"

  # Setup knowledge-capture skill (v1.0.0 -> v1.1.0)
  mkdir -p "$project_dir/.opencode/skills/knowledge-capture"
  printf '%s\n' '<!-- skill-version: 1.0.0 -->' '---' 'name: knowledge-capture' '---' '# Old KC' > "$project_dir/.opencode/skills/knowledge-capture/SKILL.md"
  make_bootstrap_script "$root/skills/enable-project-knowledge/bootstrap.sh" "1.1.0" "knowledge-capture"

  # Setup finalize-maintenance skill (v1.0.0 -> v1.1.0)
  mkdir -p "$project_dir/.opencode/skills/finalize-maintenance"
  printf '%s\n' '<!-- skill-version: 1.0.0 -->' '---' 'name: finalize-maintenance' '---' '# Old FM' > "$project_dir/.opencode/skills/finalize-maintenance/SKILL.md"
  make_bootstrap_script "$root/skills/enable-finalize-maintenance/bootstrap.sh" "1.1.0" "finalize-maintenance"

  # Upgrade knowledge-capture
  run_upgrade "$root" "knowledge-capture" "$root/skills/enable-project-knowledge"
  grep -q 'skill-version: 1.1.0' "$project_dir/.opencode/skills/knowledge-capture/SKILL.md" || { echo "FAIL: knowledge-capture not upgraded" >&2; exit 1; }
  grep -q 'knowledge-capture=1.1.0' "$root/.skill-versions" || { echo "FAIL: knowledge-capture marker not written" >&2; exit 1; }

  # Upgrade finalize-maintenance
  run_upgrade "$root" "finalize-maintenance" "$root/skills/enable-finalize-maintenance"
  grep -q 'skill-version: 1.1.0' "$project_dir/.opencode/skills/finalize-maintenance/SKILL.md" || { echo "FAIL: finalize-maintenance not upgraded" >&2; exit 1; }
  grep -q 'finalize-maintenance=1.1.0' "$root/.skill-versions" || { echo "FAIL: finalize-maintenance marker not written" >&2; exit 1; }

  rm -rf "$root"
}

assert_normal_sync_is_atomic_and_idempotent() {
  local root first_hash second_hash
  root="$(mktemp -d)"
  printf '%s\n' '<!-- @ai-engkit -->' managed '<!-- /@ai-engkit -->' > "$root/default.md"
  printf '%s\n' prefix '<!-- @ai-engkit -->' stale '<!-- /@ai-engkit -->' suffix > "$root/AGENTS.md"
  run_sync "$root" > "$root/first.out" 2> "$root/first.err"
  grep -Fxq prefix "$root/AGENTS.md"
  grep -Fxq managed "$root/AGENTS.md"
  grep -Fxq suffix "$root/AGENTS.md"
  first_hash="$(sha256sum "$root/AGENTS.md" | cut -d' ' -f1)"
  run_sync "$root" > "$root/second.out" 2> "$root/second.err"
  second_hash="$(sha256sum "$root/AGENTS.md" | cut -d' ' -f1)"
  test "$first_hash" = "$second_hash"
  test ! -s "$root/second.out"
  test ! -s "$root/second.err"
  rm -rf "$root"
}

assert_normal_sync_is_atomic_and_idempotent
assert_migration_backup_and_marker_boundary
if command -v lean-ctx >/dev/null 2>&1; then
  assert_off_config_still_recovers_malformed_toml
  assert_malformed_backup_preserves_original_bytes
  assert_malformed_backup_names_are_unique
  assert_off_config_backfills_missing_baseline_keys
  assert_lite_config_is_valid_and_idempotent
  assert_valid_config_cleans_inert_keys_and_backfills_dotted_baseline_keys
else
  printf 'lean-ctx not on host; skipping malformed recovery assertion\n' >&2
fi
assert_migration_marker_is_atomic_and_private
assert_malformed closing-before-opening $'prefix\n<!-- /@ai-engkit -->\nbody\n<!-- @ai-engkit -->\nmanaged\n<!-- /@ai-engkit -->\nsuffix'
assert_malformed duplicate-opening $'prefix\n<!-- @ai-engkit -->\nfirst\n<!-- @ai-engkit -->\nsecond\n<!-- /@ai-engkit -->\nsuffix'
assert_malformed opening-without-close $'prefix\n<!-- @ai-engkit -->\nmanaged\nsuffix'
assert_malformed closing-without-open $'prefix\nmanaged\n<!-- /@ai-engkit -->\nsuffix'
assert_upgrade_when_version_changes
assert_skip_when_version_unchanged
assert_skip_projects_without_skill
assert_upgrade_multiple_skills_independently
printf '%s\n' 'AGENTS sync tests passed'
printf '%s\n' 'Bootstrapped skill upgrade tests passed'
