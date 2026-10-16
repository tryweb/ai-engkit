#!/usr/bin/env bash
# Refuse to launch the pinned v1 binary against an unrecognized database.
set -euo pipefail

if [[ "${AI_ENGKIT_BOOT_ROLE:-ai-dev}" == "ai-admin" ]]; then
  echo "[db-compat] ai-admin command detected; skipping v1 database gate"
  exit 0
fi

HELPER="/opt/ai-engkit/scripts/ai-engkit-db-compat.py"
BASELINE="/opt/ai-engkit/core-baseline/opencode-v1-db.json"
DB="$HOME/.local/share/opencode/opencode.db"

if [[ ! -f "$HELPER" || ! -f "$BASELINE" ]]; then
  echo "[db-compat] ERROR: compatibility helper or image baseline is missing" >&2
  exit 1
fi

echo "[db-compat] checking OpenCode database compatibility before startup"
sudo -n python3 "$HELPER" check --db "$DB" --baseline "$BASELINE"
