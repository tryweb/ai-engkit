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
  local root_config missing_keys updated_config
  if grep -qE '^[[:space:]]*compression_level[[:space:]]*=[[:space:]]*"off"[[:space:]]*(#.*)?$' "$LEANCTX_RUNTIME_CONFIG"; then
    compression_is_off=1
  fi

  if [[ -f "$LEANCTX_BASELINE_CONFIG" ]]; then
    root_config="$(mktemp)"
    missing_keys="$(mktemp)"
    awk '/^[[:space:]]*\[/ { exit } { print }' "$LEANCTX_RUNTIME_CONFIG" > "$root_config"

    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ "$line" =~ ^([a-zA-Z_][a-zA-Z0-9_.]*)[[:space:]]*= ]]; then
        local key="${BASH_REMATCH[1]}"
        local key_pattern="${key//./\\.}"
        if [ "$compression_is_off" -eq 1 ] && [ "$key" = "compression_level" ]; then
          continue
        fi
        if ! grep -qE "^[[:space:]]*${key_pattern}[[:space:]]*=" "$root_config"; then
          printf '%s\n' "$line" >> "$missing_keys"
          printf '%s\n' "$line" >> "$root_config"
          printf 'lean-ctx: migrated missing key %s\n' "$key"
        fi
      fi
    done < "$LEANCTX_BASELINE_CONFIG"

    if [[ -s "$missing_keys" ]]; then
      updated_config="$(mktemp "${LEANCTX_RUNTIME_CONFIG}.tmp.XXXXXX")"
      if ! awk -v additions_file="$missing_keys" '
        BEGIN {
          while ((getline line < additions_file) > 0) additions[++count] = line
          close(additions_file)
        }
        !inserted && /^[[:space:]]*\[/ {
          print ""
          for (i = 1; i <= count; i++) print additions[i]
          inserted = 1
        }
        { print }
        END {
          if (!inserted) {
            print ""
            for (i = 1; i <= count; i++) print additions[i]
          }
        }
      ' "$LEANCTX_RUNTIME_CONFIG" > "$updated_config"; then
        rm -f "$updated_config" "$missing_keys" "$root_config"
        printf 'lean-ctx: failed to backfill top-level keys in %s\n' "$LEANCTX_RUNTIME_CONFIG" >&2
        return 1
      fi
      if ! chmod --reference="$LEANCTX_RUNTIME_CONFIG" "$updated_config"; then
        rm -f "$updated_config" "$missing_keys" "$root_config"
        printf 'lean-ctx: failed to preserve permissions for %s\n' "$LEANCTX_RUNTIME_CONFIG" >&2
        return 1
      fi
      if ! mv "$updated_config" "$LEANCTX_RUNTIME_CONFIG"; then
        rm -f "$updated_config" "$missing_keys" "$root_config"
        printf 'lean-ctx: failed to update %s\n' "$LEANCTX_RUNTIME_CONFIG" >&2
        return 1
      fi
    fi

    rm -f "$missing_keys" "$root_config"
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

# --- line selection: native vs OMO ---
# Marker file fallback for the Admin UI toggle: explicit NATIVE_AGENTS env
# always wins; when it is unset, a marker written by Admin
# ($HOME/.config/opencode/.native-agents, on the opencode-config volume so
# it survives container restarts) selects the native line. Removing the
# marker selects the OMO line. No .env or image change is required.
# This runs first so the OMO_ENABLED derivation below sees the effective line.
if [ -z "${NATIVE_AGENTS:-}" ] && [ -f "$HOME/.config/opencode/.native-agents" ]; then
  NATIVE_AGENTS=1
fi

# NATIVE_AGENTS=1 is the v1 PoC flag; OMO_ENABLED=0 is the v2-line flag.
# Normalize here so every downstream gate sees one line: an explicit
# OMO_ENABLED always wins, otherwise NATIVE_AGENTS=1 implies OMO_ENABLED=0.
if [ -z "${OMO_ENABLED:-}" ] && [ "${NATIVE_AGENTS:-0}" = "1" ]; then
  OMO_ENABLED=0
fi

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

build_opencode_permission_policy() {
  jq -n '{
    read: "allow",
    glob: "allow",
    grep: "allow",
    bash: "allow"
  }'
}

