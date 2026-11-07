#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENTRYPOINT_FILE="$SCRIPT_DIR/02-init-config.sh"

run_sync() {
  local root="$1"
  local sync_source="$root/sync.sh"
  sed -n '/^sync_ai_engkit_agents_md()/,/^sync_ai_engkit_agents_md "\$AI_ENGKIT_AGENTS_DEFAULT" "\$USER_AGENTS_MD"$/p' "$ENTRYPOINT_FILE" | sed '$d' > "$sync_source"
  source "$sync_source"
  sync_ai_engkit_agents_md "$root/default.md" "$root/AGENTS.md"
}

run_migration() {
  local root="$1"
  local migration_source="$root/migrate.sh"
  sed -n '/^migrate_leanctx_compression_level()/,/^migrate_leanctx_compression_level$/p' "$ENTRYPOINT_FILE" | sed '$d' > "$migration_source"
  printf '%s\n' 'migrate_leanctx_compression_level' >> "$migration_source"
  LEANCTX_RUNTIME_CONFIG="$root/config.toml" bash "$migration_source"
}

run_ensure() {
  local root="$1"
  local ensure_source="$root/ensure.sh"
  sed -n '/^leanctx_runtime_config_is_malformed()/,/^ensure_leanctx_config$/p' "$ENTRYPOINT_FILE" | sed '$d' > "$ensure_source"
  printf '%s\n' 'ensure_leanctx_config' >> "$ensure_source"
  # lean-ctx resolves config through XDG_CONFIG_HOME; copy the fixture there so
  # validation reads isolated contents from a regular config file.
  mkdir -p "$root/xdg/lean-ctx"
  cp "$root/config.toml" "$root/xdg/lean-ctx/config.toml"
  XDG_CONFIG_HOME="$root/xdg" LEANCTX_BASELINE_CONFIG="$root/default.toml" LEANCTX_RUNTIME_CONFIG="$root/config.toml" bash "$ensure_source"
}

