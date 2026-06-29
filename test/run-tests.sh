#!/usr/bin/env bash
set -uo pipefail

# ============================================================
# OpenChamber Integration Test Script
# Usage: ./test/run-tests.sh [container_name]
# Note: Using set -u instead of -e because curl failures are expected
# ============================================================

ENGINE_CONTAINER="${1:-ai-engkit-engine}"
UI_CONTAINER="${2:-ai-engkit-ui}"
CHAMBER_PORT="${CHAMBER_PORT:-8001}"

# Backward-compat alias: most tests below use $CONTAINER for engine tool checks
CONTAINER="${ENGINE_CONTAINER}"
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
echo " OpenChamber Test Suite (Multi-Container)"
echo " Engine: $ENGINE_CONTAINER"
echo " UI:     $UI_CONTAINER"
echo " Port:   $CHAMBER_PORT"
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

OCHAMBER_VER=$(docker exec "$UI_CONTAINER" openchamber --version 2>/dev/null || echo "error")
if [ "$OCHAMBER_VER" != "error" ]; then
  pass "openchamber version ($OCHAMBER_VER)"
else
  fail "openchamber not found in $UI_CONTAINER"
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

GLAB_VER=$(docker exec "$CONTAINER" glab --version 2>/dev/null | head -1 || echo "error")
if echo "$GLAB_VER" | grep -qi "glab"; then
  pass "glab CLI installed"
else
  fail "glab CLI not found"
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
  # Fallback: test from inside the UI container (port 3000 lives there)
  INTERNAL_CODE=$(timeout 10 docker exec "$UI_CONTAINER" sh -c 'curl -sf -o /dev/null -w "%{http_code}" http://localhost:3000/' 2>/dev/null)
  if [ -z "$INTERNAL_CODE" ]; then
    INTERNAL_CODE="000"
  fi
  if [ "$INTERNAL_CODE" = "200" ]; then
    pass "Web UI responds 200 (internal fallback via $UI_CONTAINER)"
    HTML=$(timeout 10 docker exec "$UI_CONTAINER" sh -c 'curl -sf http://localhost:3000/' 2>/dev/null || echo "")
    assert_contains "Web UI returns HTML (internal fallback)" "<!doctype html>" "$HTML"
  else
    fail "Web UI not accessible (external: 000, internal: $INTERNAL_CODE)"
  fi
else
  fail "Web UI returned HTTP $HTTP_CODE (expected 200)"
fi

# Check OPENCHAMBER_UI_PASSWORD env var is set in the UI container
UI_PASSWD_ENV=$(docker exec "$UI_CONTAINER" sh -c 'echo $OPENCHAMBER_UI_PASSWORD' 2>/dev/null || echo "")
if [ -n "$UI_PASSWD_ENV" ]; then
  pass "OPENCHAMBER_UI_PASSWORD env var is set (in $UI_CONTAINER)"
else
  fail "OPENCHAMBER_UI_PASSWORD env var is not set (in $UI_CONTAINER)"
fi

# Check that openchamber logs do NOT show "unsecured" warning
LOGS=$(timeout 5 docker logs "$UI_CONTAINER" 2>/dev/null | tail -50 || echo "NO_LOGS")
if echo "$LOGS" | grep -q "browser UI is unsecured"; then
  fail "UI password not applied (openchamber reports unsecured in $UI_CONTAINER)"
else
  pass "UI password applied (no unsecured warning in $UI_CONTAINER)"
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
  # Fallback: test from inside the UI container (health endpoint lives on :3000)
  INTERNAL_HEALTH=$(timeout 5 docker exec "$UI_CONTAINER" sh -c 'curl -sf http://localhost:3000/health' 2>/dev/null || echo "{}")
  if [ "$INTERNAL_HEALTH" != "{}" ]; then
    HEALTH_STATUS=$(echo "$INTERNAL_HEALTH" | jq -r '.status' 2>/dev/null || echo "error")
    assert_eq "Health API (internal fallback)" "ok" "$HEALTH_STATUS"
    OPCODE_RUNNING=$(echo "$INTERNAL_HEALTH" | jq -r '.openCodeRunning' 2>/dev/null || echo "false")
    assert_eq "OpenCode running (internal fallback)" "true" "$OPCODE_RUNNING"
    OPCODE_READY=$(echo "$INTERNAL_HEALTH" | jq -r '.isOpenCodeReady' 2>/dev/null || echo "false")
    assert_eq "OpenCode ready (internal fallback)" "true" "$OPCODE_READY"
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

if docker exec "$CONTAINER" docker --version >/dev/null 2>&1; then
  pass "docker CLI works"
