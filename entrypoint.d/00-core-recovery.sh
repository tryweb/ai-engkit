#!/usr/bin/env bash
# 00-core-recovery.sh — verify and recover the image-managed core before any
# user package install, configuration generation, or application startup.
#
# The core is image-owned (root:root under /opt/ai-engkit/core) and is restored
# from the baked offline baseline with no network access. This runs first in the
# entrypoint.d lexical order (00- sorts before 01-install-packages.sh) and is
# skipped for the ai-admin command, which shares the image but never runs the
# v1 core.
#
# Fail-closed: a missing or corrupt baseline makes the helper exit nonzero; the
# entrypoint then keeps the container blocked without launching later stages.
set -euo pipefail

HELPER="/opt/ai-engkit/scripts/ai-engkit-core.py"
CORE_ROOT="/opt/ai-engkit/core"
BASELINE_DIR="/opt/ai-engkit/core-baseline"

if [[ "${AI_ENGKIT_BOOT_ROLE:-ai-dev}" == "ai-admin" ]]; then
  echo "[core-recovery] ai-admin command detected; skipping managed-core recovery"
  echo
  exit 0
fi

if [[ ! -f "$HELPER" ]]; then
  echo "[core-recovery] ERROR: recovery helper not found: $HELPER" >&2
  exit 1
fi

echo "[core-recovery] verifying managed core"
sudo -n python3 "$HELPER" recover \
  --core-root "$CORE_ROOT" \
  --baseline-dir "$BASELINE_DIR"
echo
