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

# Wire git to gh's credential helper when GitHub is already authenticated, so
# HTTPS pushes work without visiting Admin. `gh auth login` non-interactively
# skips its own git-setup prompt, which is why the helper is not set by the
# login flow alone. Idempotent: no-op when the helper is set or gh is logged
# out. See src/admin/lib/gh-auth.ts (ensureGitCredentialHelper) for the Admin
# path that covers the same gap at connect time.
if gh auth status >/dev/null 2>&1; then
  if ! git config --global --get-all credential.https://github.com.helper >/dev/null 2>&1; then
    gh auth setup-git >/dev/null 2>&1 || echo "Warning: gh auth setup-git failed" >&2
  fi
fi
echo
