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

# Build plugin array from OPENCODE_PLUGINS env var (comma-separated)
PLUGINS="${OPENCODE_PLUGINS:-oh-my-openagent,lancedb-opencode-pro}"
PLUGIN_JSON=$(echo "$PLUGINS" | tr ',' '\n' | jq -R . | jq -s .)
OPCODE_CONFIG=$(jq -n --argjson plugins "$PLUGIN_JSON" '{plugin: $plugins}')

init_file "$OPCODE_CONFIG_DIR/opencode.json" "$OPCODE_CONFIG"

# --- OpenChamber settings ---
mkdir -p "$OPENCHAMBER_DATA_DIR"

init_file "$OPENCHAMBER_DATA_DIR/settings.json" '{
  "lightThemeId": "flexoki-light",
  "darkThemeId": "flexoki-dark",
  "approvedDirectories": [],
  "securityScopedBookmarks": [],
  "notifyOnSubtasks": true,
  "notifyOnCompletion": true,
  "notifyOnError": true,
  "notifyOnQuestion": true,
  "notificationTemplates": {
    "completion": {
      "title": "{agent_name} is ready",
      "message": "{model_name} completed the task"
    },
    "error": {
      "title": "Tool error",
      "message": "{last_message}"
    },
    "question": {
      "title": "Input needed",
      "message": "{last_message}"
    },
    "subtask": {
      "title": "{agent_name} is ready",
      "message": "{model_name} completed the task"
    }
  },
  "zenModel": "minimax-m2.5-free"
}'

echo "Default configs initialized"