else
  fail "docker CLI not working"
fi

if docker exec "$CONTAINER" docker info >/dev/null 2>&1; then
  pass "docker daemon reachable via socket"
else
  fail "docker daemon not reachable via socket"
fi

if docker exec "$CONTAINER" docker ps >/dev/null 2>&1; then
  pass "docker CLI can query containers"
else
  fail "docker CLI cannot query containers"
fi

if docker exec "$CONTAINER" docker compose version >/dev/null 2>&1; then
  pass "docker compose plugin works"
else
  fail "docker compose plugin not working"
fi

if docker exec "$CONTAINER" docker compose ls >/dev/null 2>&1; then
  pass "docker compose can query daemon"
else
  fail "docker compose cannot query daemon"
fi

if docker exec "$CONTAINER" docker buildx version >/dev/null 2>&1; then
  pass "docker buildx plugin works"
else
  fail "docker buildx plugin not working"
fi

if docker exec "$CONTAINER" docker buildx ls >/dev/null 2>&1; then
  pass "docker buildx can list builders"
else
  fail "docker buildx cannot list builders"
fi

if docker exec "$CONTAINER" marksman --version >/dev/null 2>&1; then
  pass "marksman CLI works"
else
  fail "marksman CLI not working"
fi

if docker exec "$CONTAINER" sh -c 'marksman server </dev/null >/tmp/marksman.out 2>/tmp/marksman.err || true; grep -q "Starting Marksman LSP server" /tmp/marksman.err; status=$?; rm -f /tmp/marksman.out /tmp/marksman.err; exit $status' 2>/dev/null; then
  pass "marksman server mode initializes before EOF"
else
  fail "marksman server failed to start"
fi

if docker exec "$CONTAINER" brew --version >/dev/null 2>&1; then
  pass "Homebrew works"
else
  fail "Homebrew not working"
fi

if docker exec "$CONTAINER" sh -c 'command -v comment-checker >/dev/null 2>&1 && comment-checker --help >/dev/null 2>&1' 2>/dev/null; then
  pass "comment-checker CLI works"
else
  fail "comment-checker CLI not working"
fi

COMMENT_CHECKER_STATUS=$(docker exec "$CONTAINER" sh -c 'comment-checker </dev/null >/dev/null 2>&1; echo $?' 2>/dev/null || echo "1")
if [ "$COMMENT_CHECKER_STATUS" = "0" ]; then
  pass "comment-checker handles empty stdin gracefully"
else
  fail "comment-checker empty-stdin behavior failed (exit=$COMMENT_CHECKER_STATUS)"
fi

# --------------------------------------------------
# 8.1 CodeGraph (Knowledge Graph Tool)
# --------------------------------------------------
echo ""
echo "--- CodeGraph (Knowledge Graph) ---"

CODEGRAPH_CMD=$(docker exec "$CONTAINER" sh -c 'command -v codegraph' 2>/dev/null || echo "not_found")
if [ "$CODEGRAPH_CMD" != "not_found" ]; then
  pass "codegraph command available at $CODEGRAPH_CMD"
else
  fail "codegraph command not found"
fi

CODEGRAPH_HELP=$(docker exec "$CONTAINER" codegraph --help 2>/dev/null || echo "error")
if echo "$CODEGRAPH_HELP" | grep -q "Commands:"; then
  pass "codegraph --help works"
else
  fail "codegraph --help failed"
fi

# CodeGraph installs its agent configuration via MCP, not a SKILL.md file
# Check both `.mcp.codegraph` (entrypoint format) and `.mcpServers.codegraph` (codegraph install format)
if docker exec "$CONTAINER" sh -c 'jq -r ".mcp.codegraph // empty" /home/devuser/.config/opencode/opencode.json 2>/dev/null | grep -q "codegraph"'; then
  pass "codegraph MCP server configured in opencode.json (.mcp.codegraph)"
elif docker exec "$CONTAINER" sh -c 'jq -r ".mcpServers.codegraph // empty" /home/devuser/.config/opencode/opencode.json 2>/dev/null | grep -q "codegraph"'; then
  pass "codegraph MCP server configured in opencode.json (.mcpServers.codegraph - legacy)"
else
  # CodeGraph may store MCP config elsewhere (e.g., project-level .codegraph/)
  skip "codegraph MCP config not found in opencode.json (may be project-scoped)"
fi

# Playwright MCP — should be baked into the image for E2E browser-driven verification
if docker exec "$CONTAINER" sh -c 'jq -e ".mcp.playwright | type == \"object\"" /home/devuser/.config/opencode/opencode.json 2>/dev/null >/dev/null'; then
  pass "playwright MCP server configured in opencode.json"