OPENCODE_PERMISSION="$(build_opencode_permission_policy)"

# Always regenerate opencode.json from OPENCODE_PLUGINS to ensure consistency
if [ "${NATIVE_AGENTS:-0}" = "1" ]; then
  PLUGINS=""
  PLUGIN_JSON="[]"
  OPENCODE_PERMISSION="null"
  echo "Native agents enabled (NATIVE_AGENTS=1): writing plugin-free opencode.json"
else
  PLUGINS="$(normalize_omo_plugin_versions "${OPENCODE_PLUGINS:-oh-my-openagent}")"
  PLUGIN_JSON=$(echo "$PLUGINS" | tr ',' '\n' | jq -R . | jq -s .)
fi
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
  --argjson permission "$OPENCODE_PERMISSION" \
  --arg playwright_version "${PLAYWRIGHT_VERSION}" \
  --arg playwright_mcp_version "${PLAYWRIGHT_MCP_VERSION}" \
  '{
    "$schema": "https://opencode.ai/config.json",
    plugin: $plugins,
    lsp: $lsp,
    permission: $permission,
    mcp: {
      codegraph: {
        type: "local",
        command: ["codegraph", "serve", "--mcp"],
        enabled: true
      },
      context7: {
        type: "remote",
        url: "https://mcp.context7.com/mcp",
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
  } | if .permission == null then del(.permission) else . end')
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
if [ "${NATIVE_AGENTS:-0}" != "1" ]; then
DEFAULT_OMO_CONFIG="/etc/opencode/omo.jsonc.default"
OMO_CONFIG_DIR="$HOME/.omo"
OMO_CONFIG_FILE="$OMO_CONFIG_DIR/omo.jsonc"

# Kept in a non-.sh file so the entrypoint runner does not execute it separately.
source "$(dirname "$0")/lib-omo-model-defaults.bash"
source "$(dirname "$0")/lib-native-agent-overrides.bash"
fi
source "$(dirname "$0")/lib-openchamber-settings.bash"

if [ "${NATIVE_AGENTS:-0}" != "1" ]; then
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
if [ "${OMO_ENABLED:-1}" != "0" ]; then
  merge_native_agent_overrides "$OPCODE_CONFIG_FILE" "$OMO_CONFIG_FILE"
fi
fi

# --- Native agents (NATIVE_AGENTS=1 only) ---
# OMO line gets agents from the oh-my-openagent plugin; the native line is
# plugin-free, so deploy the baked agent definitions into the user config.
# Deployed on every boot so image upgrades take effect on recreate.
# BEGIN FUNCTION: deploy_native_agents
deploy_native_agents() {
  local src_dir="$1"
  local dest_dir="$2"
  local manifest_file="${dest_dir}/.ai-engkit-native-manifest"
  local agent_file base
  if [ ! -d "$src_dir" ]; then
    echo "Warning: native agents source missing ($src_dir), skipping" >&2
    return 0
  fi
  mkdir -p "$dest_dir"
  # 1) Prune files this deployment previously installed but the image no
  # longer ships (renamed or dropped agent): without this, a removed agent
  # would linger in the persistent opencode-config volume forever. Only
  # manifest-listed basenames without "/" are ever deleted, so user-created
  # custom agents are never touched by this step.
  if [ -f "$manifest_file" ]; then
    while IFS= read -r base || [ -n "$base" ]; do
      [ -n "$base" ] || continue
      case "$base" in
        *"/"*) continue ;;
      esac
      if [ ! -f "${src_dir}/${base}" ] && [ -f "${dest_dir}/${base}" ]; then
        rm -f "${dest_dir}/${base}"
        echo "Native agents pruned stale deployed file: $base" >&2
      fi
    done < "$manifest_file"
  fi
  # 2) One-time sweep of OMO display-name ghosts ("Atlas - Plan Executor.md"
  # etc.): the OMO line materialized agents under "X - Y" display names while
  # the native set uses plain config keys, and the copy loop below never
  # deletes, so leftovers would keep showing up as duplicate primary agents
  # in the picker. Only " - " names absent from the image are touched here,
  # so user-created custom agents with ordinary names are never deleted.
  for agent_file in "${dest_dir}/"*" - "*.md; do
    [ -e "$agent_file" ] || continue
    base="$(basename "$agent_file")"
    if [ ! -f "${src_dir}/${base}" ]; then
      rm -f "$agent_file"
      echo "Native agents removed stale OMO display-name file: $base" >&2
    fi
  done
  # 3) Deploy the current image set and record exactly what was installed.
  {
    for agent_file in "${src_dir}/"*.md; do
      [ -f "$agent_file" ] || continue
      base="$(basename "$agent_file")"
      cp -p "$agent_file" "${dest_dir}/${base}"
      printf '%s\n' "$base"
    done
  } > "${manifest_file}.tmp"
  mv "${manifest_file}.tmp" "$manifest_file"
  echo "Native agents deployed to $dest_dir"
}
# END FUNCTION: deploy_native_agents
# BEGIN FUNCTION: undeploy_native_agents
undeploy_native_agents() {
  local dest_dir="$1"
  local manifest_file="${dest_dir}/.ai-engkit-native-manifest"
  local base
  [ -f "$manifest_file" ] || return 0
  while IFS= read -r base || [ -n "$base" ]; do
    [ -n "$base" ] || continue
    case "$base" in
      *"/"*) continue ;;
    esac
    if [ -f "${dest_dir}/${base}" ]; then
      rm -f "${dest_dir}/${base}"
      echo "Native agents removed (OMO line): $base" >&2
    fi
  done < "$manifest_file"
  rm -f "$manifest_file"
  rmdir "$dest_dir" 2>/dev/null || true
}
# END FUNCTION: undeploy_native_agents
# BEGIN FUNCTION: prune_legacy_omo_ghosts
prune_legacy_omo_ghosts() {
  local config_dir="$1"
  local legacy_dir="${config_dir}/agents"
  local legacy_config="${config_dir}/config.json"
  local ghost tmp
  # Legacy OMO materialized display-name agents ("X - Y", sometimes with
  # zero-width sort prefixes) in two places ai-engkit never manages:
  # agents/*.md (plural dir, predates the native agent/ deployment) and
  # config.json's agent object (leftover full config). On the plugin-free
  # native line both resurface as duplicate primary agents in the picker,
  # so remove exactly the " - " signature here. Anything without " - "
  # (user custom agents, general/plan pins) is never touched.
  if [ -d "$legacy_dir" ]; then
    for ghost in "${legacy_dir}/"*" - "*.md; do
      [ -e "$ghost" ] || continue
      rm -f "$ghost"
      echo "Native agents removed legacy OMO ghost file: $(basename "$ghost")" >&2
    done
  fi
  if [ -f "$legacy_config" ] && jq -e '.agent | type == "object"' "$legacy_config" >/dev/null 2>&1; then
    if jq -e '.agent | keys | map(select(contains(" - "))) | length > 0' "$legacy_config" >/dev/null 2>&1; then
      tmp="$(mktemp "${legacy_config}.tmp.XXXXXX")" || return 0
      if jq '.agent |= with_entries(select(.key | contains(" - ") | not))' "$legacy_config" > "$tmp" 2>/dev/null && mv "$tmp" "$legacy_config"; then
        echo "Native agents removed legacy OMO ghost keys from config.json" >&2
      else
        rm -f "$tmp"
      fi
    fi
  fi
}
# END FUNCTION: prune_legacy_omo_ghosts
# BEGIN FUNCTION: prune_omo_plugin_cache
prune_omo_plugin_cache() {
  local cache_dir="$1"
  local entry base
  [ -d "$cache_dir" ] || return 0
  # OpenCode caches one directory per plugin spec; the OMO directory name
  # embeds the resolved version (oh-my-openagent@<ver>), which differs per
  # environment (OH_MY_OPENAGENT_VERSION), so match the package family, never
  # an exact version. Non-OMO entries (superpowers, language servers) are left
  # untouched. OpenCode rebuilds a removed entry on demand if the OMO line
  # ever returns.
  for entry in "$cache_dir"/oh-my-openagent "$cache_dir"/oh-my-openagent@* "$cache_dir"/oh-my-opencode "$cache_dir"/oh-my-opencode@*; do
    [ -e "$entry" ] || continue
    base="$(basename "$entry")"
    rm -rf "$entry"
    echo "Native agents removed stale OMO plugin cache: $base" >&2
  done
}
# END FUNCTION: prune_omo_plugin_cache
# BEGIN FUNCTION: prune_omo_state_cache
prune_omo_state_cache() {
  local state_dir="$1"
  [ -d "$state_dir" ] || return 0
  # OMO-exclusive state cache (own named volume); dead weight on the
  # plugin-free native line. Contents only: never remove the mount point.
  if [ -n "$(ls -A "$state_dir" 2>/dev/null)" ]; then
    find "$state_dir" -mindepth 1 -delete 2>/dev/null || true
    echo "Native agents pruned OMO state cache: $state_dir" >&2
  fi
}
# END FUNCTION: prune_omo_state_cache
# BEGIN FUNCTION: archive_omo_residual_config
archive_omo_residual_config() {
  local omo_file="$1"
  local backup_file
  [ -f "$omo_file" ] || return 0
  backup_file="${omo_file}.ai-engkit-legacy-backup"
  if [ -e "$backup_file" ]; then
    backup_file="${backup_file}.$(date -u +%Y%m%dT%H%M%SZ)"
  fi
  mv "$omo_file" "$backup_file"
  echo "Native agents archived residual OMO config: $omo_file -> $backup_file" >&2
}
# END FUNCTION: archive_omo_residual_config
if [ "${NATIVE_AGENTS:-0}" = "1" ] || [ "${OMO_ENABLED:-1}" = "0" ]; then
  source "$(dirname "$0")/lib-native-routing-heads.bash"
  sync_native_routing_heads "$OPCODE_CONFIG_FILE" "$OPCODE_CONFIG_DIR/routing.json"
  deploy_native_agents "/opt/opencode/native-agents" "$OPCODE_CONFIG_DIR/agent"
  prune_legacy_omo_ghosts "$OPCODE_CONFIG_DIR"
  prune_omo_plugin_cache "$HOME/.cache/opencode/packages"
  prune_omo_state_cache "$HOME/.cache/oh-my-opencode"
  archive_omo_residual_config "$HOME/.omo/omo.jsonc"
