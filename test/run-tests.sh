#!/usr/bin/env bash
set -uo pipefail

# ============================================================
# OpenChamber Integration Test Script
# Usage: ./test/run-tests.sh [container_name]
# Note: Using set -u instead of -e because curl failures are expected
# ============================================================

# Resolve the ai-dev container: prefer the legacy name (matches dev setups),
# then fall back to the compose service label, which survives container_name
# overrides such as CI's "ci-test". A positional arg still wins.
CONTAINER="${1:-ai-engkit-dev}"
if [ "$CONTAINER" = "ai-engkit-dev" ] && ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER"; then
  CONTAINER="$(docker ps --filter 'label=com.docker.compose.project=dev' --filter 'label=com.docker.compose.service=ai-dev' --filter 'status=running' --format '{{.Names}}' 2>/dev/null | head -n 1)"
fi
CONTAINER="${CONTAINER:-ai-engkit-dev}"
CHAMBER_PORT="${CHAMBER_DEV_PORT:-8001}"
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

if [ -z "$CONTAINER" ]; then
  fail "no ai-dev container selected (expected a running container in Compose project 'dev')"
  exit 1
fi
COMPOSE_PROJECT="$(docker inspect "$CONTAINER" --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null || true)"
if [ -z "$COMPOSE_PROJECT" ]; then
  fail "cannot read Compose project label for container '$CONTAINER'; refusing to test an unknown container"
  exit 1
fi
if [ "$COMPOSE_PROJECT" != "dev" ]; then
  fail "refusing to test non-dev Compose project '$COMPOSE_PROJECT'"
  exit 1
fi

AUTHORITY_GUIDANCE_TEST="$(dirname "${BASH_SOURCE[0]}")/authority-guidance.test.sh"
if [ -x "$AUTHORITY_GUIDANCE_TEST" ] && "$AUTHORITY_GUIDANCE_TEST" >/dev/null 2>&1; then
  pass "repository and generated AGENTS authority guidance agree"
else
  fail "repository and generated AGENTS authority guidance disagree"
fi

ENTRYPOINT_SYNC_TEST="$(dirname "${BASH_SOURCE[0]}")/../entrypoint.d/02-init-config.test.sh"
if [ -x "$ENTRYPOINT_SYNC_TEST" ] && BASH_ENV=/dev/null CLAUDE_ENV_FILE= bash --noprofile --norc "$ENTRYPOINT_SYNC_TEST" >/dev/null 2>&1; then
  pass "AGENTS synchronization marker tests pass"
else
  fail "AGENTS synchronization marker tests failed"
fi

if docker exec "$CONTAINER" test ! -e /entrypoint.d/02-init-config.test.sh 2>/dev/null; then
  pass "runtime image excludes entrypoint test helpers"
else
  fail "runtime image executes host-only entrypoint test helpers"
fi

LSP_MCP_CONFIG_TEST="$(dirname "${BASH_SOURCE[0]}")/test-lsp-mcp-config.sh"
if [ "${RUN_AGENTS_TESTS_ONLY:-0}" = "1" ]; then
  exit "$FAIL"
fi

if [ -x "$LSP_MCP_CONFIG_TEST" ] && "$LSP_MCP_CONFIG_TEST" >/dev/null 2>&1; then
  pass "lsp MCP config and tools/list smoke tests pass"
else
  fail "lsp MCP config and tools/list smoke tests failed"
fi

RELIABILITY_GATE_TEST="$(dirname "${BASH_SOURCE[0]}")/leanctx-reliability-gate.sh"
if [ -x "$RELIABILITY_GATE_TEST" ] && "$RELIABILITY_GATE_TEST" --selfcheck >/dev/null 2>&1; then
  pass "lean-ctx reliability selfcheck passes"
else
  fail "lean-ctx reliability selfcheck failed"
