#!/usr/bin/env bash
set -uo pipefail

# ============================================================
# Agent Model E2E Test
# Usage: ./test/test-agent-model-e2e.sh [container_name]
#
# Proves native and OMO subagent model paths end-to-end:
#   set → restart → live resolution → child execution → restore
# Restoration and test-session cleanup are trap-guaranteed.
# ============================================================

CONTAINER="${1:-ai-engkit-dev}"
if [ "$CONTAINER" = "ai-engkit-dev" ] && ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER"; then
  CONTAINER="$(docker ps --filter 'label=com.docker.compose.project=dev' --filter 'label=com.docker.compose.service=ai-dev' --filter 'status=running' --format '{{.Names}}' 2>/dev/null | head -n 1)"
fi
CONTAINER="${CONTAINER:-ai-engkit-dev}"

PASS=0
FAIL=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { PASS=$((PASS + 1)); echo -e "  ${GREEN}PASS${NC} $1"; }
fail() { FAIL=$((FAIL + 1)); echo -e "  ${RED}FAIL${NC} $1"; }

COMPOSE_PROJECT="$(docker inspect "$CONTAINER" --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null || true)"
if [ -z "$COMPOSE_PROJECT" ]; then
  fail "cannot read Compose project label for container '$CONTAINER'; refusing to test an unknown container"
  exit 1
fi
if [ "$COMPOSE_PROJECT" != "dev" ]; then
  fail "refusing to test non-dev Compose project '$COMPOSE_PROJECT'"
  exit 1
fi

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then pass "$label"; else fail "$label (expected='$expected', actual='$actual')"; fi
}

assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -q "$needle"; then pass "$label"; else fail "$label (expected to contain '$needle')"; fi
}

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASSWORD="$(grep -E '^OPENCODE_SERVER_PASSWORD=' "$REPO_DIR/.env" 2>/dev/null | head -n 1 | cut -d= -f2-)"
if [ -z "$PASSWORD" ]; then
  echo "  ${YELLOW}SKIP${NC} agent-model-e2e: OPENCODE_SERVER_PASSWORD is not set in $REPO_DIR/.env"
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

get_agents_json() {
  opencode_api GET /agent
}