else
  # Leaving the native line must not leave its deployed files behind: with
  # the plugin back in charge they would register as duplicate plain-name
  # primary agents next to the plugin's "X - Y" display names. Only files
  # this deployment recorded in its manifest are removed.
  undeploy_native_agents "$OPCODE_CONFIG_DIR/agent"
fi

if command -v lean-ctx &>/dev/null; then
  if ! grep -qF 'lean-ctx shell hook' "$HOME/.bashrc" 2>/dev/null; then
    lean-ctx setup --non-interactive --yes >/dev/null 2>&1 || true
  fi

  if [ ! -f "$OPCODE_CONFIG_DIR/skills/lean-ctx/SKILL.md" ]; then
    lean-ctx init --agent opencode >/dev/null 2>&1 || true
  fi
fi

merge_project_lsp_config

OPENCODE_CACHE_PKG="$HOME/.cache/opencode/packages"
if [ "${NATIVE_AGENTS:-0}" != "1" ] && [ -f "$OPENCODE_CACHE_PKG/package.json" ]; then
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
# BEGIN FUNCTION: prune_stale_baked_skill_symlinks
prune_stale_baked_skill_symlinks() {
  local skills_root="$1"
  local baked_dir="$2"
  [ -d "$skills_root" ] || return 0
  local link raw skill_name
  while IFS= read -r link; do
    [ -n "$link" ] || continue
    raw="$(readlink "$link" 2>/dev/null || true)"
    case "$raw" in
      "$baked_dir"/*)
        ;;
      *)
        continue
        ;;
    esac
    skill_name="$(basename "$link")"
    if [ ! -e "$link" ] || [ ! -d "$baked_dir/$skill_name" ] || [ ! -f "$baked_dir/$skill_name/SKILL.md" ]; then
      rm "$link"
      echo "Baked skill pruned stale symlink: $link -> $raw" >&2
    fi
  done < <(find "$skills_root" -mindepth 1 -maxdepth 1 -type l -print | sort)
}
# END FUNCTION: prune_stale_baked_skill_symlinks
if [ -d "$BAKED_SKILLS_DIR" ]; then
  mkdir -p "$SKILLS_ROOT"
  prune_stale_baked_skill_symlinks "$SKILLS_ROOT" "$BAKED_SKILLS_DIR"
  while IFS= read -r skill_dir; do
    [ -n "$skill_dir" ] || continue
    skill_name="$(basename "$skill_dir")"
    target="$SKILLS_ROOT/$skill_name"
    if [ -L "$target" ]; then
      if [ "$(readlink "$target" 2>/dev/null || true)" = "$skill_dir" ]; then
        : # already symlinked to the current baked skill
      else
        echo "Baked skill name shadowed by existing symlink, skipping: $target (points to $(readlink "$target" 2>/dev/null || true))" >&2
      fi
    elif [ -e "$target" ]; then
      echo "Baked skill shadowed by existing file, skipping symlink: $target (remove it to use baked '$skill_name')" >&2
    else
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

# Repair legacy or broken bootstrapped skill formats so OpenCode can load them.
# - Flat <skill>.md (no <skill>/SKILL.md): move to directory format, preserving content.
# - SKILL.md with a leading <!-- skill-version ... --> before frontmatter: move marker after
#   the closing frontmatter delimiter (OpenCode requires frontmatter at line 1).
# Writes only to managed skill paths; idempotent. Backend restart is still required for
# a running managed opencode serve to rescan.
# Usage: repair_legacy_bootstrapped_skills <workspace_dir> [skill_name...]
# BEGIN FUNCTION: repair_legacy_bootstrapped_skills
repair_legacy_bootstrapped_skills() {
  local workspace_dir="$1"
  shift || true
  local skills=("$@")
  local proj_dir skill flat_file skill_dir skill_file first_line tmp_file

  repair_bootstrapped_skill_frontmatter() {
    local file="$1"
    local head
    IFS= read -r head < "$file" || head=""
    case "$head" in
      ---) return 0 ;;
      '<!-- skill-version:'*'-->')
        ;;
      *)
        echo "Bootstrapped skill has unrecognized leading content (manual fix needed): ${file}" >&2
        return 0
        ;;
    esac
    tmp_file="$(mktemp "${file}.tmp.XXXXXX")" || {
      echo "Bootstrapped skill frontmatter repair failed (mktemp): ${file}" >&2
      return 1
    }
    if awk '
      NR==1 { marker=$0; next }
      NR==2 && $0=="---" { in_fm=1; print; next }
      in_fm && $0=="---" { print; print ""; print marker; in_fm=2; next }
      { print }
      END { exit(in_fm==2 ? 0 : 1) }
    ' "$file" > "$tmp_file"; then
      if chmod --reference="$file" "$tmp_file" 2>/dev/null || chmod 644 "$tmp_file"; then
        if mv "$tmp_file" "$file"; then
          echo "Bootstrapped skill repaired (frontmatter moved to line 1): ${file}" >&2
        else
          rm -f "$tmp_file"
          echo "Bootstrapped skill frontmatter repair failed (move): ${file}" >&2
          return 1
        fi
      else
        rm -f "$tmp_file"
        echo "Bootstrapped skill frontmatter repair failed (chmod): ${file}" >&2
        return 1
      fi
    else
      rm -f "$tmp_file"
      echo "Bootstrapped skill frontmatter repair skipped (unexpected structure): ${file}" >&2
    fi
  }

  [ -d "$workspace_dir" ] || return 0
  for proj_dir in "$workspace_dir"/*/; do
    [ -d "$proj_dir" ] || continue
    for skill in "${skills[@]}"; do
      [ -n "$skill" ] || continue
      flat_file="${proj_dir}.opencode/skills/${skill}.md"
      skill_dir="${proj_dir}.opencode/skills/${skill}"
      skill_file="${skill_dir}/SKILL.md"

      if [ -f "$flat_file" ] && [ ! -e "$skill_file" ]; then
        if [ -e "$skill_dir" ] && [ ! -d "$skill_dir" ]; then
          echo "Bootstrapped skill migration skipped (path is not a directory): ${skill_dir}" >&2
          continue
        fi
        if ! mkdir -p "$skill_dir"; then
          echo "Bootstrapped skill migration failed (mkdir): ${skill_dir}" >&2
          continue
        fi
        if mv "$flat_file" "$skill_file"; then
          echo "Bootstrapped skill migrated (flat -> directory): ${flat_file} -> ${skill_file}" >&2
          repair_bootstrapped_skill_frontmatter "$skill_file" || true
        else
          echo "Bootstrapped skill migration failed (move): ${flat_file}" >&2
        fi
      elif [ -f "$skill_file" ]; then
        IFS= read -r first_line < "$skill_file" || first_line=""
        case "$first_line" in
          ---) ;;
          *) repair_bootstrapped_skill_frontmatter "$skill_file" || true ;;
        esac
      fi
    done
  done
}
# END FUNCTION: repair_legacy_bootstrapped_skills

