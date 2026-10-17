#!/usr/bin/env bash
# test-openchamber-update-guard.sh — regression harness for the AI-EngKit core
# update guard patcher (scripts/patch-openchamber-update-guard.py).
#
# Exercises the real patcher against a disposable copy of the exact pinned
# OpenChamber v1.24.2 sources (test/fixtures/openchamber-update-guard/web).
# No package install, no network, no installer spawn.
#
# Covered contract:
#   * happy path applies all three guards and the patched routes refuse
#     (web 409 before the original spawn handler, CLI executeUpdate failure,
#     managed OpenCode upgrade 409)                        -> tasks 1.1-1.3
#   * re-running the patcher is idempotent (byte-identical)
#   * wrong package.json version -> nonzero, no files written          -> 1.4
#   * missing anchor (drift) -> nonzero, no partial edits              -> 1.4
#   * non-unique anchor -> nonzero, no partial edits                   -> 1.4
#   * partial/unknown already-patched state -> nonzero, no writes      -> 1.4
#
# Exits 0 when all cases pass, 1 otherwise.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PATCHER="$REPO_ROOT/scripts/patch-openchamber-update-guard.py"
FIXTURE="$REPO_ROOT/test/fixtures/openchamber-update-guard/web"
HARNESS="$REPO_ROOT/test/fixtures/openchamber-update-guard/guard-harness.mjs"
EXPECTED_VERSION="1.24.2"

TARGET_FILES=(
  "server/lib/opencode/openchamber-routes.js"
  "server/lib/package-manager.js"
  "server/lib/opencode/routes.js"
)

PASS=0
FAIL=0
RED='\033[0;31m'; GREEN='\033[0;32m'; NC='\033[0m'
pass() { PASS=$((PASS + 1)); echo -e "  ${GREEN}PASS${NC} $1"; }
fail() { FAIL=$((FAIL + 1)); echo -e "  ${RED}FAIL${NC} $1"; }
assert_eq() { local l="$1" e="$2" a="$3"; [ "$e" = "$a" ] && pass "$l" || fail "$l (expected='$e', actual='$a')"; }
assert_ne() { local l="$1" a="$2" b="$3"; [ "$a" != "$b" ] && pass "$l" || fail "$l (both='$a')"; }
assert_true() { local l="$1" c="$2"; [ "$c" = "0" ] && pass "$l" || fail "$l"; }

