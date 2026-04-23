#!/usr/bin/env bash
set -euo pipefail

DEVUSER_HOME="/home/devuser"
SSH_DIR="$DEVUSER_HOME/.ssh"
GIT_CONFIG_DIR="$DEVUSER_HOME/.config/git"

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

create_symlink "$GIT_CONFIG_DIR/.gitconfig" "$DEVUSER_HOME/.gitconfig"
create_symlink "$GIT_CONFIG_DIR/.git-credentials" "$DEVUSER_HOME/.git-credentials"

# 設定 git credential helper（需指定 HOME，否則 sudo 會寫到 /root）
sudo -u devuser HOME=/home/devuser git config --global credential.helper store
echo "Configured: credential.helper store"

echo "=== Git/SSH volumes initialized ==="
echo
