#!/usr/bin/env bash
# ============================================================
# Memory Plugin E2E Test
# 驗證 lancedb-opencode-pro plugin 在 codeforge 容器啟動後是否正常運作
#
# 測試方式：docker exec 進入 ai-dev 容器，執行 opencode run 呼叫 memory_stats
#
# 使用方式：
#   ./test/test-memory-e2e.sh              # 使用預設 container (codeforge)
#   ./test/test-memory-e2e.sh <container>  # 指定 container 名稱
# ============================================================
set -uo pipefail

CONTAINER="${1:-codeforge}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}PASS${NC} $1"; }
fail() { echo -e "  ${RED}FAIL${NC} $1"; }
info() { echo -e "  ${YELLOW}INFO${NC} $1"; }

# Exit code for the test
EXIT_CODE=0

echo "============================================"
echo " Memory Plugin E2E Test"
echo " Container: $CONTAINER"
echo " Date: $(date '+%Y-%m-%d %H:%M:%S')"
echo "============================================"

# --------------------------------------------------
# 1. 前置檢查：Container 運行狀態
# --------------------------------------------------
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

# --------------------------------------------------
# 2. 前置檢查：opencode CLI 可用
# --------------------------------------------------
echo ""
echo "--- opencode CLI ---"

OPCODE_VER=$(docker exec "$CONTAINER" opencode --version 2>/dev/null || echo "error")
if [ "$OPCODE_VER" != "error" ] && [ -n "$OPCODE_VER" ]; then
  pass "opencode CLI available ($OPCODE_VER)"
else
  fail "opencode CLI not found in container"
  EXIT_CODE=1
fi

# --------------------------------------------------
# 3. Plugin 載入檢查
# --------------------------------------------------
echo ""
echo "--- Plugin Configuration ---"

# 檢查 OPENCODE_PLUGINS 環境變數
ENV_PLUGINS=$(docker exec "$CONTAINER" sh -c 'echo $OPENCODE_PLUGINS' 2>/dev/null || echo "")
if [ -n "$ENV_PLUGINS" ]; then
  info "OPENCODE_PLUGINS=$ENV_PLUGINS"
  if echo "$ENV_PLUGINS" | grep -q "lancedb-opencode-pro"; then
    pass "OPENCODE_PLUGINS includes lancedb-opencode-pro"
  else
    fail "OPENCODE_PLUGINS does not include lancedb-opencode-pro"
    EXIT_CODE=1
  fi
else
  fail "OPENCODE_PLUGINS env var not set"
  EXIT_CODE=1
fi

# 檢查 opencode.json 中的 plugin 設定
PLUGIN_CONFIG=$(docker exec "$CONTAINER" sh -c \
  'jq -r ".plugin | join(\",\")" ~/.config/opencode/opencode.json 2>/dev/null' || echo "")

if [ -n "$PLUGIN_CONFIG" ]; then
  info "opencode.json plugins: $PLUGIN_CONFIG"
  if echo "$PLUGIN_CONFIG" | grep -q "lancedb-opencode-pro"; then
    pass "lancedb-opencode-pro registered in opencode.json"
  else
    fail "lancedb-opencode-pro NOT in opencode.json plugins"
    EXIT_CODE=1
  fi
else
  fail "Cannot read opencode.json plugin config"
  EXIT_CODE=1
fi

# --------------------------------------------------
# 4. Ollama 服務檢查
# --------------------------------------------------
echo ""
echo "--- Ollama Service ---"

OLLAMA_BASE_URL=$(docker exec "$CONTAINER" sh -c 'echo $OLLAMA_BASE_URL' 2>/dev/null || echo "")
info "OLLAMA_BASE_URL=$OLLAMA_BASE_URL"

# 測試 Ollama 是否可連線
OLLAMA_TEST=$(docker exec "$CONTAINER" sh -c \
  'curl -sf http://ollama:11434/api/tags 2>/dev/null | jq -r "length" 2>/dev/null' || echo "error")

if [ "$OLLAMA_TEST" != "error" ] && [ -n "$OLLAMA_TEST" ]; then
  pass "Ollama is accessible ($OLLAMA_TEST models available)"
else
  fail "Ollama is not accessible"
  info "確保 docker-compose.dev.yml 中 ollama 服務正常"
  EXIT_CODE=1
