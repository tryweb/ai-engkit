---
name: release
description: Run local tests, auto-calculate semver, generate release notes, tag and release
---

# Release Skill

This skill automates the release process: local test validation, version bump calculation, release note generation, tagging, and pushing.

## Workflow

When the user asks to release, follow these steps in order:

### 1. Ensure Dev Container Is Running

Clear any inherited admin password before Compose resolves `docker-compose.dev.yml`.
This prevents a production/staging shell export from overriding the dev test
password; Compose will then read the repository `.env` when present, otherwise
use its documented `testadmin123` fallback.

```bash
unset ADMIN_PASSWORD
```

The tests require the `ai-engkit-dev` container (from `docker-compose.dev.yml`) to be running. Check if it's up:

```bash
docker inspect ai-engkit-dev --format='{{.State.Status}}' 2>/dev/null
```

If the container is not running or does not exist, build and start it automatically:

```bash
echo "[release] Dev container not running. Building and starting..."
docker compose -p dev -f docker-compose.dev.yml up --build -d
```

Then wait for both containers to be healthy and ready:

```bash
echo "[release] Waiting for containers to be ready..."
for i in $(seq 1 30); do
  DEV_STATUS=$(docker inspect ai-engkit-dev --format='{{.State.Status}}' 2>/dev/null)
  ADMIN_STATUS=$(docker inspect ai-engkit-admin-dev --format='{{.State.Status}}' 2>/dev/null)
  if [ "$DEV_STATUS" = "running" ] && [ "$ADMIN_STATUS" = "running" ]; then
    echo "[release] Both containers are running."
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "[release] ERROR: Containers failed to start after 30s."
    echo "[release] ai-engkit-dev status: ${DEV_STATUS:-not found}"
    echo "[release] ai-engkit-admin-dev status: ${ADMIN_STATUS:-not found}"
    docker compose -p dev -f docker-compose.dev.yml logs --tail=20
    exit 1
  fi
  sleep 2
done

# Brief extra wait for services to initialize inside the containers
sleep 5

# Detect both container names from docker-compose (avoids alphabetical ordering issue with head -1)
DEV_CONTAINER="ai-engkit-dev"
ADMIN_CONTAINER="ai-engkit-admin-dev"

# Verify both are actually running (from this compose file)
RUNNING_CONTAINERS=$(docker compose -p dev -f docker-compose.dev.yml ps --format '{{.Name}}' 2>/dev/null || echo "")

if ! echo "$RUNNING_CONTAINERS" | grep -q "$DEV_CONTAINER"; then
  echo "[release] ERROR: Main dev container ($DEV_CONTAINER) is not running."
  exit 1
fi
if ! echo "$RUNNING_CONTAINERS" | grep -q "$ADMIN_CONTAINER"; then
  echo "[release] ERROR: Admin container ($ADMIN_CONTAINER) is not running."
  exit 1
fi
echo "[release] Using containers: $DEV_CONTAINER (main), $ADMIN_CONTAINER (admin)"
```

### 2. Run Local Tests

There are three test suites that cover both the main dev container and the admin container separately:

```bash
# === 1. Main dev container — basic functionality ===
# Tests: OpenChamber, OpenCode, Web UI, Health API, dev tools, CodeGraph, LeanCTX
echo "[release] Running main dev container tests against $DEV_CONTAINER..."
./test/run-tests.sh ai-engkit-dev
if [ $? -ne 0 ]; then
  echo "[release] ERROR: Main dev container tests failed."
  exit 1
fi

# === 2. Admin container — dashboard integration ===
# Tests: container status, healthcheck, auth, OpenAPI spec
echo "[release] Running admin container tests against $ADMIN_CONTAINER..."
./test/test-admin.sh ai-engkit-admin-dev
if [ $? -ne 0 ]; then
  echo "[release] ERROR: Admin container tests failed."
  exit 1
fi

# === 3. Admin UI — smoke tests ===
# Tests: login flow, dashboard, versions page, static assets
echo "[release] Running admin UI smoke tests..."
./test/test-admin-ui.sh
if [ $? -ne 0 ]; then
  echo "[release] ERROR: Admin UI smoke tests failed."
  exit 1
fi

echo "[release] All tests passed."
```

If any test suite fails, stop and report the failures. Do not proceed with release.

### 3. Check for Uncommitted Changes

After checking documentation, verify the working tree status:

```bash
git status --short
```

**If there are uncommitted changes:**
1. **Ask the user** if they want to commit them before release
2. If user confirms, create a descriptive commit message following conventional commits:
   - `feat:` for new features
   - `fix:` for bug fixes
   - `chore:` for maintenance tasks
   - `docs:` for documentation
3. **Commit before continuing** with the release

