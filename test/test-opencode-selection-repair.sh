#!/usr/bin/env bash
# test-opencode-selection-repair.sh — deterministic harness for the narrow
# managed OpenChamber `opencodeBinary` selection repair (tasks 5.1-5.4).
#
# Contract covered:
#   * a stale/missing managed legacy selection is repaired atomically with a
#     protected, first-wins backup                             5.1
#   * unrelated JSON values and the settings file mode survive  5.2
#   * a valid custom selection is left byte-for-byte intact     5.2
#   * an unknown missing custom path is refused, not overwritten 5.3
#   * a custom v2 executable, malformed JSON, and a symlinked    5.4
#     settings file are refused without replacing anything
#   * absent/empty selection uses managed PATH; the compat wrapper resolves 5.4
#
# Exits 0 when all cases pass, 1 otherwise.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="$REPO_ROOT/entrypoint.d/lib-opencode-selection-repair.bash"
STAGE="$REPO_ROOT/entrypoint.d/00-opencode-selection-repair.sh"
PATH_STAGE="$REPO_ROOT/entrypoint.d/06-setup-opencode-path.sh"

PASS=0
FAIL=0
RED='\033[0;31m'; GREEN='\033[0;32m'; NC='\033[0m'
pass() { PASS=$((PASS + 1)); echo -e "  ${GREEN}PASS${NC} $1"; }
fail() { FAIL=$((FAIL + 1)); echo -e "  ${RED}FAIL${NC} $1"; }
assert_eq() { local l="$1" e="$2" a="$3"; [ "$e" = "$a" ] && pass "$l" || fail "$l (expected='$e', actual='$a')"; }
assert_rc0() { local l="$1" rc="$2"; [ "$rc" -eq 0 ] && pass "$l" || fail "$l (rc=$rc)"; }
assert_rcnz() { local l="$1" rc="$2"; [ "$rc" -ne 0 ] && pass "$l" || fail "$l (rc=0)"; }

