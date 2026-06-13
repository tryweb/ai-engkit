# Learnings - Dependency Update Workflow Optimization

## Project Structure
- `.github/workflows/dependency-update.yml` — Current workflow (186 lines, apt-only)
- `.github/workflows/ci.yml` — CI/CD pipeline (reference for build/test/release patterns)
- `Dockerfile` — Contains 7 pinned ARGs + 3 latest packages
- `docker-compose.dev.yml` — Test environment config
- `test/run-tests.sh` — Integration test suite
- `.opencode/skills/release.md` — Release pattern (CHANGELOG, README badges, git tag/push)
- `README.md` — Badge format: `OpenCode-VERSION-blue`, `OpenChamber-VERSION-blue`

## Key Versions (from Dockerfile)
- DOCKER_VERSION=29.5.3
- COMPOSE_VERSION=5.1.4
- BUILDX_VERSION=0.34.1
- OPENCODE_VERSION=1.17.3
- OPENCHAMBER_VERSION=1.12.4
- PLAYWRIGHT_VERSION=1.60.0
- PLAYWRIGHT_MCP_VERSION=0.0.76
- OH_MY_OPENAGENT_VERSION=latest (tracked as "latest")
- CODEGRAPH (bun install -g @colbymchenry/codegraph)
- LeanCTX (curl install via install.sh)

## Version Sources
- GitHub releases: moby/moby, docker/compose, docker/buildx, yvgude/lean-ctx
- npm: opencode-ai, @openchamber/web, playwright, @playwright/mcp, @colbymchenry/codegraph, oh-my-openagent
- Latest tracking: oh-my-openagent, codegraph, LeanCTX

## Action Versions (standardized)
- actions/checkout@v4
- docker/setup-buildx-action@v3
- docker/build-push-action@v6
- docker/login-action@v4
- actions/upload-artifact@v4
- actions/download-artifact@v4
- peter-evans/create-pull-request@v7
- softprops/action-gh-release@v2

## Script Notes
- Dockerfile numeric ARG parsing must filter out `USER_UID=1000`; the regex alone also matches non-version numeric args.
- `npm view <pkg> version` passes through as `npm view ... version`, so mocks/tests need to handle the `view` subcommand explicitly.
- When collecting JSON update rows in Bash, store lines in arrays and join at the end; command substitution strips trailing newlines and merges records.
- `sort -V` works for pinned semver comparisons like `29.5.3 < 29.5.4`.

## Version Snapshot Artifact Draft

### Canonical file
- `version-snapshot.json` (artifact only; do not store in git)

### Shape
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

### Field notes
- `timestamp`: ISO-8601 UTC when the snapshot was generated.
- `pinned`: tracked immutable version pins from the Dockerfile / workflow inputs.
- `latest`: packages tracked as latest-release targets for update detection.
- `apt_snapshot`: ISO-8601 UTC marker for the apt package index snapshot.

## Workflow step drafts

### check-versions job: upload snapshot
```yaml
- name: Upload version snapshot
  uses: actions/upload-artifact@v4
  with:
    name: version-snapshot
    path: version-snapshot.json
    retention-days: 14
```

### handle-updates job: download previous snapshot
```yaml
- name: Download previous version snapshot
  uses: actions/download-artifact@v4
  continue-on-error: true
  with:
    name: version-snapshot
```

## Artifact expiry handling
- If the download step fails because no prior artifact exists, set `previous-snapshot=absent`.
- The check-versions script should treat `absent` as "all latest values changed" on first run.
- Keep retention at 14 days to cover the weekly Monday 06:00 UTC schedule with room for 2 missed runs.

## Existing CI reference patterns
- `.github/workflows/ci.yml:40-45` — upload-artifact pattern (`image`, `/tmp/image.tar`, retention 7).
- `.github/workflows/ci.yml:58-62` — download-artifact pattern (`image`, `/tmp`).

## Research verification (2026-06-13)

### GitHub release tag sources (API)
- `moby/moby` → `docker-v29.5.3`
- `docker/compose` → `v5.1.4`
- `docker/buildx` → `v0.34.1`
- `yvgude/lean-ctx` → `v3.8.2`

### npm registry versions (curl fallback)
- `opencode-ai` → `1.17.4`
- `@openchamber/web` → `1.12.4`
- `playwright` → `1.60.0`
- `@playwright/mcp` → `0.0.76`
- `@colbymchenry/codegraph` → `1.0.0`
- `oh-my-openagent` → `4.9.2`

### Dockerfile ARG parsing
- Parsed pinned ARGs successfully: 7/7
- Matched lines:
  - `ARG DOCKER_VERSION=29.5.3`
  - `ARG COMPOSE_VERSION=5.1.4`
  - `ARG BUILDX_VERSION=0.34.1`
  - `ARG OPENCODE_VERSION=1.17.3`
  - `ARG OPENCHAMBER_VERSION=1.12.4`
  - `ARG PLAYWRIGHT_VERSION=1.60.0`
  - `ARG PLAYWRIGHT_MCP_VERSION=0.0.76`
