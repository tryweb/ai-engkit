#!/usr/bin/env bash
set -euo pipefail

HOST_HOME="${HOST_HOME:-/host/home/devuser}"
SSH_DIR="$HOME/.ssh"
GITCONFIG="$HOME/.gitconfig"
GITCREDS="$HOME/.git-credentials"
GH_DIR="$HOME/.config/gh"

copy_file() {
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
    if [ -f "$src" ]; then
      echo "Copying file: $src → $dest"
      cp -p "$src" "$dest"
    elif [ -d "$src" ]; then
      echo "Copying dir: $src → $dest"
      cp -rT "$src" "$dest"
    fi
    chown devuser:devuser "$dest"
  else
    echo "Warning: Host source not found: $src"
  fi
}

copy_dir() {
  local src="$1"
  local dest="$2"

  if [ -e "$dest" ] && [ -n "$(ls -A "$dest")" ]; then
    echo "Volume already initialized: $dest"
    return 0
  fi

  mkdir -p "$dest"

  if [ -e "$src" ]; then
    echo "Copying dir: $src → $dest"
    cp -rT "$src" "$dest"
    chown -R devuser:devuser "$dest"
  else
    echo "Warning: Host source not found: $src"
  fi
}

echo "=== Initializing Git/SSH volumes ==="

copy_dir "${HOST_HOME}/.ssh" "$SSH_DIR"
copy_file "${HOST_HOME}/.ssh/known_hosts" "$SSH_DIR/known_hosts"
copy_file "${HOST_HOME}/.gitconfig" "$GITCONFIG"
copy_file "${HOST_HOME}/.git-credentials" "$GITCREDS"
copy_dir "${HOST_HOME}/.config/gh" "$GH_DIR"

echo "=== Git/SSH volumes initialized ==="
echo
