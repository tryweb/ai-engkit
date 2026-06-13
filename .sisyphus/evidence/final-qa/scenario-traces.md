# Decision Matrix Scenario Traces

**Workflow:** `.github/workflows/dependency-update.yml` (893 lines)
**Date:** 2026-06-13
**Traced by:** Manual QA — line-by-line conditional analysis

---

## Control Flow Reference

```
Job Gates:
  build-and-test.if  = needs.check-versions.outputs.updates-needed == 'true'     (L344)
  handle-updates.if  = always() && (updates-needed == 'true' || check-failed == 'true')  (L437)

check-versions outputs (L27-33):
  updates-needed          = dockerfile_changes_needed || latest_changes_detected || apt_updates_needed  (L284)
  dockerfile-changes-needed = any pinned ARG has version_gt(current, latest)  (L214-215)
  latest-changes-detected   = any latest-tracked pkg differs from snapshot  (L242-265)
  check-failed              = check_failures >= total_checks (all 10 failed)  (L290-291)

Decision tree (L475-490):
  1. CHECK_FAILED == "true"                                    → warning-issue
  2. DOCKERFILE_CHANGES == "true" && TEST_RESULT == "success"  → create-pr
  3. DOCKERFILE_CHANGES == "true" && TEST_RESULT != "success"  → create-issue
  4. TEST_RESULT != "success"                                  → create-issue
  5. else                                                      → auto-release
```

---

## Scenario 1: Everything Current

**Inputs:** dockerfile-changes-needed=false, latest-changes-detected=false, apt-up-to-date
**Expected:** No action (workflow exits early)

### Trace
1. `check-versions` job runs. No pinned version has `version_gt` → `dockerfile_changes_needed=false` (L186)
2. Latest-tracked packages match snapshot → `latest_changes_detected=false`
3. `apt_summary="All packages are up to date"` → `apt_updates_needed=false` (L283)
4. `updates_needed = false || false || false = false` (L284-286)
5. `check-failed` not set (not all checks failed)
6. **Output:** `updates-needed=false`, `check-failed` unset

**Job gates:**
- `build-and-test.if`: `'false' == 'true'` → **SKIPPED**
- `handle-updates.if`: `always() && ('false' == 'true' || '' == 'true')` → `always() && false` → **SKIPPED**

**Actual:** Both downstream jobs skipped. Only version snapshot uploaded.
**Result:** ✅ PASS

---

## Scenario 2: Pinned Version Outdated + Tests Pass

**Inputs:** dockerfile-changes-needed=true (e.g., DOCKER_VERSION outdated), tests pass
**Expected:** action=create-pr

### Trace
1. `check-versions`: `version_gt` returns true for at least one pinned ARG → `dockerfile_changes_needed=true` (L215)
2. `updates_needed = true || ... = true` (L284)
3. `check-failed` not set (not all checks failed)
4. **Output:** `updates-needed=true`, `dockerfile-changes-needed=true`

**Job gates:**
- `build-and-test.if`: `'true' == 'true'` → **RUNS**
- Build uses `build-args` step (L356-378): iterates `pinned-updates` JSON, adds changed ARGs → only changed versions passed ✓
- Tests pass → `build-and-test.result = 'success'`
- `handle-updates.if`: `always() && ('true' == 'true' || ...)` → **RUNS**

**Decision tree (L475-490):**
1. `CHECK_FAILED == "true"`? No (unset) → skip
2. `DOCKERFILE_CHANGES == "true" && TEST_RESULT == "success"`? **YES** → `action=create-pr` (L479)

**Downstream steps:**
- L494: `Update Dockerfile version ARGs` runs — `sed -i` updates each changed ARG in Dockerfile
- L520: `Create Pull Request` runs — creates PR with version summary

**Actual:** `action=create-pr`
**Result:** ✅ PASS

---

## Scenario 3: Pinned Version Outdated + Tests Fail

**Inputs:** dockerfile-changes-needed=true, tests fail
**Expected:** action=create-issue

