#!/usr/bin/env bash
# test-security-audit-skill.sh — host-only tests for the enable-security-audit
# baked skill (no Docker required).
#
# Verifies the bootstrap contract shared by every enable-xxx skill:
#   - usage / invalid-root handling
#   - first run creates the full vendored tree
#   - second run is a no-op (idempotent)
#   - --force refreshes upstream-owned files
#   - the installed validators actually run
#   - the entrypoint registers the skill for auto-upgrade
#
# Usage: bash test/test-security-audit-skill.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BOOTSTRAP="$REPO_ROOT/.opencode/baked-skills/enable-security-audit/bootstrap.sh"
SKILL_TEMPLATE_DIR="$REPO_ROOT/.opencode/baked-skills/enable-security-audit/skill"
ENTRYPOINT="$REPO_ROOT/entrypoint.d/02-init-config.sh"
SKILL_NAME="security-audit"

PASS=0
FAIL=0
SKIP=0

pass() { PASS=$((PASS + 1)); echo "  PASS $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL $1"; }
skip() { SKIP=$((SKIP + 1)); echo "  SKIP $1"; }

TMP_ROOT="$(mktemp -d)"
cleanup() { rm -rf "$TMP_ROOT"; }
trap cleanup EXIT

count_files() {
  find "$1" -type f 2>/dev/null | wc -l | tr -d ' '
}

summary_field() {
  # summary_field "<output>" "Created"
  printf '%s\n' "$1" | sed -n "s/.*$2: \([0-9][0-9]*\).*/\1/p" | head -n 1
}

# --------------------------------------------------
# 1. Contract: argument and root validation
# --------------------------------------------------
echo "--- Bootstrap contract ---"

if bash "$BOOTSTRAP" >/dev/null 2>&1; then
  fail "bootstrap without an argument should exit non-zero"
else
  pass "bootstrap without an argument exits non-zero"
fi

if bash "$BOOTSTRAP" "$TMP_ROOT/does-not-exist" >/dev/null 2>&1; then
  fail "bootstrap with a missing root should exit non-zero"
else
  pass "bootstrap with a missing root exits non-zero"
fi

if [ -f "$SKILL_TEMPLATE_DIR/SKILL.md.template" ]; then
  pass "vendored skill template is present"
else
  fail "vendored skill template is missing at $SKILL_TEMPLATE_DIR"
fi

TEMPLATE_FILES="$(count_files "$SKILL_TEMPLATE_DIR")"
if [ "$TEMPLATE_FILES" -gt 1 ]; then
  pass "vendored tree has $TEMPLATE_FILES files"
else
  fail "vendored tree looks empty ($TEMPLATE_FILES files)"
fi

# OpenCode's skill discovery walks the whole config directory for SKILL.md.
# A nested SKILL.md under the baked enable skill would register the audit skill
# globally for every project and silently bypass the opt-in gate.
STRAY_SKILL_MD="$(find "$REPO_ROOT/.opencode/baked-skills" -mindepth 3 -name SKILL.md 2>/dev/null | wc -l | tr -d ' ')"
if [ "$STRAY_SKILL_MD" = "0" ]; then
  pass "no nested SKILL.md leaks a baked skill into global discovery"
else
  fail "$STRAY_SKILL_MD nested SKILL.md file(s) under .opencode/baked-skills would be discovered globally"
fi

# --------------------------------------------------
# 2. First run installs the whole tree
# --------------------------------------------------
echo ""
echo "--- First run ---"

PROJECT="$TMP_ROOT/project"
mkdir -p "$PROJECT"
OUTPUT="$(cd / && bash "$BOOTSTRAP" "$PROJECT" 2>&1)"
STATUS=$?

if [ "$STATUS" -eq 0 ]; then
  pass "first run exits zero (works from an unrelated cwd)"
else
  fail "first run exited $STATUS: $OUTPUT"
fi

DEST="$PROJECT/.opencode/skills/$SKILL_NAME"
if [ -f "$DEST/SKILL.md" ]; then
  pass "project SKILL.md created"
else
  fail "project SKILL.md not created"
fi

INSTALLED_FILES="$(count_files "$DEST")"
if [ "$INSTALLED_FILES" = "$TEMPLATE_FILES" ]; then
  pass "project copies every vendored file ($INSTALLED_FILES)"
else
  fail "project has $INSTALLED_FILES files (vendored tree has $TEMPLATE_FILES)"
fi

if grep -q '^name: security-audit$' "$DEST/SKILL.md"; then
  pass "installed SKILL.md frontmatter name is security-audit"
else
  fail "installed SKILL.md frontmatter name is not security-audit"
fi

for required in validate-findings.cjs validate-coverage-ledger.cjs report-schema.json LICENSE; do
  if [ -f "$DEST/$required" ]; then
    pass "required file installed: $required"
  else
    fail "required file missing: $required"
  fi
done

if [ ! -d "$PROJECT/docs/knowledge" ]; then
  pass "bootstrap does not scaffold unrelated project files"
else
  fail "bootstrap created docs/knowledge unexpectedly"
fi

if grep -q "Created: $INSTALLED_FILES, Skipped: 0, Failed: 0" <<< "$OUTPUT"; then
  pass "first run reports $INSTALLED_FILES created"
else
  fail "first run summary unexpected: $(summary_field "$OUTPUT" Created) created"
fi

# --------------------------------------------------
# 3. Second run is a no-op
# --------------------------------------------------
echo ""
echo "--- Idempotency ---"

