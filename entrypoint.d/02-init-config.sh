#!/usr/bin/env bash
set -euo pipefail

OPCODE_CONFIG_DIR="$HOME/.config/opencode"
OPENCHAMBER_DATA_DIR="${OPENCHAMBER_DATA_DIR:-$HOME/.config/openchamber}"
WORKSPACE_DIR="${WORKSPACE_DIR:-$HOME/workspace}"
LEANCTX_BASELINE_CONFIG="${LEANCTX_BASELINE_CONFIG:-/etc/lean-ctx/config.default.toml}"
LEANCTX_RUNTIME_CONFIG="${LEANCTX_RUNTIME_CONFIG:-$HOME/.config/lean-ctx/config.toml}"
migrate_leanctx_compression_level() {
    local marker_path="${LEANCTX_RUNTIME_CONFIG}.migration-v2"
    local backup_path="${LEANCTX_RUNTIME_CONFIG}.pre-migration-v2"
    local current_level
    local temporary_path

    [ -f "$LEANCTX_RUNTIME_CONFIG" ] || return 0
    [ -e "$marker_path" ] && return 0

    current_level="$(sed -nE 's/^[[:space:]]*compression_level[[:space:]]*=[[:space:]]*"([^"]*)".*$/\1/p' "$LEANCTX_RUNTIME_CONFIG" | head -n 1)"
    case "$current_level" in
        off)
            ;;
        lite|standard|max) return 0 ;;
        *)
            return 0
            ;;
    esac

    if ! cp -p "$LEANCTX_RUNTIME_CONFIG" "$backup_path"; then
        return 0
    fi
    chmod 600 "$backup_path" || return 0
    temporary_path="${LEANCTX_RUNTIME_CONFIG}.tmp.$$"
    if ! awk '
        BEGIN { replaced = 0 }
        !replaced && $0 ~ /^[[:space:]]*compression_level[[:space:]]*=/ {
            match($0, /^[[:space:]]*/)
            print substr($0, 1, RLENGTH) "compression_level = \"lite\""
            replaced = 1
            next
        }
        { print }
    ' "$LEANCTX_RUNTIME_CONFIG" > "$temporary_path"; then
        rm -f "$temporary_path"
        return 0
    fi
    chmod 600 "$temporary_path" || { rm -f "$temporary_path"; return 0; }
    if ! mv "$temporary_path" "$LEANCTX_RUNTIME_CONFIG"; then
        rm -f "$temporary_path"
        return 0
    fi
    temporary_path="${marker_path}.tmp.$$"
    printf '%s\n' 'lean-ctx compression migration v2' > "$temporary_path" || return 1
    chmod 600 "$temporary_path" || { rm -f "$temporary_path"; return 1; }
    mv "$temporary_path" "$marker_path" || { rm -f "$temporary_path"; return 1; }
}
migrate_leanctx_compression_level

