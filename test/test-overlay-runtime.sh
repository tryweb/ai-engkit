#!/usr/bin/env bash
set -uo pipefail

# ============================================================
# Overlay / OpenCode runtime verification
# Usage: ./test/test-overlay-runtime.sh [container_name] [--recreate]
#
# Verifies a live ai-dev OpenCode runtime:
#   - the documented runtime variable names are present in the overlay
#   - skill discovery works
#   - an authenticated real job completes
#   - the same checks pass after an optional ai-dev restart
#
# Credential-gated: skips cleanly when OPENCODE_SERVER_PASSWORD is unset.
# ============================================================

CONTAINER=""
RECREATE=0
for arg in "$@"; do
  case "$arg" in
    --recreate) RECREATE=1 ;;
    *) CONTAINER="$arg" ;;
  esac
done
if [ -z "$CONTAINER" ]; then
  CONTAINER="ai-engkit-dev"
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER"; then
    CONTAINER="$(docker ps --filter 'label=com.docker.compose.service=ai-dev' --filter 'status=running' --format '{{.Names}}' 2>/dev/null | head -n 1)"
  fi
fi
CONTAINER="${CONTAINER:-ai-engkit-dev}"

PASS=0
FAIL=0
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
pass() { PASS=$((PASS + 1)); echo -e "  ${GREEN}PASS${NC} $1"; }
fail() { FAIL=$((FAIL + 1)); echo -e "  ${RED}FAIL${NC} $1"; }

if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER"; then
  echo "  ${YELLOW}SKIP${NC} overlay-runtime: ai-dev container '$CONTAINER' is not running"
  exit 0
fi

PASSWORD="$(docker exec "$CONTAINER" sh -c 'printenv OPENCODE_SERVER_PASSWORD 2>/dev/null' 2>/dev/null || true)"
if [ -z "$PASSWORD" ]; then
  PASSWORD="$(docker exec "$CONTAINER" sh -c 'sed -n "s/^OPENCODE_SERVER_PASSWORD=//p" ~/.env 2>/dev/null | tail -n1' 2>/dev/null || true)"
fi
if [ -z "$PASSWORD" ]; then
  REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  PASSWORD="$(grep -E '^OPENCODE_SERVER_PASSWORD=' "$REPO_DIR/.env" 2>/dev/null | head -n 1 | cut -d= -f2-)"
fi
if [ -z "$PASSWORD" ]; then
  echo "  ${YELLOW}SKIP${NC} overlay-runtime: OPENCODE_SERVER_PASSWORD is not set in $CONTAINER"
  exit 0
fi

in_container() { docker exec "$CONTAINER" sh -c "$1"; }

get_managed_port() {
  local auth
  auth="$(printf 'opencode:%s' "$PASSWORD" | base64)"
  in_container "for f in ~/.config/openchamber/managed-opencode/*.json; do pid=\$(jq -r .pid \"\$f\" 2>/dev/null); port=\$(jq -r .port \"\$f\" 2>/dev/null); if [ -n \"\$pid\" ] && [ -n \"\$port\" ] && kill -0 \"\$pid\" 2>/dev/null && curl -fsS -m 2 -H 'Authorization: Basic $auth' \"http://127.0.0.1:\$port/agent\" >/dev/null 2>&1; then echo \"\$port\"; break; fi; done"
}

opencode_api() {
  local method="$1" path="$2" body="${3:-}" port auth
  port="$(get_managed_port)"
  [ -n "$port" ] || return 1
  auth="$(printf 'opencode:%s' "$PASSWORD" | base64)"
  if [ -n "$body" ]; then
    in_container "curl -fsS -m 180 -X '$method' -H 'Authorization: Basic $auth' -H 'Content-Type: application/json' --data-binary '$body' 'http://127.0.0.1:$port$path'"
  else
    in_container "curl -fsS -m 180 -X '$method' -H 'Authorization: Basic $auth' 'http://127.0.0.1:$port$path'"
  fi
}

wait_for_api() {
  local seconds="${1:-120}" i
  for i in $(seq 1 "$seconds"); do
    if opencode_api GET /agent >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

run_checks() {
  local label="$1"

  # Runtime variable names: only report presence, never values.
  local env_present
  env_present="$(in_container 'printenv OPENCHAMBER_OPENCODE_HOSTNAME >/dev/null 2>&1 && echo yes || echo no')"
  if [ "$env_present" = "yes" ]; then
    pass "$label: OPENCHAMBER_OPENCODE_HOSTNAME is present in the ai-dev runtime"
  else
    echo "  ${YELLOW}INFO${NC} $label: OPENCHAMBER_OPENCODE_HOSTNAME not set (base default; add it in the overlay)"
  fi

  # Skill discovery: baked skills are discoverable inside the runtime.
  if in_container 'ls -d /opt/opencode/baked-plugins/*/skills >/dev/null 2>&1'; then
    pass "$label: skill discovery finds baked skill directories"
  else
    echo "  ${YELLOW}INFO${NC} $label: no baked skill directory in this image"
  fi
  if opencode_api GET /agent | jq -e 'length > 0' >/dev/null 2>&1; then
    pass "$label: authenticated /agent discovery returns agents"
  else
    fail "$label: authenticated /agent discovery returned nothing"
  fi

  # Authenticated real job.
  local session prompt_body status agent_name
  agent_name="$(opencode_api GET /agent | jq -r 'if any(.[]; .name == "general" and .model.modelID != null) then "general" else (.[] | select(.model.modelID != null) | .name) end' 2>/dev/null | head -n1)"
  [ -n "$agent_name" ] || agent_name="general"
  session="$(opencode_api POST '/session?directory=/home/devuser/workspace' "$(jq -nc --arg title "overlay-runtime-$label" '{title:$title}')" | jq -r .id)"
  if [ -z "$session" ] || [ "$session" = "null" ]; then
    fail "$label: session creation failed"
    return
  fi
  prompt_body="$(jq -nc --arg agent "$agent_name" '{agent:$agent,parts:[{type:"text",text:"Reply with exactly OK."}]}')"
  opencode_api POST "/session/$session/prompt_async?directory=/home/devuser/workspace" "$prompt_body" >/dev/null \
    || fail "$label: prompt submission failed"
  status=""
  for _ in $(seq 1 120); do
    status="$(opencode_api GET "/session/$session/message?directory=/home/devuser/workspace" 2>/dev/null \
      | jq -r '[.[] | .info | select(.role == "assistant" and .time.completed != null)] | length' 2>/dev/null || echo 0)"
    [ "${status:-0}" -gt 0 ] 2>/dev/null && break
    sleep 1
  done
  if [ "${status:-0}" -gt 0 ] 2>/dev/null; then
    pass "$label: authenticated real job completed"
  else
    fail "$label: authenticated real job did not complete"
  fi
  opencode_api DELETE "/session/$session" >/dev/null 2>&1 || true
}

echo "== Overlay/OpenCode runtime verification (container: $CONTAINER) =="
if ! wait_for_api 120; then
  fail "managed OpenCode API not reachable"
else
  run_checks "before"
fi

if [ "$RECREATE" = "1" ]; then
  echo "  Recreating ai-dev..."
  docker restart "$CONTAINER" >/dev/null 2>&1 || fail "docker restart failed"
  if wait_for_api 120; then
    run_checks "after-recreate"
  else
    fail "managed OpenCode API not reachable after recreate"
  fi
fi

echo ""
echo "============================================"
echo " Overlay runtime: ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC}"
echo "============================================"
[ "$FAIL" -gt 0 ] && exit 1
exit 0
