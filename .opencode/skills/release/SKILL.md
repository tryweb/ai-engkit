---
name: release
description: Run local tests, auto-calculate semver, generate release notes, tag and release
---

# Release Skill

This skill automates the release process: local test validation, version bump calculation, release note generation, tagging, and pushing.

## Workflow

When the user asks to release, follow these steps in order:

### 1. Ensure the V2 Dev Stack Is Running

This repository is on the **V2 line**, which ships only the V2 dev stack:
`docker-compose.v2.dev.yml` with containers `ai-engkit-v2dev` (main) and
`ai-engkit-admin-v2dev` (admin), published on ports `8003` (OpenChamber) and
`8083` (admin health). The V1 stack (`docker-compose.dev.yml`, `ai-engkit-dev`)
no longer exists on this branch — do not look for it.

Clear any inherited admin password before Compose resolves the compose file.
This prevents a production/staging shell export from overriding the dev test
password; Compose will then read the repository `.env` when present, otherwise
use its documented `testadmin123` fallback.

```bash
unset ADMIN_PASSWORD
```

Compose needs a `.env`; seed it from the V2 template when missing (CI does the
same via `cp .env.v2.example .env`):

```bash
[ -f .env ] || cp .env.v2.example .env
```

Check whether the stack is up:

```bash
docker inspect ai-engkit-v2dev --format='{{.State.Status}}' 2>/dev/null
docker inspect ai-engkit-admin-v2dev --format='{{.State.Status}}' 2>/dev/null
```

If it is not running, start it. On the DooD dev host a full image **build** is
unreliable (see `docs/knowledge/troubleshooting/dood-image-build-stalls-on-github-assets.md`),
so prefer reusing an existing `ai-engkit-ai-v2dev` image and reserve the build
for CI:

```bash
echo "[release] V2 dev stack not running. Starting..."
docker compose -f docker-compose.v2.dev.yml up --no-build -d
# If no image exists yet, build once (slow / may stall on this host):
# docker compose -f docker-compose.v2.dev.yml up --build -d
```

Then wait for both containers and for the services to answer. Sibling-container
shells (this dev container) cannot reach the stack on `localhost`, so fall back
to the compose bridge gateway — the same way `test-v2.sh` does:

```bash
CHAMBER_PORT="${CHAMBER_V2DEV_PORT:-8003}"
ADMIN_PORT="${ADMIN_V2DEV_PORT:-8083}"
BASE_CHAMBER="http://localhost:${CHAMBER_PORT}"
BASE_ADMIN="http://localhost:${ADMIN_PORT}"

echo "[release] Waiting for the V2 stack to be ready..."
for i in $(seq 1 30); do
  DEV_STATUS=$(docker inspect ai-engkit-v2dev --format='{{.State.Status}}' 2>/dev/null)
  ADMIN_STATUS=$(docker inspect ai-engkit-admin-v2dev --format='{{.State.Status}}' 2>/dev/null)
  if [ "$DEV_STATUS" = "running" ] && [ "$ADMIN_STATUS" = "running" ]; then
    echo "[release] Both containers are running."
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "[release] ERROR: Containers failed to start after 30s."
    echo "[release] ai-engkit-v2dev status: ${DEV_STATUS:-not found}"
    echo "[release] ai-engkit-admin-v2dev status: ${ADMIN_STATUS:-not found}"
    docker compose -f docker-compose.v2.dev.yml logs --tail=20
    exit 1
  fi
  sleep 2
done

# Reachability: localhost first, then the bridge gateway (DooD sibling shell).
NET_NAME=$(docker compose -f docker-compose.v2.dev.yml config --format json 2>/dev/null \
  | jq -r '.networks.default.name // "v2dev_default"')
GW=$(docker network inspect "$NET_NAME" --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null)
if ! curl -sf -m 5 -o /dev/null "$BASE_CHAMBER/"; then
  if [ -n "$GW" ] && curl -sf -m 5 -o /dev/null "http://${GW}:${CHAMBER_PORT}/"; then
    BASE_CHAMBER="http://${GW}:${CHAMBER_PORT}"
    BASE_ADMIN="http://${GW}:${ADMIN_PORT}"
  else
    echo "[release] ERROR: OpenChamber not reachable on localhost:${CHAMBER_PORT} or ${GW:-?}:${CHAMBER_PORT}"
    exit 1
  fi
fi
curl -sf -m 5 -o /dev/null "$BASE_ADMIN/healthz" \
  || { echo "[release] ERROR: Admin health not reachable at $BASE_ADMIN"; exit 1; }
echo "[release] OpenChamber: $BASE_CHAMBER   Admin: $BASE_ADMIN"
```