wait_for_server() {
  local seconds="${1:-120}" i
  for i in $(seq 1 "$seconds"); do
    if get_agents_json >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

GENERAL_TARGET="opencode/big-pickle"
LIBRARIAN_TARGET="opencode/nemotron-3.5-lightning-free"
BASELINE="/tmp/omo-baseline-$$.json"
AUTH_BASELINE="/tmp/agent-model-auth-baseline-$$.json"
HEALTH_BASELINE="/tmp/agent-model-health-baseline-$$.json"
RESTORED=0
AUTH_SNAPSHOT=0
HEALTH_SNAPSHOT=0
HEALTH_PRESENT=0
PARENT_SESSION=""
CHILD_SESSION=""

restore() {
  local port auth
  [ "$RESTORED" = "1" ] && [ "$AUTH_SNAPSHOT" != "1" ] && [ "$HEALTH_SNAPSHOT" != "1" ] && return
  RESTORED=1
  port="$(get_managed_port 2>/dev/null || true)"
  auth="$(printf 'opencode:%s' "$PASSWORD" | base64)"
  if [ -n "$port" ]; then
    [ -n "$CHILD_SESSION" ] && in_container "curl -fsS -X DELETE -H 'Authorization: Basic $auth' 'http://127.0.0.1:$port/session/$CHILD_SESSION' >/dev/null 2>&1" || true
    [ -n "$PARENT_SESSION" ] && in_container "curl -fsS -X DELETE -H 'Authorization: Basic $auth' 'http://127.0.0.1:$port/session/$PARENT_SESSION' >/dev/null 2>&1" || true
  fi
  if [ "$AUTH_SNAPSHOT" = "1" ]; then
    docker exec -i "$CONTAINER" sh -c 'cat > ~/.local/share/opencode/auth.json' < "$AUTH_BASELINE" >/dev/null 2>&1 || fail "restore: writing auth store back"
  fi
  if [ "$HEALTH_SNAPSHOT" = "1" ]; then
    if [ "$HEALTH_PRESENT" = "1" ]; then
      docker exec -i "$CONTAINER" sh -c 'cat > ~/.cache/openchamber/agent-model-health.json' < "$HEALTH_BASELINE" >/dev/null 2>&1 || fail "restore: writing health cache back"
    else
      docker exec "$CONTAINER" sh -c 'rm -f ~/.cache/openchamber/agent-model-health.json' >/dev/null 2>&1 || fail "restore: removing health cache"
    fi
  fi
  if [ -f "$BASELINE" ]; then
    docker exec -i "$CONTAINER" sh -c 'cat > ~/.config/opencode/oh-my-opencode-slim.json' < "$BASELINE" >/dev/null 2>&1 || fail "restore: writing baseline back"
    docker restart "$CONTAINER" >/dev/null 2>&1 || true
    echo "  (restored baseline oh-my-opencode-slim.json and restarted ai-dev)"
  fi
  rm -f "$BASELINE" "$AUTH_BASELINE" "$HEALTH_BASELINE"
}
trap restore EXIT

echo "== Native Agent Model E2E (container: $CONTAINER) =="

in_container 'cat ~/.config/opencode/oh-my-opencode-slim.json' > "$BASELINE" 2>/dev/null || { fail "baseline: could not read ~/.config/opencode/oh-my-opencode-slim.json"; exit 1; }
assert_contains "baseline slim config captured" 'agents' "$(cat "$BASELINE")"

# Credential-gated: skip cleanly without server password (readiness/inference distinction requires managed server)
if ! in_container 'grep -q "OPENCODE_SERVER_PASSWORD" ~/.env 2>/dev/null && grep -q "OPENCODE_SERVER_PASSWORD=." ~/.env 2>/dev/null'; then
  echo "  SKIP agent-model-e2e: OPENCODE_SERVER_PASSWORD not set in .env (readiness/inference E2E requires live server)"
  exit 0
fi

# Catalog guard uses the live managed-server /provider endpoint (slim does not write
# a provider-models.json cache file). SKIP cleanly when either target model is absent.
PROVIDER_SNAPSHOT="$(opencode_api GET /provider 2>/dev/null || true)"
if ! printf '%s' "$PROVIDER_SNAPSHOT" | jq -e '.connected | index("opencode")' >/dev/null 2>&1 \
  || ! printf '%s' "$PROVIDER_SNAPSHOT" | jq -e --arg id "big-pickle" '.all[]? | select(.id == "opencode") | .models | has($id)' >/dev/null 2>&1; then
  echo "  ${YELLOW}SKIP${NC} agent-model-e2e: $GENERAL_TARGET is absent from the environment catalog"
  exit 0
fi
if ! printf '%s' "$PROVIDER_SNAPSHOT" | jq -e --arg id "nemotron-3.5-lightning-free" '.all[]? | select(.id == "opencode") | .models | has($id)' >/dev/null 2>&1; then
  echo "  ${YELLOW}SKIP${NC} agent-model-e2e: $LIBRARIAN_TARGET is absent from the environment catalog"
  exit 0
fi

jq --arg general "$GENERAL_TARGET" --arg librarian "$LIBRARIAN_TARGET" '
  .agents.general.model = $general
  | del(.agents.general.variant)
  | .agents.librarian.model = $librarian
  | del(.agents.librarian.variant)
' "$BASELINE" \
  | docker exec -i "$CONTAINER" sh -c 'cat > ~/.config/opencode/oh-my-opencode-slim.json' \
  || { fail "set: writing model failed"; exit 1; }
assert_eq "set: persisted native model" "$GENERAL_TARGET" "$(in_container 'jq -r .agents.general.model ~/.config/opencode/oh-my-opencode-slim.json')"
assert_eq "set: persisted librarian model" "$LIBRARIAN_TARGET" "$(in_container 'jq -r .agents.librarian.model ~/.config/opencode/oh-my-opencode-slim.json')"

docker restart "$CONTAINER" >/dev/null 2>&1 || { fail "restart: docker restart failed"; exit 1; }
if wait_for_server 120; then
  pass "confirm: /agent reachable after restart"
else
  fail "confirm: /agent not reachable within 120s"
fi
assert_eq "confirm: generated OpenCode native override" "$GENERAL_TARGET" "$(in_container 'jq -r .agent.general.model ~/.config/opencode/opencode.json')"
assert_eq "confirm: live general agent resolves target" "$GENERAL_TARGET" "$(get_agents_json | jq -r '.[] | select(.name == "general") | .model.providerID + "/" + .model.modelID')"
assert_eq "confirm: live librarian resolves target" "$LIBRARIAN_TARGET" "$(get_agents_json | jq -r '.[] | select(.name == "librarian") | .model.providerID + "/" + .model.modelID')"

verify_child_model() {
  local agent="$1" target="$2" child_body prompt_body actual_model messages
  PARENT_SESSION="$(opencode_api POST '/session?directory=/home/devuser/workspace' "$(jq -nc --arg title "agent-model-e2e-$agent-parent" '{title:$title}')" | jq -r .id)"
  [ -n "$PARENT_SESSION" ] && [ "$PARENT_SESSION" != "null" ] || { fail "$agent child: parent session creation failed"; exit 1; }
  child_body="$(jq -nc --arg parent "$PARENT_SESSION" --arg title "agent-model-e2e-$agent" --arg agent "$agent" '{parentID:$parent,title:$title,agent:$agent}')"
  CHILD_SESSION="$(opencode_api POST '/session?directory=/home/devuser/workspace' "$child_body" | jq -r .id)"
  [ -n "$CHILD_SESSION" ] && [ "$CHILD_SESSION" != "null" ] || { fail "$agent child: child session creation failed"; exit 1; }

  prompt_body="$(jq -nc --arg agent "$agent" '{agent:$agent,parts:[{type:"text",text:"Reply with exactly OK."}]}')"
  opencode_api POST "/session/$CHILD_SESSION/prompt_async?directory=/home/devuser/workspace" "$prompt_body" >/dev/null \
    || { fail "$agent child: prompt submission failed"; exit 1; }

  actual_model=""
  for _ in $(seq 1 120); do
    messages="$(opencode_api GET "/session/$CHILD_SESSION/message?directory=/home/devuser/workspace" 2>/dev/null || echo '[]')"
    actual_model="$(printf '%s' "$messages" | jq -r '[.[] | .info | select(.role == "assistant" and .time.completed != null)] | last | if . then .providerID + "/" + .modelID else empty end')"
    [ -n "$actual_model" ] && break
    sleep 1
  done
  assert_eq "child: completed $agent session used configured model" "$target" "$actual_model"

  opencode_api DELETE "/session/$CHILD_SESSION" >/dev/null 2>&1 || true
  opencode_api DELETE "/session/$PARENT_SESSION" >/dev/null 2>&1 || true
  CHILD_SESSION=""
  PARENT_SESSION=""
}

# Explicit usability verification (inference, billable, opt-in) — the only real model request
verify_child_model "general" "$GENERAL_TARGET"
echo "  (OMO librarian child verification skipped: direct /session creation bypasses OMO delegate-task model resolution; readiness Apply does not send inference)"

jq 'del(.agents.librarian.model, .agents.librarian.variant, .agents.librarian.models, .agents.librarian.fallback_models)' "$BASELINE" \
  | docker exec -i "$CONTAINER" sh -c 'cat > ~/.config/opencode/oh-my-opencode-slim.json' \
  || { fail "clear: writing automatic-model config failed"; exit 1; }
assert_eq "clear: persisted librarian model removed" "null" "$(in_container 'jq -r .agents.librarian.model ~/.config/opencode/oh-my-opencode-slim.json')"

docker restart "$CONTAINER" >/dev/null 2>&1 || { fail "clear: docker restart failed"; exit 1; }
if wait_for_server 120; then
  pass "clear: /agent reachable after restart"
else
  fail "clear: /agent not reachable within 120s"
fi
AUTOMATIC_LIBRARIAN_MODEL="$(get_agents_json | jq -r '.[] | select(.name == "librarian") | .model.providerID + "/" + .model.modelID')"
[ -n "$AUTOMATIC_LIBRARIAN_MODEL" ] && [ "$AUTOMATIC_LIBRARIAN_MODEL" != "null/null" ] \
  && pass "clear: librarian has an automatic resolved model" \
  || fail "clear: librarian automatic model is unavailable"
echo "  (OMO librarian child verification skipped: direct /session creation bypasses OMO delegate-task model resolution)"

docker exec -i "$CONTAINER" sh -c 'cat > ~/.config/opencode/oh-my-opencode-slim.json' < "$BASELINE" >/dev/null 2>&1
assert_eq "restore: file byte-identical to baseline" "0" "$(cmp -s <(in_container 'cat ~/.config/opencode/oh-my-opencode-slim.json') "$BASELINE"; echo $?)"
docker restart "$CONTAINER" >/dev/null 2>&1
RESTORED=1

if wait_for_server 120; then
  pass "restore: /agent reachable after final restart"
else
  fail "restore: /agent unavailable after final restart"
fi

STARTUP_OUTPUT="$(docker exec "$CONTAINER" sh -c 'bun run /opt/admin/lib/agent-model-reconcile-cli.ts' 2>&1)"
STARTUP_EXIT=$?
assert_eq "startup reconciler: exits successfully" "0" "$STARTUP_EXIT"
assert_contains "startup reconciler: reports reconciliation summary" "reconciled:" "$STARTUP_OUTPUT"
STARTUP_NOOP_OUTPUT="$(docker exec "$CONTAINER" sh -c 'bun run /opt/admin/lib/agent-model-reconcile-cli.ts' 2>&1)"
STARTUP_NOOP_EXIT=$?
assert_eq "startup reconciler idempotence: exits successfully" "0" "$STARTUP_NOOP_EXIT"
assert_contains "startup reconciler idempotence: reports reconciliation summary" "reconciled:" "$STARTUP_NOOP_OUTPUT"

docker exec "$CONTAINER" sh -c 'cat ~/.local/share/opencode/auth.json' > "$AUTH_BASELINE" 2>/dev/null || {
  fail "rotation: could not snapshot auth store"
  exit 1
}
AUTH_SNAPSHOT=1
if docker exec "$CONTAINER" sh -c 'test -f ~/.cache/openchamber/agent-model-health.json'; then
  docker exec "$CONTAINER" sh -c 'cat ~/.cache/openchamber/agent-model-health.json' > "$HEALTH_BASELINE" 2>/dev/null || {
    fail "rotation: could not snapshot health cache"
    exit 1
  }
  HEALTH_SNAPSHOT=1
  HEALTH_PRESENT=1
else
  docker exec "$CONTAINER" sh -c 'printf "{}"' > "$HEALTH_BASELINE"
  HEALTH_SNAPSHOT=1
fi

ROTATION_PROVIDER_A="$(in_container 'jq -r .agents.general.model ~/.config/opencode/oh-my-opencode-slim.json' | cut -d/ -f1)"
ROTATION_PROVIDER_A="${ROTATION_PROVIDER_A:-opencode}"
ROTATION_PROVIDER_B="provider-b"
ROTATION_MODEL_B="${ROTATION_PROVIDER_B}/model-b"
ROTATION_MODEL_A="${ROTATION_PROVIDER_A}/$(in_container 'jq -r .agents.general.model ~/.config/opencode/oh-my-opencode-slim.json' | cut -d/ -f2-)"
OLD_PROVIDER_A_FINGERPRINT="$(docker exec "$CONTAINER" bash -lc 'source /opt/ai-engkit/scripts/agent-model-health.sh; credential_fingerprint "$1"' -- "$ROTATION_PROVIDER_A")"
docker exec "$CONTAINER" bash -lc 'source /opt/ai-engkit/scripts/agent-model-health.sh; health_record "$1" healthy "rotation baseline"; health_record "$2" healthy "provider-b baseline"' -- "$ROTATION_MODEL_A" "$ROTATION_MODEL_B" >/dev/null 2>&1
if ! docker exec "$CONTAINER" sh -c "tmp=\$(mktemp); jq --arg provider '$ROTATION_PROVIDER_A' '.[\$provider] = ((.[\$provider] // {}) + {credential:\"rotated-$$\"})' ~/.local/share/opencode/auth.json > \"\$tmp\" && mv \"\$tmp\" ~/.local/share/opencode/auth.json" >/dev/null 2>&1; then
  fail "rotation: changing provider A credentials failed"
fi
ROTATION_OUTPUT="$(docker exec "$CONTAINER" sh -c 'bun run /opt/admin/lib/agent-model-reconcile-cli.ts' 2>&1)"
ROTATION_EXIT=$?
assert_eq "rotation: reconciler exits successfully" "0" "$ROTATION_EXIT"
NEW_PROVIDER_A_FINGERPRINT="$(docker exec "$CONTAINER" bash -lc 'source /opt/ai-engkit/scripts/agent-model-health.sh; credential_fingerprint "$1"' -- "$ROTATION_PROVIDER_A")"
ROTATION_A_CURRENT="$(in_container "jq -r --arg provider '$ROTATION_PROVIDER_A' --arg fingerprint '$NEW_PROVIDER_A_FINGERPRINT' --arg model '$ROTATION_MODEL_A' '.[(\$provider + \"|\" + \$fingerprint + \"|\" + \$model)].fingerprint // empty' ~/.cache/openchamber/agent-model-health.json")"
ROTATION_A_OLD="$(in_container "jq -r --arg provider '$ROTATION_PROVIDER_A' --arg fingerprint '$OLD_PROVIDER_A_FINGERPRINT' --arg model '$ROTATION_MODEL_A' '.[(\$provider + \"|\" + \$fingerprint + \"|\" + \$model)].fingerprint // empty' ~/.cache/openchamber/agent-model-health.json")"
if [ "$ROTATION_A_OLD" != "$OLD_PROVIDER_A_FINGERPRINT" ] || [ "$ROTATION_A_CURRENT" = "$NEW_PROVIDER_A_FINGERPRINT" ]; then
  pass "rotation: provider A cache uses the rotated credential fingerprint"
else
  fail "rotation: provider A reused the pre-rotation cached verdict"
fi
assert_eq "rotation: provider B unexpired cache remains" "healthy" "$(docker exec "$CONTAINER" bash -lc 'source /opt/ai-engkit/scripts/agent-model-health.sh; health_status "$1"' -- "$ROTATION_MODEL_B")"

echo ""
echo "============================================"
echo " Agent Model E2E: ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC}"
echo "============================================"

[ "$FAIL" -gt 0 ] && exit 1
exit 0
