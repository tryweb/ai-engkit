#!/usr/bin/env bash
# test-managed-core-recovery.sh — deterministic harness for the AI-EngKit
# managed-core isolation, integrity baseline, and offline recovery helper
# (scripts/ai-engkit-core.py) plus the startup wiring around it.
#
# Contract covered:
#   * build-baseline emits manifest + metadata (pins from ARGs) + archive  2.1/3.1/3.2
#   * verify matches a pristine tree, flags drift/extra/missing           3.3/3.4
#   * recover restores an exact tree from a partial/drifted core          3.3
#   * corrupt/missing/unsafe-baseline refuses and leaves active untouched 3.4
#   * interrupted staging is not activated and is cleaned                 3.4
#   * recovery is idempotent and offline                                  3.5/3.6
#   * PATH wrapper launch + BUN user install isolation (real closure)     2.1/2.2/2.4
#   * reserved core package names rejected before mutation                2.3
#   * startup ordering + ai-admin exclusion + root-ownership survival     3.1/4.1/4.2
#
# Exits 0 when all cases pass, 1 otherwise. The heavy real-closure integration
# (section G) auto-skips when /tmp/ai-engkit-core-bun-prefix is absent.
set -uo pipefail

# Keep the repository clean: importing the helper must not drop __pycache__.
export PYTHONDONTWRITEBYTECODE=1

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER="$REPO_ROOT/scripts/ai-engkit-core.py"
WRAPPER="$REPO_ROOT/scripts/ai-engkit-core-wrapper.sh"
RECOVERY="$REPO_ROOT/entrypoint.d/00-core-recovery.sh"
DB_GATE="$REPO_ROOT/entrypoint.d/00-db-compat-gate.sh"
SELECTION_REPAIR="$REPO_ROOT/entrypoint.d/00-opencode-selection-repair.sh"
SELECTION_LIB="$REPO_ROOT/entrypoint.d/lib-opencode-selection-repair.bash"
INSTALL_PKGS="$REPO_ROOT/entrypoint.d/01-install-packages.sh"
RESERVED_LIB="$REPO_ROOT/entrypoint.d/lib-reserved-bun-packages.bash"
FIX_PERMS="$REPO_ROOT/entrypoint.d/00-fix-perms.sh"
DOCKERFILE="$REPO_ROOT/Dockerfile"
ENTRYPOINT="$REPO_ROOT/entrypoint.sh"
REAL_PREFIX="${AI_ENGKIT_CORE_TEST_PREFIX:-/tmp/ai-engkit-core-bun-prefix}"

PASS=0
FAIL=0
SKIP=0
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
pass() { PASS=$((PASS + 1)); echo -e "  ${GREEN}PASS${NC} $1"; }
fail() { FAIL=$((FAIL + 1)); echo -e "  ${RED}FAIL${NC} $1"; }
skip() { SKIP=$((SKIP + 1)); echo -e "  ${YELLOW}SKIP${NC} $1"; }
assert_eq() { local l="$1" e="$2" a="$3"; [ "$e" = "$a" ] && pass "$l" || fail "$l (expected='$e', actual='$a')"; }
assert_ne() { local l="$1" a="$2" b="$3"; [ "$a" != "$b" ] && pass "$l" || fail "$l (both='$a')"; }
assert_rc0() { local l="$1" rc="$2"; [ "$rc" -eq 0 ] && pass "$l" || fail "$l (rc=$rc)"; }
assert_rcnz() { local l="$1" rc="$2"; [ "$rc" -ne 0 ] && pass "$l" || fail "$l (rc=0)"; }

for tool in python3 tar; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: $tool is required" >&2; exit 2; }
done
for f in "$HELPER" "$RECOVERY" "$DB_GATE" "$SELECTION_REPAIR" "$SELECTION_LIB" "$WRAPPER" "$RESERVED_LIB" "$INSTALL_PKGS"; do
  [ -f "$f" ] || { echo "ERROR: missing required file: $f" >&2; exit 2; }
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/core-recovery.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# Build a small synthetic installed prefix: bin/ symlinks + install/global tree.
make_prefix() {
  local root="$1"
  mkdir -p "$root/bin" "$root/install/global/node_modules/pkg"
  printf '#!/usr/bin/env bash\necho opencode\n' > "$root/install/global/node_modules/pkg/opencode"
  chmod 755 "$root/install/global/node_modules/pkg/opencode"
  printf '{"name":"pkg","version":"1.0.0"}\n' > "$root/install/global/node_modules/pkg/package.json"
  chmod 644 "$root/install/global/node_modules/pkg/package.json"
  ln -s ../install/global/node_modules/pkg/opencode "$root/bin/opencode"
}

