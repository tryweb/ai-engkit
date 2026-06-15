#!/usr/bin/env bash
set -uo pipefail

CONTAINER="${1:-codeforge-dev}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}PASS${NC} $1"; }
fail() { echo -e "  ${RED}FAIL${NC} $1"; }
info() { echo -e "  ${YELLOW}INFO${NC} $1"; }

EXIT_CODE=0
TEST_MEMORY_ID=""
TEST_TIMESTAMP=$(date +%s)
TEST_TEXT="E2E_HOOK_TEST_${TEST_TIMESTAMP} - This is a test memory stored via plugin hooks for E2E verification"

echo "============================================"
echo " Memory Plugin E2E Test"
echo " Container: $CONTAINER"
echo " Date: $(date '+%Y-%m-%d %H:%M:%S')"
echo "============================================"

echo ""
echo "--- Container Status ---"
STATUS=$(docker exec "$CONTAINER" sh -c 'echo $HOME' 2>/dev/null || echo "")
if [ -n "$STATUS" ]; then
  pass "Container is accessible (HOME=$STATUS)"
else
  fail "Container is not accessible"
  exit 1
fi

echo ""
echo "--- opencode CLI ---"
OPCODE_VER=$(docker exec "$CONTAINER" opencode --version 2>/dev/null || echo "error")
if [ "$OPCODE_VER" != "error" ] && [ -n "$OPCODE_VER" ]; then
  pass "opencode CLI available ($OPCODE_VER)"
else
  fail "opencode CLI not found in container"
  EXIT_CODE=1
fi

echo ""
echo "--- Plugin Configuration ---"
ENV_PLUGINS=$(docker exec "$CONTAINER" sh -c 'echo $OPENCODE_PLUGINS' 2>/dev/null || echo "")
if [ -n "$ENV_PLUGINS" ] && echo "$ENV_PLUGINS" | grep -q "lancedb-opencode-pro"; then
  pass "OPENCODE_PLUGINS includes lancedb-opencode-pro"
else
  fail "OPENCODE_PLUGINS missing lancedb-opencode-pro"
  EXIT_CODE=1
fi

PLUGIN_CONFIG=$(docker exec "$CONTAINER" sh -c \
  'jq -r ".plugin | join(\",\")" ~/.config/opencode/opencode.json 2>/dev/null' || echo "")
if [ -n "$PLUGIN_CONFIG" ] && echo "$PLUGIN_CONFIG" | grep -q "lancedb-opencode-pro"; then
  pass "lancedb-opencode-pro registered in opencode.json"
else
  fail "lancedb-opencode-pro NOT in opencode.json"
  EXIT_CODE=1
fi



