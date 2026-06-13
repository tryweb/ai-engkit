# Dependency Update Workflow Optimization

## TL;DR

> **Quick Summary**: Replace `.github/workflows/dependency-update.yml` with a comprehensive workflow that checks pinned Dockerfile versions (Docker, Compose, Buildx, OpenCode, OpenChamber, Playwright, Playwright MCP) and "latest" packages (oh-my-openagent, codegraph, LeanCTX) against upstream sources, builds and tests updated images via `docker-compose.dev.yml`, and either creates a PR (when Dockerfile pinned versions need changes) or auto-releases (when only latest/apt changes pass tests).

> **Deliverables**:
> - Single optimized `.github/workflows/dependency-update.yml` (replaces existing file)
> - Version tracking JSON schema for artifact persistence
> - README.md badge update pattern integrated into release path
> - docs/CHANGELOG.md update pattern for automated releases

> **Estimated Effort**: Medium
> **Parallel Execution**: YES — 2-wave parallelism
> **Critical Path**: check-versions → build-and-test → handle-updates

---

## Context

### Original Request
優化 `.github/workflows/dependency-update.yml` 針對 `Dockerfile` 內指定版本的套件如有新版本或是採用 latest 套件的版本與上次檢測出現變化, 就進行 build 並使用 docker-compose-dev.yml 環境驗證測試。

如果驗證成功, 不需要改動 Dockerfile 內定義的版本, 就參考 Release Skill, 直接產生 Release 相關流程與資訊。如果需要改動 Dockerfile, 就產生 PR 讓使用者核定是否要更版進行。

### Interview Summary
**Key Discussions**:
- **Version check method**: GitHub API (`gh release view`) for Docker/Compose/Buildx; `npm view` for npm packages; GitHub API for LeanCTX (`yvgude/lean-ctx` latest release)
- **Latest change tracking**: GitHub Artifact storing resolved version JSON, compared on each run
- **Additional latest packages**: `@colbymchenry/codegraph` (npm) and LeanCTX (GitHub API) added to tracking
- **PR vs Release boundary**: If any Dockerfile pinned version is outdated → create PR. If only latest/apt changes + tests pass → auto-release. Vulnerability scan is NOT a gate.
- **Auto-release scope**: Complete self-contained release (README badge updates, CHANGELOG update, git tag/push, GHCR push, GitHub Release creation)
- **No PAT available**: GITHUB_TOKEN handles everything; branch protection fallback needed
- **Action version consistency**: Standardize on `@v6` for checkout, `@v3` for setup-buildx, `@v4` for upload-artifact

**Research Findings**:
- `DOCKER_VERSION` source = `moby/moby` (not `docker/docker`) — tags: `v29.5.3` format
- `COMPOSE_VERSION` source = `docker/compose` — tags: `v5.1.4` format
- `BUILDX_VERSION` source = `docker/buildx` — tags: `v0.34.1` format
- `@playwright/mcp` and `playwright` core have independent version schemes — track separately
- LeanCTX source = `yvgude/lean-ctx` — use GitHub API for latest release tag
- GITHUB_TOKEN pushes do NOT trigger new workflow runs (GitHub anti-recursion built-in)

### Metis Review
**Identified Gaps** (addressed):
- **LeanCTX detection**: Changed from `install.sh` SHA256 checksum to GitHub API release tag query (`yvgude/lean-ctx`), since install.sh rarely changes
- **Docker repo naming**: Corrected from `docker/docker` to `moby/moby`
- **Branch protection**: Added fallback for GITHUB_TOKEN push failures on protected branches
- **Pinned + latest dual-change**: Explicitly resolved: pinned always wins → PR only
- **Action version inconsistency**: Standardized across workflow files
- **Least-privilege permissions**: Per-job permissions scoped to minimum needed

---

## Work Objectives

### Core Objective
Replace the existing apt-only dependency check workflow with a comprehensive version-aware workflow that handles pinned version updates, latest package changes, and automated release.

### Concrete Deliverables
- `.github/workflows/dependency-update.yml` — Fully rewritten workflow (186 lines → ~350 lines)
- `.sisyphus/evidence/` — QA evidence for the workflow

### Definition of Done
- [x] Workflow checks all 7 pinned Dockerfile versions against upstream sources
- [x] Workflow checks all 3 "latest" packages (oh-my-openagent, codegraph, LeanCTX) against previous artifact
- [x] Workflow builds updated image with new versions and runs docker-compose.dev.yml tests
- [x] Workflow correctly decides between PR creation vs auto-release based on Dockerfile change requirement
- [x] Auto-release creates README badge updates, CHANGELOG entry, git tag/push, GHCR push, GitHub Release
- [x] `.github/workflows/dependency-update.yml` is the only file modified

