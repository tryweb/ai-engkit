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

# Backfill: `gh auth login` (device flow via Admin UI, or `docker exec`)
# authenticates the CLI but never wires git to it, so an
# authenticated-but-unwired environment fails every `git push`/`pull` with
# "could not read Username". Heal exactly that state on boot (mirrors the
# Admin status-endpoint wiring for logins that complete while running).
# Idempotent: skips when gh is not logged in or the helper is already set.
if sudo -u devuser env HOME="$DEVUSER_HOME" gh auth status >/dev/null 2>&1; then
  if ! sudo -u devuser env HOME="$DEVUSER_HOME" git config --global --get-all credential.https://github.com.helper 2>/dev/null | grep -q 'gh auth git-credential'; then
    echo "Wiring git credential helper to gh (gh auth setup-git)"
    sudo -u devuser env HOME="$DEVUSER_HOME" gh auth setup-git >/dev/null 2>&1 \
      || echo "Warning: gh credential helper wiring failed" >&2
  fi
fi
echo