**If working tree is clean:**
- Proceed to version determination

Do not release with uncommitted changes. All changes must be committed before tagging.

### 4. Determine Current and Next Version

```bash
# Get latest stable tag on THIS release line (same major; ai-engkit keeps
# parallel v1.* (main) and v2.* lines, so never use the global highest tag).
bash .github/scripts/release-line-tag.sh 2>/dev/null || echo "v0.0.0"
```

Parse the current version (e.g., `v0.1.0`). Then analyze `git log` since the last tag to determine the bump type:

- **MAJOR** bump: if any commit contains `BREAKING CHANGE` or `!:` in the subject
- **MINOR** bump: if any commit starts with `feat:` or `feat(`
- **PATCH** bump: for `fix:`, `docs:`, `style:`, `refactor:`, `perf:`, `test:`, `ci:`, `chore:`, or any other commit

Calculate the next version accordingly (e.g., `v1.2.0`).

**Important**: Store the calculated version for later steps:

```bash
VERSION="v1.2.0"  # ← replace with the actual calculated version
```

### 5. Generate Release Notes

```bash
LAST_TAG=$(bash .github/scripts/release-line-tag.sh 2>/dev/null || echo "")
if [ -n "$LAST_TAG" ]; then
  git log ${LAST_TAG}..HEAD --oneline --no-merges
else
  git log --oneline --no-merges
fi
```

Categorize commits into sections for display to the user:

```
## Features
- feat: descriptions

## Bug Fixes
- fix: descriptions

## Other Changes
- docs, refactor, chore, ci, test, style, perf: descriptions
```

Strip the conventional commit prefix (e.g., `feat: `, `fix: `) for cleaner notes.

**Note:** The GitHub Release body is auto-generated by the CI workflow from the curated `docs/CHANGELOG.md` section for the released version (falling back to `git log` if that section is missing), so the tag message only needs a brief summary.

### 5.1. Detect Version Changes (for CHANGELOG)

Compare current Dockerfile ARGs against the last release tag, so CHANGELOG entries can be auto-generated:

```bash
LAST_TAG=$(bash .github/scripts/release-line-tag.sh 2>/dev/null || true)
CHANGED_DEPS=""
if [ -n "$LAST_TAG" ]; then
  for entry in \
    "DOCKER_VERSION:Docker Engine" \
    "COMPOSE_VERSION:Docker Compose" \
    "BUILDX_VERSION:Docker Buildx" \
    "OPENCODE_VERSION:OpenCode" \
    "OPENCHAMBER_VERSION:OpenChamber" \
    "PLAYWRIGHT_VERSION:Playwright" \
    "PLAYWRIGHT_MCP_VERSION:@playwright/mcp" \
    "GH_VERSION:GitHub CLI" \
    "GLAB_VERSION:GitLab CLI" \
    "MARKSMAN_VERSION:Marksman" \
    "LEANCTX_VERSION:lean-ctx"; do
    
    arg_name="${entry%%:*}"
    display="${entry#*:}"
    old_ver=$(git show "$LAST_TAG":Dockerfile 2>/dev/null | awk -F= -v n="ARG $arg_name=" 'index($0,n)==1{print $2;exit}')
    new_ver=$(awk -F= -v n="ARG $arg_name=" 'index($0,n)==1{print $2;exit}' Dockerfile)
    
    if [ -n "$old_ver" ] && [ -n "$new_ver" ] && [ "$old_ver" != "$new_ver" ]; then
      CHANGED_DEPS="${CHANGED_DEPS}- Upgrade ${display} from ${old_ver} to ${new_ver}.\n"
    fi
  done
fi

if [ -n "$CHANGED_DEPS" ]; then
  printf '%b' "$CHANGED_DEPS" > /tmp/release-changed-deps
  echo "Detected version changes:"
  printf '%b' "$CHANGED_DEPS"
else
  echo "No version changes detected in Dockerfile."
  rm -f /tmp/release-changed-deps
fi
```

### 5.2. Update CHANGELOG (Before Tagging)

**CRITICAL**: This step must happen BEFORE tagging, not after.

This step does two things:
1. Move existing `[Unreleased]` content into the new version section
2. Auto-generate `### Changed` entries if Step 5.1 detected version bumps

First, generate a categorized commit list from git log as fallback when `[Unreleased]` is empty:

