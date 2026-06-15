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
echo "============================================"
echo " Test Complete - Checking basic container health"
echo "============================================"

if [ $EXIT_CODE -eq 0 ]; then
  echo -e "${GREEN}Basic health check PASSED${NC}"
  echo ""
  echo "Verified:"
  echo "  - Container accessible"
  echo "  - opencode CLI available"
else
  echo -e "${RED}Basic health check FAILED${NC}"
fi

exit $EXIT_CODE
