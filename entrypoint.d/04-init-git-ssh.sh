#!/usr/bin/env bash
set -euo pipefail

SSH_DIR="$HOME/.ssh"
GIT_CONFIG_DIR="$HOME/.config/git"

init_file() {
  local file="$1"

  if [ -f "$file" ]; then
    return 0
  fi

  rm -rf "$file"
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

create_symlink() {
  local target="$1"
  local link="$2"
  local link_dir

  link_dir=$(dirname "$link")

  if [ -L "$link" ]; then
    return 0
  fi

  rm -rf "$link"
  mkdir -p "$link_dir"
  ln -s "$target" "$link"
  chown -h devuser:devuser "$link"
  echo "Symlinked: $link → $target"
}

echo "=== Initializing Git/SSH volumes ==="

init_dir "$SSH_DIR"
init_file "$SSH_DIR/known_hosts"
init_dir "$GIT_CONFIG_DIR"
init_file "$GIT_CONFIG_DIR/.gitconfig"
init_file "$GIT_CONFIG_DIR/.git-credentials"
init_file "$GIT_CONFIG_DIR/config"

create_symlink "$GIT_CONFIG_DIR/.gitconfig" "$HOME/.gitconfig"
create_symlink "$GIT_CONFIG_DIR/.git-credentials" "$HOME/.git-credentials"

echo "=== Git/SSH volumes initialized ==="
echo