build_baseline() { # $1=prefix root, $2=baseline dir ; echoes genid on success
  python3 "$HELPER" build-baseline --root "$1" --out-dir "$2" \
    --opencode-version 1.19.0 --openchamber-version 1.24.2 \
    --bun-version 1.4.2 --ai-engkit-version dev 2>/dev/null
}
recover() { python3 "$HELPER" recover --core-root "$1" --baseline-dir "$2" >/dev/null 2>&1; }
status()  { python3 "$HELPER" status --core-root "$1" --baseline-dir "$2" 2>/dev/null; }
tree_hash() { python3 "$HELPER" build-baseline --root "$1" --out-dir "$WORK/hashout" 2>/dev/null; }

echo "== A. build-baseline emits manifest, metadata pins, and archive (2.1/3.1/3.2) =="
PRE="$WORK/pre"; BASE="$WORK/base"; make_prefix "$PRE"; mkdir -p "$BASE"
GENID="$(build_baseline "$PRE" "$BASE")"; rc=$?
assert_rc0 "build-baseline succeeds" "$rc"
[ -n "$GENID" ] && pass "generation id printed" || fail "generation id printed"
for f in manifest.json metadata.json core.tar.gz; do
  [ -f "$BASE/$f" ] && pass "baseline artifact: $f" || fail "baseline artifact: $f"
done
META_OC="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["opencode_version"])' "$BASE/metadata.json" 2>/dev/null)"
META_OB="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["openchamber_version"])' "$BASE/metadata.json" 2>/dev/null)"
META_GEN="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["generation_id"])' "$BASE/metadata.json" 2>/dev/null)"
assert_eq "metadata opencode pin" "1.19.0" "$META_OC"
assert_eq "metadata openchamber pin" "1.24.2" "$META_OB"
assert_eq "metadata generation id matches" "$GENID" "$META_GEN"
python3 - "$BASE/manifest.json" <<'PY' && pass "manifest records types/modes/links" || fail "manifest records types/modes/links"
import json, sys
m = json.load(open(sys.argv[1]))
by = {e["path"]: e for e in m["entries"]}
assert by["bin/opencode"]["type"] == "symlink"
assert by["bin/opencode"]["target"] == "../install/global/node_modules/pkg/opencode"
assert by["install/global/node_modules/pkg/opencode"]["type"] == "file"
assert by["install/global/node_modules/pkg/opencode"]["mode"] == 0o755
assert by["install/global/node_modules/pkg/opencode"]["sha256"]
assert by["install/global/node_modules/pkg/package.json"]["mode"] == 0o644
PY
python3 "$HELPER" verify --root "$PRE" --manifest "$BASE/manifest.json" >/dev/null 2>&1
assert_rc0 "verify accepts pristine tree" "$?"

echo "== B. recover restores exact tree from drift/partial/extra (3.3) =="
CORE="$WORK/core"
assert_rc0 "recover from missing core" "$(recover "$CORE" "$BASE"; echo $?)"
status "$CORE" "$BASE" | grep -qx clean && pass "recovered core is clean" || fail "recovered core is clean"
# same-version content drift
printf 'tampered\n' >> "$CORE/active/install/global/node_modules/pkg/opencode"
assert_ne "drift changes status" "clean" "$(status "$CORE" "$BASE")"
recover "$CORE" "$BASE"; assert_rc0 "recover repairs content drift" "$?"
status "$CORE" "$BASE" | grep -qx clean && pass "content drift restored clean" || fail "content drift restored clean"
# partial install (missing file)
rm -f "$CORE/active/install/global/node_modules/pkg/package.json"
recover "$CORE" "$BASE"; assert_rc0 "recover repairs partial install" "$?"
[ -f "$CORE/active/install/global/node_modules/pkg/package.json" ] && pass "missing file restored" || fail "missing file restored"
# unexpected extra file
touch "$CORE/active/install/global/node_modules/pkg/extra.txt"
recover "$CORE" "$BASE"; assert_rc0 "recover removes unexpected file" "$?"
[ -e "$CORE/active/install/global/node_modules/pkg/extra.txt" ] && fail "unexpected file removed" || pass "unexpected file removed"
# mode drift
chmod 600 "$CORE/active/install/global/node_modules/pkg/opencode"
recover "$CORE" "$BASE" >/dev/null 2>&1
[ "$(stat -c '%a' "$CORE/active/install/global/node_modules/pkg/opencode")" = "755" ] && pass "mode drift restored" || fail "mode drift restored"

