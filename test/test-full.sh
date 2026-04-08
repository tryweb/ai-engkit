#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# Full Integration Test: Build -> Start -> Test -> Cleanup
# Usage: ./test/test-full.sh
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CONTAINER="${CONTAINER_NAME:-ai-dev}"
CHAMBER_PORT="${CHAMBER_PORT:-8000}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}=== Step 1: Cleanup ===${NC}"
cd "$PROJECT_DIR"
docker-compose down --remove-orphans 2>/dev/null || true
docker-compose down -v --remove-orphans 2>/dev/null || true
sleep 2

echo -e "${GREEN}=== Step 2: Build ===${NC}"
docker-compose build --no-cache
echo -e "${GREEN}Build complete${NC}"

echo -e "${GREEN}=== Step 3: Start ===${NC}"
docker-compose up -d
echo "Waiting for services to stabilize..."
sleep 20

echo -e "${GREEN}=== Step 4: Run Tests ===${NC}"
bash "$SCRIPT_DIR/run-tests.sh" "$CONTAINER"
TEST_EXIT=$?

echo ""
if [ $TEST_EXIT -eq 0 ]; then
  echo -e "${GREEN}All tests passed!${NC}"
else
  echo -e "${RED}Some tests failed!${NC}"
fi

echo ""
echo -e "${YELLOW}=== Step 5: Cleanup ===${NC}"
docker-compose down --remove-orphans 2>/dev/null || true
echo -e "${YELLOW}Services stopped${NC}"

exit $TEST_EXIT