for tool in jq timeout stat; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: $tool is required" >&2; exit 2; }
done
[ -f "$LIB" ] || { echo "ERROR: missing helper: $LIB" >&2; exit 2; }
[ -f "$STAGE" ] || { echo "ERROR: missing stage: $STAGE" >&2; exit 2; }
[ -f "$PATH_STAGE" ] || { echo "ERROR: missing path stage: $PATH_STAGE" >&2; exit 2; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/opencode-selection.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# Isolate $HOME so the legacy/compat paths resolve inside the disposable tree.
export HOME="$WORK/home"
mkdir -p "$HOME/.config/openchamber"
SETTINGS="$HOME/.config/openchamber/settings.json"

# Deterministic managed launcher (a stand-in for /opt/ai-engkit/core/bin/opencode)
# and the compatibility wrapper the old image used.
MANAGED="$WORK/core/bin/opencode"
mkdir -p "$(dirname "$MANAGED")"
printf '#!/usr/bin/env bash\nprintf "1.19.0\\n"\n' > "$MANAGED"
chmod 755 "$MANAGED"
mkdir -p "$HOME/.bun/bin"
ln -s "$MANAGED" "$HOME/.bun/bin/opencode"

# shellcheck source=../entrypoint.d/lib-opencode-selection-repair.bash
source "$LIB"

write_settings() { # $1=opencodeBinary value or __ABSENT__ ; extra body via $2
  local value="$1" extra="${2:-}"
  if [ "$value" = "__ABSENT__" ]; then
    printf '{"defaultModel":"opencode/big-pickle","showOpenCodeUpdateNotifications":false%s}\n' "$extra" > "$SETTINGS"
  else
    printf '{"defaultModel":"opencode/big-pickle","showOpenCodeUpdateNotifications":false,"opencodeBinary":"%s"%s}\n' "$value" "$extra" > "$SETTINGS"
  fi
}

echo "== A. absent / empty selection uses managed PATH lookup (5.4) =="
rm -f "$SETTINGS"
ensure_managed_opencode_selection "$SETTINGS" "$MANAGED" >/dev/null 2>&1
assert_rc0 "missing settings file is a no-op" "$?"
[ -e "$SETTINGS" ] && fail "missing settings file not created" || pass "missing settings file not created"

write_settings "__ABSENT__"
BEFORE="$(cat "$SETTINGS")"
ensure_managed_opencode_selection "$SETTINGS" "$MANAGED" >/dev/null 2>&1
assert_rc0 "absent key uses managed PATH" "$?"
assert_eq "absent key leaves the file unchanged" "$BEFORE" "$(cat "$SETTINGS")"

write_settings ""
BEFORE="$(cat "$SETTINGS")"
ensure_managed_opencode_selection "$SETTINGS" "$MANAGED" >/dev/null 2>&1
assert_rc0 "empty selection uses managed PATH" "$?"
assert_eq "empty selection leaves the file unchanged" "$BEFORE" "$(cat "$SETTINGS")"

write_settings "__ABSENT__" ',"opencodeBinary":123'
BEFORE="$(cat "$SETTINGS")"
ensure_managed_opencode_selection "$SETTINGS" "$MANAGED" >/dev/null 2>&1
assert_rc0 "non-string selection uses managed PATH" "$?"
assert_eq "non-string selection leaves the file unchanged" "$BEFORE" "$(cat "$SETTINGS")"

echo "== B. stale managed legacy selection repaired with protected backup (5.1) =="
write_settings "$HOME/.opencode/bin/opencode" ',"projects":[{"id":"p1","path":"/w/p1"}],"activeProjectId":"p1"'
chmod 640 "$SETTINGS"
MODE_BEFORE="$(stat -c '%a' "$SETTINGS")"
rm -f "${SETTINGS}.ai-engkit-backup"
ensure_managed_opencode_selection "$SETTINGS" "$MANAGED" >/dev/null 2>&1
assert_rc0 "stale legacy managed selection repaired" "$?"
assert_eq "selection rewritten to managed launcher" "$MANAGED" "$(jq -r '.opencodeBinary' "$SETTINGS")"
assert_eq "managed selection resolves" "1.19.0" "$(timeout 10 "$(jq -r '.opencodeBinary' "$SETTINGS")" --version 2>/dev/null)"

echo "== C. unrelated fields and file mode preserved (5.2) =="
assert_eq "defaultModel preserved" "opencode/big-pickle" "$(jq -r '.defaultModel' "$SETTINGS")"
assert_eq "notification flag preserved" "false" "$(jq -r '.showOpenCodeUpdateNotifications' "$SETTINGS")"
assert_eq "projects preserved" "p1" "$(jq -r '.projects[0].id' "$SETTINGS")"
assert_eq "activeProjectId preserved" "p1" "$(jq -r '.activeProjectId' "$SETTINGS")"
assert_eq "file mode preserved" "$MODE_BEFORE" "$(stat -c '%a' "$SETTINGS")"

echo "== D. backup is protected and idempotent (5.1/5.4) =="
BACKUP="${SETTINGS}.ai-engkit-backup"
rm -f "$BACKUP"
write_settings "$HOME/.opencode/bin/opencode"
BACKUP_TARGET="$WORK/backup-target"
printf 'preserve mode\n' > "$BACKUP_TARGET"
chmod 644 "$BACKUP_TARGET"
ln -s "$BACKUP_TARGET" "$BACKUP"
BEFORE="$(cat "$SETTINGS")"
ensure_managed_opencode_selection "$SETTINGS" "$MANAGED" >/dev/null 2>&1
assert_rcnz "symlinked backup path refused" "$?"
assert_eq "symlinked backup path leaves settings untouched" "$BEFORE" "$(cat "$SETTINGS")"
assert_eq "symlink target mode is preserved" "644" "$(stat -c '%a' "$BACKUP_TARGET")"
[ -L "$BACKUP" ] && pass "symlinked backup remains untouched" || fail "symlinked backup remains untouched"
rm -f "$BACKUP"
ensure_managed_opencode_selection "$SETTINGS" "$MANAGED" >/dev/null 2>&1
assert_rc0 "repair succeeds after unsafe backup path is removed" "$?"
[ -f "$BACKUP" ] && pass "backup created" || fail "backup created"
assert_eq "backup preserves the legacy selection" "$HOME/.opencode/bin/opencode" "$(jq -r '.opencodeBinary' "$BACKUP")"
assert_eq "backup mode is protected 600" "600" "$(stat -c '%a' "$BACKUP")"
BACKUP_SUM="$(sha256sum "$BACKUP" | cut -d' ' -f1)"
SETTINGS_SUM="$(sha256sum "$SETTINGS" | cut -d' ' -f1)"
ensure_managed_opencode_selection "$SETTINGS" "$MANAGED" >/dev/null 2>&1
assert_rc0 "second run on repaired selection is clean" "$?"
assert_eq "second run creates no new backup contents" "$BACKUP_SUM" "$(sha256sum "$BACKUP" | cut -d' ' -f1)"
assert_eq "second run changes no settings bytes" "$SETTINGS_SUM" "$(sha256sum "$SETTINGS" | cut -d' ' -f1)"

echo "== E. compat wrapper and managed launcher selections are left alone (5.4) =="
write_settings "$HOME/.bun/bin/opencode"
BEFORE="$(cat "$SETTINGS")"
ensure_managed_opencode_selection "$SETTINGS" "$MANAGED" >/dev/null 2>&1
assert_rc0 "compat wrapper selection accepted" "$?"
assert_eq "compat wrapper selection unchanged" "$BEFORE" "$(cat "$SETTINGS")"
assert_eq "old image wrapper still resolves" "1.19.0" "$(timeout 10 "$HOME/.bun/bin/opencode" --version 2>/dev/null)"

write_settings "$MANAGED"
BEFORE="$(cat "$SETTINGS")"
ensure_managed_opencode_selection "$SETTINGS" "$MANAGED" >/dev/null 2>&1
assert_rc0 "current managed selection accepted" "$?"
assert_eq "current managed selection unchanged" "$BEFORE" "$(cat "$SETTINGS")"

echo "== F. valid custom v1 selection is preserved byte-for-byte (5.2) =="
CUSTOM_V1="$WORK/custom/v1/opencode"
mkdir -p "$(dirname "$CUSTOM_V1")"
printf '#!/usr/bin/env bash\nprintf "1.19.0\\n"\n' > "$CUSTOM_V1"
chmod 755 "$CUSTOM_V1"
write_settings "$CUSTOM_V1"
chmod 600 "$SETTINGS"
BEFORE="$(cat "$SETTINGS")"
MODE_BEFORE="$(stat -c '%a' "$SETTINGS")"
rm -f "$BACKUP"
ensure_managed_opencode_selection "$SETTINGS" "$MANAGED" >/dev/null 2>&1
assert_rc0 "valid custom selection accepted" "$?"
assert_eq "custom selection bytes unchanged" "$BEFORE" "$(cat "$SETTINGS")"
assert_eq "custom selection mode unchanged" "$MODE_BEFORE" "$(stat -c '%a' "$SETTINGS")"
[ -e "$BACKUP" ] && fail "no backup for preserved custom selection" || pass "no backup for preserved custom selection"

echo "== G. unknown missing custom path is refused, not overwritten (5.3) =="
write_settings "$WORK/custom/missing/opencode"
BEFORE="$(cat "$SETTINGS")"
ensure_managed_opencode_selection "$SETTINGS" "$MANAGED" >/dev/null 2>&1
assert_rcnz "unknown missing custom path refused" "$?"
assert_eq "unknown missing custom path left untouched" "$BEFORE" "$(cat "$SETTINGS")"

echo "== H. custom v2 executable is refused and preserved (5.4) =="
CUSTOM_V2="$WORK/custom/v2/opencode"
mkdir -p "$(dirname "$CUSTOM_V2")"
printf '#!/usr/bin/env bash\nprintf "2.0.30\\n"\n' > "$CUSTOM_V2"
chmod 755 "$CUSTOM_V2"
write_settings "$CUSTOM_V2"
BEFORE="$(cat "$SETTINGS")"
ensure_managed_opencode_selection "$SETTINGS" "$MANAGED" >/dev/null 2>&1
assert_rcnz "custom v2 executable refused" "$?"
assert_eq "custom v2 selection left untouched" "$BEFORE" "$(cat "$SETTINGS")"

echo "== I. malformed JSON and symlinked settings are refused (5.4) =="
printf '{"opencodeBinary": "%s", broken\n' "$HOME/.opencode/bin/opencode" > "$SETTINGS"
BEFORE="$(cat "$SETTINGS")"
ensure_managed_opencode_selection "$SETTINGS" "$MANAGED" >/dev/null 2>&1
assert_rcnz "malformed JSON refused" "$?"
assert_eq "malformed JSON left untouched" "$BEFORE" "$(cat "$SETTINGS")"

REAL_SETTINGS="$WORK/real-settings.json"
write_settings "$HOME/.opencode/bin/opencode"
cp "$SETTINGS" "$REAL_SETTINGS"
TARGET_SUM="$(sha256sum "$REAL_SETTINGS" | cut -d' ' -f1)"
ln -sf "$REAL_SETTINGS" "$SETTINGS"
ensure_managed_opencode_selection "$SETTINGS" "$MANAGED" >/dev/null 2>&1
assert_rcnz "symlinked settings refused" "$?"
[ -L "$SETTINGS" ] && pass "symlink preserved" || fail "symlink preserved"
assert_eq "symlink target left untouched" "$TARGET_SUM" "$(sha256sum "$REAL_SETTINGS" | cut -d' ' -f1)"

echo "== J. startup wiring sources the repair and skips ai-admin (5.1) =="
grep -qF 'ensure_managed_opencode_selection' "$STAGE" && pass "stage invokes the repair" || fail "stage invokes the repair"
grep -qF 'lib-opencode-selection-repair.bash' "$STAGE" && pass "stage sources the helper" || fail "stage sources the helper"
grep -qF 'AI_ENGKIT_BOOT_ROLE:-ai-dev' "$STAGE" && pass "stage guards on boot role" || fail "stage guards on boot role"
# The PATH ordering block must be unchanged.
grep -qF 'export PATH="/opt/ai-engkit/core/bin:$PATH"' "$PATH_STAGE" \
  && grep -qF 'export PATH="$HOME/.bun/bin:$PATH"' "$PATH_STAGE" \
  && pass "PATH ordering unchanged" || fail "PATH ordering unchanged"

echo "== K. real stage refuses ai-dev but stays available for ai-admin (5.1/5.3) =="
STAGE_HOME="$WORK/stagehome"
mkdir -p "$STAGE_HOME/.config/openchamber"
printf '{"opencodeBinary": "%s", broken\n' "$STAGE_HOME/.opencode/bin/opencode" > "$STAGE_HOME/.config/openchamber/settings.json"
STAGE_BEFORE="$(cat "$STAGE_HOME/.config/openchamber/settings.json")"
( HOME="$STAGE_HOME" AI_ENGKIT_BOOT_ROLE=ai-dev bash "$STAGE" ) >/dev/null 2>&1
assert_rcnz "ai-dev stage refuses malformed settings" "$?"
assert_eq "ai-dev refusal leaves settings untouched" "$STAGE_BEFORE" "$(cat "$STAGE_HOME/.config/openchamber/settings.json")"
( HOME="$STAGE_HOME" AI_ENGKIT_BOOT_ROLE=ai-admin bash "$STAGE" ) >/dev/null 2>&1
assert_rc0 "ai-admin stage skips the repair and stays available" "$?"
assert_eq "ai-admin leaves settings untouched" "$STAGE_BEFORE" "$(cat "$STAGE_HOME/.config/openchamber/settings.json")"

echo ""
echo "passed: $PASS    failed: $FAIL"
[ "$FAIL" -eq 0 ]
