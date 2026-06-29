#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.dev.yml}"
ENGINE_CONTAINER="${ENGINE_CONTAINER:-ai-engkit-engine-dev}"
UI_CONTAINER="${UI_CONTAINER:-ai-engkit-ui-dev}"
CHAMBER_PORT="${CHAMBER_PORT:-8001}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}=== Step 1: Cleanup ===${NC}"
cd "$PROJECT_DIR"
docker compose -f "$COMPOSE_FILE" down --remove-orphans 2>/dev/null || true
docker compose -f "$COMPOSE_FILE" down -v --remove-orphans 2>/dev/null || true
sleep 2

echo -e "${GREEN}=== Step 2: Build ===${NC}"
docker compose -f "$COMPOSE_FILE" build --no-cache
echo -e "${GREEN}Build complete${NC}"

echo -e "${GREEN}=== Step 3: Start ===${NC}"
docker compose -f "$COMPOSE_FILE" up -d
echo "Waiting for services to stabilize..."
sleep 30

echo -e "${GREEN}=== Step 4: Run Tests ===${NC}"
CHAMBER_PORT="$CHAMBER_PORT" bash "$SCRIPT_DIR/run-tests.sh" "$ENGINE_CONTAINER" "$UI_CONTAINER"
TEST_EXIT=$?

echo ""
if [ $TEST_EXIT -eq 0 ]; then
  echo -e "${GREEN}All tests passed!${NC}"
else
  echo -e "${RED}Some tests failed!${NC}"
fi

echo ""
echo -e "${YELLOW}=== Step 5: Cleanup ===${NC}"
docker compose -f "$COMPOSE_FILE" down --remove-orphans 2>/dev/null || true
echo -e "${YELLOW}Services stopped${NC}"

exit $TEST_EXIT