### Must Have
- Version check for all 7 pinned ARGs: DOCKER, COMPOSE, BUILDX, OPENCODE, OPENCHAMBER, PLAYWRIGHT, PLAYWRIGHT_MCP
- Version check for 3 latest packages: oh-my-openagent, @colbymchenry/codegraph, LeanCTX
- Apt package update detection (existing functionality preserved)
- Artifact-based latest version tracking between weekly runs
- docker-compose.dev.yml based integration testing
- Decision tree: Dockerfile changes → PR; Only latest/apt changes + tests pass → Auto-release
- Self-contained release: README badges, CHANGELOG, git tag/push, GHCR push, GitHub Release

### Must NOT Have (Guardrails)
- No modification to `ci.yml` or other workflow files (scope boundary)
- No vulnerability scanning as a release gate (user decision)
- No MAJOR/MINOR version bumps in auto-release (strictly PATCH)
- No addition of new README badges for Docker/Compose/Buildx/Playwright (scope control)
- No "latest" resolved version stored in git — artifact only
- No gh CLI auth outside of GITHUB_TOKEN

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES (GitHub Actions)
- **Automated tests**: N/A — this is a workflow configuration change, tested via dry-run and structural verification
- **Agent-Executed QA**: YAML syntax validation, workflow structural analysis, acceptance criteria verification

### QA Policy
Every task MUST include agent-executed QA scenarios. Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Workflow YAML**: Use Bash (`yamllint` / `python -c "import yaml; yaml.safe_load(open(...))"`) to validate syntax
- **Logic Verification**: Use Bash to simulate the decision tree logic and verify outputs
- **Structural Review**: Ensure all jobs, steps, outputs, needs, and conditionals are correctly wired

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately — independent preparation):
├── Task 1: Research & verify version source details [quick]
├── Task 2: Draft version-checking script (Bash) [quick]
├── Task 3: Draft artifact management logic [quick]

Wave 2 (After Wave 1 — main workflow construction):
├── Task 4: Write the complete dependency-update.yml [unspecified-high]
├── Task 5: Self-review & structural verification [deep]

Wave FINAL (After ALL tasks):
├── Task F1: Plan compliance audit (oracle)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Real manual QA (unspecified-high)
└── Task F4: Scope fidelity check (deep)
```

Critical Path: Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → F1-F4 → user okay
Parallel Speedup: ~40% faster than sequential
Max Concurrent: 3 (Wave 1)

---

## TODOs

> **CRITICAL**: The executor has NO context from this interview. All domain knowledge (version sources, decision tree, artifact schema) is embedded in the task descriptions below. Read each task fully before implementing.

- [x] 1. Research & verify version source details

  **What to do**:
  - Verify the exact GitHub API responses for each version source by running:
    - `gh release view --repo moby/moby --json tagName --jq .tagName` — verify tag format (strip leading `v`)
    - `gh release view --repo docker/compose --json tagName --jq .tagName` — verify tag format
    - `gh release view --repo docker/buildx --json tagName --jq .tagName` — verify tag format
    - `npm view opencode-ai version` — verify numeric-only output
    - `npm view @openchamber/web version` — verify numeric-only output
    - `npm view playwright version` — verify numeric-only output
    - `npm view @playwright/mcp version` — verify numeric-only output
    - `npm view @colbymchenry/codegraph version` — verify numeric-only output
    - `npm view oh-my-openagent version` — verify numeric-only output
    - `curl -fsSL https://api.github.com/repos/yvgude/lean-ctx/releases/latest | jq -r .tag_name` — verify tag format
  - Verify Dockerfile ARG lines exist and can be parsed with `grep`/`sed`:
    - Pattern: `^ARG DOCKER_VERSION=([0-9.]+)$`
  - Verify download URLs for latest versions exist (e.g., `curl -sI "https://download.docker.com/linux/static/stable/x86_64/docker-${LATEST}.tgz"`)
  - Document the exact tag format and any URL pattern differences

  **Must NOT do**:
  - Do not modify any workflow files during this research task
  - Do not commit research findings to git

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Information gathering — run curl/gh/npm commands, record results
  - **Skills**: `[]`
  - **Skills Evaluated but Omitted**: N/A

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2, 3)
  - **Blocks**: Task 4
  - **Blocked By**: None (can start immediately)

  **References**:
  - `Dockerfile:4-16` — ARG definitions to parse
  - Existing `dependency-update.yml:40-65` — Current apt-check script pattern (Bash-in-docker pattern)
  - `ci.yml:29-38` — docker/build-push-action usage pattern

  **Acceptance Criteria**:
  - [ ] All 10 version sources verified with actual API responses documented
  - [ ] Dockerfile ARG parsing pattern confirmed for all 7 pinned versions
  - [ ] Download URL verification pattern documented
  - [ ] Research notes available for Task 4