fi

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
  if echo "$haystack" | grep "$needle" >/dev/null; then
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
  # Fallback: test from inside container
  INTERNAL_CODE=$(timeout 10 docker exec "$CONTAINER" sh -c 'curl -sf -o /dev/null -w "%{http_code}" http://localhost:3000/' 2>/dev/null)
  if [ -z "$INTERNAL_CODE" ]; then
    INTERNAL_CODE="000"
  fi
  if [ "$INTERNAL_CODE" = "200" ]; then
    pass "Web UI responds 200 (internal fallback)"
    HTML=$(timeout 10 docker exec "$CONTAINER" sh -c 'curl -sf http://localhost:3000/' 2>/dev/null || echo "")
    assert_contains "Web UI returns HTML (internal fallback)" "<!doctype html>" "$HTML"
  else
    fail "Web UI not accessible (external: 000, internal: $INTERNAL_CODE)"
  fi
else
  fail "Web UI returned HTTP $HTTP_CODE (expected 200)"
fi

# --------------------------------------------------
# 6.1 OpenChamber Static Assets
# --------------------------------------------------
echo ""
echo "--- OpenChamber Static Assets ---"

OPENCHAMBER_LOG="/home/devuser/.config/openchamber/logs/openchamber-3000.log"
NOTFOUND_BEFORE=$(docker exec "$CONTAINER" sh -c \
  "grep -c 'NotFoundError' '$OPENCHAMBER_LOG' 2>/dev/null || true")

for asset in /favicon.ico /favicon.svg /favicon-32.png /site.webmanifest; do
  ASSET_CODE=$(docker exec "$CONTAINER" sh -c \
    "curl -sf -o /dev/null -w '%{http_code}' 'http://localhost:3000${asset}'" 2>/dev/null || echo "000")
  if [ "$ASSET_CODE" = "200" ]; then
    pass "OpenChamber ${asset} served (200)"
  else
    fail "OpenChamber ${asset} returned ${ASSET_CODE} (expected 200)"
  fi
done

sleep 1
NOTFOUND_AFTER=$(docker exec "$CONTAINER" sh -c \
  "grep -c 'NotFoundError' '$OPENCHAMBER_LOG' 2>/dev/null || true")
if [ "${NOTFOUND_AFTER:-0}" -le "${NOTFOUND_BEFORE:-0}" ]; then
  pass "No new OpenChamber NotFoundError entries"
else
  fail "OpenChamber NotFoundError increased (${NOTFOUND_BEFORE} -> ${NOTFOUND_AFTER})"
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
# 8.1b LSP MCP bridge + native Exa websearch
# --------------------------------------------------
echo ""
echo "--- LSP MCP Bridge / Native Websearch ---"

# Restored OMO LSP bridge, separate from the native `lsp` block.
if docker exec "$CONTAINER" sh -c 'jq -e ".mcp.lsp.type == \"local\" and .mcp.lsp.enabled == true" /home/devuser/.config/opencode/opencode.json >/dev/null 2>&1'; then
  pass "lsp MCP server configured in opencode.json (.mcp.lsp)"
else
  fail "lsp MCP server not configured in opencode.json"
fi

assert_file_exists "vendored lsp bridge CLI in image" "/opt/ai-engkit/vendor/lsp-daemon/dist/cli.js"

LSP_MCP_COMMAND=$(docker exec "$CONTAINER" sh -c 'jq -r ".mcp.lsp.command | join(\" \")" /home/devuser/.config/opencode/opencode.json 2>/dev/null')
if [ "$LSP_MCP_COMMAND" = "node /opt/ai-engkit/vendor/lsp-daemon/dist/cli.js mcp" ]; then
  pass "lsp MCP uses the vendored absolute command"
else
  fail "lsp MCP command is '${LSP_MCP_COMMAND}', expected the vendored absolute path"
fi

if docker exec "$CONTAINER" sh -c 'jq -e ".mcp.lsp.command[1] | (startswith(\"/\") and (contains(\"/.cache/\") | not))" /home/devuser/.config/opencode/opencode.json >/dev/null 2>&1'; then
  pass "lsp MCP command is absolute and not cache-relative"