- Notes: `ARG UPGRADE_PACKAGES=true`, `ARG OH_MY_OPENAGENT_VERSION=latest`, `ARG USERNAME=devuser`, `ARG USER_UID=1000`, `ARG DOCKER_GID` are present but outside the pinned-regex set.

### Download URL checks
- Docker static tarball `https://download.docker.com/linux/static/stable/x86_64/docker-29.5.3.tgz` → `HTTP/2 200`
- Compose binary `https://github.com/docker/compose/releases/download/v5.1.4/docker-compose-linux-x86_64` → `HTTP/2 302`
- Buildx binary `https://github.com/docker/buildx/releases/download/v0.34.1/buildx-v0.34.1.linux-amd64` → `HTTP/2 302`

## Workflow Rewrite (2026-06-13)

### File Stats
- Final file: `.github/workflows/dependency-update.yml` — 859 lines (larger than estimated ~350 due to inline bash script)
- 3 jobs: `check-versions`, `build-and-test`, `handle-updates`
- 17 steps in handle-updates (covers all 5 action paths)

### Key Decisions
- Inline bash script in check-versions (~200 lines) rather than external file — keeps workflow self-contained
- Python helpers for JSON building and CHANGELOG manipulation — more reliable than pure bash for string handling
- `docker-compose.override.yml` pattern from ci.yml for test services — avoids mutating docker-compose.dev.yml
- `continue-on-error: true` on artifact download steps — handles first-run gracefully
- moby/moby tag prefix handling: `docker-vX.Y.Z` → strip both `docker-v` and `v` prefixes

### Action Versions Used
- actions/checkout@v4, docker/setup-buildx-action@v3, docker/build-push-action@v6
- docker/login-action@v4, actions/upload-artifact@v4, actions/download-artifact@v4
- peter-evans/create-pull-request@v7, softprops/action-gh-release@v2, actions/github-script@v7
- Zero uses of @v6 checkout (was in old workflow, now fixed)

### Decision Tree Coverage
| Scenario | Action |
|---|---|
| Everything current | No action (workflow exits early via `if` on build-and-test) |
| Pinned outdated + tests pass | create-pr |
| Pinned outdated + tests fail | create-issue |
| Only latest changed + tests pass | auto-release |
| Only latest changed + tests fail | create-issue |
| Only apt updates + tests pass | auto-release |
| Only apt updates + tests fail | create-issue |
| All checks failed | warning-issue |

## Review Findings (2026-06-13)
- `actions/download-artifact@v4` without `run-id` cannot fetch `version-snapshot` from a prior workflow run, so the workflow currently behaves like a first run every time.
- That makes `latest_changes_detected=true` on every run, breaking the "everything current" exit path and contaminating apt-only scenarios.
- The `warning-issue` path is unreachable because `handle-updates` is gated on `updates-needed == 'true'`, while `check-failed=true` does not force `updates-needed=true`.
- `handle-updates` likely also needs `pull-requests: write` for `peter-evans/create-pull-request@v7`; current permissions are otherwise minimally scoped.
- Edge-case gaps still remain: no timeout around `npm view`, GHCR login failure stops auto-release, and partial git-push failure is not recoverable via fallback PR.

## Self-Review Fixes Applied (2026-06-13)

### Fix Summary (7 issues)
1. **Cross-run artifact**: `actions/download-artifact@v4` only works within same run. Replaced with `gh run list` + `gh run download` to fetch from last successful run.
2. **warning-issue reachability**: `handle-updates.if` now includes `|| needs.check-versions.outputs.check-failed == 'true'` so the job runs even when `updates-needed` is false but all checks failed.
3. **pull-requests: write**: Required by `peter-evans/create-pull-request@v7`. Added to handle-updates permissions.
4. **npm view timeout**: Wrapped with `timeout 10` inside `get_npm_version()` helper. All callers (including snapshot generation) go through this helper.
5. **GHCR login continue-on-error**: Added `continue-on-error: true` so downstream steps can still attempt to run.
6. **Shell safety**: Added `set -euo pipefail` to all multi-line bash blocks. Two exceptions use `set -uo pipefail` (no `-e`):
   - Test runner step: needs to capture non-zero exit via `PIPESTATUS[0]`
   - Git push step: uses `|| true` patterns for partial failure detection
7. **Git push partial failure**: Separated branch push and tag push with individual success tracking. Outputs `branch-pushed` for fallback PR to know context.

### Gotcha: `set -e` vs `git diff --cached --quiet`
`git diff --cached --quiet` returns exit 1 when there ARE changes. With `set -e`, the `&& echo ... && exit 0` pattern aborts on the non-zero. Fixed by using `if git diff --cached --quiet; then ... else ... fi`.

### Final file: 893 lines
