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

# --- OpenCode config ---
mkdir -p "$OPCODE_CONFIG_DIR"
OPCODE_CONFIG_FILE="$OPCODE_CONFIG_DIR/opencode.json"

DEFAULT_CONFIG_SOURCE="/etc/opencode/opencode.json.default"
if [ -f "$DEFAULT_CONFIG_SOURCE" ] && [ ! -f "$OPCODE_CONFIG_FILE" ]; then
  echo "Copying default config from: $DEFAULT_CONFIG_SOURCE"
  cp "$DEFAULT_CONFIG_SOURCE" "$OPCODE_CONFIG_FILE"
fi

# Build plugin array from OPENCODE_PLUGINS env var (comma-separated)
PLUGINS="${OPENCODE_PLUGINS:-oh-my-openagent,lancedb-opencode-pro}"
PLUGIN_JSON=$(echo "$PLUGINS" | tr ',' '\n' | jq -R . | jq -s .)

if [ ! -f "$OPCODE_CONFIG_FILE" ]; then
  OPCODE_CONFIG=$(jq -n \
    --argjson plugins "$PLUGIN_JSON" \
    '{plugin: $plugins}')
  echo "Creating default: $OPCODE_CONFIG_FILE"
  echo "$OPCODE_CONFIG" > "$OPCODE_CONFIG_FILE"
fi

OPENCODE_CACHE_PKG="$HOME/.cache/opencode/packages"
if [ -f "$OPENCODE_CACHE_PKG/package.json" ]; then
  CACHED_PKGS=$(jq -r '.dependencies | keys | join(",")' "$OPENCODE_CACHE_PKG/package.json" 2>/dev/null || echo "")
  EXPECTED_PKGS=$(echo "$PLUGINS" | tr ',' '\n' | sort | tr '\n' ',')
  CACHED_SORTED=$(echo "$CACHED_PKGS" | tr ',' '\n' | sort | tr '\n' ',')
  if [ "$CACHED_SORTED" != "$EXPECTED_PKGS" ]; then
    echo "Stale plugin cache detected ($CACHED_PKGS), removing..."
    rm -rf "$OPENCODE_CACHE_PKG/node_modules" "$OPENCODE_CACHE_PKG/package.json" "$OPENCODE_CACHE_PKG/bun.lock"
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