echo "== C. recovery is idempotent and changes nothing on a clean core (3.6) =="
BEFORE="$(cd "$CORE" && find . | LC_ALL=C sort | while read -r p; do
  if [ -L "$p" ]; then printf 'L %s %s\n' "$p" "$(readlink "$p")";
  elif [ -d "$p" ]; then printf 'D %s %s\n' "$p" "$(stat -c '%a' "$p")";
  else printf 'F %s %s %s\n' "$p" "$(stat -c '%a' "$p")" "$(sha256sum "$p" | cut -d' ' -f1)"; fi
done | sha256sum)"
OUT="$(python3 "$HELPER" recover --core-root "$CORE" --baseline-dir "$BASE" 2>&1)"
AFTER="$(cd "$CORE" && find . | LC_ALL=C sort | while read -r p; do
  if [ -L "$p" ]; then printf 'L %s %s\n' "$p" "$(readlink "$p")";
  elif [ -d "$p" ]; then printf 'D %s %s\n' "$p" "$(stat -c '%a' "$p")";
  else printf 'F %s %s %s\n' "$p" "$(stat -c '%a' "$p")" "$(sha256sum "$p" | cut -d' ' -f1)"; fi
done | sha256sum)"
echo "$OUT" | grep -q "clean:" && pass "second run reports clean" || fail "second run reports clean ($OUT)"
assert_eq "second run changes no files" "$BEFORE" "$AFTER"

echo "== D. invalid baseline fails closed and leaves active untouched (3.4) =="
capture_active() { readlink "$CORE/active" 2>/dev/null || echo missing; }
for case in corrupt-archive missing-archive missing-manifest bad-digest; do
  B2="$WORK/base-$case"; cp -R "$BASE" "$B2"
  case "$case" in
    corrupt-archive) printf 'garbage' >> "$B2/core.tar.gz" ;;
    missing-archive) rm -f "$B2/core.tar.gz" ;;
    missing-manifest) rm -f "$B2/manifest.json" ;;
    bad-digest) printf 'deadbeef' >> "$B2/metadata.json" ;;
  esac
  ACTIVE_BEFORE="$(capture_active)"
  recover "$CORE" "$B2"; rc=$?
  assert_rcnz "$case refused" "$rc"
  assert_eq "$case leaves active unchanged" "$ACTIVE_BEFORE" "$(capture_active)"
done

echo "== E. unexpected/unsafe link and interrupted staging (3.4) =="
UNSAFE="$WORK/unsafe"; make_prefix "$UNSAFE"; ln -s ../../../../etc/passwd "$UNSAFE/bin/escape"
python3 "$HELPER" build-baseline --root "$UNSAFE" --out-dir "$WORK/unsafe-base" >/dev/null 2>&1
assert_rcnz "build-baseline rejects escaping symlink" "$?"

