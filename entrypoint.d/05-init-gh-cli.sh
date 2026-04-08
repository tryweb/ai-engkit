#!/usr/bin/env bash
set -euo pipefail

DEVUSER_HOME="/home/devuser"
GH_CONFIG_DIR="$DEVUSER_HOME/.config/gh"

init_dir() {
  local dir="$1"

  if [ -d "$dir" ] && [ -n "$(ls -A "$dir")" ]; then
    return 0
  fi

  mkdir -p "$dir"
  chown -R devuser:devuser "$dir"
  echo "Created: $dir"
}

echo "=== Initializing GH CLI config ==="
init_dir "$GH_CONFIG_DIR"
echo "=== GH CLI config initialized ==="
echo