```bash
# Helper: strip commit hash + type prefix, capitalize, add bullet
fmt_commit() { sed 's/^[0-9a-f]* //' | sed 's/^[a-z]*[^:]*: *//' | sed 's/^./\U&/' | sed 's/^/- /'; }

LAST_TAG=$(bash .github/scripts/release-line-tag.sh 2>/dev/null || true)
COMMITS_SINCE_TAG=$(git log ${LAST_TAG}..HEAD --oneline --no-merges 2>/dev/null || true)
CATEGORIZED_COMMITS=""
if [ -n "$COMMITS_SINCE_TAG" ]; then
  # Categorize commits into sections matching existing CHANGELOG convention
  FEATS=$(git log ${LAST_TAG}..HEAD --oneline --no-merges 2>/dev/null | grep -iE '^[0-9a-f]+ feat' | fmt_commit)
  FIXES=$(git log ${LAST_TAG}..HEAD --oneline --no-merges 2>/dev/null | grep -iE '^[0-9a-f]+ fix' | fmt_commit)
  DOCS=$(git log ${LAST_TAG}..HEAD --oneline --no-merges 2>/dev/null | grep -iE '^[0-9a-f]+ docs' | fmt_commit)
  SECURITY=$(git log ${LAST_TAG}..HEAD --oneline --no-merges 2>/dev/null | grep -iE '^[0-9a-f]+ security' | fmt_commit)
  REMOVED=$(git log ${LAST_TAG}..HEAD --oneline --no-merges 2>/dev/null | grep -iE '^[0-9a-f]+ remove' | fmt_commit)
  CHANGED=$(git log ${LAST_TAG}..HEAD --oneline --no-merges 2>/dev/null | grep -iE '^[0-9a-f]+ (chore|refactor|perf|test|ci|style)' | fmt_commit)
  # Breaking changes detected by `!:` in subject (e.g. "feat!: xxx" or "chore!: xxx")
  BREAKING=$(git log ${LAST_TAG}..HEAD --oneline --no-merges 2>/dev/null | grep -E '^[0-9a-f]+ .+!: ' | fmt_commit || true)

  [ -n "$BREAKING" ] && CATEGORIZED_COMMITS="${CATEGORIZED_COMMITS}### Changed\n${BREAKING}\n\n"
  [ -n "$FEATS" ]    && CATEGORIZED_COMMITS="${CATEGORIZED_COMMITS}### Added\n${FEATS}\n\n"
  [ -n "$FIXES" ]    && CATEGORIZED_COMMITS="${CATEGORIZED_COMMITS}### Fixed\n${FIXES}\n\n"
  [ -n "$SECURITY" ] && CATEGORIZED_COMMITS="${CATEGORIZED_COMMITS}### Security\n${SECURITY}\n\n"
  [ -n "$REMOVED" ]  && CATEGORIZED_COMMITS="${CATEGORIZED_COMMITS}### Removed\n${REMOVED}\n\n"
  [ -n "$DOCS" ]     && CATEGORIZED_COMMITS="${CATEGORIZED_COMMITS}### Documentation\n${DOCS}\n\n"
  [ -n "$CHANGED" ]  && CATEGORIZED_COMMITS="${CATEGORIZED_COMMITS}### Changed\n${CHANGED}\n\n"
  printf '%b' "$CATEGORIZED_COMMITS" > /tmp/release-git-log-commits
fi
```

Run the CHANGELOG updater:

```bash
NEXT_VERSION="v$(echo "$VERSION" | sed 's/v//')"
TODAY="$(date -u +%Y-%m-%d)"
CHANGELOG="docs/CHANGELOG.md"

python3 - "$CHANGELOG" "$NEXT_VERSION" "$TODAY" <<'PYEOF'
import re, sys, os

changelog_path, version, date = sys.argv[1:4]
version_no_v = version.lstrip('v')
repo = 'https://github.com/tryweb/ai-engkit'

with open(changelog_path, 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Capture existing [Unreleased] content (everything between header and next ##)
unrel_match = re.search(
    r'^## \[Unreleased\]\n(.*?)(?=^## \[|\Z)',
    content, re.MULTILINE | re.DOTALL
)
existing_unrel = unrel_match.group(1).strip() if unrel_match else ''

# 2. Remove old [Unreleased] section + its content
content = re.sub(
    r'^## \[Unreleased\]\n.*?(?=^## \[|\Z)',
    '', content, count=1, flags=re.MULTILINE | re.DOTALL
).rstrip()

# 3. Remove old version section for same version (idempotent)
content = re.sub(
    r'^## \[' + re.escape(version_no_v) + r'\] - \d{4}-\d{2}-\d{2}\n.*?(?=^## \[|\Z)',
    '', content, count=0, flags=re.MULTILINE | re.DOTALL
).rstrip()

# 4. Read auto-detected changes from step 5.1
changed_deps = ''
try:
    with open('/tmp/release-changed-deps') as f:
        deps = f.read().strip()
        if deps:
            changed_deps = '### Changed\n' + deps
except (FileNotFoundError, IOError):
    pass

# 5. Read auto-generated git log commits (fallback when [Unreleased] is empty)
git_log_commits = ''
try:
    with open('/tmp/release-git-log-commits') as f:
        gc = f.read().strip()
        if gc:
            git_log_commits = gc
except (FileNotFoundError, IOError):
    pass

# 6. Build new version section:
#    - Use [Unreleased] content if present
#    - Fall back to auto-generated git log commits
#    - Append changed_deps if any
new_section_parts = [f'## [{version_no_v}] - {date}']
if existing_unrel:
    new_section_parts.append(existing_unrel)
elif git_log_commits:
    new_section_parts.append(git_log_commits)
if changed_deps:
    new_section_parts.append(changed_deps)
new_section = '\n\n'.join(new_section_parts) + '\n'

# 7. Insert new empty [Unreleased] + new version section at top
insert_point = content.find('## [')
if insert_point >= 0:
    after = content[insert_point:]
    content = '## [Unreleased]\n\n\n' + new_section + '\n' + after
else:
    content = '## [Unreleased]\n\n\n' + new_section + '\n' + content

# 8. Rebuild version links
versions = re.findall(r'^## \[(\d+\.\d+\.\d+)\] - ', content, re.MULTILINE)
links = []
if versions:
    links.append(f'[Unreleased]: {repo}/compare/v{versions[0]}...HEAD')
    prev = None
    for v in reversed(versions):
        if prev is None:
            links.append(f'[{v}]: {repo}/releases/tag/v{v}')
        else:
            links.append(f'[{v}]: {repo}/compare/v{prev}...v{v}')
        prev = v

# 9. Strip old links, preserve format footer
fmt_marker = '\n---\n\n## Format'
if fmt_marker in content:
    body_part, _ = content.split(fmt_marker, 1)
    content = body_part.rstrip() + fmt_marker
else:
    content = re.sub(
        r'\n*\[(?:Unreleased|\d+\.\d+\.\d+)\]: https://github\.com[^\n]*',
        '', content
    ).rstrip()

content += '\n\n' + '\n'.join(links) + '\n'

with open(changelog_path, 'w', encoding='utf-8') as f:
    f.write(content)
PYEOF

echo "CHANGELOG updated for ${NEXT_VERSION}"
```

Then verify the result and commit:

```bash
git diff docs/CHANGELOG.md
git add docs/CHANGELOG.md
git commit -m "docs: update CHANGELOG for ${NEXT_VERSION} release"
```

This ensures the CHANGELOG changes are included in the release tag.

### 5.3. Verify Deferred Vulnerability Register

Before tagging, check the deferred vulnerability register
(`docs/DEFERRED_VULNERABILITIES.md`) for convergence. The register tracks
upstream-blocked alerts dismissed as `won't fix`; CI rebuilds re-run Grype, so
upstream fixes flip the alert state from `dismissed` to `fixed`:

```bash
# For each ALERT_NUMBER in the Active section of the register:
gh api repos/tryweb/ai-engkit/code-scanning/alerts/<ALERT_NUMBER> --jq '.state'
# fixed     → upstream fixed; move the row from Active to Resolved in the register
# open      → alert re-appeared; re-evaluate (dismiss as FP, mitigate, or handle)
# dismissed → still waiting on upstream; keep Active
```

Also verify bundled-runtime rows directly when their fix is expected (e.g.
codegraph rows once the package repackages with a patched node):

```bash
~/.bun/install/global/node_modules/@colbymchenry/codegraph-linux-x64/node --version
# >= 24.18.1 → resolved, move rows to Resolved
```

If any rows resolved, commit the register update alongside the CHANGELOG
(`docs: update deferred vulnerability register`). Do not release with
Active rows whose resolution condition is already met — resolve them first.

### 6. Confirm with User

Present the calculated version and generated release notes. Ask for confirmation before proceeding.

### 7. Tag and Push

Upon confirmation:

```bash
git tag -a v{VERSION} -m "Release v{VERSION}"
git push origin main
git push origin v{VERSION}
```

This triggers the GitHub Actions CI workflow which will:
- Build and test
- Push image to `ghcr.io`
- Create GitHub Release with auto-generated body containing:
  - Docker pull command
  - Quick start instructions
  - Full changelog since previous tag

### 8. Report

After push, inform the user:
- New version tag
- GHCR image URL: `ghcr.io/{repo}:{version}`
- GitHub Release URL (will be created by CI)

## Rules

- Never skip the test step
- Never release with uncommitted changes (must commit first)
- Never push without user confirmation
- If `git log` is empty since last tag, warn the user
- Use semver format: `v{MAJOR}.{MINOR}.{PATCH}`
- If no previous tag exists, use `v0.0.0` as the calculation base and create
  the first release as `v0.0.1`, matching CI and dependency-update automation.