### Trace
1. `check-versions`: same as Scenario 2 → `dockerfile_changes_needed=true`, `updates_needed=true`
2. `build-and-test` runs, tests fail → `build-and-test.result = 'failure'`
3. `handle-updates` runs (same gate as Scenario 2)

**Decision tree:**
1. `CHECK_FAILED == "true"`? No → skip
2. `DOCKERFILE_CHANGES == "true" && TEST_RESULT == "success"`? No (`failure != success`) → skip
3. `DOCKERFILE_CHANGES == "true" && TEST_RESULT != "success"`? **YES** → `action=create-issue` (L482)

**Downstream steps:**
- L781: `Create issue for failures` runs — checks for duplicate, creates issue with test output

**Actual:** `action=create-issue`
**Result:** ✅ PASS

---

## Scenario 4: Only Latest Changed + Tests Pass

**Inputs:** dockerfile-changes-needed=false, latest-changes-detected=true, tests pass
**Expected:** action=auto-release

### Trace
1. `check-versions`: No pinned ARG outdated → `dockerfile_changes_needed=false`
2. Latest-tracked package differs from snapshot → `latest_changes_detected=true`
3. `updates_needed = false || true || ... = true` (L284)
4. `build-and-test` runs, tests pass → `result = 'success'`
5. `handle-updates` runs

**Decision tree:**
1. `CHECK_FAILED == "true"`? No → skip
2. `DOCKERFILE_CHANGES == "true" && ...`? No (`false != true`) → skip
3. `DOCKERFILE_CHANGES == "true" && ...`? No → skip
4. `TEST_RESULT != "success"`? No (`success == success`) → skip
5. **else** → `action=auto-release` (L488)

**Downstream steps:**
- L551-566: `Determine next version` — finds latest tag, bumps patch
- L567-584: `Extract current package versions` — reads Dockerfile ARGs
- L586-598: `Update README badges` — sed updates badge versions
- L600-660: `Update CHANGELOG` — inserts new version section
- L662-676: `Commit release changes` — commits README + CHANGELOG
- L678-685: `Login to GHCR` — with `continue-on-error: true`
- L687-696: `Build and push image to GHCR`
- L697-717: `Tag and push release` — tracks BRANCH_PUSH/TAG_PUSH
- L719-751: `Create GitHub Release` (if push-success=true)
- L753-778: `Fallback to PR` (if push-success=false)

**Actual:** `action=auto-release`
**Result:** ✅ PASS

---

## Scenario 5: Only Latest Changed + Tests Fail

**Inputs:** dockerfile-changes-needed=false, latest-changes-detected=true, tests fail
**Expected:** action=create-issue

### Trace
1. `check-versions`: `dockerfile_changes_needed=false`, `latest_changes_detected=true`
2. `updates_needed=true` → `build-and-test` runs, fails → `result = 'failure'`
3. `handle-updates` runs

**Decision tree:**
1. `CHECK_FAILED == "true"`? No → skip
2. `DOCKERFILE_CHANGES == "true" && ...`? No → skip
3. `DOCKERFILE_CHANGES == "true" && ...`? No → skip
4. `TEST_RESULT != "success"`? **YES** (`failure != success`) → `action=create-issue` (L485)

**Actual:** `action=create-issue`
**Result:** ✅ PASS

---

## Scenario 6: Only APT Updates + Tests Pass

**Inputs:** dockerfile-changes-needed=false, latest-changes-detected=false, apt has updates, tests pass
**Expected:** action=auto-release

### Trace
1. `check-versions`: `dockerfile_changes_needed=false`, `latest_changes_detected=false`
2. `apt_summary` contains package count → `apt_updates_needed=true` (L283)
3. `updates_needed = false || false || true = true` (L284)
4. `build-and-test` runs (L344: `updates-needed == 'true'`), tests pass → `result = 'success'`
5. `handle-updates` runs

**Decision tree:**
1. `CHECK_FAILED == "true"`? No → skip
2. `DOCKERFILE_CHANGES == "true" && ...`? No → skip
3. `DOCKERFILE_CHANGES == "true" && ...`? No → skip
4. `TEST_RESULT != "success"`? No → skip
5. **else** → `action=auto-release` (L488)

