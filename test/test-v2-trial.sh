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
  echo "CELL cell1 NOT-IMPLEMENTED"
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