python3 - "$HELPER" "$WORK/malroot" "$WORK/malbase" <<'PY' && pass "crafted unsafe baseline built" || fail "crafted unsafe baseline built"
import importlib.util, json, pathlib, sys
helper, root, out = sys.argv[1], pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3])
spec = importlib.util.spec_from_file_location("aek", helper)
mod = importlib.util.module_from_spec(spec)
sys.modules["aek"] = mod
spec.loader.exec_module(mod)
root.mkdir(parents=True, exist_ok=True); out.mkdir(parents=True, exist_ok=True)
(root / "bin").mkdir(); (root / "install").mkdir()
(root / "install" / "data").write_text("x\n")
(root / "escape").symlink_to("../../../../etc/passwd")
entries = mod.collect_entries(root)
gen = mod.generation_id(entries)
(out / "manifest.json").write_text(json.dumps({"schema": 1, "generation_id": gen, "entries": [entries[k] for k in sorted(entries)]}))
mod.create_archive(root, out / "core.tar.gz")
meta = {"schema": 1, "generation_id": gen, "archive_name": "core.tar.gz", "manifest_name": "manifest.json",
        "archive_sha256": mod.sha256_file(out / "core.tar.gz"),
        "opencode_version": "x", "openchamber_version": "x", "bun_version": "x", "ai_engkit_version": "x"}
(out / "metadata.json").write_text(json.dumps(meta))
PY
ACTIVE_BEFORE="$(capture_active)"
recover "$CORE" "$WORK/malbase"; rc=$?
assert_rcnz "recover refuses escaping staged link" "$rc"
assert_eq "unsafe baseline leaves active unchanged" "$ACTIVE_BEFORE" "$(capture_active)"

mkdir -p "$CORE/.staging.999.42" && echo junk > "$CORE/.staging.999.42/f"
recover "$CORE" "$BASE"; assert_rc0 "recover with stale staging succeeds" "$?"
[ -d "$CORE/.staging.999.42" ] && fail "stale staging cleaned" || pass "stale staging cleaned"
if ls -A "$CORE/generations" 2>/dev/null | grep -q staging; then
  fail "no staging generation activated"
else
  pass "no staging generation activated"
fi

echo "== F. recovery is offline (no network) (3.5) =="
grep -qE "urllib|requests|httpx|socket|http\\.client|curl |wget |bun install|bun add" "$HELPER" \
  && fail "helper has no network calls" || pass "helper has no network calls"
HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9 \
  python3 "$HELPER" recover --core-root "$CORE" --baseline-dir "$BASE" >/dev/null 2>&1
assert_rc0 "recover succeeds with network proxies poisoned" "$?"

echo "== G. PATH launch, closure, and bun resolution (2.1/2.2/2.4) =="
if [ -d "$REAL_PREFIX/install/global/node_modules/opencode-ai/bin" ]; then
  HEAVY_CORE="$WORK/heavy-core"; HEAVY_BASE="$WORK/heavy-base"
  python3 "$HELPER" build-baseline --root "$REAL_PREFIX" --out-dir "$HEAVY_BASE" \
    --opencode-version 1.19.0 --openchamber-version 1.24.2 --bun-version 1.4.2 --ai-engkit-version dev >/dev/null 2>&1
  assert_rc0 "baseline built from real closure" "$?"
  recover "$HEAVY_CORE" "$HEAVY_BASE"; assert_rc0 "recover from real closure" "$?"
  # Install the stable PATH wrappers exactly as the Dockerfile does.
  mkdir -p "$HEAVY_CORE/bin"
  cp "$WRAPPER" "$HEAVY_CORE/bin/opencode"; chmod 755 "$HEAVY_CORE/bin/opencode"
  cp "$WRAPPER" "$HEAVY_CORE/bin/openchamber"; chmod 755 "$HEAVY_CORE/bin/openchamber"
  USERBIN="$WORK/userbin"; mkdir -p "$USERBIN"
  ln -sf "$(command -v bun)" "$USERBIN/bun"; ln -sf "$(command -v bun)" "$USERBIN/node"
  LAUNCH_PATH="$HEAVY_CORE/bin:$USERBIN:/usr/bin:/bin"
  OC="$(PATH="$LAUNCH_PATH" timeout 60 "$HEAVY_CORE/bin/opencode" --version 2>/dev/null | tr -d '\r' | head -1)"
  OCB="$(PATH="$LAUNCH_PATH" timeout 60 "$HEAVY_CORE/bin/openchamber" --version 2>/dev/null | tr -d '\r' | head -1)"
  assert_eq "core opencode launches through PATH" "1.19.0" "$OC"
  assert_eq "core openchamber launches through PATH" "1.24.2" "$OCB"
  # bun/node must come from the user prefix, not the core
  assert_eq "bun resolves from user prefix" "$USERBIN/bun" "$(PATH="$LAUNCH_PATH" command -v bun)"