**Note:** Build uses `UPGRADE_PACKAGES=true` as the only build arg (no pinned changes), which triggers apt upgrade in the Dockerfile.

**Actual:** `action=auto-release`
**Result:** ✅ PASS

---

## Scenario 7: Only APT Updates + Tests Fail

**Inputs:** dockerfile-changes-needed=false, latest-changes-detected=false, apt has updates, tests fail
**Expected:** action=create-issue

### Trace
1. Same as Scenario 6 through `updates_needed=true`
2. `build-and-test` runs, tests fail → `result = 'failure'`
3. `handle-updates` runs

**Decision tree:**
1. `CHECK_FAILED == "true"`? No → skip
2. `DOCKERFILE_CHANGES == "true" && ...`? No → skip
3. `DOCKERFILE_CHANGES == "true" && ...`? No → skip
4. `TEST_RESULT != "success"`? **YES** → `action=create-issue` (L485)

**Actual:** `action=create-issue`
**Result:** ✅ PASS

---

## Scenario 8: All Version Checks Failed

**Inputs:** All 10 version checks return "unknown" (check_failures >= total_checks)
**Expected:** action=warning-issue

### Trace
1. `check-versions`: Every `get_github_tag`/`get_npm_version` returns "unknown"
2. Each pinned check hits `continue` at L211 → `dockerfile_changes_needed` stays `false`
3. Each latest check hits `continue` at L249-250 → `latest_changes_detected` stays `false`
4. `check_failures = 10`, `total_checks = 7 + 3 = 10` → `check_failures >= total_checks` → `check-failed=true` (L291)
5. `updates_needed` depends on apt: could be `true` or `false`

**Job gates:**
- `build-and-test.if`: depends on `updates-needed` — may or may not run
- `handle-updates.if`: `always() && (updates-needed == 'true' || check-failed == 'true')` → **RUNS** (because `check-failed == 'true'`)

**Decision tree:**
1. `CHECK_FAILED == "true"`? **YES** → `action=warning-issue` (L476)

**Note:** Even if `build-and-test` was skipped (TEST_RESULT='skipped'), the `CHECK_FAILED` check comes first in the decision tree, so it's correctly handled regardless.

**Downstream steps:**
- L847-892: `Create warning issue for check failures` — checks for duplicate with title containing "version check failures", creates issue about API/registry failures

**Actual:** `action=warning-issue`
**Result:** ✅ PASS

---

## Edge Cases

### Edge Case 1: First Run (No Previous Artifact)

**Trace:**
- L46-48: `gh run list` finds no successful runs → `LAST_RUN=""` → download skipped
- L50-55: `version-snapshot.json` doesn't exist → `snapshot-found=false`
- L242-246: For each latest-tracked package: `[[ ! -f "version-snapshot.json" ]]` is true → `latest_changes_detected=true`, status="changed", previous="missing"
- This means `updates_needed=true` → build-and-test runs

**Expected behavior:** All latest packages treated as changed → triggers build+test → if tests pass, auto-release (no Dockerfile changes)
**Result:** ✅ PASS — Correctly handles first run by treating all latest as changed

### Edge Case 2: npm view Timeout

**Trace:**
- L105: `timeout 10 npm view "$pkg" version 2>/dev/null || true`
- If npm hangs, `timeout 10` kills it after 10 seconds
- The `|| true` prevents `set -euo pipefail` from exiting
- `version=""` → L107: empty check → prints "unknown"
- L208-211: `latest == "unknown"` → `warn` + `check_failures++` + `continue`

**Expected behavior:** Timeout returns "unknown", increments failure counter, skips that package
**Result:** ✅ PASS — Properly wrapped with timeout and fallback

### Edge Case 3: GHCR Login Failure

**Trace:**
- L679-685: `Login to GHCR` step has `continue-on-error: true`
- If login fails, the step is marked as failed but workflow continues
- L687-696: `Build and push image to GHCR` will attempt to push — this will fail if login failed
- However, the `docker/build-push-action` failure would cause the step to fail
- But this step does NOT have `continue-on-error`, so it would fail the job