fi

# 檢查 nomic-embed-text 模型（使用 curl 而非 ollama list，因為容器內沒有 ollama CLI）
EMBED_MODEL=$(docker exec "$CONTAINER" sh -c \
  'curl -sf http://ollama:11434/api/tags 2>/dev/null | jq -r ".models[].name" 2>/dev/null | grep -q "nomic-embed-text" && echo "available" || echo "not_found"' 2>/dev/null || echo "error")

if [ "$EMBED_MODEL" = "available" ]; then
  pass "nomic-embed-text model is available"
else
  fail "nomic-embed-text model not found"
  info "Ollama 正在下載模型，可能需要等待"
  EXIT_CODE=1
fi

# --------------------------------------------------
# 5. LanceDB 資料目錄檢查
# --------------------------------------------------
echo ""
echo "--- LanceDB Storage ---"

DB_PATH=$(docker exec "$CONTAINER" sh -c \
  'echo $HOME/.opencode/memory/lancedb' 2>/dev/null || echo "")

if [ -n "$DB_PATH" ]; then
  info "DB path: $DB_PATH"
  
  # 檢查目錄是否存在或可創建
  DB_WRITABLE=$(docker exec "$CONTAINER" sh -c \
    "mkdir -p $DB_PATH && test -w $DB_PATH && echo 'writable'" 2>/dev/null || echo "error")
  
  if [ "$DB_WRITABLE" = "writable" ]; then
    pass "LanceDB data directory is writable"
  else
    fail "LanceDB data directory is not writable"
    EXIT_CODE=1
  fi
else
  fail "Cannot determine DB path"
  EXIT_CODE=1
fi

# --------------------------------------------------
# 6. E2E: opencode run 呼叫 memory_stats
# --------------------------------------------------
echo ""
echo "--- E2E: memory_stats Execution ---"

# 取得 opencode server 的 port（從 openchamber health endpoint）
OPCODE_PORT=$(docker exec "$CONTAINER" sh -c \
  "curl -sf http://localhost:3000/health 2>/dev/null | jq -r '.openCodePort // empty'" 2>/dev/null || echo "")

if [ -z "$OPCODE_PORT" ]; then
  fail "Cannot get opencode server port from health endpoint"
  info "請確認 openchamber 正常運行"
  EXIT_CODE=1
