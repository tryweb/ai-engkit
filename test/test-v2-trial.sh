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
  local repo_root
  repo_root="$(cd "$(dirname "$0")/.." && pwd)"
  # Seed scratch workspace with the 12 native agents (trial-workspace is gitignored)
  mkdir -p "${repo_root}/trial-workspace/.opencode"
  rm -rf "${repo_root}/trial-workspace/.opencode/agents"
  cp -r "${repo_root}/.opencode/agents" "${repo_root}/trial-workspace/.opencode/agents"

  docker compose -f "${repo_root}/docker-compose.v2.yml" ps --status running --format '{{.Name}}' | grep -q '^ai-engkit-v2$'
  docker compose -f "${repo_root}/docker-compose.v2.yml" ps --status running --format '{{.Name}}' | grep -q '^ai-engkit-admin-v2$'
  echo "PASS: trial containers running"

  docker exec ai-engkit-v2 opencode --version 2>&1 | grep -q '2\.0\.15'
  echo "PASS: opencode 2.0.15 in trial container"

  [ "$(docker exec ai-engkit-v2 jq -c '.plugin' ~/.config/opencode/opencode.json)" = "[]" ]
  echo "PASS: opencode.json plugin-free"
  docker exec ai-engkit-v2 test ! -f ~/.omo/omo.jsonc
  echo "PASS: no ~/.omo/omo.jsonc (OMO lifecycle skipped)"
  [ "$(docker exec ai-engkit-v2 find /home/devuser/workspace/.opencode/agents -name '*.md' | wc -l)" -eq 12 ]
  echo "PASS: 12 native agents visible in trial workspace"

  local code
  code="$(curl -sS -m 10 -o /dev/null -w '%{http_code}' "http://localhost:${CHAMBER_V2_PORT}/")"
  case "$code" in 2*|3*) echo "PASS: OpenChamber responds on ${CHAMBER_V2_PORT} (HTTP $code)";; *) echo "FAIL: OpenChamber HTTP $code" >&2; return 1;; esac
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
