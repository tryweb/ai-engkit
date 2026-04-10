#!/usr/bin/env bash
set -euo pipefail

DEVUSER_HOME="/home/devuser"
GLAB_CONFIG_DIR="$DEVUSER_HOME/.config/glab-cli"

init_dir() {
  local dir="$1"

  if [ -d "$dir" ] && [ -n "$(ls -A "$dir")" ]; then
    return 0
  fi

  mkdir -p "$dir"
  chown -R devuser:devuser "$dir" 2>/dev/null || true
  echo "Created: $dir"
}

echo "=== Initializing GLAB CLI config ==="
init_dir "$GLAB_CONFIG_DIR"
echo "=== GLAB CLI config initialized ==="
echo