leanctx_runtime_config_is_malformed() {
    local validation_output
    local compression_level
    command -v lean-ctx >/dev/null 2>&1 || return 2
    if [ -d /opt/admin/node_modules/smol-toml ]; then
        if ! (cd /opt/admin && LEANCTX_PARSE_PATH="$LEANCTX_RUNTIME_CONFIG" bun -e 'import { parse } from "smol-toml"; parse(await Bun.file(process.env.LEANCTX_PARSE_PATH).text())' >/dev/null 2>&1); then
            return 0
        fi
    fi
    compression_level="$(sed -nE 's/^[[:space:]]*compression_level[[:space:]]*=[[:space:]]*"([^"]*)"[[:space:]]*(#.*)?$/\1/p' "$LEANCTX_RUNTIME_CONFIG" | head -n 1)"
    case "$compression_level" in
        off|lite|standard|max) ;;
        "")
            grep -qE '^[[:space:]]*compression_level[[:space:]]*=' "$LEANCTX_RUNTIME_CONFIG" && return 0
            ;;
        *) return 0 ;;
    esac
    validation_output="$(lean-ctx config validate 2>&1)" && return 1
    validation_output="${validation_output,,}"
    case "$validation_output" in
        *not\ found*|*unavailable*) return 2 ;;
    esac
    case "$validation_output" in
        *unknown*)
            case "$validation_output" in
                *invalid*|*error*) return 0 ;;
                *) return 1 ;;
            esac
            ;;
        *)
            return 0
            ;;
    esac
}
ensure_leanctx_config() {
  mkdir -p "$(dirname "$LEANCTX_RUNTIME_CONFIG")"

  if [[ ! -f "$LEANCTX_RUNTIME_CONFIG" ]]; then
    if [[ -f "$LEANCTX_BASELINE_CONFIG" ]]; then
      cp "$LEANCTX_BASELINE_CONFIG" "$LEANCTX_RUNTIME_CONFIG"
      chmod 600 "$LEANCTX_RUNTIME_CONFIG"
      printf 'lean-ctx: seeded runtime config from %s\n' "$LEANCTX_BASELINE_CONFIG"
    fi
    return
  fi

  local leanctx_available=0
  command -v lean-ctx >/dev/null 2>&1 || leanctx_available=1

  if [ "$leanctx_available" -eq 0 ] && leanctx_runtime_config_is_malformed; then
    local backup_path
    backup_path="$(mktemp "${LEANCTX_RUNTIME_CONFIG}.malformed.XXXXXX")"
    rm -f "$backup_path"
    mv "$LEANCTX_RUNTIME_CONFIG" "$backup_path"
    if [[ -f "$LEANCTX_BASELINE_CONFIG" ]]; then
      cp "$LEANCTX_BASELINE_CONFIG" "$LEANCTX_RUNTIME_CONFIG"
      chmod 600 "$LEANCTX_RUNTIME_CONFIG"
      printf 'lean-ctx: malformed config backed up to %s; reseeded from baseline\n' "$backup_path" >&2
    else
      printf 'lean-ctx: malformed config backed up to %s; baseline is missing\n' "$backup_path" >&2
    fi
    return
  fi

  sed -i -E \
    -e 's/^tools\.profile[[:space:]]*=/tool_profile =/' \
    -e '/^budget\.information_gate\.(enabled|max_overlap_ratio|min_novel_lines|track_granularity)[[:space:]]*=/d' \
    -e '/^[[:space:]]*(cognitive_mode|search\.candidate_count|loop_detection\.(enabled|max_calls_per_tool|max_total_calls)|boundary_policy\.universal_gotchas|proxy\.(enabled|port)|secret_detection\.redact_in_archive)[[:space:]]*=/d' \
    "$LEANCTX_RUNTIME_CONFIG"

  [ "$leanctx_available" -eq 0 ] || return 1

  local compression_is_off=0
  if grep -qE '^[[:space:]]*compression_level[[:space:]]*=[[:space:]]*"off"[[:space:]]*(#.*)?$' "$LEANCTX_RUNTIME_CONFIG"; then
    compression_is_off=1
  fi

  if [[ -f "$LEANCTX_BASELINE_CONFIG" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ "$line" =~ ^([a-zA-Z_][a-zA-Z0-9_.]*)[[:space:]]*= ]]; then
        local key="${BASH_REMATCH[1]}"
        local key_pattern="${key//./\\.}"
        if [ "$compression_is_off" -eq 1 ] && [ "$key" = "compression_level" ]; then
          continue
        fi
        if ! grep -qE "^[[:space:]]*${key_pattern}[[:space:]]*=" "$LEANCTX_RUNTIME_CONFIG"; then
          printf '\n%s\n' "$line" >> "$LEANCTX_RUNTIME_CONFIG"
          printf 'lean-ctx: migrated missing key %s\n' "$key"
        fi
      fi
    done < "$LEANCTX_BASELINE_CONFIG"
  fi
}

ensure_leanctx_config
PROJECT_OPENCODE_DIR="$WORKSPACE_DIR/.opencode"
PROJECT_LSP_CONFIG_FILE="$PROJECT_OPENCODE_DIR/lsp.json"
DEFAULT_LSP_CONFIG_FILE="/etc/opencode/lsp.json.default"