### 2. Run Local Tests (the V2 CI gate)

The authoritative gate is `.github/workflows/ci.yml` (`build-v2` + `test-v2` +
`scan-v2`), which runs on a tag push. Reproduce it locally as far as the host
allows. The old V1 helpers (`run-tests.sh`, `test-admin.sh`, `test-admin-ui.sh`)
target V1 containers/compose files and no longer apply on this branch.

```bash
# === 0. Stack-free guards (CI build-v2) ===
bash test/test-compose-isolation.sh
bash test/test-check-versions.sh

# === 1. V2 image build (CI build-v2) ===
# May be unreliable on the DooD dev host (see the dood-image-build-stalls note);
# when it cannot run locally, CI builds the image on the runner instead.
docker compose -f docker-compose.v2.dev.yml build ai-dev

# === 2. V2 integration cells + admin HTTP smoke (CI test-v2) ===
# Needs the stack from step 1. test-v2.sh falls back to the bridge gateway
# itself; the smoke script takes explicit URLs (BASE_* come from step 1).
bash test/test-v2.sh cell1
bash test/test-v2.sh cell2
bash test/test-v2.sh cell3
CHAMBER_V2_URL="${BASE_CHAMBER:-http://localhost:8003}" \
ADMIN_V2_URL="${BASE_ADMIN:-http://localhost:8083}" \
ADMIN_PASSWORD=testadmin123 bash test/test-v2-admin-integration.sh

# === 3. Admin suite — run exactly as CI does ===
# build-v2 runs the plain form inside the image; test-v2 adds OMO_ENABLED=1 and
# --parallel=4 for worker/per-file module isolation. A single-process run
# WITHOUT --parallel leaks module state and shows spurious failures
# (see docs/knowledge/patterns/admin-test-isolation.md).
docker run --rm --entrypoint /home/devuser/.bun/bin/bun ai-engkit-ai-v2dev \
  --cwd /opt/admin test
docker exec -e OMO_ENABLED=1 ai-engkit-admin-v2dev \
  bun --cwd /opt/admin test --parallel=4
docker exec ai-engkit-admin-v2dev bun run --cwd /opt/admin typecheck

# To exercise HEAD from the repo checkout instead of the baked image:
#   (cd src/admin && OMO_ENABLED=1 bun test --parallel=4 && bun run typecheck)

# === 4. OpenChamber update guard regression (CI build-v2) ===
docker run --rm --pull never -v "$PWD:/repo" -w /repo \
  --entrypoint /bin/bash ai-engkit-ai-v2dev test/test-openchamber-update-guard.sh
```

If any step fails, stop and report the failures. Do not proceed with release.
Note which steps could not run locally (typically the image build) and confirm
that CI covers them on the tag push.

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
# Get latest tag
git describe --tags --abbrev=0 2>/dev/null || echo "v0.0.0"
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
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
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
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || true)
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

LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || true)
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

The V2 line's publish branch is **`v2`** (CI triggers on `branches: ['v2']` and
`tags: ['v2.*']`) — **not** `main`. Push the branch you are releasing from:

```bash
git tag -a v{VERSION} -m "Release v{VERSION}"
git push origin v2
git push origin v{VERSION}
```

This triggers the GitHub Actions V2 CI workflow (`build-v2`, `test-v2`, `scan-v2`,
then `push-v2`/release) which will:
- Build the V2 image and run the V2 gate
- Push the versioned image to `ghcr.io` (version tags only — `:latest` moves only
  via the separate `promote.yml` workflow; see
  `docs/knowledge/architecture/release-channel-publish-promote.md`)
- Create the GitHub Release with an auto-generated body containing:
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
- **V2 line only**: the dev stack is `docker-compose.v2.dev.yml`
  (`ai-engkit-v2dev` / `ai-engkit-admin-v2dev`); the V1 helpers
  (`run-tests.sh`, `test-admin.sh`, `test-admin-ui.sh`, `docker-compose.dev.yml`)
  do not apply. Run the admin suite with `OMO_ENABLED=1 … --parallel=4` or it
  reports spurious serial-state failures.
- **Publish branch is `v2`**, not `main`.