else
  skip "real closure integration (fixture $REAL_PREFIX absent)"
fi

echo "== H. PATH wrapper sets BUN_INSTALL; user prefix untouched (2.3/2.4) =="
FAKE_CORE="$WORK/fakecore"; mkdir -p "$FAKE_CORE/bin" "$FAKE_CORE/active/bin"
printf '#!/usr/bin/env bash\nprintf "BUN_INSTALL=%%s\\n" "${BUN_INSTALL:-unset}"\n' > "$FAKE_CORE/active/bin/opencode"
chmod 755 "$FAKE_CORE/active/bin/opencode"
cp "$WRAPPER" "$FAKE_CORE/bin/opencode"; chmod 755 "$FAKE_CORE/bin/opencode"
WRAPPED_OUT="$(BUN_INSTALL=/home/devuser/.bun bash "$FAKE_CORE/bin/opencode")"
assert_eq "wrapper passes explicit core BUN_INSTALL" "BUN_INSTALL=$FAKE_CORE/active" "$WRAPPED_OUT"
# The export is process-local: it must not leak into the caller's environment.
LEAK_CHECK="$(BUN_INSTALL=/home/devuser/.bun bash -c 'bash "$1" >/dev/null; printf "%s" "$BUN_INSTALL"' _ "$FAKE_CORE/bin/opencode")"
assert_eq "wrapper does not leak BUN_INSTALL to caller" "/home/devuser/.bun" "$LEAK_CHECK"
grep -q "BUN_INSTALL" "$INSTALL_PKGS" && fail "install-packages does not set BUN_INSTALL" || pass "install-packages does not set BUN_INSTALL"

echo "== I. reserved core package names rejected before mutation (2.3) =="
# shellcheck source=entrypoint.d/lib-reserved-bun-packages.bash
source "$RESERVED_LIB"
assert_eq "scoped name with version" "@openchamber/web" "$(bun_package_name '@openchamber/web@1.24.2')"
assert_eq "plain name with version" "opencode-ai" "$(bun_package_name 'opencode-ai@1.19.0')"
assert_eq "unversioned scoped name" "@opencode/cli" "$(bun_package_name '@opencode/cli')"
assert_rc0 "unrelated request allowed" "$(assert_no_reserved_bun_packages typescript eslint 2>/dev/null; echo $?)"
assert_rcnz "mixed request with opencode-ai refused" "$(assert_no_reserved_bun_packages typescript opencode-ai@1.19.0 2>/dev/null; echo $?)"
assert_rcnz "scoped openchamber refused" "$(assert_no_reserved_bun_packages @openchamber/web@1.24.2 2>/dev/null; echo $?)"
assert_rcnz "scoped opencode/cli refused" "$(assert_no_reserved_bun_packages @opencode/cli 2>/dev/null; echo $?)"
# The startup installer must refuse before it calls bun at all.
STUBBIN="$WORK/stubbin"; mkdir -p "$STUBBIN"; MARKER="$WORK/bun-called"
printf '#!/usr/bin/env bash\ntouch %q\n' "$MARKER" > "$STUBBIN/bun"; chmod 755 "$STUBBIN/bun"
rm -f "$MARKER"
( PATH="$STUBBIN:/usr/bin:/bin" HOME="$WORK/emptyhome" BUN_PACKAGES="typescript opencode-ai@1.19.0" \
  bash "$INSTALL_PKGS" ) >/dev/null 2>&1; rc=$?
assert_rcnz "mixed request aborts the installer" "$rc"
[ -e "$MARKER" ] && fail "reserved request never invokes bun" || pass "reserved request never invokes bun"
rm -f "$MARKER"
( PATH="$STUBBIN:/usr/bin:/bin" HOME="$WORK/emptyhome" BUN_PACKAGES="typescript eslint" \
  bash "$INSTALL_PKGS" ) >/dev/null 2>&1; rc=$?