init_file() {
  local file="$1"
  local content="$2"
  if [ ! -f "$file" ]; then
    echo "Creating default: $file"
    echo "$content" > "$file"
  fi
}

merge_project_lsp_config() {
  if [ ! -f "$DEFAULT_LSP_CONFIG_FILE" ]; then
    return 0
  fi

  mkdir -p "$PROJECT_OPENCODE_DIR"

  if [ ! -f "$PROJECT_LSP_CONFIG_FILE" ]; then
    cp "$DEFAULT_LSP_CONFIG_FILE" "$PROJECT_LSP_CONFIG_FILE"
    echo "Creating default: $PROJECT_LSP_CONFIG_FILE"
    return 0
  fi

  local merged_file
  merged_file="$(mktemp)"

  if jq -s '.[0] * .[1]' "$DEFAULT_LSP_CONFIG_FILE" "$PROJECT_LSP_CONFIG_FILE" > "$merged_file"; then
    mv "$merged_file" "$PROJECT_LSP_CONFIG_FILE"
    echo "Merged default Markdown LSP config into: $PROJECT_LSP_CONFIG_FILE"
  else
    rm -f "$merged_file"
    echo "Warning: Failed to merge $PROJECT_LSP_CONFIG_FILE with defaults" >&2
    return 1
  fi
}

plugin_dependency_name() {
  local plugin="$1"
  if [[ "$plugin" == @* ]]; then
    local scoped="${plugin#@}"
    local scope="${scoped%%/*}"
    local package="${scoped#*/}"
    package="${package%%@*}"
    printf '@%s/%s\n' "$scope" "$package"
  else
    printf '%s\n' "${plugin%%@*}"
  fi
}

expected_plugin_names() {
  local plugins="$1"
  local plugin
  echo "$plugins" | tr ',' '\n' | while IFS= read -r plugin; do
    plugin="${plugin//[[:space:]]/}"
    if [ -n "$plugin" ]; then
      plugin_dependency_name "$plugin"
    fi
  done | sort | tr '\n' ','
}

normalize_omo_plugin_versions() {
  local plugins="$1"
  local plugin
  local normalized=()

  IFS=',' read -ra plugin_list <<< "$plugins"
  for plugin in "${plugin_list[@]}"; do
    plugin="${plugin//[[:space:]]/}"
    if [ "$plugin" = "oh-my-openagent" ]; then
      plugin="oh-my-openagent@${OH_MY_OPENAGENT_VERSION}"
    fi
    [ -n "$plugin" ] && normalized+=("$plugin")
  done

  (IFS=,; printf '%s\n' "${normalized[*]}")
}

# --- lean-ctx XDG migration (v3.8.5+) ---
# Detect legacy single-dir layout (~/.config/lean-ctx with data files)
# and migrate to XDG split (config→XDG_CONFIG_HOME, data→XDG_DATA_HOME, …).
# The migration is crash-safe (atomic rename, idempotent, no clobber).
if command -v lean-ctx &>/dev/null; then
  if [ -d "$HOME/.config/lean-ctx/sessions" ] || [ -d "$HOME/.config/lean-ctx/vectors" ]; then
    echo "Detected legacy lean-ctx single-dir layout; migrating to XDG Base Directory..."
    lean-ctx doctor --fix 2>/dev/null || true
  fi
fi

# Admin persists LSP_SERVERS to lsp-managed.env inside the opencode-config
# volume on every Apply; import it here when the container environment does
# not already define LSP_SERVERS, so compose values keep precedence.
if [ -z "${LSP_SERVERS:-}" ]; then
  LSP_SERVERS="$(grep -E '^LSP_SERVERS=' "$HOME/.config/opencode/lsp-managed.env" 2>/dev/null | tail -n 1 | cut -d= -f2- || true)"
fi

# --- OpenCode config ---
mkdir -p "$OPCODE_CONFIG_DIR"
OPCODE_CONFIG_FILE="$OPCODE_CONFIG_DIR/opencode.json"

