#!/usr/bin/env bash
set -euo pipefail

HOST_HOME="${HOST_HOME:-/host/home/devuser}"
SSH_DIR="$HOME/.ssh"
GITCONFIG="$HOME/.gitconfig"
GITCREDS="$HOME/.git-credentials"
GH_DIR="$HOME/.config/gh"

copy_if_empty() {
  local src="$1"
  local dest="$2"
  local dest_dir

  dest_dir=$(dirname "$dest")

  if [ -e "$dest" ]; then
    echo "Volume already initialized: $dest"
    return 0
  fi

  mkdir -p "$dest_dir"

  if [ -e "$src" ]; then
    echo "Copying from host: $src → $dest"
    cp -r "$src" "$dest"
    chown -R devuser:devuser "$dest"
  else
    echo "Warning: Host source not found: $src"
  fi
}

echo "=== Initializing Git/SSH volumes ==="

copy_if_empty "${HOST_HOME}/.ssh" "$SSH_DIR"
copy_if_empty "${HOST_HOME}/.ssh/known_hosts" "$SSH_DIR/known_hosts"
copy_if_empty "${HOST_HOME}/.gitconfig" "$GITCONFIG"
copy_if_empty "${HOST_HOME}/.git-credentials" "$GITCREDS"
copy_if_empty "${HOST_HOME}/.config/gh" "$GH_DIR"

echo "=== Git/SSH volumes initialized ==="
echo
