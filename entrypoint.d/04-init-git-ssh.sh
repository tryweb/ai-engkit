#!/usr/bin/env bash
set -euo pipefail

SSH_DIR="$HOME/.ssh"
GH_DIR="$HOME/.config/gh"

init_file() {
  local file="$1"

  if [ -f "$file" ]; then
    return 0
  fi

  mkdir -p "$(dirname "$file")"
  touch "$file"
  chown devuser:devuser "$file"
  echo "Created: $file"
}

init_dir() {
  local dir="$1"

  if [ -d "$dir" ] && [ -n "$(ls -A "$dir")" ]; then
    return 0
  fi

  mkdir -p "$dir"
  chown -R devuser:devuser "$dir"
  echo "Created: $dir"
}

echo "=== Initializing Git/SSH volumes ==="

init_dir "$SSH_DIR"
init_file "$SSH_DIR/known_hosts"
init_file "$HOME/.gitconfig"
init_file "$HOME/.git-credentials"
init_dir "$GH_DIR"

echo "=== Git/SSH volumes initialized ==="
echo