assert_rc0 "unrelated request installs normally" "$rc"
[ -e "$MARKER" ] && pass "unrelated request invokes bun" || fail "unrelated request invokes bun"

echo "== J. startup ordering, ai-admin exclusion, ownership survival (3.1/4.1/4.2) =="
[ "$(printf '%s\n' 00-core-recovery.sh 01-install-packages.sh 02-init-config.sh | LC_ALL=C sort | head -1)" = "00-core-recovery.sh" ] \
  && pass "recovery sorts before package install/config" || fail "recovery sorts before package install/config"
grep -qF 'AI_ENGKIT_BOOT_ROLE' "$ENTRYPOINT" && pass "entrypoint exports typed boot role" || fail "entrypoint exports typed boot role"
if grep -qF 'AI_ENGKIT_BOOT_COMMAND' "$ENTRYPOINT"; then fail "entrypoint does not export full boot command"; else pass "entrypoint does not export full boot command"; fi
grep -qF 'AI_ENGKIT_BOOT_ROLE:-ai-dev' "$RECOVERY" && pass "recovery scopes itself by boot role" || fail "recovery scopes itself by boot role"
grep -qF '00-db-compat-gate.sh' "$ENTRYPOINT" && pass "entrypoint blocks failed database preflight" || fail "entrypoint blocks failed database preflight"
grep -qF '00-opencode-selection-repair.sh' "$ENTRYPOINT" && pass "entrypoint blocks failed CLI-selection preflight" || fail "entrypoint blocks failed CLI-selection preflight"
grep -q '/opt/ai-engkit/core' "$FIX_PERMS" && fail "fix-perms leaves core paths alone" || pass "fix-perms leaves core paths alone"
grep -qE 'chown -R root:root /opt/ai-engkit/core' "$DOCKERFILE" && pass "image makes core root-owned" || fail "image makes core root-owned"
grep -q 'BUN_INSTALL=/opt/ai-engkit/core/generations/.build' "$DOCKERFILE" \
  && pass "image installs core into isolated prefix" || fail "image installs core into isolated prefix"

# ai-admin must not invoke recovery; ai-dev must. Substitute only image paths in
# a temporary test copy, keeping production helper locations fixed.
ADMIN_MARKER="$WORK/admin-helper-ran"
cat > "$WORK/stub-helper.py" <<PY
import pathlib, sys
pathlib.Path("$ADMIN_MARKER").write_text("ran")
sys.exit(0)
PY
TEST_RECOVERY="$WORK/core-recovery.sh"
sed \
  -e "s|/opt/ai-engkit/scripts/ai-engkit-core.py|$WORK/stub-helper.py|" \
  -e "s|/opt/ai-engkit/core|$WORK/core|g" \
  -e "s|/opt/ai-engkit/core-baseline|$WORK/baseline|g" \
  "$RECOVERY" > "$TEST_RECOVERY"
mkdir -p "$WORK/stubbin"
cat > "$WORK/stubbin/sudo" <<'SH'
#!/usr/bin/env bash
if [[ "${1:-}" == "-E" ]]; then exit 0; fi
[[ "${1:-}" == "-n" ]] && shift
exec "$@"
SH
chmod +x "$WORK/stubbin/sudo"
rm -f "$ADMIN_MARKER"
AI_ENGKIT_BOOT_ROLE=ai-admin PATH="$WORK/stubbin:$PATH" bash "$TEST_RECOVERY" >/dev/null 2>&1
assert_rc0 "ai-admin recovery hook exits 0" "$?"
[ -e "$ADMIN_MARKER" ] && fail "ai-admin does not run recovery" || pass "ai-admin does not run recovery"
AI_ENGKIT_BOOT_ROLE=ai-admin bash "$DB_GATE" >/dev/null 2>&1
assert_rc0 "ai-admin database gate exits 0" "$?"
AI_ENGKIT_BOOT_ROLE=ai-dev PATH="$WORK/stubbin:$PATH" bash "$TEST_RECOVERY" >/dev/null 2>&1
assert_rc0 "ai-dev recovery hook exits 0" "$?"
[ -e "$ADMIN_MARKER" ] && pass "ai-dev runs recovery" || fail "ai-dev runs recovery"

