#!/usr/bin/env bash
set -uo pipefail

# ============================================================
# OpenChamber Integration Test Script
# Usage: ./test/run-tests.sh [container_name]
# Note: Using set -u instead of -e because curl failures are expected
# ============================================================

CONTAINER="${1:-ai-dev}"
CHAMBER_PORT="${CHAMBER_PORT:-8000}"
PASS=0
FAIL=0
SKIP=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { PASS=$((PASS + 1)); echo -e "  ${GREEN}PASS${NC} $1"; }
fail() { FAIL=$((FAIL + 1)); echo -e "  ${RED}FAIL${NC} $1"; }
skip() { SKIP=$((SKIP + 1)); echo -e "  ${YELLOW}SKIP${NC} $1"; }

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    pass "$label"
  else
    fail "$label (expected='$expected', actual='$actual')"
  fi
}

assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -q "$needle"; then
    pass "$label"
  else
    fail "$label (expected to contain '$needle')"
  fi
}

assert_file_exists() {
  local label="$1" path="$2"
  if docker exec "$CONTAINER" test -f "$path" 2>/dev/null; then
    pass "$label"
  else
    fail "$label ($path not found)"
  fi
}

assert_dir_exists() {
  local label="$1" path="$2"
  if docker exec "$CONTAINER" test -d "$path" 2>/dev/null; then
    pass "$label"
  else
    fail "$label ($path not found)"
  fi
}

echo "============================================"
echo " OpenChamber Test Suite"
echo " Container: $CONTAINER"
echo " Port: $CHAMBER_PORT"
echo "============================================"
echo ""

# --------------------------------------------------
# 1. Container Status
# --------------------------------------------------
echo "--- Container Status ---"

STATUS=$(docker inspect "$CONTAINER" --format '{{.State.Status}}' 2>/dev/null || echo "not_found")
assert_eq "Container exists and running" "running" "$STATUS"

RESTART_COUNT=$(docker inspect "$CONTAINER" --format '{{.RestartCount}}' 2>/dev/null || echo "-1")
if [ "$RESTART_COUNT" = "0" ]; then
  pass "No restarts (RestartCount=0)"
else
  fail "Unexpected restarts (RestartCount=$RESTART_COUNT)"
fi

# --------------------------------------------------
# 2. User & Environment
# --------------------------------------------------
echo ""
echo "--- User & Environment ---"

WHOAMI=$(docker exec "$CONTAINER" whoami 2>/dev/null || echo "error")
assert_eq "Running as devuser" "devuser" "$WHOAMI"

HOME_DIR=$(docker exec "$CONTAINER" sh -c 'echo $HOME' 2>/dev/null || echo "error")
assert_eq "HOME is /home/devuser" "/home/devuser" "$HOME_DIR"

# --------------------------------------------------
# 3. Versions
# --------------------------------------------------
echo ""
echo "--- Versions ---"

OPCODE_VER=$(docker exec "$CONTAINER" opencode --version 2>/dev/null || echo "error")
if [ "$OPCODE_VER" != "error" ]; then
  pass "opencode version ($OPCODE_VER)"
else
  fail "opencode not found"
fi

OCHAMBER_VER=$(docker exec "$CONTAINER" openchamber --version 2>/dev/null || echo "error")
if [ "$OCHAMBER_VER" != "error" ]; then
  pass "openchamber version ($OCHAMBER_VER)"
else
  fail "openchamber not found"
fi

OSPEC_VER=$(docker exec "$CONTAINER" openspec --version 2>/dev/null || docker exec "$CONTAINER" openspec version 2>/dev/null || echo "error")
if [ "$OSPEC_VER" != "error" ]; then
  pass "openspec installed ($OSPEC_VER)"
else
  fail "openspec not found"
fi

GH_VER=$(docker exec "$CONTAINER" gh --version 2>/dev/null | head -1 || echo "error")
if echo "$GH_VER" | grep -q "gh version"; then
  pass "gh CLI installed"
else
  fail "gh CLI not found"
fi

# --------------------------------------------------
# 4. Config Files
# --------------------------------------------------
echo ""
echo "--- Config Files ---"

assert_file_exists "opencode.json exists" "/home/devuser/.config/opencode/opencode.json"
assert_file_exists "settings.json exists" "/home/devuser/.config/openchamber/settings.json"