else
  fail "lsp MCP command is not an absolute non-cache path"
fi

if docker exec "$CONTAINER" sh -c 'jq -e ".lsp.marksman.command[0] == \"marksman\"" /home/devuser/.config/opencode/opencode.json >/dev/null 2>&1'; then
  pass "native lsp block preserved alongside mcp.lsp"
else
  fail "native lsp block missing from opencode.json"
fi

if docker exec "$CONTAINER" sh -c 'jq -e ".permission.websearch == \"allow\"" /home/devuser/.config/opencode/opencode.json >/dev/null 2>&1'; then
  pass "permission.websearch is allow in opencode.json"
else
  fail "permission.websearch is not allow in opencode.json"
fi

if docker exec "$CONTAINER" sh -c 'jq -e ".mcp | has(\"websearch\") | not" /home/devuser/.config/opencode/opencode.json >/dev/null 2>&1'; then
  pass "websearch is not registered as an MCP block"
else
  fail "websearch must not be an MCP block"
fi

EXA_ENV=$(docker exec "$CONTAINER" sh -c 'printf "%s" "${OPENCODE_ENABLE_EXA:-}"' 2>/dev/null || echo "")
assert_eq "OPENCODE_ENABLE_EXA is passed into ai-dev" "1" "$EXA_ENV"