- [x] 2. Draft version-checking script (Bash module)

  **What to do**:
  Create a reusable Bash script (`check-versions.sh`) that encapsulates all version-checking logic. This script will be embedded/inlined into the workflow's `check-versions` job.

  The script must:
  1. **Parse Dockerfile**: Read all `ARG <NAME>=<VERSION>` lines for the 7 pinned packages
  2. **Check pinned versions**: For each pinned package, query upstream and determine if latest > current
  3. **Load previous artifact**: If `version-snapshot.json` exists (from artifact download), load it
  4. **Check latest packages** (oh-my-openagent, codegraph, LeanCTX): Resolve current version, compare with previously stored version
  5. **Check apt packages**: Run the existing `apt-get upgrade -s` detection pattern
  6. **Output decisions**: Write `$GITHUB_OUTPUT` with:
     - `updates-needed`: true/false
     - `dockerfile-changes-needed`: true/false (any pinned version outdated)
     - `latest-changes-detected`: true/false
     - `pinned-updates`: JSON of what changed
     - `latest-updates`: JSON of what changed
     - `apt-updates`: summary string
  7. **Generate version-snapshot.json**: Contains all resolved versions + timestamp, for artifact upload

  Key behaviors:
  - If no previous artifact exists → treat all latest packages as "changed"
  - If version check fails (network error) → mark as "unknown", don't fail the build
  - Strip `v` prefix from GitHub release tags for comparison
  - Use numeric version comparison (`sort -V`) for pinned packages
  - Handle `npm view` returning unexpected output gracefully

  **Must NOT do**:
  - Do not compare versions using string equality — use semver comparison
  - Do not fail the job if a single version source is unreachable

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Self-contained Bash script, clear spec
  - **Skills**: `[]`
  - **Skills Evaluated but Omitted**: N/A

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 3)
  - **Blocks**: Task 4
  - **Blocked By**: None (can start independently)

  **References**:
  - `dependency-update.yml:40-65` — Existing Bash-in-docker pattern for apt checking
  - Dockerfile ARG lines — version string extraction pattern
  - GitHub release API (`gh release view --repo OWNER/REPO --json tagName --jq .tagName`)

  **Acceptance Criteria**:
  - [ ] Bash script correctly parses all 7 pinned ARGs from Dockerfile
  - [ ] Bash script queries all 10 version sources and handles errors gracefully
  - [ ] Bash script produces correct `$GITHUB_OUTPUT` variables
  - [ ] Artifact JSON generation includes all resolved versions + timestamp
  - [ ] Missing artifact scenario → all latest treated as "changed"
  - [ ] Version comparison works correctly (e.g., "29.5.3" < "29.5.4")

