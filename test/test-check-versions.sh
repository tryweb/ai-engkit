#!/usr/bin/env bash
# test-check-versions.sh — regression harness for derived BUN_VERSION checking.
#
# Exercises the REAL .opencode/scripts/check-versions.sh offline: a curl shim
# (test/fixtures/check-versions/bin/curl) is prepended to PATH and serves
# fixture responses for the two upstream sources the checker needs:
#   - npm:   https://registry.npmjs.org/@openchamber/web/latest
#   - GitHub: https://raw.githubusercontent.com/openchamber/openchamber/<tag>/package.json
#
# Expected behavior under test (contract for the pending implementation):
#   * check-versions.sh json emits a BUN_VERSION row derived from the pinned
#     OPENCHAMBER_VERSION: fetch upstream OpenChamber's package.json at that
#     git tag (bare tag primary, "v"-prefixed tag as fallback) and read the
#     bun version from its packageManager field ("bun@X.Y.Z").
#   * pinned BUN_VERSION == derived          => status "current"
#   * pinned BUN_VERSION behind derived      => status "outdated"
#   * pinned BUN_VERSION ahead of derived    => status "outdated"
#   * packageManager missing / not a bun pin => status "check_failed"
#   * bare-tag fetch fails, v-tag succeeds   => row resolves (not check_failed)
#
# Also asserts .github/workflows/dependency-update.yml tracks BUN_VERSION and
# expects 15 pins (14 existing + BUN_VERSION).
#
# Exits 0 when all cases pass, 1 otherwise. Runs offline (curl shim) in CI.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECKER="$REPO_ROOT/.opencode/scripts/check-versions.sh"
WORKFLOW="$REPO_ROOT/.github/workflows/dependency-update.yml"
FIXTURES="$REPO_ROOT/test/fixtures/check-versions"
MOCK_BIN="$FIXTURES/bin"

PASS=0
FAIL=0

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

pass() { PASS=$((PASS + 1)); echo -e "  ${GREEN}PASS${NC} $1"; }
fail() { FAIL=$((FAIL + 1)); echo -e "  ${RED}FAIL${NC} $1"; }

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    pass "$label"
  else
    fail "$label (expected='$expected', actual='$actual')"
  fi
}

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq is required" >&2; exit 2; }
[ -f "$CHECKER" ]  || { echo "ERROR: checker not found: $CHECKER" >&2; exit 2; }
[ -x "$MOCK_BIN/curl" ] || { echo "ERROR: curl shim not executable: $MOCK_BIN/curl" >&2; exit 2; }

# Run the real checker against a fixture Dockerfile with mocked curl.
# $1 = fixture Dockerfile, $2 = CV_PKG_MODE
run_checker() {
  CV_FIXTURE_DIR="$FIXTURES" CV_PKG_MODE="$2" CHECK_VERSIONS_TIMEOUT=5 \
    PATH="$MOCK_BIN:$PATH" bash "$CHECKER" json "$1" 2>/dev/null
}

json_field() { # $1 = json, $2 = jq expression
  printf '%s' "$1" | jq -r "$2" 2>/dev/null || echo "unparseable"
}

# Run the real checker in V2-line mode against a fixture Dockerfile + compose.
run_checker_v2() { # $1 = fixture Dockerfile, $2 = fixture compose
  CV_FIXTURE_DIR="$FIXTURES" CV_PKG_MODE="${3:-aligned}" CHECK_VERSIONS_TIMEOUT=5 \
    CHECK_V2_LINE=1 CHECK_COMPOSE_FILE="$2" \
    PATH="$MOCK_BIN:$PATH" bash "$CHECKER" json "$1" 2>/dev/null
}

assert_bun_status() { # $1 = label, $2 = expected status, $3 = dockerfile, $4 = mode
  local label="$1" expected="$2" dockerfile="$3" mode="$4" out status
  out="$(run_checker "$dockerfile" "$mode")"
  [ -n "$out" ] || out='{}'
  status="$(json_field "$out" '.BUN_VERSION.status // "absent"')"
  assert_eq "$label" "$expected" "$status"
}

echo "== check-versions.sh derived BUN_VERSION cases =="

assert_bun_status "bun-aligned-is-current" "current" \
  "$FIXTURES/Dockerfile.aligned" "aligned"

assert_bun_status "bun-behind-is-outdated" "outdated" \
  "$FIXTURES/Dockerfile.behind" "aligned"

assert_bun_status "bun-ahead-is-outdated" "outdated" \
  "$FIXTURES/Dockerfile.ahead" "aligned"

assert_bun_status "bun-missing-packageManager-is-check_failed" "check_failed" \
  "$FIXTURES/Dockerfile.aligned" "missing-pm"

assert_bun_status "bun-invalid-packageManager-is-check_failed" "check_failed" \
  "$FIXTURES/Dockerfile.aligned" "invalid-pm"

assert_bun_status "bun-vtag-fallback-resolves" "current" \
  "$FIXTURES/Dockerfile.aligned" "vtag-fallback"

echo "== fixture sanity (mock plumbing) =="

aligned_out="$(run_checker "$FIXTURES/Dockerfile.aligned" "aligned")"
assert_eq "openchamber-row-is-current" "current" \
  "$(json_field "$aligned_out" '.OPENCHAMBER_VERSION.status // "absent"')"
assert_eq "bun-derived-version-surfaced" "1.3.14" \
  "$(json_field "$aligned_out" '.BUN_VERSION.latest // "absent"')"

echo "== V2 line mode (CHECK_V2_LINE=1) =="

# The V2 compose is the source of truth for the pins it overrides; the
# OMO pin is dropped (D1: the v2 line carries no OMO runtime).
v2_out="$(run_checker_v2 "$FIXTURES/Dockerfile.v2" "$FIXTURES/compose.v2.yml")"
[ -n "$v2_out" ] || v2_out='{}'
assert_eq "v2-openchamber-pin-comes-from-compose" "2.1.1" \
  "$(json_field "$v2_out" '.OPENCHAMBER_VERSION.pinned // "absent"')"
assert_eq "v2-opencode-cli-pin-comes-from-compose" "2.0.24" \
  "$(json_field "$v2_out" '.OPENCODE_CLI_VERSION.pinned // "absent"')"
assert_eq "v2-drops-omo-pin" "absent" \
  "$(json_field "$v2_out" '.OH_MY_OPENAGENT_VERSION.pinned // "absent"')"
assert_eq "v2-superseded-opencode-row-absent" "absent" \
  "$(json_field "$v2_out" '.OPENCODE_VERSION.pinned // "absent"')"

echo "== CI workflow contract =="

if grep -q 'BUN_VERSION' "$WORKFLOW"; then
  pass "ci-workflow-tracks-BUN_VERSION"
else
  fail "ci-workflow-tracks-BUN_VERSION (BUN_VERSION not found in $WORKFLOW)"
fi

# Count pinned case arms of the form:  NAME_VERSION)   source='...'
# Count pinned case arms. The char class includes "|" so the combined
# OpenCode arm introduced by the V2 cross-major switch
# (`OPENCODE_VERSION|OPENCODE_CLI_VERSION)`) counts once, not zero.
pin_count="$(grep -cE '^[[:space:]]+[A-Z_|]+_VERSION\)[[:space:]]+source=' "$WORKFLOW")"
assert_eq "ci-workflow-expects-15-pins" "15" "$pin_count"

echo ""
echo "passed: $PASS    failed: $FAIL"
[ "$FAIL" -eq 0 ]
