#!/usr/bin/env bash
set -euo pipefail

# Ensure /home/devuser/workspace is a git repo so the engine's
# /experimental/worktree endpoint can create a project. Worktrees
# require an existing git directory; without this, the UI's
# "create project" flow fails with WorktreeNotGitError.
#
# Idempotent: skip if .git already exists, preserving any user
# commits that were made in a previous container run.
WORKSPACE="/home/devuser/workspace"

if [ -d "$WORKSPACE/.git" ]; then
  exit 0
fi

echo "=== Initializing git repo in workspace ==="
git -C "$WORKSPACE" init -b main
git -C "$WORKSPACE" config user.email "ai@engkit.local"
git -C "$WORKSPACE" config user.name "ai-engkit"
git -C "$WORKSPACE" add -A
git -C "$WORKSPACE" commit -m "initial workspace bootstrap" --allow-empty
echo "=== Git repo initialized ==="
echo
