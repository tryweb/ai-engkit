#!/usr/bin/env bash
set -euo pipefail

OPCODE_CONFIG_DIR="$HOME/.config/opencode"
OPENCHAMBER_DATA_DIR="${OPENCHAMBER_DATA_DIR:-$HOME/.config/openchamber}"

init_file() {
  local file="$1"
  local content="$2"
  if [ ! -f "$file" ]; then
    echo "Creating default: $file"
    echo "$content" > "$file"
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

link_superpowers_skills() {
  local cache_dir="$1"
  local skills_root="$2"

  if [ ! -d "$cache_dir" ]; then
    return 1
  fi

  local skills_dir=""
  skills_dir=$(find "$cache_dir" -path "*/node_modules/superpowers/skills" -type d 2>/dev/null | head -1 || true)
  if [ -z "$skills_dir" ] || [ ! -d "$skills_dir" ]; then
    return 1
  fi

  mkdir -p "$skills_root"
  local linked=0
  local skill_dir
  while IFS= read -r skill_dir; do
    local skill_name="${skill_dir##*/}"
    local target="$skills_root/$skill_name"

    if [ -L "$target" ]; then
      if [ "$(readlink "$target")" = "$skill_dir" ] && [ -f "$target/SKILL.md" ]; then
        linked=$((linked + 1))
        continue
      fi
      rm -f "$target"
    elif [ -e "$target" ]; then
      echo "Skipping Superpowers skill '$skill_name'; $target already exists"
      continue
    fi

    ln -s "$skill_dir" "$target"
    echo "Superpowers skill symlinked: $target -> $skill_dir"
    linked=$((linked + 1))
  done < <(find "$skills_dir" -mindepth 1 -maxdepth 1 -type d -exec test -f '{}/SKILL.md' ';' -print | sort)

  [ "$linked" -gt 0 ]
}

# --- OpenCode config ---
mkdir -p "$OPCODE_CONFIG_DIR"
OPCODE_CONFIG_FILE="$OPCODE_CONFIG_DIR/opencode.json"

# Always regenerate opencode.json from OPENCODE_PLUGINS to ensure consistency
PLUGINS="${OPENCODE_PLUGINS:-oh-my-openagent}"
PLUGIN_JSON=$(echo "$PLUGINS" | tr ',' '\n' | jq -R . | jq -s .)
OPCODE_CONFIG=$(jq -n \
  --argjson plugins "$PLUGIN_JSON" \
  '{plugin: $plugins}')
echo "Updating opencode.json with plugins: $PLUGINS"
echo "$OPCODE_CONFIG" > "$OPCODE_CONFIG_FILE"

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

# Workaround for opencode#20940: plugin config() hook mutations are invisible to skill discovery.
# Symlinks ensure superpowers skills are found via global scan path in all projects.
SKILLS_ROOT="$OPCODE_CONFIG_DIR/skills"
BAKED_SUPERPOWERS="/opt/opencode/baked-plugins/superpowers"

if echo "$PLUGINS" | tr ',' '\n' | grep -q '^superpowers@\|^superpowers$'; then
  if ! link_superpowers_skills "$OPENCODE_CACHE_PKG" "$SKILLS_ROOT"; then
    if [ -d "$BAKED_SUPERPOWERS/skills" ]; then
      echo "Superpowers skills not in cache; copying from baked image..."
      mkdir -p "$OPENCODE_CACHE_PKG"
      cp -r "$BAKED_SUPERPOWERS" "$OPENCODE_CACHE_PKG/node_modules/"
      if ! link_superpowers_skills "$OPENCODE_CACHE_PKG" "$SKILLS_ROOT"; then
        echo "Warning: Superpowers skills symlink failed after cache copy"
      fi
    else
      echo "Superpowers skills not found in cache yet; warming OpenCode plugin cache..."
      timeout 180 opencode >/dev/null 2>&1 || true
      if ! link_superpowers_skills "$OPENCODE_CACHE_PKG" "$SKILLS_ROOT"; then
        echo "Warning: Superpowers skills directory not found after OpenCode cache warmup"
      fi
    fi
  fi
fi

OPENCODE_DIR="$HOME/.opencode"
mkdir -p "$OPENCODE_DIR"
LANCEDB_SIDECAR="$OPENCODE_DIR/lancedb-opencode-pro.json"
OLLAMA_URL="${LANCEDB_OPENCODE_PRO_OLLAMA_BASE_URL:-${OLLAMA_BASE_URL:-http://localhost:11434}}"
EMBED_PROVIDER="${LANCEDB_OPENCODE_PRO_EMBEDDING_PROVIDER:-ollama}"
EMBED_MODEL="${LANCEDB_OPENCODE_PRO_EMBEDDING_MODEL:-nomic-embed-text}"

jq -n \
  --arg ollama_url "$OLLAMA_URL" \
  --arg provider "$EMBED_PROVIDER" \
  --arg model "$EMBED_MODEL" \
  '{embedding: {provider: $provider, model: $model, baseUrl: $ollama_url}}' \
  > "$LANCEDB_SIDECAR"
echo "Updated: $LANCEDB_SIDECAR"

OPENCODE_CACHE_PKG="$HOME/.cache/opencode/packages"
LANCEDB_PLUGIN_DIR="$OPENCODE_CACHE_PKG/lancedb-opencode-pro@latest"
if [ -d "$LANCEDB_PLUGIN_DIR" ]; then
  echo "Testing LanceDB plugin initialization..."
  cd "$LANCEDB_PLUGIN_DIR"
  TEST_OUTPUT=$(bun -e "try { const lancedb = require('@lancedb/lancedb'); console.log('LanceDB: OK'); } catch(e) { console.error('LanceDB: ERROR', e.message); process.exit(1); }" 2>&1)
  echo "$TEST_OUTPUT"
  if echo "$TEST_OUTPUT" | grep -q "OK"; then
    echo "LanceDB plugin validated successfully"
    echo "Pre-loading native bindings for OpenCode..."
    bun -e "require('@lancedb/lancedb-linux-x64-gnu')" 2>/dev/null || true
  else
    echo "Warning: LanceDB validation failed, but continuing..."
  fi
fi

echo "Default configs initialized"