extract_function() {
  local func_name="$1"
  local src_file="$2"
  sed -n "/^# BEGIN FUNCTION: ${func_name}$/,/^# END FUNCTION: ${func_name}$/p" "$src_file"
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

assert_shipped_baseline_disables_shadow_mode_and_backfills() {
  local root
  root="$(mktemp -d)"
  grep -Fxq 'shadow_mode = false' "$SCRIPT_DIR/../docker/lean-ctx/config.default.toml"
  printf '%s\n' 'compression_level = "lite"' 'shadow_mode = false' > "$root/default.toml"
  printf '%s\n' 'compression_level = "lite"' > "$root/config.toml"
  run_ensure "$root"
  grep -Fxq 'shadow_mode = false' "$root/config.toml"
  rm -rf "$root"
}

assert_shadow_mode_backfill_stays_at_root_after_telemetry_section() {
  local root first_hash second_hash
  root="$(mktemp -d)"
  printf '%s\n' 'compression_level = "lite"' 'shadow_mode = false' > "$root/default.toml"
  printf '%s\n' \
    'compression_level = "lite"' \
    '[telemetry]' \
    'last_heartbeat = "2026-10-13"' \
    'shadow_mode = false' > "$root/config.toml"
  run_ensure "$root"
  python3 - "$root/config.toml" <<'PY'
import sys
import tomllib

with open(sys.argv[1], "rb") as config_file:
    config = tomllib.load(config_file)

assert config.get("shadow_mode") is False, config
assert config.get("telemetry") == {
    "last_heartbeat": "2026-10-13",
    "shadow_mode": False,
}, config
PY
  first_hash="$(sha256sum "$root/config.toml" | cut -d' ' -f1)"
  run_ensure "$root"
  second_hash="$(sha256sum "$root/config.toml" | cut -d' ' -f1)"
  test "$first_hash" = "$second_hash"
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

assert_opencode_permission_policy_allows_shell() {
  local root policy status=0
  root="$(mktemp -d)"
  sed -n '/^build_opencode_permission_policy()/,/^}/p' "$ENTRYPOINT_FILE" > "$root/permission-policy.sh"
  printf '%s\n' 'build_opencode_permission_policy' >> "$root/permission-policy.sh"
  policy="$(bash "$root/permission-policy.sh")" || status=$?
  rm -rf "$root"
  test "$status" -eq 0
  grep -Fq -- '--argjson permission "$OPENCODE_PERMISSION"' "$ENTRYPOINT_FILE"
  grep -Fq 'permission: $permission,' "$ENTRYPOINT_FILE"
  printf '%s\n' "$policy" | jq -e '
    .read == "allow" and
    .glob == "allow" and
    .grep == "allow" and
    .bash == "allow"
  ' >/dev/null
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
  grep -q 'knowledge-capture v1.1.0' "$project_dir/.opencode/skills/knowledge-capture/SKILL.md"
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

run_deploy() {
  local root="$1"
  local deploy_source="$root/deploy.sh"
  extract_function "deploy_native_agents" "$ENTRYPOINT_FILE" > "$deploy_source"
  printf '%s\n' "deploy_native_agents \"$root/src\" \"$root/dest\"" >> "$deploy_source"
  bash "$deploy_source"
}

run_undeploy() {
  local root="$1"
  local undeploy_source="$root/undeploy.sh"
  extract_function "undeploy_native_agents" "$ENTRYPOINT_FILE" > "$undeploy_source"
  printf '%s\n' "undeploy_native_agents \"$root/dest\"" >> "$undeploy_source"
  bash "$undeploy_source"
}

run_prune_ghosts() {
  local root="$1"
  local prune_source="$root/prune.sh"
  extract_function "prune_legacy_omo_ghosts" "$ENTRYPOINT_FILE" > "$prune_source"
  printf '%s\n' "prune_legacy_omo_ghosts \"$root/cfg\"" >> "$prune_source"
  bash "$prune_source"
}

run_prune_plugin_cache() {
  local root="$1"
  local prune_source="$root/prune-cache.sh"
  extract_function "prune_omo_plugin_cache" "$ENTRYPOINT_FILE" > "$prune_source"
  printf '%s\n' "prune_omo_plugin_cache \"$root/cache\"" >> "$prune_source"
  bash "$prune_source"
}

run_prune_state_cache() {
  local root="$1"
  local prune_source="$root/prune-state.sh"
  extract_function "prune_omo_state_cache" "$ENTRYPOINT_FILE" > "$prune_source"
  printf '%s\n' "prune_omo_state_cache \"$root/state\"" >> "$prune_source"
  bash "$prune_source"
}

assert_deploy_installs_and_records_manifest() {
  local root
  root="$(mktemp -d)"
  mkdir -p "$root/src"
  printf '%s\n' '---' 'description: Atlas agent' 'mode: primary' '---' '# Atlas' > "$root/src/atlas.md"
  printf '%s\n' '---' 'description: Sisyphus agent' 'mode: primary' '---' '# Sisyphus' > "$root/src/sisyphus.md"
  run_deploy "$root" > "$root/stdout" 2> "$root/stderr"
  cmp -s "$root/src/atlas.md" "$root/dest/atlas.md"
  cmp -s "$root/src/sisyphus.md" "$root/dest/sisyphus.md"
  grep -Fxq 'atlas.md' "$root/dest/.ai-engkit-native-manifest"
  grep -Fxq 'sisyphus.md' "$root/dest/.ai-engkit-native-manifest"
  grep -Fq 'Native agents deployed to' "$root/stdout"
  rm -rf "$root"
}

assert_deploy_removes_omo_display_name_ghosts() {
  local root
  root="$(mktemp -d)"
  mkdir -p "$root/src" "$root/dest"
  printf '%s\n' '# Atlas' > "$root/src/atlas.md"
  printf '%s\n' '# stale ghost' > "$root/dest/Atlas - Plan Executor.md"
  printf '%s\n' '# stale ghost' > "$root/dest/Sisyphus - ultraworker.md"
  printf '%s\n' '# user custom agent, must survive' > "$root/dest/my-helper.md"
  run_deploy "$root" > "$root/stdout" 2> "$root/stderr"
  test ! -e "$root/dest/Atlas - Plan Executor.md"
  test ! -e "$root/dest/Sisyphus - Ultraworker.md"
  test ! -e "$root/dest/Sisyphus - ultraworker.md"
  grep -Fq '# user custom agent, must survive' "$root/dest/my-helper.md"
  cmp -s "$root/src/atlas.md" "$root/dest/atlas.md"
  grep -Fq 'stale OMO display-name file' "$root/stderr"
  rm -rf "$root"
}

assert_deploy_prunes_dropped_agent_via_manifest() {
  local root
  root="$(mktemp -d)"
  mkdir -p "$root/src" "$root/dest"
  printf '%s\n' '# Atlas' > "$root/src/atlas.md"
  printf '%s\n' '# old agent from previous image' > "$root/dest/athena.md"
  printf '%s\n' 'athena.md' 'atlas.md' > "$root/dest/.ai-engkit-native-manifest"
  printf '%s\n' '# user custom agent, must survive' > "$root/dest/my-helper.md"
  run_deploy "$root" > "$root/stdout" 2> "$root/stderr"
  test ! -e "$root/dest/athena.md"
  grep -Fq '# user custom agent, must survive' "$root/dest/my-helper.md"
  grep -Fxq 'atlas.md' "$root/dest/.ai-engkit-native-manifest"
  ! grep -Fxq 'athena.md' "$root/dest/.ai-engkit-native-manifest"
  grep -Fq 'pruned stale deployed file: athena.md' "$root/stderr"
  rm -rf "$root"
}

assert_deploy_is_idempotent() {
  local root first_hash second_hash
  root="$(mktemp -d)"
  mkdir -p "$root/src" "$root/dest"
  printf '%s\n' '# Atlas' > "$root/src/atlas.md"
  printf '%s\n' '# stale ghost' > "$root/dest/Atlas - Plan Executor.md"
  run_deploy "$root" > /dev/null 2>&1
  first_hash="$(find "$root/dest" -type f | sort | xargs sha256sum | sha256sum | cut -d' ' -f1)"
  run_deploy "$root" > "$root/second.out" 2> "$root/second.err"
  second_hash="$(find "$root/dest" -type f | sort | xargs sha256sum | sha256sum | cut -d' ' -f1)"
  test "$first_hash" = "$second_hash"
  test ! -e "$root/dest/Atlas - Plan Executor.md"
  rm -rf "$root"
}

assert_deploy_skips_missing_source() {
  local root status=0
  root="$(mktemp -d)"
  run_deploy "$root" > "$root/stdout" 2> "$root/stderr" || status=$?
  test "$status" -eq 0
  test ! -e "$root/dest"
  grep -Fq 'native agents source missing' "$root/stderr"
  rm -rf "$root"
}

assert_undeploy_removes_manifest_files_only() {
  local root
  root="$(mktemp -d)"
  mkdir -p "$root/dest"
  printf '%s\n' '# Atlas' > "$root/dest/atlas.md"
  printf '%s\n' '# user custom agent, must survive' > "$root/dest/my-helper.md"
  printf '%s\n' 'atlas.md' '../escape.md' '' > "$root/dest/.ai-engkit-native-manifest"
  run_undeploy "$root" > "$root/stdout" 2> "$root/stderr"
  test ! -e "$root/dest/atlas.md"
  test ! -e "$root/dest/.ai-engkit-native-manifest"
  grep -Fq '# user custom agent, must survive' "$root/dest/my-helper.md"
  rm -rf "$root"
}

assert_undeploy_without_manifest_is_noop() {
  local root status=0
  root="$(mktemp -d)"
  mkdir -p "$root/dest"
  printf '%s\n' '# user custom agent, must survive' > "$root/dest/my-helper.md"
  run_undeploy "$root" > "$root/stdout" 2> "$root/stderr" || status=$?
  test "$status" -eq 0
  grep -Fq '# user custom agent, must survive' "$root/dest/my-helper.md"
  rm -rf "$root"
}

assert_deploy_then_undeploy_roundtrip() {
  local root
  root="$(mktemp -d)"
  mkdir -p "$root/src"
  printf '%s\n' '# Atlas' > "$root/src/atlas.md"
  run_deploy "$root" > /dev/null 2>&1
  test -f "$root/dest/atlas.md"
  run_undeploy "$root" > "$root/stdout" 2> "$root/stderr"
  test ! -e "$root/dest/atlas.md"
  test ! -e "$root/dest/.ai-engkit-native-manifest"
  test ! -e "$root/dest"
  rm -rf "$root"
}

assert_prune_removes_legacy_ghost_files() {
  local root zw
  root="$(mktemp -d)"
  zw="$(printf '\u200b')"
  mkdir -p "$root/cfg/agents"
  printf '%s\n' '# stale ghost' > "$root/cfg/agents/Atlas - Plan Executor.md"
  printf '%s\n' '# stale ghost with sort prefix' > "$root/cfg/agents/${zw}Sisyphus - Ultraworker.md"
  printf '%s\n' '# user custom agent, must survive' > "$root/cfg/agents/my-helper.md"
  printf '%s\n' '# ordinary name without separator, must survive' > "$root/cfg/agents/Sisyphus-Junior.md"
  run_prune_ghosts "$root" > "$root/stdout" 2> "$root/stderr"
  test ! -e "$root/cfg/agents/Atlas - Plan Executor.md"
  test ! -e "$root/cfg/agents/${zw}Sisyphus - Ultraworker.md"
  grep -Fq '# user custom agent, must survive' "$root/cfg/agents/my-helper.md"
  grep -Fq '# ordinary name without separator, must survive' "$root/cfg/agents/Sisyphus-Junior.md"
  grep -Fq 'legacy OMO ghost file' "$root/stderr"
  rm -rf "$root"
}

assert_prune_strips_config_json_ghost_keys() {
  local root
  root="$(mktemp -d)"
  mkdir -p "$root/cfg"
  printf '%s\n' '{"agent":{"Sisyphus - ultraworker":{"permission":{}},"general":{"model":"opencode/big-pickle"},"plan":{}}}' > "$root/cfg/config.json"
  run_prune_ghosts "$root" > "$root/stdout" 2> "$root/stderr"
  ! jq -e '.agent | has("Sisyphus - ultraworker")' "$root/cfg/config.json" >/dev/null
  test "$(jq -c '.agent.general.model' "$root/cfg/config.json")" = '"opencode/big-pickle"'
  jq -e '.agent | has("plan")' "$root/cfg/config.json" >/dev/null
  grep -Fq 'legacy OMO ghost keys' "$root/stderr"
  rm -rf "$root"
}

assert_prune_is_noop_without_legacy_paths() {
  local root status=0
  root="$(mktemp -d)"
  mkdir -p "$root/cfg"
  run_prune_ghosts "$root" > "$root/stdout" 2> "$root/stderr" || status=$?
  test "$status" -eq 0
  test ! -e "$root/stderr" || test ! -s "$root/stderr"
  rm -rf "$root"
}

assert_prune_leaves_clean_config_json_alone() {
  local root before after
  root="$(mktemp -d)"
  mkdir -p "$root/cfg"
  printf '%s\n' '{"agent":{"general":{"model":"opencode/big-pickle"}}}' > "$root/cfg/config.json"
  before="$(sha256sum "$root/cfg/config.json" | cut -d' ' -f1)"
  run_prune_ghosts "$root" > "$root/stdout" 2> "$root/stderr"
  after="$(sha256sum "$root/cfg/config.json" | cut -d' ' -f1)"
  test "$before" = "$after"
  ! grep -Fq 'legacy OMO ghost keys' "$root/stderr"
  rm -rf "$root"
}

assert_prune_survives_malformed_config_json() {
  local root status=0
  root="$(mktemp -d)"
  mkdir -p "$root/cfg"
  printf '%s\n' '{"agent": {"broken": ' > "$root/cfg/config.json"
  run_prune_ghosts "$root" > "$root/stdout" 2> "$root/stderr" || status=$?
  test "$status" -eq 0
  grep -Fq '"broken":' "$root/cfg/config.json"
  rm -rf "$root"
}

assert_plugin_cache_prunes_all_omo_versions_only() {
  local root
  root="$(mktemp -d)"
  mkdir -p "$root/cache/oh-my-openagent@4.19.4" "$root/cache/oh-my-openagent@5.1.57" \
    "$root/cache/oh-my-opencode@1.0.0" "$root/cache/superpowers@git+https:" \
    "$root/cache/bash-language-server"
  printf '%s\n' '# stale' > "$root/cache/oh-my-openagent@5.1.57/pkg.txt"
  run_prune_plugin_cache "$root" > "$root/stdout" 2> "$root/stderr"
  test ! -e "$root/cache/oh-my-openagent@4.19.4"
  test ! -e "$root/cache/oh-my-openagent@5.1.57"
  test ! -e "$root/cache/oh-my-opencode@1.0.0"
  test -d "$root/cache/superpowers@git+https:"
  test -d "$root/cache/bash-language-server"
  grep -Fq 'stale OMO plugin cache: oh-my-openagent@5.1.57' "$root/stderr"
  rm -rf "$root"
}

assert_plugin_cache_is_noop_without_cache_dir() {
  local root status=0
  root="$(mktemp -d)"
  run_prune_plugin_cache "$root" > "$root/stdout" 2> "$root/stderr" || status=$?
  test "$status" -eq 0
  test ! -s "$root/stderr"
  rm -rf "$root"
}

assert_state_cache_empties_contents_keeps_mount() {
  local root
  root="$(mktemp -d)"
  mkdir -p "$root/state/nested"
  printf '%s\n' 'data' > "$root/state/nested/file.txt"
  run_prune_state_cache "$root" > "$root/stdout" 2> "$root/stderr"
  test -d "$root/state"
  test -z "$(ls -A "$root/state")"
  grep -Fq 'pruned OMO state cache' "$root/stderr"
  rm -rf "$root"
}

assert_state_cache_is_noop_when_empty_or_missing() {
  local root status=0
  root="$(mktemp -d)"
  mkdir -p "$root/state"
  run_prune_state_cache "$root" > "$root/stdout" 2> "$root/stderr" || status=$?
  test "$status" -eq 0
  test ! -s "$root/stderr"
  rm -rf "$root/state"
  run_prune_state_cache "$root" > "$root/stdout2" 2> "$root/stderr2" || status=$?
  test "$status" -eq 0
  test ! -s "$root/stderr2"
  rm -rf "$root"
}

assert_normal_sync_is_atomic_and_idempotent
assert_opencode_permission_policy_allows_shell
assert_migration_backup_and_marker_boundary
if command -v lean-ctx >/dev/null 2>&1; then
  assert_off_config_still_recovers_malformed_toml
  assert_malformed_backup_preserves_original_bytes
  assert_malformed_backup_names_are_unique
  assert_off_config_backfills_missing_baseline_keys
  assert_lite_config_is_valid_and_idempotent
  assert_valid_config_cleans_inert_keys_and_backfills_dotted_baseline_keys
  assert_shipped_baseline_disables_shadow_mode_and_backfills
  assert_shadow_mode_backfill_stays_at_root_after_telemetry_section
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
assert_deploy_installs_and_records_manifest
assert_deploy_removes_omo_display_name_ghosts
assert_deploy_prunes_dropped_agent_via_manifest
assert_deploy_is_idempotent
assert_deploy_skips_missing_source
assert_undeploy_removes_manifest_files_only
assert_undeploy_without_manifest_is_noop
assert_deploy_then_undeploy_roundtrip
assert_prune_removes_legacy_ghost_files
assert_prune_strips_config_json_ghost_keys
assert_prune_is_noop_without_legacy_paths
assert_prune_leaves_clean_config_json_alone
assert_prune_survives_malformed_config_json
assert_plugin_cache_prunes_all_omo_versions_only
assert_plugin_cache_is_noop_without_cache_dir
assert_state_cache_empties_contents_keeps_mount
assert_state_cache_is_noop_when_empty_or_missing
printf '%s\n' 'AGENTS sync tests passed'
printf '%s\n' 'Bootstrapped skill upgrade tests passed'
printf '%s\n' 'Native agents deploy tests passed'
