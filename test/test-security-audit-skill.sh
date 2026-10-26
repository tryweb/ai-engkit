#!/usr/bin/env bash
# test-security-audit-skill.sh — host tests for enable-security-audit (V2)
#
# Covers: vendored tree shape, SKILL.md.template guard, bootstrap install /
# idempotency / --force refresh / AGENTS.md routing note, validators, and
# admin + entrypoint wiring. Run: bash test/test-security-audit-skill.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BAKED="$REPO_ROOT/.opencode/baked-skills/enable-security-audit"
BOOTSTRAP="$BAKED/bootstrap.sh"
SKILL_DIR="$BAKED/skill"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "PASS $1"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL $1${2:+ ($2)}"; }

# --- 1-11: vendored tree shape ------------------------------------------------
[ -f "$BAKED/SKILL.md" ] && pass "baked SKILL.md exists" || fail "baked SKILL.md exists"
[ -x "$BOOTSTRAP" ] && pass "bootstrap.sh executable" || fail "bootstrap.sh executable"
[ -f "$BAKED/UPSTREAM.md" ] && pass "UPSTREAM.md exists" || fail "UPSTREAM.md exists"
[ -f "$SKILL_DIR/SKILL.md.template" ] && pass "SKILL.md.template exists" || fail "SKILL.md.template exists"
[ -f "$SKILL_DIR/LICENSE" ] && pass "LICENSE vendored" || fail "LICENSE vendored"
file_count="$(find "$SKILL_DIR" -type f | wc -l | tr -d ' ')"
[ "$file_count" = "21" ] && pass "skill tree has 21 files" || fail "skill tree has 21 files" "found=$file_count"
if [ -z "$(find "$SKILL_DIR" -name 'SKILL.md' -print -quit)" ]; then
  pass "no live SKILL.md under skill/ (template guard)"
else
  fail "no live SKILL.md under skill/ (template guard)"
fi
[ -x "$SKILL_DIR/validate-findings.cjs" ] && pass "validate-findings.cjs executable" || fail "validate-findings.cjs executable"
[ -x "$SKILL_DIR/validate-coverage-ledger.cjs" ] && pass "validate-coverage-ledger.cjs executable" || fail "validate-coverage-ledger.cjs executable"
grep -q 'skill-version:' "$BOOTSTRAP" && pass "bootstrap carries skill-version" || fail "bootstrap carries skill-version"
grep -q 'c1c8a8c' "$BAKED/UPSTREAM.md" && pass "UPSTREAM pins c1c8a8c" || fail "UPSTREAM pins c1c8a8c"

# --- 12-13: usage errors ------------------------------------------------------
if bash "$BOOTSTRAP" >/dev/null 2>&1; then
  fail "bootstrap without args exits non-zero"
else
  pass "bootstrap without args exits non-zero"
fi
if bash "$BOOTSTRAP" /does/not/exist >/dev/null 2>&1; then
  fail "bootstrap on missing dir exits non-zero"
else
  pass "bootstrap on missing dir exits non-zero"
fi

# --- 14-20: fresh install -----------------------------------------------------
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
bash "$BOOTSTRAP" "$WORK/proj" >/dev/null 2>&1 && fail "bootstrap rejects missing project root" || pass "bootstrap rejects missing project root"
mkdir -p "$WORK/proj"
bash "$BOOTSTRAP" "$WORK/proj" >/dev/null 2>&1 || fail "fresh bootstrap exits zero"
installed="$(find "$WORK/proj/.opencode/skills/security-audit" -type f | wc -l | tr -d ' ')"
[ "$installed" = "21" ] && pass "fresh install writes 21 files" || fail "fresh install writes 21 files" "found=$installed"
[ -f "$WORK/proj/.opencode/skills/security-audit/SKILL.md" ] && pass "installed SKILL.md restored" || fail "installed SKILL.md restored"
grep -q 'skill-version:' "$WORK/proj/.opencode/skills/security-audit/SKILL.md" && pass "installed SKILL.md carries version" || fail "installed SKILL.md carries version"
[ -f "$WORK/proj/AGENTS.md" ] && pass "AGENTS.md created" || fail "AGENTS.md created"
note_count="$(grep -c 'security-audit-routing' "$WORK/proj/AGENTS.md")"
[ "$note_count" = "2" ] && pass "routing note present exactly once" || fail "routing note present exactly once" "markers=$note_count"
if grep -q 'team_mode.enabled=true' "$WORK/proj/AGENTS.md"; then
  fail "routing note requires no team_mode toggle (V2)"
