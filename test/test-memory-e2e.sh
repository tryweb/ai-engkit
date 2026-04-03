#!/usr/bin/env bash
set -uo pipefail

CONTAINER="${1:-codeforge}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}PASS${NC} $1"; }
fail() { echo -e "  ${RED}FAIL${NC} $1"; }
info() { echo -e "  ${YELLOW}INFO${NC} $1"; }

EXIT_CODE=0

echo "============================================"
echo " Memory Plugin E2E Test"
echo " Container: $CONTAINER"
echo " Date: $(date '+%Y-%m-%d %H:%M:%S')"
echo "============================================"

echo ""
echo "--- Container Status ---"
STATUS=$(docker inspect "$CONTAINER" --format '{{.State.Status}}' 2>/dev/null || echo "not_found")
if [ "$STATUS" = "running" ]; then
  pass "Container is running"
else
  fail "Container is not running (status: $STATUS)"
  echo ""
  echo "請確認容器已啟動："
  echo "  docker compose -f docker-compose.dev.yml up -d"
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
echo "--- Ollama Service ---"
OLLAMA_BASE_URL=$(docker exec "$CONTAINER" sh -c 'echo $OLLAMA_BASE_URL' 2>/dev/null || echo "")
info "OLLAMA_BASE_URL=$OLLAMA_BASE_URL"

OLLAMA_TEST=$(docker exec "$CONTAINER" sh -c \
  'curl -sf http://ollama:11434/api/tags 2>/dev/null | jq -r "length" 2>/dev/null' || echo "error")
if [ "$OLLAMA_TEST" != "error" ] && [ -n "$OLLAMA_TEST" ]; then
  pass "Ollama is accessible ($OLLAMA_TEST models available)"
else
  fail "Ollama is not accessible"
  EXIT_CODE=1
fi

EMBED_MODEL=$(docker exec "$CONTAINER" sh -c \
  'curl -sf http://ollama:11434/api/tags 2>/dev/null | jq -r ".models[].name" 2>/dev/null | grep -q "nomic-embed-text" && echo "available" || echo "not_found"' 2>/dev/null || echo "error")
if [ "$EMBED_MODEL" = "available" ]; then
  pass "nomic-embed-text model is available"
else
  fail "nomic-embed-text model not found"
  EXIT_CODE=1
fi

echo ""
echo "--- LanceDB Dependencies ---"
LANCEDB_CACHE=$(docker exec "$CONTAINER" sh -c \
  'ls -la /home/devuser/.cache/opencode/node_modules/@lancedb 2>/dev/null | grep -q lancedb && echo "found" || echo "not_found"' 2>/dev/null || echo "error")
if [ "$LANCEDB_CACHE" = "found" ]; then
  pass "LanceDB native addon is installed"
else
  fail "LanceDB native addon not found"
  EXIT_CODE=1
fi

echo ""
echo "--- LanceDB Storage ---"
DB_PATH=$(docker exec "$CONTAINER" sh -c 'echo $HOME/.opencode/memory/lancedb' 2>/dev/null || echo "")
if [ -n "$DB_PATH" ]; then
  info "DB path: $DB_PATH"
  DB_WRITABLE=$(docker exec "$CONTAINER" sh -c \
    "mkdir -p $DB_PATH && test -w $DB_PATH && echo 'writable'" 2>/dev/null || echo "error")
  if [ "$DB_WRITABLE" = "writable" ]; then
    pass "LanceDB data directory is writable"
  else
    fail "LanceDB data directory is not writable"
    EXIT_CODE=1
  fi
fi

echo ""
echo "--- AI Provider Check ---"
LITE_LLM_PID=$(docker exec "$CONTAINER" pgrep -f "litellm.*4000" 2>/dev/null || echo "")
if [ -n "$LITE_LLM_PID" ]; then
  info "litellm proxy is running (PID: $LITE_LLM_PID)"
  LITE_LLM_HEALTH=$(docker exec "$CONTAINER" curl -sf http://localhost:4000/health 2>/dev/null | jq -r '.healthy_count' 2>/dev/null || echo "error")
  if [ "$LITE_LLM_HEALTH" != "error" ]; then
    pass "litellm API is accessible"
  else
    info "litellm API not responding yet"
  fi
else
  info "litellm proxy not running"
fi

LLM_MODEL=$(docker exec "$CONTAINER" sh -c \
  'curl -sf http://ollama:11434/api/tags 2>/dev/null | jq -r ".models[].name" 2>/dev/null | grep -v "nomic-embed" | head -1' 2>/dev/null || echo "")
if [ -n "$LLM_MODEL" ]; then
  info "LLM model available: $LLM_MODEL"
  pass "AI provider setup complete"
else
  info "No LLM model available for functional testing"
fi

echo ""
echo "============================================"
echo " Test Complete - Exit Code: $EXIT_CODE"
echo "============================================"

if [ $EXIT_CODE -eq 0 ]; then
  echo -e "${GREEN}Plugin installation verification passed${NC}"
  echo ""
  if [ -z "$LLM_MODEL" ]; then
    echo "Note: Functional E2E test skipped (no LLM model)"
    echo "To enable full E2E testing:"
    echo "  docker exec $CONTAINER ollama pull qwen2.5:0.5b"
  fi
else
  echo -e "${RED}Plugin installation verification failed${NC}"
fi

exit $EXIT_CODE