# Register all bootstrappable skills for auto-upgrade/repair.
# Format: <skill_name> <bootstrap_dir>
# Skills not following the bootstrap.sh + SKILL.md pattern (e.g. superpowers via symlink,
# openspec via CLI) are not listed here.
UPGRADEABLE_SKILLS=(
  "knowledge-capture:$SKILLS_ROOT/enable-project-knowledge"
  "finalize-maintenance:$SKILLS_ROOT/enable-finalize-maintenance"
  "security-audit:$SKILLS_ROOT/enable-security-audit"
)

# Repair legacy/broken project skill formats before version-based upgrades so that
# migrated projects become eligible for upgrade in the same boot.
repair_legacy_bootstrapped_skills "$WORKSPACE_DIR" "knowledge-capture" "finalize-maintenance" "security-audit"

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

# --- OpenChamber default settings (seed + backfill defaultAgent/defaultModel, update notifications off) ---
# Native line defaults new sessions to Sisyphus (exact /agent name); the OMO
# line passes no agent so its default-agent behavior is unchanged.
if [ "${NATIVE_AGENTS:-0}" = "1" ]; then
  ensure_openchamber_default_settings "$OPENCHAMBER_DATA_DIR/settings.json" "opencode/big-pickle" "sisyphus"
else
  ensure_openchamber_default_settings "$OPENCHAMBER_DATA_DIR/settings.json" "opencode/big-pickle"
fi

echo "Default configs initialized"
