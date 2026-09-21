#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "SKIP admin-upgrade-staging-perms: root is required to create the ownership fixture"
  exit 0
fi
if ! id devuser >/dev/null 2>&1; then
  echo "SKIP admin-upgrade-staging-perms: devuser is not available"
  exit 0
fi
if ! command -v runuser >/dev/null 2>&1; then
  echo "SKIP admin-upgrade-staging-perms: runuser is not available"
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/admin-data"
printf 'services:\n  ai-dev:\n    image: prior\n' > "$WORK/upgrade-base.yml"
chown root:root "$WORK" "$WORK/upgrade-base.yml"
chmod 0755 "$WORK"
chown devuser:devuser "$WORK/admin-data"
chmod 0700 "$WORK/admin-data"

OLD_PATH="$WORK/upgrade-base.yml.staging"
NEW_PATH="$WORK/admin-data/upgrade-base.yml.staging"

if runuser -u devuser -- sh -c "printf '%s' staged > '$OLD_PATH'" 2>/dev/null; then
  echo "FAIL admin-upgrade-staging-perms: old sibling path is writable"
  exit 1
fi
echo "PASS admin-upgrade-staging-perms: old sibling path rejects uid 1000"

runuser -u devuser -- sh -c "printf '%s' staged > '$NEW_PATH'"
if [ "$(cat "$NEW_PATH")" != "staged" ]; then
  echo "FAIL admin-upgrade-staging-perms: writable mount staging content mismatch"
  exit 1
fi
rm -f "$NEW_PATH"

if [ -e "$OLD_PATH" ] || [ -e "$NEW_PATH" ]; then
  echo "FAIL admin-upgrade-staging-perms: staging file left behind"
  exit 1
fi
if [ "$(cat "$WORK/upgrade-base.yml")" != $'services:\n  ai-dev:\n    image: prior\n' ]; then
  echo "FAIL admin-upgrade-staging-perms: stored base was modified"
  exit 1
fi
echo "PASS admin-upgrade-staging-perms: admin-data staging is writable and cleaned"