else
  pass "routing note requires no team_mode toggle (V2)"
fi
grep -q 'native subagents' "$WORK/proj/AGENTS.md" && pass "routing note points to native subagents" || fail "routing note points to native subagents"

# --- 21-24: idempotency -------------------------------------------------------
second_out="$(bash "$BOOTSTRAP" "$WORK/proj" 2>&1)"
echo "$second_out" | grep -qi 'already enabled' && pass "second run reports already enabled" || fail "second run reports already enabled"
note_count2="$(grep -c 'security-audit-routing' "$WORK/proj/AGENTS.md")"
[ "$note_count2" = "2" ] && pass "note not duplicated on re-run" || fail "note not duplicated on re-run" "markers=$note_count2"
echo "hand edit" >> "$WORK/proj/.opencode/skills/security-audit/HUNTING.md"
bash "$BOOTSTRAP" "$WORK/proj" >/dev/null 2>&1
tail -1 "$WORK/proj/.opencode/skills/security-audit/HUNTING.md" | grep -q 'hand edit' \
  && pass "re-run without --force preserves hand edits" \
  || fail "re-run without --force preserves hand edits"

# --- 25-27: pre-existing content + --force ------------------------------------
mkdir -p "$WORK/pre"
printf '# My project\n' > "$WORK/pre/AGENTS.md"
bash "$BOOTSTRAP" "$WORK/pre" >/dev/null 2>&1
grep -q '# My project' "$WORK/pre/AGENTS.md" && pass "pre-existing AGENTS.md preserved" || fail "pre-existing AGENTS.md preserved"
[ "$(grep -c 'security-audit-routing' "$WORK/pre/AGENTS.md")" = "2" ] && pass "note appended exactly once" || fail "note appended exactly once"
bash "$BOOTSTRAP" --force "$WORK/pre" >/dev/null 2>&1
[ "$(grep -c 'security-audit-routing' "$WORK/pre/AGENTS.md")" = "2" ] && pass "--force keeps single note copy" || fail "--force keeps single note copy"
grep -q '# My project' "$WORK/pre/AGENTS.md" && pass "--force preserves user content" || fail "--force preserves user content"
tail -1 "$WORK/proj/.opencode/skills/security-audit/HUNTING.md" | grep -q 'hand edit' || fail "--force precondition (hand edit present)"
bash "$BOOTSTRAP" --force "$WORK/proj" >/dev/null 2>&1
tail -1 "$WORK/proj/.opencode/skills/security-audit/HUNTING.md" | grep -q 'hand edit' \
  && fail "--force refreshes hand-edited tree" \
  || pass "--force refreshes hand-edited tree"

# --- 28-29 + wiring ------------------------------------------------------------
python3 -c 'import json;json.load(open("'"$SKILL_DIR"'/report-schema.json"))' 2>/dev/null \
  && pass "report-schema.json is valid JSON" \
  || fail "report-schema.json is valid JSON"
grep -q '"security-audit:$SKILLS_ROOT/enable-security-audit"' "$REPO_ROOT/entrypoint.d/02-init-config.sh" \
  && pass "entrypoint registers security-audit upgrade" \
  || fail "entrypoint registers security-audit upgrade"
grep -q '"security-audit"' "$REPO_ROOT/src/admin/lib/projects.ts" \
  && pass "admin PROJECT_FEATURES includes security-audit" \
  || fail "admin PROJECT_FEATURES includes security-audit"
grep -q 'security-audit' "$REPO_ROOT/src/admin/static/projects-page.js" \
  && pass "admin frontend lists security-audit" \
  || fail "admin frontend lists security-audit"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -gt 0 ] && exit 1
exit 0