**Analysis:** The `continue-on-error` on login means the workflow won't abort at login, but the subsequent push step will fail if auth is missing. This is a **partial protection** — the auto-release path would fail at the push step, but the git tag/push steps come AFTER the GHCR push, so they would also be skipped.

**Wait** — re-reading the step order:
- L678: Login to GHCR (continue-on-error: true)
- L687: Build and push image to GHCR (NO continue-on-error)
- L697: Tag and push release
- L719: Create GitHub Release

If GHCR push fails (L687), the job fails and L697+ are skipped. The release would NOT be created.

**Expected behavior:** GHCR login failure → push fails → no release created
**Result:** ⚠️ PARTIAL — `continue-on-error` on login doesn't fully protect the auto-release path. If GHCR is down, the entire release fails. This is arguably correct behavior (don't release without the image), but the `continue-on-error` on login is misleading — it suggests the intent was to continue despite login failure.

### Edge Case 4: Git Push to Protected Branch

**Trace:**
- L700-717: `Tag and push release` step:
  ```bash
  BRANCH_PUSH=0; TAG_PUSH=0
  git push origin main && BRANCH_PUSH=1 || true
  if [[ "$BRANCH_PUSH" -eq 1 ]]; then
    git push origin "$NEXT_VERSION" && TAG_PUSH=1 || true
  fi
  ```
- If `main` is protected: `git push origin main` fails → `BRANCH_PUSH=0` (the `|| true` prevents exit)
- Since `BRANCH_PUSH=0`, tag push is skipped
- `push-success=false` is set (L715)
- L753-778: `Fallback to PR if push failed` — condition: `action == 'auto-release' && push-success == 'false'` → **RUNS**
- Creates a PR with the release changes instead

**Expected behavior:** Protected branch → fallback to PR
**Result:** ✅ PASS — Clean fallback mechanism

### Edge Case 5: Git Push Partial Failure (Tag Fails After Branch Push)

**Trace:**
- L706-710: Branch push succeeds (`BRANCH_PUSH=1`), then tag push fails (`TAG_PUSH=0`)
- L712-717: `BRANCH_PUSH=1 && TAG_PUSH=0` → `push-success=false`, `branch-pushed=1`
- L753: Fallback PR step runs

**Analysis:** The branch push already succeeded (commit is on main), but the tag failed. The fallback PR is created, but the commit is already on main. The PR would contain the same changes that are already pushed.

**Expected behavior:** Partial failure → fallback PR created
**Result:** ⚠️ MINOR ISSUE — The commit is already on `main` but the tag is missing. The fallback PR would be a no-op (no diff from main). A better approach might be to retry the tag push or create a lightweight tag via the API. However, this is a rare edge case and the current behavior is safe (no data loss).

### Edge Case 6: Duplicate Issue Detection

**Trace for `create-issue` (L806-813):**
```javascript
const issues = await github.rest.issues.listForRepo({
  owner, repo, state: 'open', labels: 'dependencies,automated'
});
const existing = issues.data.find(i => i.title.includes('Dependency update check'));
if (existing) {
  core.notice(`Existing issue #${existing.number} found, skipping creation`);
  return;
}
```

**Trace for `warning-issue` (L855-862):**
```javascript
const existing = issues.data.find(i => i.title.includes('version check failures'));
if (existing) {
  core.notice(`Existing warning issue #${existing.number} found, skipping creation`);
  return;
}
```

**Analysis:** Both issue creation paths check for existing open issues with matching title substring AND matching labels (`dependencies,automated`). If found, creation is skipped with a notice.

**Expected behavior:** No duplicate issues created
**Result:** ✅ PASS — Both paths have duplicate detection

### Edge Case 7: Build Args for Pinned Updates (Only Changed ARGs Passed)

**Trace (L356-378):**
```bash
BUILD_ARGS="UPGRADE_PACKAGES=true"
PINNED='${{ needs.check-versions.outputs.pinned-updates }}'
if [[ "$PINNED" != "[]" && -n "$PINNED" ]]; then
  while IFS= read -r item; do
    name="$(echo "$item" | jq -r '.name')"
    latest="$(echo "$item" | jq -r '.latest')"
    if [[ -n "$name" && -n "$latest" && "$latest" != "null" ]]; then
      BUILD_ARGS="${BUILD_ARGS}"$'\n'"${name}=${latest}"
    fi
  done < <(echo "$PINNED" | jq -c '.[]')