ENTRYPOINT_TEST_DIR="$WORK/entrypoint.d"
mkdir -p "$ENTRYPOINT_TEST_DIR"
ROLE_MARKER="$WORK/boot-role"
cat > "$ENTRYPOINT_TEST_DIR/00-core-recovery.sh" <<SH
#!/usr/bin/env bash
printf '%s' "\$AI_ENGKIT_BOOT_ROLE" > "$ROLE_MARKER"
SH
chmod +x "$ENTRYPOINT_TEST_DIR/00-core-recovery.sh"
sed "s|/entrypoint.d/\\*|$ENTRYPOINT_TEST_DIR/*|" "$ENTRYPOINT" > "$WORK/entrypoint.sh"
chmod +x "$WORK/entrypoint.sh"
PATH="$WORK/stubbin:$PATH" bash "$WORK/entrypoint.sh" bun run /opt/admin/server.ts >/dev/null 2>&1
assert_rc0 "production ai-admin command reaches app without blocking" "$?"
assert_eq "production ai-admin gets admin role" "ai-admin" "$(<"$ROLE_MARKER")"
DEV_ADMIN_COMMAND=$'set -e\nsudo find /opt/ai-engkit -path /opt/ai-engkit/extensions -prune -o -exec chown devuser:devuser {} +\nmkdir -p /opt/ai-engkit/admin-data\nbun run /opt/admin/server.ts'
PATH="$WORK/stubbin:$PATH" bash "$WORK/entrypoint.sh" sh -c "$DEV_ADMIN_COMMAND" >/dev/null 2>&1
assert_rc0 "development ai-admin shell command reaches app without blocking" "$?"
assert_eq "development ai-admin gets admin role" "ai-admin" "$(<"$ROLE_MARKER")"
PATH="$WORK/stubbin:$PATH" bash "$WORK/entrypoint.sh" bash -c 'bun run /opt/admin/server.ts' >/dev/null 2>&1
assert_rc0 "bash-wrapped ai-admin command reaches app without blocking" "$?"
assert_eq "bash-wrapped ai-admin gets admin role" "ai-admin" "$(<"$ROLE_MARKER")"
PATH="$WORK/stubbin:$PATH" bash "$WORK/entrypoint.sh" bun run /opt/admin/server.ts --extra-args >/dev/null 2>&1
assert_rc0 "ai-admin command with extra arguments reaches app" "$?"
assert_eq "ai-admin command with extra arguments gets admin role" "ai-admin" "$(<"$ROLE_MARKER")"
PATH="$WORK/stubbin:$PATH" bash "$WORK/entrypoint.sh" openchamber serve >/dev/null 2>&1
assert_rc0 "ai-dev command reaches app without blocking" "$?"
assert_eq "ai-dev command gets dev role" "ai-dev" "$(<"$ROLE_MARKER")"

LATE_MARKER="$WORK/later-stage-ran"
cat > "$ENTRYPOINT_TEST_DIR/00-core-recovery.sh" <<SH
#!/usr/bin/env bash
exit 0
SH
chmod +x "$ENTRYPOINT_TEST_DIR/00-core-recovery.sh"
mkdir -p "$WORK/.local/share/opencode"
CORRUPT_DB="$WORK/.local/share/opencode/opencode.db"
printf 'not a sqlite database\n' > "$CORRUPT_DB"
DB_HASH_BEFORE="$(sha256sum "$CORRUPT_DB" | cut -d' ' -f1)"
sed \
  -e "s|/opt/ai-engkit/scripts/ai-engkit-db-compat.py|$REPO_ROOT/scripts/ai-engkit-db-compat.py|" \
  -e "s|/opt/ai-engkit/core-baseline/opencode-v1-db.json|$REPO_ROOT/scripts/db-compat-baseline.json|" \
  "$DB_GATE" > "$ENTRYPOINT_TEST_DIR/00-db-compat-gate.sh"