# Always regenerate opencode.json from OPENCODE_PLUGINS to ensure consistency
PLUGINS="$(normalize_omo_plugin_versions "${OPENCODE_PLUGINS:-oh-my-openagent}")"
PLUGIN_JSON=$(echo "$PLUGINS" | tr ',' '\n' | jq -R . | jq -s .)
# Catalog of admin-controlled LSP servers (id -> command/extensions),
# mirroring src/admin/lib/lsp-catalog.ts. Version pinning is applied via
# BUN_PACKAGES in 01-install-packages.sh, not in this lsp block.
LSP_CATALOG_JSON=$(cat <<'JSON'
{
  "typescript": { "command": ["typescript-language-server", "--stdio"], "extensions": [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"] },
  "json": { "command": ["vscode-json-language-server", "--stdio"], "extensions": [".json", ".jsonc"] },
  "css": { "command": ["vscode-css-language-server", "--stdio"], "extensions": [".css", ".scss", ".less"] },
  "html": { "command": ["vscode-html-language-server", "--stdio"], "extensions": [".html", ".htm"] },
  "yaml-ls": { "command": ["yaml-language-server", "--stdio"], "extensions": [".yaml", ".yml"] },
  "dockerfile": { "command": ["docker-langserver", "--stdio"], "extensions": [".dockerfile", ".Dockerfile"] },
  "biome": { "command": ["biome", "lsp-proxy"], "extensions": [".js", ".jsx", ".ts", ".tsx", ".json"] },
  "pyright": { "command": ["pyright-langserver", "--stdio"], "extensions": [".py", ".pyi"] }
}
JSON
)

# Build the opencode.json lsp block: always-on marksman plus each enabled
# LSP_SERVERS entry (mapped to its catalog command/extensions). Unknown keys
# and disabled entries are dropped; invalid or absent LSP_SERVERS yields just
# marksman.
if [ -n "${LSP_SERVERS:-}" ]; then
  ENABLED_LSP=$(printf '%s' "$LSP_SERVERS" | jq --argjson catalog "$LSP_CATALOG_JSON" \
    '[ (to_entries | map(if .key == "yaml" then .key = "yaml-ls" else . end))[] | select(.value.enabled == true) | select($catalog[.key] != null) | { (.key): $catalog[.key] } ] | add // {}' 2>/dev/null || echo "{}")
else
  ENABLED_LSP="{}"
fi
LSP_BLOCK=$(jq -n --argjson enabled "$ENABLED_LSP" \
  '{ marksman: { command: ["marksman", "server"], extensions: [".md", ".markdown"] } } * $enabled')

OPCODE_CONFIG=$(jq -n \
  --argjson plugins "$PLUGIN_JSON" \
  --argjson lsp "$LSP_BLOCK" \
  --arg playwright_version "${PLAYWRIGHT_VERSION}" \
  --arg playwright_mcp_version "${PLAYWRIGHT_MCP_VERSION}" \
  '{
    "$schema": "https://opencode.ai/config.json",
    plugin: $plugins,
    lsp: $lsp,
    mcp: {
      codegraph: {
        type: "local",
        command: ["codegraph", "serve", "--mcp"],
        enabled: true
      },
      playwright: {
        type: "local",
        command: ["pw-mcp"],
        enabled: true
      },
      "lean-ctx": {
        type: "local",
        command: ["lean-ctx"],
        enabled: true
      }
    }
  }')
echo "Updating opencode.json with plugins: $PLUGINS"
echo "$OPCODE_CONFIG" > "$OPCODE_CONFIG_FILE"

# --- Custom provider injection (from OPENCODE_PROVIDER env var) ---
# OPENCODE_PROVIDER expects JSON: the value of the "provider" key,
# e.g. '{"ollama":{"npm":"@ai-sdk/openai-compatible","name":"Ollama","options":{"baseURL":"http://host:11434/v1"},"models":{"gemma4:12b":{"name":"gemma4:12b"}}}}'
if [ -n "${OPENCODE_PROVIDER:-}" ]; then
  PROVIDER_OBJ=$(echo "$OPENCODE_PROVIDER" | jq '.' 2>/dev/null) || true
  if [ -n "$PROVIDER_OBJ" ]; then
    echo "Merging custom provider(s) from OPENCODE_PROVIDER"
    jq -s '.[0] * {provider: .[1]}' "$OPCODE_CONFIG_FILE" <(echo "$PROVIDER_OBJ") > "${OPCODE_CONFIG_FILE}.tmp" \
      && mv "${OPCODE_CONFIG_FILE}.tmp" "$OPCODE_CONFIG_FILE"
  else
    echo "Warning: OPENCODE_PROVIDER is not valid JSON, skipping" >&2
  fi
fi

# --- OMO unified configuration ---
DEFAULT_OMO_CONFIG="/etc/opencode/omo.jsonc.default"
OMO_CONFIG_DIR="$HOME/.omo"
OMO_CONFIG_FILE="$OMO_CONFIG_DIR/omo.jsonc"

# Kept in a non-.sh file so the entrypoint runner does not execute it separately.
source "$(dirname "$0")/lib-omo-model-defaults.bash"
source "$(dirname "$0")/lib-openchamber-settings.bash"
source "$(dirname "$0")/lib-native-agent-overrides.bash"

archive_legacy_omo_configs() {
  local legacy_name legacy_file backup_file
  for legacy_name in oh-my-openagent.json oh-my-openagent.jsonc oh-my-opencode.json oh-my-opencode.jsonc; do
    legacy_file="$OPCODE_CONFIG_DIR/$legacy_name"
    [ -f "$legacy_file" ] || continue
    backup_file="${legacy_file}.ai-engkit-legacy-backup"
    if [ -e "$backup_file" ]; then
      backup_file="${backup_file}.$(date -u +%Y%m%dT%H%M%SZ)"
    fi
    mv "$legacy_file" "$backup_file"
    echo "Archived legacy OMO config: $legacy_file -> $backup_file"
  done
}

archive_legacy_omo_configs
mkdir -p "$OMO_CONFIG_DIR"

initialize_omo_permissions "$OMO_CONFIG_FILE" "$DEFAULT_OMO_CONFIG"
if ! normalize_omo_config "$OMO_CONFIG_FILE"; then
  echo "Warning: OMO config normalization was not applied; review the reported path" >&2
fi
if command -v lean-ctx &>/dev/null; then
  if ! grep -qF 'lean-ctx shell hook' "$HOME/.bashrc" 2>/dev/null; then
    lean-ctx setup --non-interactive --yes >/dev/null 2>&1 || true
  fi

  if [ ! -f "$OPCODE_CONFIG_DIR/skills/lean-ctx/SKILL.md" ]; then
    lean-ctx init --agent opencode >/dev/null 2>&1 || true
  fi
fi

merge_native_agent_overrides "$OPCODE_CONFIG_FILE" "$OMO_CONFIG_FILE"

merge_project_lsp_config

OPENCODE_CACHE_PKG="$HOME/.cache/opencode/packages"
if [ -f "$OPENCODE_CACHE_PKG/package.json" ]; then
  CACHED_PKGS=$(jq -r '.dependencies | keys | join(",")' "$OPENCODE_CACHE_PKG/package.json" 2>/dev/null || echo "")
  EXPECTED_PKGS=$(expected_plugin_names "$PLUGINS")
  CACHED_SORTED=$(expected_plugin_names "$CACHED_PKGS")
  if [ "$CACHED_SORTED" != "$EXPECTED_PKGS" ]; then
    echo "Stale plugin cache detected ($CACHED_PKGS), removing..."
    rm -rf "$OPENCODE_CACHE_PKG/node_modules" "$OPENCODE_CACHE_PKG/package.json" "$OPENCODE_CACHE_PKG/bun.lock"
  fi
fi


# --- Baked skills (enable-project-knowledge) ---
SKILLS_ROOT="$OPCODE_CONFIG_DIR/skills"
BAKED_SKILLS_DIR="/opt/opencode/baked-skills"
if [ -d "$BAKED_SKILLS_DIR" ]; then
  mkdir -p "$SKILLS_ROOT"
  while IFS= read -r skill_dir; do
    [ -n "$skill_dir" ] || continue
    skill_name="$(basename "$skill_dir")"
    target="$SKILLS_ROOT/$skill_name"
    if [ ! -e "$target" ]; then
      ln -s "$skill_dir" "$target"
      echo "Baked skill symlinked: $target -> $skill_dir"
    fi
  done < <(find "$BAKED_SKILLS_DIR" -mindepth 1 -maxdepth 1 -type d -exec test -f '{}/SKILL.md' ';' -print | sort)
fi

# --- Bootstrapped skill upgrade ---
# When a template skill in baked-skills changes (version bump), auto-upgrade
# all projects that have the skill enabled. Version is tracked per-skill in
# $OPCODE_CONFIG_DIR/.skill-versions.
#
# Usage: upgrade_bootstrapped_skills <skill_name> <bootstrap_dir> <workspace_dir> <version_file>
#   skill_name:     name of the skill (e.g. "knowledge-capture")
#   bootstrap_dir:  path to the bootstrap script's parent directory
#   workspace_dir:  path to the workspace containing projects
#   version_file:   path to the version tracking file
# BEGIN FUNCTION: upgrade_bootstrapped_skills
upgrade_bootstrapped_skills() {
  local bootstrap_skill="$1"
  local bootstrap_dir="$2"
  local workspace_dir="$3"
  local version_file="$4"

  local bootstrap_script="$bootstrap_dir/bootstrap.sh"

  if [ ! -f "$bootstrap_script" ]; then
    return 0
  fi

  local template_ver
  template_ver="$(grep 'skill-version:' "$bootstrap_script" 2>/dev/null | head -1 | sed 's/.*skill-version:[[:space:]]*//;s/[[:space:]]*-->//' || true)"
  if [ -z "$template_ver" ]; then
    return 0
  fi

  local last_ver
  last_ver="$(grep "^${bootstrap_skill}=" "$version_file" 2>/dev/null | cut -d= -f2 || true)"
  if [ "$template_ver" = "$last_ver" ]; then
    return 0
  fi

  echo "Bootstrapped skill '$bootstrap_skill' updated ($last_ver -> $template_ver), upgrading projects..."
  local upgraded=0
  local failed=0
  if [ -d "$workspace_dir" ]; then
    for proj_dir in "$workspace_dir"/*/; do
      [ -d "$proj_dir" ] || continue
      if [ -f "${proj_dir}.opencode/skills/${bootstrap_skill}/SKILL.md" ]; then
        echo "  Upgrading: $(basename "$proj_dir")"
        if bash "$bootstrap_script" --force "$proj_dir"; then
          upgraded=$((upgraded + 1))
        else
          echo "  Warning: upgrade failed for $(basename "$proj_dir")" >&2
          failed=$((failed + 1))
        fi
      fi
    done
  fi

  # Only update version marker if at least one project upgraded and none failed
  if [ "$upgraded" -gt 0 ] && [ "$failed" -eq 0 ]; then
    if grep -q "^${bootstrap_skill}=" "$version_file" 2>/dev/null; then
      sed -i "s/^${bootstrap_skill}=.*/${bootstrap_skill}=${template_ver}/" "$version_file"
    else
      echo "${bootstrap_skill}=${template_ver}" >> "$version_file"
    fi
    echo "Bootstrapped skill upgrade complete: $bootstrap_skill=$template_ver ($upgraded project(s))"
  elif [ "$failed" -gt 0 ]; then
    echo "Bootstrapped skill upgrade incomplete: $failed project(s) failed. Will retry on next start." >&2
    return 1
  else
    echo "Bootstrapped skill upgrade: no projects to upgrade"
  fi
}
# END FUNCTION: upgrade_bootstrapped_skills

# Register all bootstrappable skills for auto-upgrade.
# Format: <skill_name> <bootstrap_dir>
# Skills not following the bootstrap.sh + SKILL.md pattern (e.g. superpowers via symlink,
# openspec via CLI) are not listed here.
UPGRADEABLE_SKILLS=(
  "knowledge-capture:$SKILLS_ROOT/enable-project-knowledge"
  "finalize-maintenance:$SKILLS_ROOT/enable-finalize-maintenance"
)

for _entry in "${UPGRADEABLE_SKILLS[@]}"; do
  _skill_name="${_entry%%:*}"
  _bootstrap_dir="${_entry#*:}"
  upgrade_bootstrapped_skills "$_skill_name" "$_bootstrap_dir" "$WORKSPACE_DIR" "$OPCODE_CONFIG_DIR/.skill-versions"
done

# --- ai-engkit environment knowledge (AGENTS.md) ---
# Sync ai-engkit-specific sections into the user's AGENTS.md.
# The template is delimited by <!-- @ai-engkit --> ... <!-- /@ai-engkit -->
# sentinels. First install appends it; afterwards the reconstructed complete
# file is compared by content hash against the current user file and replaced
# in place on mismatch, so template updates propagate across image rebuilds
# while anything outside the markers (user notes, generated blocks) is
# preserved.
AI_ENGKIT_AGENTS_DEFAULT="/etc/opencode/AGENTS.md.default"
USER_AGENTS_MD="$OPCODE_CONFIG_DIR/AGENTS.md"

sync_ai_engkit_agents_md() {
  local default_file="$1"
  local user_file="$2"
  local tmp_file
  [ -f "$default_file" ] || return 0

  if [ ! -f "$user_file" ]; then
    cp "$default_file" "$user_file"
    echo "Created AGENTS.md with AI-EngKit environment knowledge"
    return 0
  fi

  local marker_state
  marker_state="$(awk '
    /<!-- @ai-engkit -->/ {
      openings++
      if (closings > 0 || openings > 1) malformed = 1
    }
    /<!-- \/@ai-engkit -->/ {
      closings++
      if (openings == 0 || closings > 1) malformed = 1
    }
    END {
      if (malformed || openings > 1 || closings > 1 || (openings == 1 && closings != 1)) exit 1
      if (openings == 1 && closings == 1) print "ordered"
      else if (openings == 0 && closings == 0) print "none"
      else exit 1
    }
  ' "$user_file" 2>/dev/null || printf '%s\n' malformed)"

  if [ "$marker_state" = "malformed" ]; then
    echo "Warning: malformed @ai-engkit marker order in AGENTS.md; skipping auto-update" >&2
    return 0
  fi

  if [ "$marker_state" = "none" ]; then
    echo "" >> "$user_file"
    cat "$default_file" >> "$user_file"
    echo "Appended AI-EngKit environment knowledge to AGENTS.md"
    return 0
  fi

  tmp_file="$(mktemp)"
  # The baked default includes its own sentinels.
  awk -v repl_file="$default_file" '
    BEGIN { replaced = 0 }
    !replaced && /<!-- @ai-engkit -->/ {
      replaced = 1
      while ((getline line < repl_file) > 0) print line
      close(repl_file)
      next
    }
    replaced == 1 && /<!-- \/@ai-engkit -->/ { replaced = 2; next }
    replaced == 1 { next }
    { print }
  ' "$user_file" > "$tmp_file"

  if [ "$(md5sum "$tmp_file" | cut -d' ' -f1)" != "$(md5sum "$user_file" | cut -d' ' -f1)" ]; then
    mv "$tmp_file" "$user_file"
    echo "Updated AI-EngKit environment knowledge block in AGENTS.md"
  else
    rm -f "$tmp_file"
  fi
}

sync_ai_engkit_agents_md "$AI_ENGKIT_AGENTS_DEFAULT" "$USER_AGENTS_MD"

# --- OpenChamber default settings (seed + backfill defaultModel, update notifications off) ---
ensure_openchamber_default_settings "$OPENCHAMBER_DATA_DIR/settings.json" "opencode/big-pickle"

echo "Default configs initialized"