else
  fail "playwright MCP server not configured in opencode.json"
fi

# The MCP command is invoked via the pw-mcp wrapper, which internally calls
# `bunx -y "@playwright/mcp@<version>"`. Verify the wrapper itself is installed
# and on PATH so the MCP can resolve to it.
if docker exec "$CONTAINER" sh -c 'command -v pw-mcp >/dev/null'; then
  pass "playwright MCP command resolves via pw-mcp wrapper on PATH"
else
  fail "pw-mcp wrapper not on PATH (playwright MCP cannot launch)"
fi

# --------------------------------------------------
# 8.2 LeanCTX (Context Runtime)
# --------------------------------------------------
echo ""
echo "--- LeanCTX (Context Runtime) ---"

assert_file_exists "lean-ctx config.toml exists" "/home/devuser/.config/lean-ctx/config.toml"
assert_file_exists "lean-ctx env.sh exists" "/home/devuser/.config/lean-ctx/env.sh"
assert_file_exists "lean-ctx shell hook exists" "/home/devuser/.config/lean-ctx/shell-hook.bash"
assert_file_exists "~/.bashenv exists" "/home/devuser/.bashenv"

LEAN_CTX_CONFIG=$(docker exec "$CONTAINER" sh -c 'cat /home/devuser/.config/lean-ctx/config.toml' 2>/dev/null || echo "")
assert_contains "lean-ctx config enables permission inheritance" 'permission_inheritance = "on"' "$LEAN_CTX_CONFIG"
assert_contains "lean-ctx config sets standard compression" 'compression_level = "standard"' "$LEAN_CTX_CONFIG"
assert_contains "lean-ctx config caps graph index" 'graph_index_max_files = 5000' "$LEAN_CTX_CONFIG"

BASHRC_CONTENT=$(docker exec "$CONTAINER" sh -c 'cat /home/devuser/.bashrc' 2>/dev/null || echo "")
assert_contains "~/.bashrc contains lean-ctx shell hook" 'lean-ctx shell hook' "$BASHRC_CONTENT"
assert_contains "~/.bashrc contains lean-ctx agent aliases" 'lean-ctx agent aliases' "$BASHRC_CONTENT"

BASHENV_CONTENT=$(docker exec "$CONTAINER" sh -c 'cat /home/devuser/.bashenv' 2>/dev/null || echo "")
assert_contains "~/.bashenv contains lean-ctx shell hook" 'lean-ctx shell hook' "$BASHENV_CONTENT"
assert_contains "~/.bashenv defines _lc hook" '_lc()' "$BASHENV_CONTENT"

BASH_ENV_VALUE=$(docker exec "$CONTAINER" sh -c 'printf "%s" "$BASH_ENV"' 2>/dev/null || echo "")
assert_eq "BASH_ENV points to lean-ctx env.sh" "/home/devuser/.config/lean-ctx/env.sh" "$BASH_ENV_VALUE"

CLAUDE_ENV_FILE_VALUE=$(docker exec "$CONTAINER" sh -c 'printf "%s" "$CLAUDE_ENV_FILE"' 2>/dev/null || echo "")
assert_eq "CLAUDE_ENV_FILE points to lean-ctx env.sh" "/home/devuser/.config/lean-ctx/env.sh" "$CLAUDE_ENV_FILE_VALUE"