else
  info "OpenCode server port: $OPCODE_PORT"
  
  info "Executing: opencode run --attach http://localhost:$OPCODE_PORT 'call memory_stats'"
  info "(timeout: 90s)"
  
  # 執行 opencode run，呼叫 memory_stats
  # 需要使用 --attach 連接到運行中的 openchamber/opencode server
  # 輸出是 JSONL 格式（每行一個 JSON），需要解析 tool_use 事件
  MEMORY_OUT=$(timeout 90 docker exec "$CONTAINER" opencode run \
    --attach "http://localhost:$OPCODE_PORT" \
    "call memory_stats tool and return the JSON result" \
    --format json 2>/dev/null || echo "TIMEOUT_OR_ERROR")
  
  # 從 JSONL 中提取 tool_use 事件的 output 欄位
  # tool_use 事件的結構：{"type":"tool_use","part":{"tool":"memory_stats","state":{"output":"..."}}}
  MEMORY_STATS_JSON=$(echo "$MEMORY_OUT" | jq -r 'select(.type == "tool_use" and .part.tool == "memory_stats") | .part.state.output // empty' 2>/dev/null || echo "")
  
  # 分析輸出
  if [ "$MEMORY_OUT" = "TIMEOUT_OR_ERROR" ]; then
    fail "opencode run command timed out or failed"
    info "可能原因："
    info "  1. opencode 版本與 plugin 不相容 (v1.3.8+ NAPI bug)"
    info "  2. Ollama 模型未就緒"
    info "  3. Plugin 未正確載入"
    EXIT_CODE=1
    
  elif [ -z "$MEMORY_STATS_JSON" ]; then
    # 無法提取 memory_stats 輸出
    if echo "$MEMORY_OUT" | grep -qi "Memory store unavailable\|unavailable\|napi.*addon\|addon.*napi"; then
      fail "Plugin loaded but memory store unavailable"
      info "這是 OpenCode v1.3.8+ 的已知 NAPI bug (Issue #20623)"
      info "建議：降級到 v1.3.7 或等待 OpenCode 修復"
      info "緩解方式："
      info "  docker exec $CONTAINER opencode upgrade 1.3.7"
      EXIT_CODE=1
    elif echo "$MEMORY_OUT" | grep -qi "Tool.*not found\|memory_stats.*not\|plugin.*not.*load"; then
      fail "memory_stats tool not found (plugin not loaded correctly)"
      EXIT_CODE=1
    else
      fail "Cannot extract memory_stats output from response"
      info "Output preview: $(echo "$MEMORY_OUT" | head -c 500)"
      EXIT_CODE=1
    fi
    
  elif echo "$MEMORY_STATS_JSON" | grep -qi "Memory store unavailable\|unavailable\|napi.*addon\|addon.*napi"; then
    fail "Plugin loaded but memory store unavailable"
    info "這是 OpenCode v1.3.8+ 的已知 NAPI bug (Issue #20623)"
    info "建議：降級到 v1.3.7 或等待 OpenCode 修復"
    info "緩解方式："
    info "  docker exec $CONTAINER opencode upgrade 1.3.7"
    EXIT_CODE=1
    
  elif echo "$MEMORY_STATS_JSON" | grep -qi "error\|Error\|ERROR"; then
    fail "memory_stats returned an error"
    info "Output: $(echo "$MEMORY_STATS_JSON" | head -c 300)"
    EXIT_CODE=1
    
  elif echo "$MEMORY_STATS_JSON" | jq -e 'has("provider") and has("scope")' > /dev/null 2>&1; then
    pass "memory_stats returned valid JSON output"
    
    # 解析並顯示關鍵資訊（根據實際回傳格式）
    PROVIDER=$(echo "$MEMORY_STATS_JSON" | jq -r '.provider // "unknown"' 2>/dev/null)
    SCOPE=$(echo "$MEMORY_STATS_JSON" | jq -r '.scope // "unknown"' 2>/dev/null)
    RECENT_COUNT=$(echo "$MEMORY_STATS_JSON" | jq -r '.recentCount // "unknown"' 2>/dev/null)
    EMBEDDING_MODEL=$(echo "$MEMORY_STATS_JSON" | jq -r '.embeddingModel // "unknown"' 2>/dev/null)
    VECTOR_INDEX=$(echo "$MEMORY_STATS_JSON" | jq -r '.index.vector // false' 2>/dev/null)
    FTS_INDEX=$(echo "$MEMORY_STATS_JSON" | jq -r '.index.fts // false' 2>/dev/null)
    
    info "Provider: $PROVIDER"
    info "Scope: $SCOPE"
    info "Recent Count: $RECENT_COUNT"
    info "Embedding Model: $EMBEDDING_MODEL"
    info "Vector Index: $VECTOR_INDEX"
    info "FTS Index: $FTS_INDEX"
    
    pass "JSON structure is valid"
    
  else
    # 輸出不是明顯的錯誤，但也不符合預期格式
    fail "Unexpected memory_stats output format"
    info "Output preview: $(echo "$MEMORY_STATS_JSON" | head -c 500)"
    EXIT_CODE=1
  fi
fi

# --------------------------------------------------
# 7. 清理測試 session（可選）
# --------------------------------------------------
echo ""
echo "--- Cleanup ---"

# 列出最近 sessions 並提示清理
RECENT_SESSIONS=$(docker exec "$CONTAINER" opencode session list --max-count 5 --format json 2>/dev/null | \
  jq -r '.[0].id' 2>/dev/null || echo "")

if [ -n "$RECENT_SESSIONS" ]; then
  info "最近 session: $RECENT_SESSIONS"
  info "如需清理，可執行："
  info "  docker exec $CONTAINER opencode session list"
fi

# --------------------------------------------------
# Summary
# --------------------------------------------------
echo ""
echo "============================================"
echo " Memory Plugin E2E Test Complete"
echo " Exit Code: $EXIT_CODE"
echo "============================================"

if [ $EXIT_CODE -eq 0 ]; then
  echo -e "${GREEN}所有檢查通過！lancedb-opencode-pro 正常運作${NC}"
else
  echo -e "${RED}部分檢查失敗，請查看上方錯誤訊息${NC}"
fi

exit $EXIT_CODE