echo ""
echo "--- Plugin Hook Load Test ---"
PLUGIN_LOAD=$(docker exec "$CONTAINER" bash -c 'bun -e "
import plugin from \"/home/devuser/.cache/opencode/packages/lancedb-opencode-pro@latest/node_modules/lancedb-opencode-pro/dist/index.js\";
const hooks = await plugin({
  client: {
    config: { get() { return { memory: { provider: \"lancedb-opencode-pro\", dbPath: \"/home/devuser/.opencode/memory/lancedb\" } }; } },
    session: { messages() { return []; }, get() { return { directory: \"/workspace\" }; } },
  },
  project: { id: \"proj-test\", worktree: \"/workspace\", vcs: \"git\", time: { created: Date.now() } },
  directory: \"/workspace\",
  worktree: \"/workspace\",
  serverUrl: new URL(\"http://localhost:4096\"),
  \$: () => { throw new Error(\"shell not needed\"); },
});
console.log(JSON.stringify({ loaded: true, tools: Object.keys(hooks.tool || {}) }));
" 2>&1')

if echo "$PLUGIN_LOAD" | grep -q '"loaded":true'; then
  pass "Plugin hooks loaded successfully"
  TOOL_COUNT=$(echo "$PLUGIN_LOAD" | grep -o '"memory_remember"' | wc -l)
  if [ "$TOOL_COUNT" -gt 0 ]; then
    pass "memory_remember tool available"
  else
    fail "memory_remember tool not found"
    EXIT_CODE=1
  fi
else
  fail "Plugin hooks failed to load"
  EXIT_CODE=1
fi

echo ""
echo "--- Test: memory_remember via Hook ---"
if [ $EXIT_CODE -eq 0 ]; then
  MEMORY_RESULT=$(docker exec "$CONTAINER" bash -c 'bun -e "
import plugin from \"/home/devuser/.cache/opencode/packages/lancedb-opencode-pro@latest/node_modules/lancedb-opencode-pro/dist/index.js\";
const hooks = await plugin({
  client: {
    config: { get() { return { memory: { provider: \"lancedb-opencode-pro\", dbPath: \"/home/devuser/.opencode/memory/lancedb\" } }; } },
    session: { messages() { return []; }, get() { return { directory: \"/workspace\" }; } },
  },
  project: { id: \"proj-test\", worktree: \"/workspace\", vcs: \"git\", time: { created: Date.now() } },
  directory: \"/workspace\",
  worktree: \"/workspace\",
  serverUrl: new URL(\"http://localhost:4096\"),
  \$: () => { throw new Error(\"shell not needed\"); },
});
const ctx = { sessionID: \"test\", messageID: \"msg\", agent: \"general\", directory: \"/workspace\", worktree: \"/workspace\", abort: new AbortController().signal, metadata() {}, async ask() {} };
const result = await hooks.tool.memory_remember.execute({ text: process.argv[1], category: \"testing\" }, ctx);
console.log(result);
" -- "'"$TEST_TEXT"'"' 2>&1)
  
  if echo "$MEMORY_RESULT" | grep -q "Stored memory"; then
    TEST_MEMORY_ID=$(echo "$MEMORY_RESULT" | grep -oE '[a-f0-9-]{36}' | head -1)
    pass "memory_remember executed successfully"
    info "Memory ID: $TEST_MEMORY_ID"
  elif echo "$MEMORY_RESULT" | grep -q "too short"; then
    fail "memory_remember failed: content too short (need >= 80 chars)"
    EXIT_CODE=1
  else
    fail "memory_remember failed: $MEMORY_RESULT"
    EXIT_CODE=1
  fi
fi

echo ""
echo "--- Test: memory_search via Hook ---"
if [ $EXIT_CODE -eq 0 ]; then
  SEARCH_RESULT=$(docker exec "$CONTAINER" bash -c 'bun -e "
import plugin from \"/home/devuser/.cache/opencode/packages/lancedb-opencode-pro@latest/node_modules/lancedb-opencode-pro/dist/index.js\";
const hooks = await plugin({
  client: {
    config: { get() { return { memory: { provider: \"lancedb-opencode-pro\", dbPath: \"/home/devuser/.opencode/memory/lancedb\" } }; } },
    session: { messages() { return []; }, get() { return { directory: \"/workspace\" }; } },
  },
  project: { id: \"proj-test\", worktree: \"/workspace\", vcs: \"git\", time: { created: Date.now() } },
  directory: \"/workspace\",
  worktree: \"/workspace\",
  serverUrl: new URL(\"http://localhost:4096\"),
  \$: () => { throw new Error(\"shell not needed\"); },
});
const ctx = { sessionID: \"test\", messageID: \"msg\", agent: \"general\", directory: \"/workspace\", worktree: \"/workspace\", abort: new AbortController().signal, metadata() {}, async ask() {} };
const result = await hooks.tool.memory_search.execute({ query: \"E2E_HOOK_TEST\", limit: 5 }, ctx);
console.log(result.includes(\"E2E_HOOK_TEST\") ? \"FOUND\" : \"NOT_FOUND\");
" 2>&1')
  
  if echo "$SEARCH_RESULT" | grep -q "FOUND"; then
    pass "memory_search found the stored memory"
  elif echo "$SEARCH_RESULT" | grep -q "NOT_FOUND"; then
    fail "memory_search did not find the stored memory"
    EXIT_CODE=1
  else
    fail "memory_search failed: $SEARCH_RESULT"
    EXIT_CODE=1
  fi
fi

echo ""
echo "--- Test: memory_stats via Hook ---"
if [ $EXIT_CODE -eq 0 ]; then
  STATS_RESULT=$(docker exec "$CONTAINER" bash -c 'bun -e "
import plugin from \"/home/devuser/.cache/opencode/packages/lancedb-opencode-pro@latest/node_modules/lancedb-opencode-pro/dist/index.js\";
const hooks = await plugin({
  client: {
    config: { get() { return { memory: { provider: \"lancedb-opencode-pro\", dbPath: \"/home/devuser/.opencode/memory/lancedb\" } }; } },
    session: { messages() { return []; }, get() { return { directory: \"/workspace\" }; } },
  },
  project: { id: \"proj-test\", worktree: \"/workspace\", vcs: \"git\", time: { created: Date.now() } },
  directory: \"/workspace\",
  worktree: \"/workspace\",
  serverUrl: new URL(\"http://localhost:4096\"),
  \$: () => { throw new Error(\"shell not needed\"); },
});
const ctx = { sessionID: \"test\", messageID: \"msg\", agent: \"general\", directory: \"/workspace\", worktree: \"/workspace\", abort: new AbortController().signal, metadata() {}, async ask() {} };
const result = await hooks.tool.memory_stats.execute({}, ctx);
console.log(result);
" 2>&1')
  
  if echo "$STATS_RESULT" | grep -q "lancedb-opencode-pro"; then
    pass "memory_stats returned valid response"
    if echo "$STATS_RESULT" | grep -q '"status":"healthy"'; then
      info "Embedder health: healthy"
    fi
  else
    fail "memory_stats failed: $STATS_RESULT"
    EXIT_CODE=1
  fi
fi

echo ""
echo "--- Cleanup Test Memory ---"
if [ -n "$TEST_MEMORY_ID" ]; then
  CLEANUP_RESULT=$(docker exec "$CONTAINER" bash -c 'bun -e "
import plugin from \"/home/devuser/.cache/opencode/packages/lancedb-opencode-pro@latest/node_modules/lancedb-opencode-pro/dist/index.js\";
const hooks = await plugin({
  client: {
    config: { get() { return { memory: { provider: \"lancedb-opencode-pro\", dbPath: \"/home/devuser/.opencode/memory/lancedb\" } }; } },
    session: { messages() { return []; }, get() { return { directory: \"/workspace\" }; } },
  },
  project: { id: \"proj-test\", worktree: \"/workspace\", vcs: \"git\", time: { created: Date.now() } },
  directory: \"/workspace\",
  worktree: \"/workspace\",
  serverUrl: new URL(\"http://localhost:4096\"),
  \$: () => { throw new Error(\"shell not needed\"); },
});
const ctx = { sessionID: \"test\", messageID: \"msg\", agent: \"general\", directory: \"/workspace\", worktree: \"/workspace\", abort: new AbortController().signal, metadata() {}, async ask() {} };
const result = await hooks.tool.memory_forget.execute({ id: process.argv[1], force: true }, ctx);
console.log(result);
" -- "$TEST_MEMORY_ID"' 2>&1)
  
  if echo "$CLEANUP_RESULT" | grep -q "Permanently deleted"; then
    pass "Test memory cleaned up"
  else
    info "Cleanup: $CLEANUP_RESULT"
  fi
fi

echo ""
echo "============================================"
echo " Test Complete - Exit Code: $EXIT_CODE"
echo "============================================"

if [ $EXIT_CODE -eq 0 ]; then
  echo -e "${GREEN}Memory E2E test PASSED${NC}"
  echo ""
  echo "Verified:"
  echo "  - opencode CLI available"
  echo "  - Plugin configured correctly"
  echo "  - Plugin hooks loaded successfully"
  echo "  - memory_remember tool executed"
  echo "  - memory_search found stored memory"
  echo "  - memory_stats returned valid response"
  echo ""
  echo "Testing method: Hook-based (via plugin hooks API)"
else
  echo -e "${RED}Memory E2E test FAILED${NC}"
fi

exit $EXIT_CODE