for tool in python3 bun; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: $tool is required" >&2; exit 2; }
done
[ -f "$PATCHER" ]  || { echo "ERROR: patcher not found: $PATCHER" >&2; exit 2; }
[ -d "$FIXTURE" ]  || { echo "ERROR: fixture not found: $FIXTURE" >&2; exit 2; }
[ -f "$HARNESS" ]  || { echo "ERROR: harness not found: $HARNESS" >&2; exit 2; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/oc-update-guard.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

new_pkg() { local d; d="$(mktemp -d "$WORK/pkg.XXXXXX")"; cp -R "$FIXTURE/." "$d/"; printf '%s' "$d"; }

# Snapshot the patcher-owned files' hashes (sorted, stable) for a package dir.
snapshot() {
  local dir="$1" f
  for f in "${TARGET_FILES[@]}"; do sha256sum "$dir/$f"; done
}

run_patch() { # $1 = package dir, $2 = expected version (stdout+stderr captured by caller)
  OPENCHAMBER_PACKAGE_DIR="$1" OPENCHAMBER_EXPECTED_VERSION="$2" python3 "$PATCHER"
}

echo "== 1.1-1.3 happy path: guards applied and enforced =="

PKG1="$(new_pkg)"
BEFORE1="$(snapshot "$PKG1")"
out1="$(run_patch "$PKG1" "$EXPECTED_VERSION" 2>&1)"; rc1=$?
assert_eq "patcher-succeeds" "0" "$rc1"
[ "$rc1" -ne 0 ] && echo "$out1" | sed 's/^/    | /'

for f in "${TARGET_FILES[@]}"; do
  if grep -q 'AI-ENGKIT-UPDATE-GUARD: begin' "$PKG1/$f"; then
    pass "guard-marker-present: $f"
  else
    fail "guard-marker-present: $f"
  fi
done
AFTER1="$(snapshot "$PKG1")"
assert_ne "guards-changed-source" "$BEFORE1" "$AFTER1"

# Dynamic enforcement: 409 before original handler, CLI failure, upgrade refusal.
if bun "$HARNESS" "$PKG1"; then
  pass "dynamic-guard-harness"
else
  fail "dynamic-guard-harness"
fi

echo "== idempotency: second run is a no-op =="

out2="$(run_patch "$PKG1" "$EXPECTED_VERSION" 2>&1)"; rc2=$?
assert_eq "second-run-succeeds" "0" "$rc2"
assert_eq "second-run-byte-identical" "$AFTER1" "$(snapshot "$PKG1")"
if echo "$out2" | grep -q 'already patched'; then
  pass "second-run-reports-already-patched"
else
  fail "second-run-reports-already-patched ($out2)"
fi

echo "== 1.4 version mismatch fails closed =="

PKG2="$(new_pkg)"
python3 - "$PKG2/package.json" <<'PY'
import json, sys
p = sys.argv[1]
data = json.load(open(p, encoding="utf-8"))
data["version"] = "1.24.1"
json.dump(data, open(p, "w", encoding="utf-8"), indent=2)
PY
SNAP2="$(snapshot "$PKG2")"
out3="$(run_patch "$PKG2" "$EXPECTED_VERSION" 2>&1)"; rc3=$?
assert_ne "version-mismatch-nonzero" "0" "$rc3"
if echo "$out3" | grep -qi 'version mismatch'; then
  pass "version-mismatch-diagnostic"
else
  fail "version-mismatch-diagnostic ($out3)"
fi
assert_eq "version-mismatch-no-writes" "$SNAP2" "$(snapshot "$PKG2")"

echo "== 1.4 missing anchor (source drift) fails closed =="

PKG3="$(new_pkg)"
DRIFT="$PKG3/server/lib/opencode/openchamber-routes.js"
python3 - "$DRIFT" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding="utf-8").read()
s = s.replace(
    "export const registerOpenChamberRoutes = (app, dependencies) => {",
    "export const registerOpenChamberRoutes = (app, dependencies, extra) => {",
    1,
)
open(p, "w", encoding="utf-8").write(s)
PY
SNAP3="$(snapshot "$PKG3")"
out4="$(run_patch "$PKG3" "$EXPECTED_VERSION" 2>&1)"; rc4=$?
assert_ne "anchor-drift-nonzero" "0" "$rc4"
if echo "$out4" | grep -qi 'anchor not found'; then
  pass "anchor-drift-diagnostic"
else
  fail "anchor-drift-diagnostic ($out4)"
fi
assert_eq "anchor-drift-no-partial-edits" "$SNAP3" "$(snapshot "$PKG3")"

echo "== 1.4 non-unique anchor fails closed =="

PKG4="$(new_pkg)"
DUP="$PKG4/server/lib/opencode/routes.js"
printf "\n  let openCodeUpgradePromise = null;\n\n  app.post('/api/opencode/upgrade', async (req, res) => {\n" >> "$DUP"
SNAP4="$(snapshot "$PKG4")"
out5="$(run_patch "$PKG4" "$EXPECTED_VERSION" 2>&1)"; rc5=$?
assert_ne "non-unique-anchor-nonzero" "0" "$rc5"
if echo "$out5" | grep -qi 'not unique'; then
  pass "non-unique-anchor-diagnostic"
else
  fail "non-unique-anchor-diagnostic ($out5)"
fi
assert_eq "non-unique-anchor-no-partial-edits" "$SNAP4" "$(snapshot "$PKG4")"

echo "== 1.4 partial already-patched state fails closed =="

PKG5="$(new_pkg)"
PARTIAL="$PKG5/server/lib/opencode/openchamber-routes.js"
python3 - "$PARTIAL" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding="utf-8").read()
s = s.replace(
    "export const registerOpenChamberRoutes = (app, dependencies) => {",
    "export const registerOpenChamberRoutes = (app, dependencies) => {\n  // AI-ENGKIT-UPDATE-GUARD: begin",
    1,
)
open(p, "w", encoding="utf-8").write(s)
PY
SNAP5="$(snapshot "$PKG5")"
out6="$(run_patch "$PKG5" "$EXPECTED_VERSION" 2>&1)"; rc6=$?
assert_ne "partial-state-nonzero" "0" "$rc6"
if echo "$out6" | grep -qi 'partial or unknown'; then
  pass "partial-state-diagnostic"
else
  fail "partial-state-diagnostic ($out6)"
fi
assert_eq "partial-state-no-writes" "$SNAP5" "$(snapshot "$PKG5")"

echo ""
echo "passed: $PASS    failed: $FAIL"
[ "$FAIL" -eq 0 ]
