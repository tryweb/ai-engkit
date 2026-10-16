#!/usr/bin/env bash
# test-db-compat-gate.sh — deterministic harness for the OpenCode v1 database
# compatibility preflight (scripts/ai-engkit-db-compat.py) and its baseline.
#
# Contract covered (OpenSpec data-compatibility tasks 6.1-6.6):
#   * pinned v1 baseline captured from the disposable v1.19.0 fixture      6.1
#   * absent / fresh / recognized-v1 databases allowed                     6.2
#   * v2 / unknown schema refused with the data files untouched            6.3
#   * private-copy inspection, WAL-aware, source hashes/mtimes unchanged   6.4
#   * locked / corrupt / orphan-sidecar cases refused with guidance        6.5
#   * refusal restores no backup and deletes no session                    6.6
#   * no OpenCode CLI is ever started
#
# Runs entirely with the Python 3 standard library; no Docker and no network.
# The pinned fixture at /tmp/ai-engkit-v119-fixture is exercised only when it
# exists (that case skips otherwise).
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER="$REPO_ROOT/scripts/ai-engkit-db-compat.py"
BASELINE="$REPO_ROOT/scripts/db-compat-baseline.json"
PY_TEST_DIR="$REPO_ROOT/test/lib/db-compat"
FIXTURE_DB="/tmp/ai-engkit-v119-fixture/data/opencode/opencode.db"

PASS=0
FAIL=0
SKIP=0
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
pass() { PASS=$((PASS + 1)); echo -e "  ${GREEN}PASS${NC} $1"; }
fail() { FAIL=$((FAIL + 1)); echo -e "  ${RED}FAIL${NC} $1"; }
skip() { SKIP=$((SKIP + 1)); echo -e "  ${YELLOW}SKIP${NC} $1"; }
assert_eq() { local l="$1" e="$2" a="$3"; [ "$e" = "$a" ] && pass "$l" || fail "$l (expected='$e', actual='$a')"; }
assert_rc0() { local l="$1" rc="$2"; [ "$rc" -eq 0 ] && pass "$l" || fail "$l (rc=$rc)"; }
assert_rcnz() { local l="$1" rc="$2"; [ "$rc" -ne 0 ] && pass "$l" || fail "$l (rc=0)"; }
assert_contains() { local l="$1" n="$2" h="$3"; echo "$h" | grep -qF "$n" && pass "$l" || fail "$l (missing '$n')"; }

command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 is required" >&2; exit 2; }
for f in "$HELPER" "$BASELINE" "$PY_TEST_DIR"/test_gate_*.py; do
  [ -f "$f" ] || { echo "ERROR: missing required file: $f" >&2; exit 2; }
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/db-compat.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT
DATA_DIR="$WORK/data/opencode"   # nested so the temp copy is never under the data path
mkdir -p "$DATA_DIR"
DB="$DATA_DIR/opencode.db"

# status helpers -----------------------------------------------------------------
check_status() { python3 "$HELPER" check --db "$1" --baseline "$BASELINE" 2>/dev/null | head -n1; }
check_json()   { python3 "$HELPER" check --db "$1" --baseline "$BASELINE" --json 2>/dev/null; }
check_rc()     { python3 "$HELPER" check --db "$1" --baseline "$BASELINE" >/dev/null 2>&1; echo $?; }
file_fingerprint() { sha256sum "$@" 2>/dev/null; stat -c '%n %s %Y' "$@" 2>/dev/null; }

# fixture builders ---------------------------------------------------------------
build_v1() { # $1 = db path ; $2... = migration ids (default: all)
  python3 - "$1" "$BASELINE" "${@:2}" <<'PY'
import json, sqlite3, sys
db, baseline, *ids = sys.argv[1:]
tables = json.load(open(baseline))["tables"]
if not ids:
    ids = json.load(open(baseline))["migration_ids"]
con = sqlite3.connect(db)
for t in tables:
    if t == "migration":
        con.execute("CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)")
    else:
        con.execute(f'CREATE TABLE "{t}" (id TEXT)')
for mid in ids:
    con.execute("INSERT INTO migration (id, time_completed) VALUES (?, 1)", (mid,))
con.commit(); con.close()
PY
}
build_v2() { python3 - "$1" <<'PY'
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
con.execute("CREATE TABLE session_v2 (id TEXT)")
con.execute("CREATE TABLE message (id TEXT)")
con.commit(); con.close()
PY
}

echo "== A. Python standard-library unit tests =="
PY_RC=0
: >"$WORK/py-tests.log"
for py_test in "$PY_TEST_DIR"/test_gate_*.py; do
  if ! PYTHONDONTWRITEBYTECODE=1 python3 "$py_test" >>"$WORK/py-tests.log" 2>&1; then
    PY_RC=1
  fi
