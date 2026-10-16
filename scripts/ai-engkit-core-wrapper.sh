#!/usr/bin/env bash
# ai-engkit-core-wrapper.sh — stable PATH entry point for the managed core.
#
# Installed as both `/opt/ai-engkit/core/bin/opencode` and
# `/opt/ai-engkit/core/bin/openchamber` (and symlinked from `~/.bun/bin` for
# absolute-path consumers). It resolves the active generation, points
# BUN_INSTALL at that generation for this process only, and execs the managed
# binary. It never changes the user's global Bun prefix, so `BUN_PACKAGES`
# installs and interactive `bun install -g` keep targeting `~/.bun`.
set -euo pipefail

name="$(basename "$0")"
source_path="${BASH_SOURCE[0]}"
core_root="$(cd -- "$(dirname -- "$(readlink -f -- "$source_path")")/.." && pwd)"
target="$core_root/active/bin/$name"

if [[ ! -e "$target" ]]; then
  echo "ai-engkit-core: managed core '$name' is unavailable at $target" >&2
  echo "The image-managed core is missing or not recovered; deploy a new AI-EngKit image." >&2
  exit 127
fi

export BUN_INSTALL="$core_root/active"
exec "$target" "$@"
