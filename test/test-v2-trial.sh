#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# V2 Trial Test Script — Isolated V2 trial cells
# Usage: ./test/test-v2-trial.sh [cell1|cell2|cell3|cell4|cell5|cell6|cell7|all]
# ============================================================

CHAMBER_V2_PORT="${CHAMBER_V2_PORT:-8002}"
ADMIN_V2_PORT="${ADMIN_V2_PORT:-8082}"

# --------------------------------------------------
# Cell stubs — real assertions come later
# --------------------------------------------------

cell1() {
  echo "CELL cell1: no-OMO baseline"
  local repo_root compose
  repo_root="$(cd "$(dirname "$0")/.." && pwd)"
  compose="docker compose -f ${repo_root}/docker-compose.v2.yml"

  $compose ps --status running --format '{{.Name}}' | grep -q '^ai-engkit-v2$'
  $compose ps --status running --format '{{.Name}}' | grep -q '^ai-engkit-admin-v2$'
  echo "PASS: trial containers running"

  # Seed workspace through the daemon: host-path writes are invisible to the
  # trial container under DooD, so `docker cp` (not cp into a bind) is required
  docker exec ai-engkit-v2 rm -rf /home/devuser/workspace/.opencode/agents
  docker cp "${repo_root}/.opencode/agents" ai-engkit-v2:/home/devuser/workspace/.opencode/agents

  docker exec ai-engkit-v2 opencode --version 2>&1 | grep -q '2\.0\.15'
  echo "PASS: opencode 2.0.15 in trial container"

  [ "$(docker exec ai-engkit-v2 jq -c '.plugin' ~/.config/opencode/opencode.json)" = "[]" ]
  echo "PASS: opencode.json plugin-free"
  docker exec ai-engkit-v2 test ! -f ~/.omo/omo.jsonc
  echo "PASS: no ~/.omo/omo.jsonc (OMO lifecycle skipped)"
  [ "$(docker exec ai-engkit-v2 find /home/devuser/workspace/.opencode/agents -name '*.md' | wc -l)" -eq 12 ]
  echo "PASS: 12 native agents visible in trial workspace"

  # Reachable base: localhost works from a host shell; from inside a sibling
  # container (DooD) use the compose bridge gateway instead
  local base=""
  if curl -sf -m 8 -o /dev/null "http://localhost:${CHAMBER_V2_PORT}/"; then
    base="http://localhost:${CHAMBER_V2_PORT}"
  else
    local gw
    gw="$(docker network inspect v2_default --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null)" || gw=""
    if [ -n "$gw" ] && curl -sf -m 8 -o /dev/null "http://${gw}:${CHAMBER_V2_PORT}/"; then
      base="http://${gw}:${CHAMBER_V2_PORT}"
    fi
  fi
  if [ -n "$base" ]; then
    echo "PASS: OpenChamber responds at $base"
  else
    echo "FAIL: OpenChamber unreachable on ${CHAMBER_V2_PORT}" >&2
    return 1
  fi
}

cell2() {
  echo "CELL cell2 NOT-IMPLEMENTED"
}

cell3() {
  echo "CELL cell3 NOT-IMPLEMENTED"
}

cell4() {
  echo "CELL cell4 NOT-IMPLEMENTED"
}

cell5() {
  echo "CELL cell5 NOT-IMPLEMENTED"
}

cell6() {
  echo "CELL cell6 NOT-IMPLEMENTED"
}

cell7() {
  echo "CELL cell7 NOT-IMPLEMENTED"
}

# --------------------------------------------------
# Main — case dispatch
# --------------------------------------------------

main() {
  local target="${1:-all}"
  case "$target" in
    cell1) cell1 ;;
    cell2) cell2 ;;
    cell3) cell3 ;;
    cell4) cell4 ;;
    cell5) cell5 ;;
    cell6) cell6 ;;
    cell7) cell7 ;;
    all) cell1; cell2; cell3; cell4; cell5; cell6; cell7 ;;
    *) echo "Usage: $0 [cell1|cell2|cell3|cell4|cell5|cell6|cell7|all]" >&2; exit 1 ;;
  esac
}

main "$@"