SECOND="$(bash "$BOOTSTRAP" "$PROJECT" 2>&1)"
SECOND_STATUS=$?
if [ "$SECOND_STATUS" -eq 0 ]; then
  pass "second run exits zero"
else
  fail "second run exited $SECOND_STATUS"
fi

if grep -q "Created: 0, Skipped: $TEMPLATE_FILES, Failed: 0" <<< "$SECOND"; then
  pass "second run skips every existing file"
else
  fail "second run summary unexpected: created=$(summary_field "$SECOND" Created) skipped=$(summary_field "$SECOND" Skipped)"
fi

# --------------------------------------------------
# 4. --force refreshes upstream-owned files
# --------------------------------------------------
echo ""
echo "--- Upgrade path (--force) ---"

printf 'corrupted by local edit\n' > "$DEST/validate-findings.cjs"
FORCED="$(bash "$BOOTSTRAP" --force "$PROJECT" 2>&1)"
FORCE_STATUS=$?
if [ "$FORCE_STATUS" -eq 0 ]; then
  pass "--force exits zero"
else
  fail "--force exited $FORCE_STATUS"
fi

if cmp -s "$DEST/validate-findings.cjs" "$SKILL_TEMPLATE_DIR/validate-findings.cjs"; then
  pass "--force restores a modified vendored file"
else
  fail "--force did not restore the modified vendored file"
fi

if grep -q "Created: $TEMPLATE_FILES, Skipped: 0, Failed: 0" <<< "$FORCED"; then
  pass "--force reports the full tree refreshed"
else
  fail "--force summary unexpected"
fi

# --------------------------------------------------
# 7. AGENTS.md routing note
# --------------------------------------------------
echo ""
echo "--- Routing note ---"

if grep -q '^## Security Skill Routing' "$PROJECT/AGENTS.md" \
  && grep -q '"team_mode": { "enabled": true }' "$PROJECT/AGENTS.md"; then
  pass "bootstrap records the routing note in a fresh project"
else
  fail "AGENTS.md routing note missing or incomplete after first run"
fi

if [ "$(grep -c '^## Security Skill Routing' "$PROJECT/AGENTS.md")" = "1" ]; then
  pass "routing note appears exactly once after repeated runs"
else
  fail "routing note duplicated across runs"
fi

SEEDED="$TMP_ROOT/seeded"
mkdir -p "$SEEDED"
printf 'my notes, no trailing newline' > "$SEEDED/AGENTS.md"
bash "$BOOTSTRAP" "$SEEDED" >/dev/null 2>&1
if grep -q '^my notes, no trailing newline$' "$SEEDED/AGENTS.md" \
  && grep -q '^## Security Skill Routing' "$SEEDED/AGENTS.md"; then
  pass "pre-existing AGENTS.md content survives with the note separated"
else
  fail "seeded AGENTS.md was damaged or the note is missing"
fi

bash "$BOOTSTRAP" --force "$SEEDED" >/dev/null 2>&1
if [ "$(grep -c '^## Security Skill Routing' "$SEEDED/AGENTS.md")" = "1" ] \
  && grep -q '^my notes, no trailing newline$' "$SEEDED/AGENTS.md"; then
  pass "--force preserves user content and does not duplicate the note"
else
  fail "--force damaged AGENTS.md"
fi

# --------------------------------------------------
# 5. Installed validators run
# --------------------------------------------------
echo ""
echo "--- Installed validators ---"

printf '[]' > "$TMP_ROOT/findings.json"
if command -v node >/dev/null 2>&1; then
  if (cd "$DEST" && node validate-findings.cjs "$TMP_ROOT/findings.json" >/dev/null 2>&1); then
    pass "node runs validate-findings.cjs on an empty record set"
  else
    fail "node failed to run validate-findings.cjs"
  fi
else
  skip "node not available"
fi

if command -v bun >/dev/null 2>&1; then
  if (cd "$DEST" && bun test validate-findings.test.cjs validate-coverage-ledger.test.cjs >/dev/null 2>&1); then
    pass "upstream validator test suites pass under bun"
  else
    fail "upstream validator test suites failed under bun"
  fi
else
  skip "bun not available (cannot run upstream validator tests)"
fi

# --------------------------------------------------
# 6. Entrypoint auto-upgrade registration
# --------------------------------------------------
echo ""
echo "--- Auto-upgrade registration ---"

if grep -q '"security-audit:\$SKILLS_ROOT/enable-security-audit"' "$ENTRYPOINT"; then
  pass "entrypoint registers security-audit for auto-upgrade"
else
  fail "entrypoint does not register security-audit in UPGRADEABLE_SKILLS"
fi

VERSION="$(grep 'skill-version:' "$BOOTSTRAP" | head -1 | sed 's/.*skill-version:[[:space:]]*//;s/[[:space:]]*-->//')"
if [ -n "$VERSION" ]; then
  pass "bootstrap declares skill-version $VERSION"
else
  fail "bootstrap has no skill-version marker (auto-upgrade cannot detect changes)"
fi

if grep -q "^# <!-- skill-version:" "$BOOTSTRAP"; then
  pass "skill-version marker is on a comment line (not emitted as output)"
else
  fail "skill-version marker is not comment-prefixed"
fi

# --------------------------------------------------
# Summary
# --------------------------------------------------
echo ""
echo "============================================"
echo " security-audit enable skill: $PASS passed, $FAIL failed, $SKIP skipped"
echo "============================================"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