done
PY_CASES=$(grep -c ' \.\.\. ok' "$WORK/py-tests.log" || true)
PY_SKIPPED=$(grep -c ' \.\.\. skipped' "$WORK/py-tests.log" || true)
if [ "$PY_RC" -eq 0 ]; then
  pass "python unit tests pass ($PY_CASES passed, $PY_SKIPPED skipped)"
else
  fail "python unit tests failed"
  tail -n 30 "$WORK/py-tests.log"
fi

echo "== B. recognized v1 allowed, stable status token (6.2) =="
build_v1 "$DB"
assert_rc0 "recognized v1 exits 0" "$(check_rc "$DB")"
assert_eq "recognized v1 status" "allow_v1" "$(check_status "$DB")"
JSON="$(check_json "$DB")"
assert_contains "json marks allowed" '"allowed": true' "$JSON"
assert_contains "json reports status" '"status": "allow_v1"' "$JSON"

echo "== C. absent and fresh databases allowed (6.2) =="
assert_eq "absent allowed" "allow_absent" "$(check_status "$DATA_DIR/absent.db")"
: > "$DATA_DIR/empty.db"
assert_eq "fresh empty allowed" "allow_fresh" "$(check_status "$DATA_DIR/empty.db")"

echo "== D. v2 / unknown / locked / corrupt / orphan refused with guidance (6.3/6.5) =="
build_v2 "$DATA_DIR/v2.db"
assert_rcnz "v2 refused nonzero" "$(check_rc "$DATA_DIR/v2.db")"
assert_eq "v2 status" "refuse_v2" "$(check_status "$DATA_DIR/v2.db")"
build_v1 "$DATA_DIR/unknown.db" "20990101000000_future_thing"
assert_eq "unknown migration id refused" "refuse_unknown" "$(check_status "$DATA_DIR/unknown.db")"
printf 'not a sqlite database %s' "$(printf 'x%.0s' $(seq 1 200))" > "$DATA_DIR/corrupt.db"
assert_eq "corrupt refused" "refuse_corrupt" "$(check_status "$DATA_DIR/corrupt.db")"
orphan="$DATA_DIR/orphan/data/opencode"; mkdir -p "$orphan"; : > "$orphan/opencode.db-wal"
assert_eq "orphan sidecar refused" "refuse_orphan_sidecars" "$(check_status "$orphan/opencode.db")"
build_v1 "$DATA_DIR/locked.db"
python3 - "$DATA_DIR/locked.db" "$WORK/ready" <<'PY' &
import os, sqlite3, sys, time
con = sqlite3.connect(sys.argv[1]); con.execute("BEGIN IMMEDIATE")
open(sys.argv[2], "w").close()
time.sleep(60)
PY
WRITER=$!
for _ in $(seq 1 50); do [ -f "$WORK/ready" ] && break; sleep 0.1; done
assert_eq "locked (writer held open) refused" "refuse_locked" "$(check_status "$DATA_DIR/locked.db")"
kill "$WRITER" 2>/dev/null; wait "$WRITER" 2>/dev/null
GUIDE="$(python3 "$HELPER" check --db "$DATA_DIR/v2.db" --baseline "$BASELINE" 2>&1 >/dev/null)"
assert_contains "v2 prints operator guidance" "v2" "$GUIDE"
GUIDE_C="$(python3 "$HELPER" check --db "$DATA_DIR/corrupt.db" --baseline "$BASELINE" 2>&1 >/dev/null)"
assert_contains "corrupt prints recovery guidance" "known-good backup" "$GUIDE_C"

echo "== E. original database and sidecar hashes/mtimes unchanged (6.4) =="
WALDIR="$WORK/wal/data/opencode"; mkdir -p "$WALDIR"; WDB="$WALDIR/opencode.db"
build_v1 "$WDB"
python3 - "$WDB" <<'PY'
import sqlite3, sys
con = sqlite3.connect(sys.argv[1]); con.execute("PRAGMA journal_mode=WAL")
con.execute('INSERT INTO "session" (id) VALUES ("live")'); con.commit(); con.close()
PY
BEFORE="$(file_fingerprint "$WDB" "$WDB"-wal "$WDB"-shm 2>/dev/null)"
check_status "$WDB" >/dev/null
AFTER="$(file_fingerprint "$WDB" "$WDB"-wal "$WDB"-shm 2>/dev/null)"
assert_eq "original db+sidecar hashes and mtimes unchanged" "$BEFORE" "$AFTER"