fi
```

**Analysis:**
- `pinned-updates` JSON only contains entries where `version_gt` returned true (L214-216)
- The loop only adds ARGs from this filtered list
- If `PINNED` is `[]` (no changes), only `UPGRADE_PACKAGES=true` is passed
- Each ARG is validated: name non-empty, latest non-empty and not "null"

**Expected behavior:** Only changed ARGs are passed as build args
**Result:** ✅ PASS — Correctly filters to only changed versions

---

## Summary

### Scenario Results

| # | Scenario | Expected | Actual | Result |
|---|----------|----------|--------|--------|
| 1 | Everything current | No action (jobs skipped) | Jobs skipped | ✅ PASS |
| 2 | Pinned outdated + tests pass | create-pr | create-pr | ✅ PASS |
| 3 | Pinned outdated + tests fail | create-issue | create-issue | ✅ PASS |
| 4 | Only latest changed + tests pass | auto-release | auto-release | ✅ PASS |
| 5 | Only latest changed + tests fail | create-issue | create-issue | ✅ PASS |
| 6 | Only apt updates + tests pass | auto-release | auto-release | ✅ PASS |
| 7 | Only apt updates + tests fail | create-issue | create-issue | ✅ PASS |
| 8 | All version checks failed | warning-issue | warning-issue | ✅ PASS |

**Scenarios: 8/8 PASS**

### Edge Case Results

| # | Edge Case | Result | Notes |
|---|-----------|--------|-------|
| 1 | First run (no artifact) | ✅ PASS | All latest treated as changed |
| 2 | npm view timeout | ✅ PASS | `timeout 10` + fallback to "unknown" |
| 3 | GHCR login failure | ⚠️ PARTIAL | `continue-on-error` on login is misleading; push step will still fail |
| 4 | Git push protected branch | ✅ PASS | Clean fallback to PR |
| 5 | Git push partial failure | ⚠️ MINOR | Commit on main but tag missing; fallback PR is no-op |
| 6 | Duplicate issue detection | ✅ PASS | Both issue paths check for existing |
| 7 | Build args only changed | ✅ PASS | Correctly filters to changed ARGs only |

**Edge Cases: 5/7 PASS, 2/7 MINOR WARNINGS (non-blocking)**

### Observations

1. **GHCR continue-on-error (Edge Case 3):** The `continue-on-error: true` on the GHCR login step (L680) suggests intent to survive login failures, but the subsequent push step (L687) has no such protection. If the intent is "release even without GHCR image", the push step also needs `continue-on-error`. If the intent is "fail release if no image", the login step's `continue-on-error` is unnecessary noise. **Recommendation:** Clarify intent — either add `continue-on-error` to push step too, or remove it from login.

2. **Partial push recovery (Edge Case 5):** When branch push succeeds but tag push fails, the fallback PR is created but the commit is already on main. This is harmless but could confuse maintainers. **Recommendation:** Consider retrying tag push via `gh api` or adding a comment explaining the situation.

3. **Decision tree is well-ordered:** The `CHECK_FAILED` check comes first, ensuring that even if `build-and-test` was skipped (result='skipped'), the warning-issue path is taken. The `DOCKERFILE_CHANGES` checks come before the generic `TEST_RESULT` check, ensuring PRs are created for Dockerfile changes rather than generic issues.

---

## VERDICT: ✅ APPROVE

All 8 decision matrix scenarios trace correctly through the workflow conditionals. The decision tree ordering is sound, job gates are properly configured, and the `always()` + `check-failed` clause in `handle-updates` correctly catches the all-checks-failed scenario. The 2 minor warnings are non-blocking edge cases with safe (if imperfect) behavior.