LSP_MCP_TOOLS=$(docker exec "$CONTAINER" sh -c '
  {
    printf "%s\n" "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"clientInfo\":{\"name\":\"ai-engkit-tests\",\"version\":\"1.0\"}}}"
    printf "%s\n" "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}"
    sleep 1
    printf "%s\n" "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\",\"params\":{}}"
    sleep 2
  } | timeout 20 node /opt/ai-engkit/vendor/lsp-daemon/dist/cli.js mcp 2>/dev/null
' 2>/dev/null)
for tool in diagnostics goto_definition find_references symbols prepare_rename rename; do
  assert_contains "lsp MCP tools/list exposes $tool" "\"name\":\"$tool\"" "$LSP_MCP_TOOLS"
done

# --------------------------------------------------
# 8.2 LeanCTX (Context Runtime)
# --------------------------------------------------
echo ""
echo "--- LeanCTX (Context Runtime) ---"

assert_file_exists "lean-ctx config.toml exists" "/home/devuser/.config/lean-ctx/config.toml"
assert_file_exists "lean-ctx env.sh exists" "/home/devuser/.config/lean-ctx/env.sh"
assert_file_exists "lean-ctx shell hook exists" "/home/devuser/.config/lean-ctx/shell-hook.bash"
assert_file_exists "~/.bashenv exists" "/home/devuser/.bashenv"

LEAN_CTX_VERSION_OUT=$(docker exec "$CONTAINER" sh -c 'lean-ctx --version' 2>/dev/null || echo "")
EXPECTED_LEAN_CTX_VERSION=$(docker exec "$CONTAINER" sh -c 'printf "%s" "$LEANCTX_VERSION"' 2>/dev/null || echo "")
if [ -n "$EXPECTED_LEAN_CTX_VERSION" ]; then
  assert_contains "lean-ctx --version reports $EXPECTED_LEAN_CTX_VERSION" "$EXPECTED_LEAN_CTX_VERSION" "$LEAN_CTX_VERSION_OUT"
else
  if echo "$LEAN_CTX_VERSION_OUT" | grep -qE '[0-9]+\.[0-9]+\.[0-9]+'; then
    pass "lean-ctx --version reports a valid version ($LEAN_CTX_VERSION_OUT)"
  else
    fail "lean-ctx --version did not return a valid version"
  fi
fi

LEAN_CTX_CONFIG=$(docker exec "$CONTAINER" sh -c 'cat /home/devuser/.config/lean-ctx/config.toml' 2>/dev/null || echo "")
LEAN_CTX_BASELINE_CONFIG=$(docker exec "$CONTAINER" sh -c 'cat /etc/lean-ctx/config.default.toml' 2>/dev/null || echo "")
assert_contains "lean-ctx config enables permission inheritance" 'permission_inheritance = "on"' "$LEAN_CTX_CONFIG"
assert_contains "lean-ctx config sets lite compression" 'compression_level = "lite"' "$LEAN_CTX_CONFIG"
assert_contains "lean-ctx config enables secret detection" 'secret_detection.enabled = true' "$LEAN_CTX_CONFIG"
assert_contains "lean-ctx config enables secret redaction" 'secret_detection.redact = true' "$LEAN_CTX_CONFIG"
if echo "$LEAN_CTX_CONFIG" | grep '^cognitive_mode[[:space:]]*=' >/dev/null; then
  fail "lean-ctx config contains inert cognitive mode"
else
  pass "lean-ctx config omits inert cognitive mode"
fi
assert_contains "lean-ctx runtime config retains a graph index cap" 'graph_index_max_files = ' "$LEAN_CTX_CONFIG"
assert_contains "lean-ctx baseline caps graph index at 5000" 'graph_index_max_files = 5000' "$LEAN_CTX_BASELINE_CONFIG"

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

MCP_TOOLS=$(docker exec -i "$CONTAINER" python3 - <<'PY' 2>/dev/null
import json
import select
import subprocess

process = subprocess.Popen(
    ["lean-ctx"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.DEVNULL,
)

def send(message):
    payload = json.dumps(message, separators=(",", ":")).encode()
    process.stdin.write(f"Content-Length: {len(payload)}\r\n\r\n".encode() + payload)
    process.stdin.flush()

def receive():
    ready, _, _ = select.select([process.stdout], [], [], 10)
    if not ready:
        raise TimeoutError("timed out waiting for lean-ctx MCP response")
    headers = b""
    while b"\r\n\r\n" not in headers:
        byte = process.stdout.read(1)
        if not byte:
            raise RuntimeError("lean-ctx exited before MCP response")
        headers += byte
    length = next(
        int(line.split(b":", 1)[1])
        for line in headers.split(b"\r\n")
        if line.lower().startswith(b"content-length:")
    )
    return json.loads(process.stdout.read(length))

try:
    send({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "ai-engkit-test", "version": "1.0"},
        },
    })
    receive()
    send({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})
    send({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
    response = receive()
    for tool in response["result"]["tools"]:
        print(tool["name"])
finally:
    process.terminate()
PY
)
assert_contains "lean-ctx MCP exposes ctx_read" $'\nctx_read\n' "\n$MCP_TOOLS\n"
assert_contains "lean-ctx MCP exposes ctx_shell" $'\nctx_shell\n' "\n$MCP_TOOLS\n"
assert_contains "lean-ctx MCP exposes ctx_compose" $'\nctx_compose\n' "\n$MCP_TOOLS\n"

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
# 8.3 OMO Unified Agent Permissions
# --------------------------------------------------
echo ""
echo "--- OMO Unified Agent Permissions ---"

# 8.3.1 Default file in image
assert_file_exists "oh-my-opencode-slim.json.default in /etc/opencode" "/etc/opencode/oh-my-opencode-slim.json.default"

# 8.3.2 Runtime config in user opencode config directory
OMO_CONFIG_FILE="/home/devuser/.config/opencode/oh-my-opencode-slim.json"
assert_file_exists "oh-my-opencode-slim.json in user config directory" "$OMO_CONFIG_FILE"

if docker exec "$CONTAINER" test ! -f /home/devuser/.config/opencode/oh-my-openagent.json 2>/dev/null; then
  pass "legacy oh-my-openagent.json is not an active config"
else
  fail "legacy oh-my-openagent.json remains active"
fi

OMO_PLUGIN=$(docker exec "$CONTAINER" jq -r '.plugin[] | select(startswith("oh-my-opencode-slim@"))' /home/devuser/.config/opencode/opencode.json 2>/dev/null || echo "")
OMO_VERSION=$(docker exec "$CONTAINER" sh -c 'printf "%s" "$OH_MY_OPENCODE_SLIM_VERSION"' 2>/dev/null || echo "")
if [[ "$OMO_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; then
  pass "OMO runtime version is pinned ($OMO_VERSION)"
else
  fail "OMO runtime version is not an exact semver ('$OMO_VERSION')"
fi
assert_eq "OMO plugin declaration matches runtime pin" "oh-my-opencode-slim@$OMO_VERSION" "$OMO_PLUGIN"

# 8.3.3 All slim agents present (preset agents + top-level overrides)
OMO_AGENTS=$(docker exec "$CONTAINER" jq -r '((.presets["opencode-go"] // {} | keys) + (.agents // {} | keys) | unique | join(","))' "$OMO_CONFIG_FILE" 2>/dev/null || echo "")
assert_contains "orchestrator agent defined" 'orchestrator' "$OMO_AGENTS"
assert_contains "explorer agent defined"    'explorer'      "$OMO_AGENTS"
assert_contains "librarian agent defined"   'librarian'     "$OMO_AGENTS"
assert_contains "oracle agent defined"      'oracle'        "$OMO_AGENTS"
assert_contains "designer agent defined"    'designer'      "$OMO_AGENTS"
assert_contains "fixer agent defined"       'fixer'         "$OMO_AGENTS"
assert_contains "observer agent defined"    'observer'      "$OMO_AGENTS"

# 8.3.4 Runtime config uses schema-valid tools and no stale migration layer
OMO_PERMISSION_COUNT=$(docker exec "$CONTAINER" jq '[.agents[] | select(has("permission"))] | length' "$OMO_CONFIG_FILE" 2>/dev/null || echo "")
OMO_STALE_AGENT_LAYER=$(docker exec "$CONTAINER" jq '.["[opencode]"] | type == "object" and has("agents")' "$OMO_CONFIG_FILE" 2>/dev/null || echo "")
assert_eq "OMO agents contain no unsupported permission keys" "0" "$OMO_PERMISSION_COUNT"
assert_eq "OMO config contains no stale [opencode].agents layer" "false" "$OMO_STALE_AGENT_LAYER"

# 8.3.8 Only allowlisted native agents may be generated inline
OPCODE_UNEXPECTED_AGENTS=$(docker exec "$CONTAINER" jq -r '[(.agent // {}) | keys[] | select((. != "general") and (. != "plan"))] | join(",")' /home/devuser/.config/opencode/opencode.json 2>/dev/null || echo "")
assert_eq "opencode.json has no unexpected inline agents" "" "$OPCODE_UNEXPECTED_AGENTS"
# Reconcile runs after openchamber serve (provider 120s + lifecycle 120s + 3x30s retry + 60s deferred; observed 9m43s in CI); allow eventual consistency up to 300s.
for _ in $(seq 1 60); do
  OMO_GENERAL_MODEL=$(docker exec "$CONTAINER" jq -r '.agents.general.model // empty' "$OMO_CONFIG_FILE" 2>/dev/null || echo "")
  OPCODE_GENERAL_MODEL=$(docker exec "$CONTAINER" jq -r '.agent.general.model // empty' /home/devuser/.config/opencode/opencode.json 2>/dev/null || echo "")
  if [ "$OMO_GENERAL_MODEL" = "$OPCODE_GENERAL_MODEL" ]; then break; fi
  echo "  waiting for native bridge sync: OMO='$OMO_GENERAL_MODEL' OPCODE='$OPCODE_GENERAL_MODEL' (attempt $_/60)" >&2
  sleep 5
done
assert_eq "general native model matches persisted OMO override" "$OMO_GENERAL_MODEL" "$OPCODE_GENERAL_MODEL"

# --------------------------------------------------
# 8.4 Superpowers (per-project only)
# --------------------------------------------------
# Superpowers is no longer globally enabled; it is a per-project feature
# managed from the admin Projects drawer.  Only verify the baked image
# still ships the plugin source so per-project enablement can symlink it.
if docker exec "$CONTAINER" sh -c 'test -d /opt/opencode/baked-plugins/superpowers/skills' 2>/dev/null; then
  pass "superpowers baked plugin source present for per-project enablement"
else
  fail "superpowers baked plugin source missing (per-project enablement broken)"
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
if docker exec "$CONTAINER" playwright --version >/dev/null 2>&1; then
  pass "playwright ${PLAYWRIGHT_VERSION} CLI works"
else
  fail "playwright CLI not available (expected version: ${PLAYWRIGHT_VERSION})"
fi

PLAYWRIGHT_MCP_VERSION=$(docker exec "$CONTAINER" sh -c 'echo "${PLAYWRIGHT_MCP_VERSION}"' 2>/dev/null || echo "unknown")
if docker exec "$CONTAINER" playwright-mcp --help >/dev/null 2>&1; then
  pass "@playwright/mcp ${PLAYWRIGHT_MCP_VERSION} CLI works"
else
  fail "@playwright/mcp CLI not available (expected version: ${PLAYWRIGHT_MCP_VERSION})"
fi

MCP_OUTPUT=$(docker exec "$CONTAINER" sh -c '
  {
    printf "%s\\n" "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"clientInfo\":{\"name\":\"ai-engkit-tests\",\"version\":\"1.0\"}}}"
    sleep 1
    printf "%s\\n" "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}"
    sleep 1
    printf "%s\\n" "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"browser_navigate\",\"arguments\":{\"url\":\"about:blank\"}}}"
    sleep 5
  } | timeout 20 pw-mcp 2>/dev/null
' 2>/dev/null)
if echo "$MCP_OUTPUT" | grep -q '"id":2' && ! echo "$MCP_OUTPUT" | grep -q '"isError":true'; then
  pass "MCP JSON-RPC browser_navigate succeeds"
else
  fail "MCP JSON-RPC browser_navigate failed"
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

WRAPPER_VERSION=$(docker exec "$CONTAINER" sh -c 'playwright-mcp --version 2>/dev/null' | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
if [ "$WRAPPER_VERSION" = "$PLAYWRIGHT_MCP_VERSION" ]; then
  pass "pw-mcp wrapper pins @playwright/mcp@${WRAPPER_VERSION}"
else
  fail "pw-mcp wrapper version (${WRAPPER_VERSION}) != PLAYWRIGHT_MCP_VERSION (${PLAYWRIGHT_MCP_VERSION})"
fi

# --------------------------------------------------
# 11. SSH Agent
# --------------------------------------------------
echo ""
echo "--- SSH Agent ---"

assert_file_exists "ssh-agent environment exists" "/home/devuser/.ssh/agent.env"
if docker exec "$CONTAINER" sh -c '. /home/devuser/.ssh/agent.env && test -S "$SSH_AUTH_SOCK"' 2>/dev/null; then
  pass "ssh-agent socket is live"
else
  fail "ssh-agent socket is not live"
fi

if docker exec "$CONTAINER" sh -c '. /home/devuser/.ssh/agent.env && ssh-add -l >/dev/null 2>&1; status=$?; test "$status" -eq 0 || test "$status" -eq 1' 2>/dev/null; then
  SSH_ADD_STATUS=0
else
  SSH_ADD_STATUS=1
fi
assert_eq "ssh-add can query agent" "0" "$SSH_ADD_STATUS"

AGENT_LOGS=$(docker logs "$CONTAINER" 2>/dev/null || echo "")
assert_contains "startup reports SSH-agent reload" "SSH agent:" "$AGENT_LOGS"

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