cat > "$ENTRYPOINT_TEST_DIR/01-later.sh" <<SH
#!/usr/bin/env bash
touch "$LATE_MARKER"
SH
chmod +x "$ENTRYPOINT_TEST_DIR/00-db-compat-gate.sh" "$ENTRYPOINT_TEST_DIR/01-later.sh"
HOME="$WORK" PATH="$WORK/stubbin:$PATH" bash "$WORK/entrypoint.sh" openchamber serve >"$WORK/blocked.log" 2>&1 &
BLOCKED_PID=$!
for _ in $(seq 1 100); do grep -qF '[entrypoint] preflight refused startup' "$WORK/blocked.log" && break; sleep 0.02; done
if grep -qF '[entrypoint] preflight refused startup' "$WORK/blocked.log" && kill -0 "$BLOCKED_PID" 2>/dev/null; then
  pass "failed preflight leaves container process blocked"
else
  fail "failed preflight leaves container process blocked"
fi
[ -e "$LATE_MARKER" ] && fail "blocked preflight skips later startup stages" || pass "blocked preflight skips later startup stages"
grep -qF 'refuse_corrupt' "$WORK/blocked.log" && pass "database refusal is logged before blocking" || fail "database refusal is logged before blocking"
kill -TERM "$BLOCKED_PID" 2>/dev/null || true
wait "$BLOCKED_PID" 2>/dev/null; BLOCK_RC=$?
assert_rc0 "blocked startup exits cleanly on TERM" "$BLOCK_RC"
DB_HASH_AFTER="$(sha256sum "$CORRUPT_DB" | cut -d' ' -f1)"
assert_eq "blocked database remains byte-identical" "$DB_HASH_BEFORE" "$DB_HASH_AFTER"

rm -f "$LATE_MARKER"
CLI_HOME="$WORK/cli-home"
CLI_SETTINGS="$CLI_HOME/.config/openchamber/settings.json"
mkdir -p "$(dirname "$CLI_SETTINGS")"
printf '{"opencodeBinary":"%s", broken\n' "$CLI_HOME/.opencode/bin/opencode" > "$CLI_SETTINGS"
CLI_SETTINGS_BEFORE="$(sha256sum "$CLI_SETTINGS" | cut -d' ' -f1)"
cp "$SELECTION_REPAIR" "$ENTRYPOINT_TEST_DIR/00-opencode-selection-repair.sh"
cp "$SELECTION_LIB" "$ENTRYPOINT_TEST_DIR/lib-opencode-selection-repair.bash"
chmod +x "$ENTRYPOINT_TEST_DIR/00-opencode-selection-repair.sh"
HOME="$CLI_HOME" PATH="$WORK/stubbin:$PATH" bash "$WORK/entrypoint.sh" openchamber serve >"$WORK/selection-blocked.log" 2>&1 &
SELECTION_BLOCKED_PID=$!
for _ in $(seq 1 100); do grep -qF '[entrypoint] preflight refused startup' "$WORK/selection-blocked.log" && break; sleep 0.02; done
if grep -qF '[entrypoint] preflight refused startup' "$WORK/selection-blocked.log" && kill -0 "$SELECTION_BLOCKED_PID" 2>/dev/null; then
  pass "CLI-selection refusal leaves container process blocked"
else
  fail "CLI-selection refusal leaves container process blocked"
fi
[ -e "$LATE_MARKER" ] && fail "CLI-selection refusal skips later startup stages" || pass "CLI-selection refusal skips later startup stages"
grep -qF 'refusing malformed settings JSON' "$WORK/selection-blocked.log" && pass "CLI-selection refusal is logged before blocking" || fail "CLI-selection refusal is logged before blocking"
kill -TERM "$SELECTION_BLOCKED_PID" 2>/dev/null || true
wait "$SELECTION_BLOCKED_PID" 2>/dev/null; SELECTION_BLOCK_RC=$?
assert_rc0 "CLI-selection blocked startup exits cleanly on TERM" "$SELECTION_BLOCK_RC"
CLI_SETTINGS_AFTER="$(sha256sum "$CLI_SETTINGS" | cut -d' ' -f1)"
assert_eq "refused settings remain byte-identical" "$CLI_SETTINGS_BEFORE" "$CLI_SETTINGS_AFTER"

echo ""
echo "passed: $PASS    failed: $FAIL    skipped: $SKIP"
[ "$FAIL" -eq 0 ]