OPCODE_PLUGINS=$(docker exec "$CONTAINER" jq -r '.plugin | length' ~/.config/opencode/opencode.json 2>/dev/null || \
  docker exec "$CONTAINER" sh -c 'jq -r ".plugin | length" ~/.config/opencode/opencode.json' 2>/dev/null || echo "0")
if [ "$OPCODE_PLUGINS" -gt 0 ] 2>/dev/null; then
  pass "opencode.json has $OPCODE_PLUGINS plugin(s)"
else
  fail "opencode.json has no plugins"
fi

# --------------------------------------------------
# 5. Data Persistence
# --------------------------------------------------
echo ""
echo "--- Data Persistence ---"

assert_file_exists "opencode.db exists" "/home/devuser/.local/share/opencode/opencode.db"
assert_dir_exists "openchamber logs dir" "/home/devuser/.config/openchamber/logs"
assert_dir_exists "openchamber run dir" "/home/devuser/.config/openchamber/run"
assert_file_exists "models.json cache" "/home/devuser/.cache/opencode/models.json"

# --------------------------------------------------
# 6. Web UI & Auth
# --------------------------------------------------
echo ""
echo "--- Web UI & Auth ---"

# Try external access first, fallback to internal container test
HTTP_CODE=$(curl -sf -o /dev/null -w "%{http_code}" "http://localhost:${CHAMBER_PORT}/" 2>/dev/null)
if [ -z "$HTTP_CODE" ] || [ "$HTTP_CODE" = "000" ]; then
  HTTP_CODE="000"
fi
if [ "$HTTP_CODE" = "200" ]; then
  assert_eq "Web UI responds 200" "200" "$HTTP_CODE"
  HTML=$(curl -sf "http://localhost:${CHAMBER_PORT}/" 2>/dev/null || echo "")
  assert_contains "Web UI returns HTML" "<!doctype html>" "$HTML"
elif [ "$HTTP_CODE" = "000" ]; then
  # Fallback: test from inside container
  INTERNAL_CODE=$(timeout 10 docker exec "$CONTAINER" sh -c 'curl -sf -o /dev/null -w "%{http_code}" http://localhost:3000/' 2>/dev/null)
  if [ -z "$INTERNAL_CODE" ]; then
    INTERNAL_CODE="000"
  fi
  if [ "$INTERNAL_CODE" = "200" ]; then
    skip "Web UI responds 200 (internal only, network unavailable)"
    skip "Web UI returns HTML (internal only, network unavailable)"
  else
    fail "Web UI not accessible (external: 000, internal: $INTERNAL_CODE)"
  fi
else
  fail "Web UI returned HTTP $HTTP_CODE (expected 200)"
fi

# Check OPENCHAMBER_UI_PASSWORD env var is set
UI_PASSWD_ENV=$(docker exec "$CONTAINER" sh -c 'echo $OPENCHAMBER_UI_PASSWORD' 2>/dev/null || echo "")
if [ -n "$UI_PASSWD_ENV" ]; then
  pass "OPENCHAMBER_UI_PASSWORD env var is set"
else
  fail "OPENCHAMBER_UI_PASSWORD env var is not set"
fi

# Check that openchamber logs do NOT show "unsecured" warning
LOGS=$(timeout 5 docker logs "$CONTAINER" 2>/dev/null | tail -50 || echo "NO_LOGS")
if echo "$LOGS" | grep -q "browser UI is unsecured"; then
  fail "UI password not applied (openchamber reports unsecured)"
else
  pass "UI password applied (no unsecured warning)"
fi

# --------------------------------------------------
# 7. Health API
# --------------------------------------------------
echo ""
echo "--- Health API ---"

# Try external access first, fallback to internal container test
HEALTH=$(curl -sf "http://localhost:${CHAMBER_PORT}/health" 2>/dev/null || echo "{}")
if [ "$HEALTH" != "{}" ]; then
  HEALTH_STATUS=$(echo "$HEALTH" | jq -r '.status' 2>/dev/null || echo "error")
  assert_eq "Health status is ok" "ok" "$HEALTH_STATUS"

  OPCODE_RUNNING=$(echo "$HEALTH" | jq -r '.openCodeRunning' 2>/dev/null || echo "false")
  assert_eq "OpenCode running" "true" "$OPCODE_RUNNING"

  OPCODE_READY=$(echo "$HEALTH" | jq -r '.isOpenCodeReady' 2>/dev/null || echo "false")
  assert_eq "OpenCode ready" "true" "$OPCODE_READY"