- [x] 3. Draft artifact management logic

  **What to do**:
  Define the JSON schema and GitHub Actions steps for the version tracking artifact:

  1. **Artifact JSON Schema** (`version-snapshot.json`):
  ```json
  {
    "timestamp": "2026-06-13T06:00:00Z",
    "pinned": {
      "DOCKER_VERSION": "29.5.3",
      "COMPOSE_VERSION": "5.1.4",
      "BUILDX_VERSION": "0.34.1",
      "OPENCODE_VERSION": "1.17.3",
      "OPENCHAMBER_VERSION": "1.12.4",
      "PLAYWRIGHT_VERSION": "1.60.0",
      "PLAYWRIGHT_MCP_VERSION": "0.0.76"
    },
    "latest": {
      "OH_MY_OPENAGENT_VERSION": "3.15.0",
      "CODEGRAPH_VERSION": "0.8.7",
      "LEANCTX_VERSION": "v3.7.4"
    },
    "apt_snapshot": "2026-06-13T06:00:00Z"
  }
  ```

  2. **Workflow steps to wire**:
  - `check-versions` job: Upload artifact with `actions/upload-artifact@v4`, name: `version-snapshot`, retention-days: 14
  - `handle-updates` job: Download artifact with `actions/download-artifact@v4` to get previous snapshot for comparison
  - Always save the NEW snapshot after check-versions completes

  3. **Artifact expiry handling**:
  - If download-artifact step fails (no artifact found), set `previous-snapshot=absent`
  - The check-versions script already handles this (treats all latest as "changed")

  **Must NOT do**:
  - Do not store version snapshot in git repository
  - Do not use artifact retention longer than 14 days (schedule is weekly, 14d = 2 missed runs buffer)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Define schema, wire upload/download steps
  - **Skills**: `[]`
  - **Skills Evaluated but Omitted**: N/A

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2)
  - **Blocks**: Task 4
  - **Blocked By**: None

  **References**:
  - `ci.yml:40-45,58-62` — Existing artifact upload/download pattern (image artifact)
  - `dependency-update.yml:147-186` — Existing `create-update-issue` job (previous workflow's output handling)

  **Acceptance Criteria**:
  - [ ] Artifact JSON schema covers all tracked packages
  - [ ] Upload step configured with correct name, path, and retention-days
  - [ ] Download step handles missing artifact gracefully
  - [ ] New snapshot always uploaded after check-versions completes

---

- [x] 4. Write the complete dependency-update.yml

  **What to do**:
  Write `.github/workflows/dependency-update.yml` — the complete rewritten workflow file (~350 lines).

  **Workflow Structure**:

  ```yaml
  name: Dependency Update Check

  on:
    schedule:
      - cron: '0 6 * * 1'   # Weekly Monday 6AM UTC
    workflow_dispatch:        # Manual trigger

  env:
    FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: "true"
    REGISTRY: ghcr.io
    IMAGE_NAME: ${{ github.repository }}
  ```

  **Job 1: `check-versions`** (permissions: `contents: read`)
  ```
  steps:
    1. actions/checkout@v4
    2. (embedded) Run check-versions Bash script (from Task 2)
       - Parses Dockerfile ARGs
       - Queries all version sources
       - Loads previous artifact (if any)
       - Compares versions
       - Sets outputs: updates-needed, dockerfile-changes-needed, etc.
    3. actions/upload-artifact@v4 — Upload version-snapshot.json
  ```

  **Job 2: `build-and-test`** (permissions: `contents: read`)
  ```
  needs: check-versions
  if: needs.check-versions.outputs.updates-needed == 'true'
  steps:
    1. actions/checkout@v4
    2. Build image with updated versions
       - Use docker/build-push-action@v6
       - Pass updated ARGs via build-args
       - For pinned version updates: pass the new version as ARG
       - For latest/apt only: build normally (UPGRADE_PACKAGES=true)
    3. Start docker-compose.dev.yml services
       - Override image to use the newly built image
       - Same pattern as current ci.yml (docker-compose.override.yml)
    4. Wait for services (sleep 30-60s)
    5. Run integration tests: test/run-tests.sh ci-test
    6. Upload test results as artifact
    7. Cleanup
  ```

  **Job 3: `handle-updates`** (permissions: `contents: write`, `packages: write`, `issues: write`)
  ```
  needs: [check-versions, build-and-test]
  if: always() && needs.check-versions.outputs.updates-needed == 'true'
  steps:
    1. actions/checkout@v4 (with fetch-depth: 0 for git operations)
    2. Download test results artifact
    3. Decision tree:
       if dockerfile-changes-needed == 'true' → PR path
       if tests failed → Create issue (existing pattern)
       if only latest/apt changed + tests passed → Auto-release path
    4. PR path (dockerfile changes needed):
       - Use peter-evans/create-pull-request@v7
       - Branch name: chore/update-dockerfile-versions-{date}
       - Title: "chore: update Dockerfile pinned versions"
       - Body: auto-generated summary of version changes
       - Labels: ['dependencies', 'automated']
    5. Auto-release path (latest/apt only, tests passed):
       a. Determine next version (PATCH bump from latest git tag)
       b. Update README badges:
          - sed -i "s/OpenCode-[^-]*-blue/OpenCode-${OPCODE_VER}-blue/" README.md
          - sed -i "s/OpenChamber-[^-]*-blue/OpenChamber-${CHAMBER_VER}-blue/" README.md
       c. Update docs/CHANGELOG.md:
          - Add new version section under [Unreleased]
          - Include dependency update entries
       d. git add + git commit
       e. git tag v{NEW_VERSION}
       f. git push (GITHUB_TOKEN)
          - If push fails (branch protection) → create PR with release changes instead
       g. Login to GHCR (docker/login-action@v4)
       h. Tag and push image to GHCR
       i. Create GitHub Release (softprops/action-gh-release@v2)
  ```

  **Key implementation details**:
  - Use `actions/checkout@v4` consistently (matching ci.yml, checkout@v6 caused version inconsistency)
  - Use `docker/setup-buildx-action@v3` for buildx setup
  - Use `docker/login-action@v4` for GHCR auth
  - Use `peter-evans/create-pull-request@v7` for PR creation
  - Use `softprops/action-gh-release@v2` for release creation
  - All version-checking logic is inline Bash (no external scripts to maintain)
  - Concurrency group to prevent overlapping runs: `group: dependency-update-${{ github.ref }}`

  **Error Handling**:
  - If version check sources all fail → mark as "check-failed" (not "up-to-date"), create a warning issue
  - If build fails → exit with error, Slack/issue notification
  - If tests fail → create issue with test output, do not PR or release
  - If git push fails (protected branch) → fall back to PR creation
  - If artifact download fails → treat as "first run" (all latest = changed)

  **Must NOT do**:
  - Do not modify ci.yml or any other workflow files
  - Do not add vulnerability scanning as a release gate
  - Do not bump MAJOR or MINOR version — only PATCH for dependency auto-releases
  - Do not store full Dockerfile modification in PR branch — only version ARG changes
  - Do not use `actions/checkout@v6` — standardize on `@v4`

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Complex YAML workflow with multiple jobs, conditional logic, and git operations
  - **Skills**: `[]`
  - **Skills Evaluated but Omitted**: N/A

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2 (single task)
  - **Blocks**: Task 5
  - **Blocked By**: Tasks 1, 2, 3

  **References**:
  - `.github/workflows/dependency-update.yml` (current) — Starting point, preserve schedule and env
  - `.github/workflows/ci.yml` — Reference for build steps, GHCR push, release creation
  - `docker-compose.dev.yml` — Test environment configuration
  - `.opencode/skills/release.md:44-171` — Release Skill pattern (version bump, CHANGELOG, README badges)
  - `README.md:5-8` — Badge format for sed replacement

  **Acceptance Criteria**:
  - [ ] Workflow YAML passes `python -c "import yaml; yaml.safe_load(open(...))"` validation
  - [ ] All 3 jobs have correct `needs` and `if` conditionals
  - [ ] Decision tree correctly handles all combinations (see matrix below)
  - [ ] Auto-release generates valid git tag, CHANGELOG, and README changes
  - [ ] PR creation includes all Dockerfile version ARG changes
  - [ ] GHCR push step has correct image tagging
  - [ ] Concurrency group configured to prevent overlapping runs

  **Decision Matrix** (every scenario must produce the correct output):

  | Scenario | dockerfile-changes | latest-changes | test-result | Expected Output |
  |----------|-------------------|----------------|-------------|-----------------|
  | Everything current | false | false | N/A | No action (workflow exits early) |
  | Pinned version outdated | true | any | pass | Create PR |
  | Pinned version outdated | true | any | fail | Create issue |
  | Only latest changed | false | true | pass | Auto-release |
  | Only latest changed | false | true | fail | Create issue |
  | Only apt updates | false | false | pass | Auto-release |
  | Only apt updates | false | false | fail | Create issue |
  | All version checks failed | unknown | unknown | N/A | Create warning issue |

---

- [x] 5. Self-review & structural verification

  **What to do**:
  Perform a comprehensive review of the generated workflow file:

  1. **YAML Syntax Validation**:
  ```bash
  python3 -c "import yaml; yaml.safe_load(open('.github/workflows/dependency-update.yml'))"
  ```

  2. **Structural Integrity Check**:
  - Verify all `needs:` references match actual job names
  - Verify all `if:` conditionals reference correct job outputs
  - Verify all `${{ needs.xxx.outputs.yyy }}` references match actual output names
  - Verify artifact upload/download names are consistent
  - Verify no circular dependencies between jobs

  3. **Decision Tree Simulation**:
  - Trace the logic for each scenario in the decision matrix
  - Verify that the `if:` condition for each job step produces the correct outcome

  4. **Permission Verification**:
  - Verify `check-versions` job has only `contents: read`
  - Verify `handle-updates` job has `contents: write`, `packages: write`, `issues: write`
  - Verify GITHUB_TOKEN permissions are sufficient for each operation

  5. **Action Version Audit**:
  - Verify all `uses:` references use consistent versions
  - Cross-reference with `ci.yml` for consistency

  6. **Edge Cases**:
  - What happens when artifact download fails? → Should not fail the job
  - What happens when `npm view` times out? → Should mark as unknown, not fail
  - What happens when git push is rejected? → Should fall back to PR
  - What happens when GHCR login fails? → Should create issue, not fail silently

  **Must NOT do**:
  - Do not modify the workflow during review (report issues for Task 4 to fix)

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Thorough verification of complex workflow logic
  - **Skills**: `[]`
  - **Skills Evaluated but Omitted**: N/A

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2 (sequential)
  - **Blocks**: F1-F4
  - **Blocked By**: Task 4

  **References**:
  - `.github/workflows/dependency-update.yml` (new) — File under review
  - `.github/workflows/ci.yml` — Reference for action version consistency

  **Acceptance Criteria**:
  - [ ] YAML syntax validation passes
  - [ ] All 3 jobs have correct needs/if/output wiring
  - [ ] All 7 decision matrix scenarios produce correct outcomes
  - [ ] Permissions are scoped per-job correctly
  - [ ] Action versions are consistent across workflows
  - [ ] All edge cases are handled (artifact missing, npm failure, push rejection, GHCR failure)
  - [ ] Review report documents any issues found (with specific line numbers)

---

## Final Verification Wave

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
>
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.

- [x] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, check workflow syntax, trace logic). For each "Must NOT Have": search for forbidden patterns. Verify deliverables match plan. Check evidence files exist in `.sisyphus/evidence/`.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [x] F2. **Code Quality Review** — `unspecified-high`
  Check `.github/workflows/dependency-update.yml` for: YAML best practices (anchors for reused steps?), action version pinning (no `@main` or `@latest`), secret usage (GITHUB_TOKEN vs PAT), Bash script safety (set -e, pipefail), error handling in shell steps. Check AI slop: over-commented YAML, unnecessary abstractions.
  Output: `YAML [PASS/FAIL] | Bash [PASS/FAIL] | Versions [PASS/FAIL] | VERDICT`

