#!/usr/bin/env bash
# ============================================================
# Release Memory Plugin Test
# 啟動完整 dev 環境，執行 memory plugin E2E 測試
#
# 此腳本用於 release 前驗證 lancedb-opencode-pro plugin 是否正常運作
# 如果測試失敗，release 將被阻擋
#
# 使用方式：
#   ./test/release-memory-test.sh              # 使用預設設定
#   ./test/release-memory-test.sh --no-cleanup # 測試後不清理環境
# ============================================================
set -uo pipefail

NO_CLEANUP=false
if [ "${1:-}" = "--no-cleanup" ]; then
  NO_CLEANUP=true
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="$PROJECT_DIR/docker-compose.dev.yml"
CONTAINER="codeforge"
COMPOSE_PROJECT="codeforge"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}PASS${NC} $1"; }
fail() { echo -e "  ${RED}FAIL${NC} $1"; }
info() { echo -e "  ${YELLOW}INFO${NC} $1"; }

EXIT_CODE=0

echo "============================================"
echo " Release Memory Plugin Test"
echo " Project: $PROJECT_DIR"
echo "============================================"

# --------------------------------------------------
# 1. 檢查 docker-compose.dev.yml 是否存在
# --------------------------------------------------
echo ""
echo "--- Prerequisites ---"

if [ ! -f "$COMPOSE_FILE" ]; then
  fail "docker-compose.dev.yml not found at $COMPOSE_FILE"
  exit 1
fi
pass "docker-compose.dev.yml exists"

# --------------------------------------------------
# 2. 停止現有環境（如有的話）
# --------------------------------------------------
echo ""
echo "--- Cleanup Existing Environment ---"

EXISTING=$(docker compose -f "$COMPOSE_FILE" ps -q 2>/dev/null || echo "")
if [ -n "$EXISTING" ]; then
  info "Stopping existing containers..."
  docker compose -f "$COMPOSE_FILE" down --remove-orphans 2>/dev/null
fi
pass "Environment clean"

# --------------------------------------------------
# 3. 啟動完整環境
# --------------------------------------------------
echo ""
echo "--- Starting Environment ---"

info "Building image (if needed)..."
docker compose -f "$COMPOSE_FILE" build 2>/dev/null

info "Starting services..."
docker compose -f "$COMPOSE_FILE" up -d

# --------------------------------------------------
# 4. 等待 Ollama 健康檢查通過
# --------------------------------------------------
echo ""
echo "--- Waiting for Ollama ---"

OLLAMA_HEALTHY=false
for i in {1..60}; do
  OLLAMA_STATUS=$(docker inspect ollama --format '{{.State.Health.Status}}' 2>/dev/null || echo "none")
  if [ "$OLLAMA_STATUS" = "healthy" ]; then
    OLLAMA_HEALTHY=true
    break
  fi
  info "Waiting for Ollama to be healthy... ($i/60)"
  sleep 5
done

if [ "$OLLAMA_HEALTHY" = "true" ]; then
  pass "Ollama is healthy"
else
  fail "Ollama did not become healthy in time"
  info "Current status: $OLLAMA_STATUS"
  EXIT_CODE=1
fi

# --------------------------------------------------
# 5. 等待 ai-dev 容器就緒
# --------------------------------------------------
echo ""
echo "--- Waiting for ai-dev ---"

CONTAINER_RUNNING=false
for i in {1..30}; do
  CONTAINER_STATUS=$(docker inspect "$CONTAINER" --format '{{.State.Status}}' 2>/dev/null || echo "none")
  if [ "$CONTAINER_STATUS" = "running" ]; then
    CONTAINER_RUNNING=true
    break
  fi
  info "Waiting for container... ($i/30)"
  sleep 2
done

if [ "$CONTAINER_RUNNING" = "true" ]; then
  pass "ai-dev container is running"
else
  fail "ai-dev container did not start"
  EXIT_CODE=1
fi

# 等待 openchamber 完全就緒
info "Waiting for openchamber to be ready..."
sleep 10

# 檢查 openchamber health
OPENCHAMBER_READY=false
for i in {1..10}; do
  HEALTH=$(docker exec "$CONTAINER" sh -c 'curl -sf http://localhost:3000/health 2>/dev/null | jq -r ".isOpenCodeReady" 2>/dev/null || echo "false"' 2>/dev/null || echo "false")
  if [ "$HEALTH" = "true" ]; then
    OPENCHAMBER_READY=true
    break
  fi
  info "Waiting for openchamber... ($i/10)"
  sleep 3
done

if [ "$OPENCHAMBER_READY" = "true" ]; then
  pass "openchamber is ready"
else
  fail "openchamber did not become ready"
  EXIT_CODE=1
fi

# --------------------------------------------------
# 6. 執行 Memory Plugin E2E 測試
# --------------------------------------------------
echo ""
echo "--- Running Memory Plugin E2E Test ---"

if [ $EXIT_CODE -eq 0 ]; then
  if [ -f "$SCRIPT_DIR/test-memory-e2e.sh" ]; then
    info "Executing test-memory-e2e.sh..."
    if "$SCRIPT_DIR/test-memory-e2e.sh" "$CONTAINER"; then
      pass "Memory plugin E2E test passed"
    else
      fail "Memory plugin E2E test failed"
      EXIT_CODE=1
    fi
  else
    fail "test-memory-e2e.sh not found"
    EXIT_CODE=1
  fi
else
  fail "Skipping memory test due to previous failures"
fi

# --------------------------------------------------
# 7. 清理環境
# --------------------------------------------------
echo ""
echo "--- Cleanup ---"

if [ "$NO_CLEANUP" = "true" ]; then
  info "Skipping cleanup (--no-cleanup flag set)"
  info "To clean up manually:"
  info "  cd $PROJECT_DIR && docker compose -f docker-compose.dev.yml down"
else
  info "Stopping services..."
  docker compose -f "$COMPOSE_FILE" down --remove-orphans 2>/dev/null
  pass "Environment cleaned"
fi

# --------------------------------------------------
# Summary
# --------------------------------------------------
echo ""
echo "============================================"
echo " Release Memory Test Complete"
echo " Exit Code: $EXIT_CODE"
echo "============================================"

if [ $EXIT_CODE -eq 0 ]; then
  echo -e "${GREEN}Memory plugin 測試通過！可以繼續 release${NC}"
else
  echo -e "${RED}Memory plugin 測試失敗！Release 被阻擋${NC}"
  echo ""
  echo "可能原因："
  echo "  1. OpenCode 版本與 lancedb-opencode-pro 不相容"
  echo "  2. Ollama 服務未正常運行"
  echo "  3. lancedb-opencode-pro plugin 未正確載入"
  echo ""
  echo "建議："
  echo "  1. 檢查 OpenCode 版本（建議 1.3.7）"
  echo "  2. 確認 docker-compose.dev.yml 中的 OPENCODE_PLUGINS 設定"
  echo "  3. 執行 --no-cleanup 查看詳細錯誤訊息"
fi

exit $EXIT_CODE
