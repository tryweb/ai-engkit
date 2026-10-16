#!/usr/bin/env bash
set -euo pipefail

if [[ "${AI_ENGKIT_BOOT_ROLE:-ai-dev}" == "ai-admin" ]]; then
  echo "[opencode-selection] ai-admin command detected; skipping v1 CLI selection repair"
  exit 0
fi

source "$(dirname "$0")/lib-opencode-selection-repair.bash"
ensure_managed_opencode_selection "$HOME/.config/openchamber/settings.json"