- [x] F3. **Real Manual QA** — `unspecified-high`
  Validate the workflow structure by tracing the decision matrix scenarios. For each of the 6 test scenarios, manually trace the if-conditionals and verify the output is correct. Save trace results to `.sisyphus/evidence/final-qa/scenario-traces.md`.
  Output: `Scenarios [6/6 pass] | Edge Cases [N tested] | VERDICT`

- [x] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff of `.github/workflows/dependency-update.yml`. Verify 1:1 — everything in spec was built (no missing), nothing beyond spec was built (no creep). Check "Must NOT do" compliance. Detect cross-task contamination (Task N touching Task M's files).
  Output: `Tasks [5/5 compliant] | Contamination [CLEAN] | VERDICT`

---

## Commit Strategy

- **1**: N/A (research only)
- **2**: N/A (script embedded in workflow)
- **3**: N/A (schema embedded in workflow design)
- **4**: `ci: rewrite dependency-update.yml with version checking and auto-release` — `.github/workflows/dependency-update.yml`
- **5**: N/A (review, no code changes)

---

## Success Criteria

### Verification Commands
```bash
# Validate YAML syntax
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/dependency-update.yml'))"

# Verify workflow structure (job names exist)
grep -c "^  check-versions:" .github/workflows/dependency-update.yml  # Expected: 1
grep -c "^  build-and-test:" .github/workflows/dependency-update.yml  # Expected: 1
grep -c "^  handle-updates:" .github/workflows/dependency-update.yml  # Expected: 1

# Verify permissions separation
grep -A5 "permissions:" .github/workflows/dependency-update.yml

# Verify concurrency group
grep "concurrency:" .github/workflows/dependency-update.yml

# Verify no checkout@v6 (inconsistent with ci.yml)
grep "actions/checkout@" .github/workflows/dependency-update.yml  # Should show @v4 only
```

### Final Checklist
- [x] All "Must Have" present in the generated workflow
- [x] All "Must NOT Have" absent from the generated workflow
- [x] All action versions are pinned and consistent
- [x] Decision tree handles all 6+ scenarios correctly
- [x] Auto-release is fully self-contained (no PAT dependency)
- [x] PR creation handles branch protection fallback
- [x] Artifact management handles expiry gracefully