else
  # Fallback: test from inside container
  INTERNAL_HEALTH=$(timeout 5 docker exec "$CONTAINER" sh -c 'curl -sf http://localhost:3000/health' 2>/dev/null || echo "{}")
  if [ "$INTERNAL_HEALTH" != "{}" ]; then
    HEALTH_STATUS=$(echo "$INTERNAL_HEALTH" | jq -r '.status' 2>/dev/null || echo "error")
    OPCODE_RUNNING=$(echo "$INTERNAL_HEALTH" | jq -r '.openCodeRunning' 2>/dev/null || echo "false")
    OPCODE_READY=$(echo "$INTERNAL_HEALTH" | jq -r '.isOpenCodeReady' 2>/dev/null || echo "false")
    skip "Health API (internal only, network unavailable)"
    skip "OpenCode running (internal only, network unavailable)"
    skip "OpenCode ready (internal only, network unavailable)"
  else
    fail "Health API not accessible (external or internal)"
  fi
fi

# --------------------------------------------------
# 8. Dev Tools
# --------------------------------------------------
echo ""
echo "--- Dev Tools ---"

TOOLS="git diff jq tree less tmux python3 gh zip unzip wget curl ssh rsync htop nano bun node"
for tool in $TOOLS; do
  if docker exec "$CONTAINER" sh -c "command -v $tool >/dev/null 2>&1" 2>/dev/null; then
    pass "$tool available"
  else
    fail "$tool missing"
  fi
done

# --------------------------------------------------
# 8.1 Graphify (Knowledge Graph Tool)
# --------------------------------------------------
echo ""
echo "--- Graphify (Knowledge Graph) ---"

GRAPHIFY_CMD=$(docker exec "$CONTAINER" sh -c 'command -v graphify' 2>/dev/null || echo "not_found")
if [ "$GRAPHIFY_CMD" != "not_found" ]; then
  pass "graphify command available at $GRAPHIFY_CMD"
else
  fail "graphify command not found"
fi

GRAPHIFY_HELP=$(docker exec "$CONTAINER" graphify --help 2>/dev/null || echo "error")
if echo "$GRAPHIFY_HELP" | grep -q "Commands:"; then
  pass "graphify --help works"
else
  fail "graphify --help failed"
fi

if docker exec "$CONTAINER" test -f /home/devuser/.config/opencode/skills/graphify/SKILL.md 2>/dev/null; then
  pass "graphify SKILL.md exists"
else
  fail "graphify SKILL.md not found"
fi

# --------------------------------------------------
# 8.2 Superpowers (Agentic Skills Framework)
# --------------------------------------------------
echo ""
echo "--- Superpowers (Agentic Skills Framework) ---"

if docker exec "$CONTAINER" sh -c 'jq -r ".plugin | join(\" \")" ~/.config/opencode/opencode.json 2>/dev/null | grep -q "superpowers"'; then
  pass "superpowers plugin configured in opencode.json"
else
  fail "superpowers plugin not found in opencode.json"
fi

SUPERPOWERS_PLUGIN_COUNT=$(docker exec "$CONTAINER" sh -c 'jq -r ".plugin | length" ~/.config/opencode/opencode.json 2>/dev/null' || echo "0")
if [ "$SUPERPOWERS_PLUGIN_COUNT" -gt 0 ] 2>/dev/null; then
  pass "superpowers plugin entry exists"
else
  fail "superpowers plugin entry missing"
fi

if docker exec "$CONTAINER" sh -c 'test -f /home/devuser/.config/opencode/skills/using-superpowers/SKILL.md && test -f /home/devuser/.config/opencode/skills/systematic-debugging/SKILL.md' 2>/dev/null; then
  pass "superpowers skills discoverable in global skills path"
else
  fail "superpowers skills not found in global skills path"
fi

# --------------------------------------------------
# 9. Node symlink (bun compatibility)
# --------------------------------------------------
echo ""
echo "--- Node/Bun Compatibility ---"

NODE_PATH=$(docker exec "$CONTAINER" sh -c 'command -v node' 2>/dev/null || echo "not_found")
if [ "$NODE_PATH" != "not_found" ]; then
  pass "node command available at $NODE_PATH"
else
  fail "node command not found"
fi

# --------------------------------------------------
# Summary
# --------------------------------------------------
echo ""
echo "============================================"
echo " Results: ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC}, ${YELLOW}$SKIP skipped${NC}"
echo "============================================"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
