#!/usr/bin/env bash

fix_perms() {
  local path="$1"
  local user
  local group

  user="$(id -u)"
  group="$(id -g)"

  if [ -e "$path" ]; then
    sudo chown -R "$user:$group" "$path" 2>/dev/null || true
  fi
}

echo "Fixing permissions"
fix_perms "$HOME"/.config/opencode
fix_perms "$HOME"/.local/share/opencode
fix_perms "$HOME"/.local/share/lean-ctx
fix_perms "$HOME"/.local/state/lean-ctx
fix_perms "$HOME"/.cache/lean-ctx
fix_perms "$HOME"/.cache/opencode
fix_perms "$HOME"/.cache/oh-my-opencode
fix_perms "$HOME"/.config/openchamber
fix_perms "$HOME"/.config/glab-cli
fix_perms "$HOME"/.config/gh
fix_perms "$HOME"/.ssh
fix_perms "$HOME"/.config/git
fix_perms "$HOME"/workspace
echo