echo "== F. WAL-only schema change is detected; source untouched (6.4) =="
CRASHDIR="$WORK/crash/data/opencode"; mkdir -p "$CRASHDIR"; CDB="$CRASHDIR/opencode.db"
python3 - "$CDB" <<'PY'
import os, sqlite3, sys
con = sqlite3.connect(sys.argv[1]); con.execute("PRAGMA journal_mode=WAL")
con.execute("CREATE TABLE session_v2 (id TEXT)"); con.commit()
os._exit(1)  # exit without SQLite's close-time checkpoint: schema stays in the WAL
PY
[ -s "$CDB-wal" ] && pass "writer exit left a non-empty WAL" || fail "writer exit left a non-empty WAL"
# Control: the main file alone carries no schema, so the WAL is what is detected.
MAINONLY="$WORK/mainonly/data/opencode"; mkdir -p "$MAINONLY"; cp "$CDB" "$MAINONLY/opencode.db"
assert_eq "main file alone has no schema (control)" "allow_fresh" "$(check_status "$MAINONLY/opencode.db")"
assert_eq "WAL-only v2 marker detected" "refuse_v2" "$(check_status "$CDB")"

echo "== G. no OpenCode CLI is ever started (6.3/6.6) =="
STUBBIN="$WORK/stubbin"; mkdir -p "$STUBBIN"; MARKER="$WORK/opencode-ran"
for tool in opencode bun node sqlite3; do
  printf '#!/usr/bin/env bash\ntouch %q\nexit 0\n' "$MARKER" > "$STUBBIN/$tool"; chmod 755 "$STUBBIN/$tool"
done
rm -f "$MARKER"
PATH="$STUBBIN:/usr/bin:/bin" python3 "$HELPER" check --db "$DB" --baseline "$BASELINE" >/dev/null 2>&1
if [ -e "$MARKER" ]; then fail "helper never invokes opencode/bun/node/sqlite3"; else pass "helper never invokes opencode/bun/node/sqlite3"; fi
PY_HELPERS=(
  "$HELPER"
  "$REPO_ROOT/scripts/ai_engkit_db_compat_model.py"
  "$REPO_ROOT/scripts/ai_engkit_db_compat_schema.py"
  "$REPO_ROOT/scripts/ai_engkit_db_compat_gate.py"
)
if grep -qE 'subprocess|os\.system|popen' "${PY_HELPERS[@]}"; then fail "helper has no shell-out primitives"; else pass "helper has no shell-out primitives"; fi
# Every added .py must ship PEP 723 metadata and run instructions.
for f in "${PY_HELPERS[@]}"; do
  assert_contains "$(basename "$f") has PEP 723 metadata" '# /// script' "$(cat "$f")"
  assert_contains "$(basename "$f") has run instructions" '# How to run:' "$(cat "$f")"
done

echo "== H. baseline missing refuses, no backup/rollback path (6.6) =="
MISSING_RC="$(python3 "$HELPER" check --db "$DB" --baseline "$WORK/nope.json" >/dev/null 2>&1; echo $?)"
assert_rcnz "missing baseline exits nonzero" "$MISSING_RC"
MISSING_STATUS="$(python3 "$HELPER" check --db "$DB" --baseline "$WORK/nope.json" 2>/dev/null | head -n1)"
assert_eq "missing baseline status token" "refuse_baseline" "$MISSING_STATUS"
# Refusal must not create a .bak, restore a backup, or delete any session row.
find "$WORK" -name '*.bak' -o -name '*-backup*' | grep -q . && fail "no backup artifacts created" || pass "no backup artifacts created"

echo "== I. pinned fixture (skips when absent) (6.1) =="
if [ -f "$FIXTURE_DB" ]; then
  FBEFORE="$(file_fingerprint "$FIXTURE_DB" "$FIXTURE_DB"-wal "$FIXTURE_DB"-shm 2>/dev/null)"
  assert_eq "fixture recognized as v1" "allow_v1" "$(check_status "$FIXTURE_DB")"
  CAPTURE="$WORK/captured.json"
  python3 "$HELPER" capture-baseline --db "$FIXTURE_DB" --out "$CAPTURE" \
    --opencode-version 1.19.0 --openchamber-version 1.24.2 >/dev/null 2>&1
  assert_rc0 "capture-baseline succeeds" "$?"
  python3 - "$CAPTURE" "$BASELINE" <<'PY' && pass "committed baseline matches fixture capture" || fail "committed baseline matches fixture capture"
import json, sys
assert json.load(open(sys.argv[1])) == json.load(open(sys.argv[2]))
PY
  FAFTER="$(file_fingerprint "$FIXTURE_DB" "$FIXTURE_DB"-wal "$FIXTURE_DB"-shm 2>/dev/null)"
  assert_eq "fixture db+sidecars unchanged by the gate" "$FBEFORE" "$FAFTER"
else
  skip "pinned fixture absent ($FIXTURE_DB)"
fi

echo ""
echo "passed: $PASS    failed: $FAIL    skipped: $SKIP"
[ "$FAIL" -eq 0 ]
