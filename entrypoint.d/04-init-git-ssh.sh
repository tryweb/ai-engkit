#!/usr/bin/env bash
set -euo pipefail

# Copy git SSH configs from host source to named volumes on first start
# This ensures git credentials persist across container restarts when using named volumes

HOST_HOME="${HOST_HOME:-/host/home/$USERNAME}"
SSH_DIR="$HOME/.ssh"
GITCONFIG="$HOME/.gitconfig"
GITCREDS="$HOME/.git-credentials"
GH_DIR="$HOME/.config/gh"

# Helper to copy file/dir only if volume is empty (first start)
copy_if_empty() {
  local src="$1"
  local dest="$2"
  local dest_dir

  dest_dir=$(dirname "$dest")

  # Check if destination exists and has content
  if [ -e "$dest" ]; then
    echo "Volume already initialized: $dest"
    return 0
  fi

  # Create parent dir if needed
  mkdir -p "$dest_dir"

  # Copy from host source
  if [ -e "$src" ]; then
    echo "Copying from host: $src → $dest"
    cp -r "$src" "$dest"
    # Fix ownership
    chown -R "$USERNAME:$USERNAME" "$dest"
  else
    echo "Warning: Host source not found: $src"
  fi
}

echo "=== Initializing Git/SSH volumes ==="

# SSH keys directory
copy_if_empty "${HOST_HOME}/.ssh" "$SSH_DIR"

# SSH known_hosts file
copy_if_empty "${HOST_HOME}/.ssh/known_hosts" "$SSH_DIR/known_hosts"

# Git config file
copy_if_empty "${HOST_HOME}/.gitconfig" "$GITCONFIG"

# Git credentials file
copy_if_empty "${HOST_HOME}/.git-credentials" "$GITCREDS"

# GitHub CLI config directory
copy_if_empty "${HOST_HOME}/.config/gh" "$GH_DIR"

echo "=== Git/SSH volumes initialized ==="
echo