NONINTERACTIVE_BASH_ENV=$(docker exec "$CONTAINER" sh -lc 'bash -c '\''printf "%s" "$BASH_ENV"'\''' 2>/dev/null || echo "")
assert_eq "non-interactive bash inherits BASH_ENV" "/home/devuser/.config/lean-ctx/env.sh" "$NONINTERACTIVE_BASH_ENV"

if docker exec "$CONTAINER" sh -c 'bash -c "test -f \"\$BASH_ENV\""' 2>/dev/null; then
  pass "non-interactive bash can resolve env.sh from BASH_ENV"
else
  fail "non-interactive bash cannot resolve env.sh from BASH_ENV"
fi

if docker exec "$CONTAINER" sh -c 'jq -e ".mcp[\"lean-ctx\"] | type == \"object\"" /home/devuser/.config/opencode/opencode.json >/dev/null 2>&1'; then
  pass "lean-ctx MCP configured in opencode.json"
else
  fail "lean-ctx MCP not configured in opencode.json"
fi

OPENCODE_MCP_LIST=$(docker exec "$CONTAINER" sh -c 'opencode mcp list' 2>/dev/null || echo "")
assert_contains "opencode mcp list includes lean-ctx" 'lean-ctx' "$OPENCODE_MCP_LIST"
assert_contains "opencode mcp list shows lean-ctx connected" 'connected' "$OPENCODE_MCP_LIST"

if docker exec "$CONTAINER" sh -c 'lean-ctx config validate >/dev/null 2>&1'; then
  pass "lean-ctx config validate passes"
else
  fail "lean-ctx config validate failed"
fi

LEAN_CTX_DOCTOR=$(docker exec "$CONTAINER" sh -c 'lean-ctx doctor' 2>/dev/null || echo "")
assert_contains "lean-ctx doctor sees config.toml" 'config.toml' "$LEAN_CTX_DOCTOR"
assert_contains "lean-ctx doctor reports permission inheritance on" 'Permission inheritance' "$LEAN_CTX_DOCTOR"
assert_contains "lean-ctx doctor reports shell aliases" 'Shell aliases' "$LEAN_CTX_DOCTOR"
assert_contains "lean-ctx doctor reports BASH_ENV set" 'BASH_ENV' "$LEAN_CTX_DOCTOR"
assert_contains "lean-ctx doctor reports CLAUDE_ENV_FILE set" 'CLAUDE_ENV_FILE' "$LEAN_CTX_DOCTOR"

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
# 10. Playwright & Chromium 實機驗證
# --------------------------------------------------
echo ""
echo "--- Playwright / Chromium ---"

PLAYWRIGHT_VERSION=$(docker exec "$CONTAINER" sh -c 'echo "${PLAYWRIGHT_VERSION}"' 2>/dev/null || echo "unknown")
if docker exec "$CONTAINER" sh -c 'bunx -y "playwright@${PLAYWRIGHT_VERSION}" --version' >/dev/null 2>&1; then
  pass "playwright ${PLAYWRIGHT_VERSION} CLI works"
else
  fail "playwright CLI not available (expected version: ${PLAYWRIGHT_VERSION})"
fi

PLAYWRIGHT_MCP_VERSION=$(docker exec "$CONTAINER" sh -c 'echo "${PLAYWRIGHT_MCP_VERSION}"' 2>/dev/null || echo "unknown")
if docker exec "$CONTAINER" sh -c 'bunx -y "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" --help' >/dev/null 2>&1; then
  pass "@playwright/mcp ${PLAYWRIGHT_MCP_VERSION} CLI works"
else
  fail "@playwright/mcp CLI not available (expected version: ${PLAYWRIGHT_MCP_VERSION})"
fi

CHROMIUM_BIN=$(docker exec "$CONTAINER" sh -c 'find /ms-playwright -type f -name chrome -path "*/chrome-linux64/*" 2>/dev/null | head -1')
if [ -n "$CHROMIUM_BIN" ]; then
  pass "chromium binary exists at ${CHROMIUM_BIN}"
else
  fail "chromium binary not found in /ms-playwright"
fi

if docker exec "$CONTAINER" sh -c '
  CHROME=$(find /ms-playwright -type f -name chrome -path "*/chrome-linux64/*" 2>/dev/null | head -1)
  [ -n "$CHROME" ] && timeout 5 "$CHROME" --headless --no-sandbox --disable-gpu --dump-dom about:blank 2>/dev/null | grep -q "html"
'; then
  pass "chromium launches headless successfully"
else
  fail "chromium failed to launch headless"
fi

if docker exec "$CONTAINER" sh -c 'command -v pw-mcp >/dev/null && [ -x "$(command -v pw-mcp)" ]'; then
  pass "pw-mcp wrapper is installed and executable"
else
  fail "pw-mcp wrapper not found in PATH"
fi

CONFIG_PW_CMD=$(docker exec "$CONTAINER" sh -c 'jq -r ".mcp.playwright.command | join(\" \")" /home/devuser/.config/opencode/opencode.json 2>/dev/null')
if [ "$CONFIG_PW_CMD" = "pw-mcp" ]; then
  pass "opencode.json mcp.playwright uses pw-mcp wrapper"
else
  fail "opencode.json mcp.playwright command is '${CONFIG_PW_CMD}', expected 'pw-mcp'"
fi

WRAPPER_VERSION=$(docker exec "$CONTAINER" sh -c 'grep -oP "@playwright/mcp@\K[^\"]+" /usr/local/bin/pw-mcp 2>/dev/null | head -1')
if [ "$WRAPPER_VERSION" = "$PLAYWRIGHT_MCP_VERSION" ]; then
  pass "pw-mcp wrapper pins @playwright/mcp@${WRAPPER_VERSION}"
else
  fail "pw-mcp wrapper version (${WRAPPER_VERSION}) != PLAYWRIGHT_MCP_VERSION (${PLAYWRIGHT_MCP_VERSION})"
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
