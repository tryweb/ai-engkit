#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER="${OPENCHAMBER_CONTAINER:-}"
PASSWORD="${OPENCHAMBER_UI_PASSWORD:-chamber}"
BASE_URL="${OPENCHAMBER_BASE_URL:-http://127.0.0.1:3000}"
REMOTE_SCRIPT="/tmp/ai-engkit-openchamber-update-e2e.mjs"

if [[ -z "$CONTAINER" ]]; then
  echo "ERROR: set OPENCHAMBER_CONTAINER to a disposable running ai-dev container" >&2
  exit 2
fi

cleanup() {
  docker exec "$CONTAINER" rm -f "$REMOTE_SCRIPT" >/dev/null 2>&1 || true
}
trap cleanup EXIT

installer_process_count() {
  docker exec -u root "$CONTAINER" python3 -c '
import os
import shlex

def installer_command(args):
    if not args:
        return False
    executable = os.path.basename(args[0]).lower()
    if executable in {"bun", "npm", "npm-cli.js", "pnpm", "yarn"}:
        for index, argument in enumerate(args[1:], 1):
            if argument in {"install", "add", "update"}:
                return any("openchamber" in value.lower() for value in args[index + 1 :])
    if executable == "node" and len(args) > 1 and "npm-cli.js" in args[1]:
        return installer_command([args[1], *args[2:]])
    if executable in {"sh", "bash"}:
        for index, argument in enumerate(args[:-1]):
            if argument == "-c":
                try:
                    return installer_command(shlex.split(args[index + 1]))
                except ValueError:
                    return False
    return False

count = 0
for entry in os.scandir("/proc"):
    if not entry.name.isdecimal() or int(entry.name) == os.getpid():
        continue
    try:
        raw = open(f"/proc/{entry.name}/cmdline", "rb").read()
    except OSError:
        continue
    args = [value.decode(errors="replace") for value in raw.split(b"\0") if value]
    if installer_command(args):
        count += 1
print(count)
'
}

core_integrity_status() {
  docker exec -u root "$CONTAINER" python3 /opt/ai-engkit/scripts/ai-engkit-core.py status \
    --core-root /opt/ai-engkit/core \
    --baseline-dir /opt/ai-engkit/core-baseline
}

CORE_BEFORE="$(core_integrity_status)"
if [[ "$CORE_BEFORE" != "clean" ]]; then
  echo "ERROR: managed core was not clean before browser test: $CORE_BEFORE" >&2
  exit 1
fi

BEFORE="$(installer_process_count)"
if [[ "$BEFORE" != "0" ]]; then
  echo "ERROR: installer processes already running in $CONTAINER: $BEFORE" >&2
  exit 1
fi

READY=0
for ((attempt = 0; attempt < 60; attempt++)); do
  if docker exec "$CONTAINER" curl -fsS --max-time 2 "$BASE_URL/" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done
if [[ "$READY" != "1" ]]; then
  echo "ERROR: OpenChamber did not become ready at $BASE_URL" >&2
  exit 1
fi

docker cp "$REPO_ROOT/e2e/openchamber-update-guard.mjs" "$CONTAINER:$REMOTE_SCRIPT"
set +e
docker exec \
  -w /tmp \
  -e NODE_PATH=/home/devuser/.bun/install/global/node_modules \
  -e OPENCHAMBER_BASE_URL="$BASE_URL" \
  -e OPENCHAMBER_UI_PASSWORD="$PASSWORD" \
  "$CONTAINER" bun run "$REMOTE_SCRIPT"
E2E_RC=$?
set -e

AFTER="$(installer_process_count)"
CORE_AFTER="$(core_integrity_status)"
if [[ "$AFTER" != "0" ]]; then
  echo "ERROR: update click left $AFTER OpenChamber installer process(es) running" >&2
  exit 1
fi
if [[ "$CORE_AFTER" != "$CORE_BEFORE" ]]; then
  echo "ERROR: managed core integrity changed from '$CORE_BEFORE' to '$CORE_AFTER'" >&2
  exit 1
fi
if [[ "$E2E_RC" -ne 0 ]]; then
  exit "$E2E_RC"
fi
echo "PASS no OpenChamber installer process was spawned"
echo "PASS managed core remained manifest-clean"
