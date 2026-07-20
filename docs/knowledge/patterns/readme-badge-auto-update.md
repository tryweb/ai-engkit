# README Badge Auto-Update Pattern

## Context

`README.md` displays shields.io version badges for pinned Dockerfile dependencies
(e.g. Docker, Playwright, lean-ctx, OpenCode, OpenChamber). The
`dependency-update.yml` workflow checks upstream versions weekly and auto-updates
both the Dockerfile ARG and the README badge.

When adding a new pinned component to the Dockerfile, or removing one, the
badge auto-update pipeline must be updated in **three** places inside
`.github/workflows/dependency-update.yml`.

## Problem

If an engineer adds a new `ARG FOO_VERSION=x.y.z` to the Dockerfile and a
corresponding shields.io badge to README.md but forgets to wire up the CI
auto-update, the badge quickly falls out of sync. Conversely, removing a
component from the Dockerfile but leaving dead badge-update code in the
workflow causes confusing CI output or error noise.

## Solution

Whenever adding or removing a pinned version badge from README.md, make
corresponding changes in **all three locations** in
`.github/workflows/dependency-update.yml`:

### 1. `check-versions` → `Check all dependency versions` step — ARG whitelist

The whitelist that parses Dockerfile ARGs is at this awk invocation:

```yaml
while IFS='=' read -r name ver; do
  case "$name" in
    DOCKER_VERSION|COMPOSE_VERSION|...|LEANCTX_VERSION)
      PINNED_NAMES+=("$name")
      PINNED_VERSIONS+=("$ver")
      ;;
  esac
done < <(awk '/^ARG [A-Z0-9_]+=/{sub(/^ARG /, ""); print}' Dockerfile)
```

**Add**: include the new ARG name in the case list and update the expected
count check (`-ne 11` → increment by 1).
**Remove**: delete the ARG name from the case list and decrement the count.

### 2. `handle-updates` → `Extract current package versions` step — grep extraction

```yaml
OPENCODE_VER=$(grep -oP '^ARG OPENCODE_VERSION=\K[0-9.]+' Dockerfile || echo "unknown")
# ... similar for each badge
echo "opencode-version=$OPENCODE_VER" >> "$GITHUB_OUTPUT"
```

**Add**: a `grep -oP` line to extract the new version, a `jq` select line to
pick up version bumps from `pinned-updates`, an override `if` block, and an
`echo` output line.
**Remove**: delete all corresponding lines for the removed component.

### 3. `handle-updates` → `Update README badges` step — sed replacement

```yaml
DOCKER_VER="${{ steps.pkg-versions.outputs.docker-version }}"
if [[ "$DOCKER_VER" != "unknown" ]]; then
  sed -i "s/Docker-[^-]*-2496ED/Docker-${DOCKER_VER}-2496ED/" README.md
fi
```

**Add**: read the version from `pkg-versions` outputs and run a sed command.
The sed pattern targets the badge color as an anchor (e.g. `-2496ED` for
Docker's brand blue) to avoid matching other badge text.
**Remove**: delete the variable read + sed block for the removed component.

## Why It Works

- The color-anchored sed pattern is specific enough to avoid false matches
  while being generic enough to handle any version string.
- Separating extraction (step 2) from update (step 3) keeps the pipeline
  testable — versions flow through `GITHUB_OUTPUT` and can be inspected
  independently.
- The whitelist in step 1 prevents the CI from silently skipping unknown ARGs
  — if a new ARG is added but not whitelisted, the count check fails loudly.

## Side Effects / Tradeoffs

- Each new badge adds ~12 lines of YAML across the three locations. For 10+
  badges, consider switching to a data-driven approach (YAML list → loop).
- The expected count check (`-ne 11`) is a double-edged sword: it catches
  omissions but requires a manual update every time an ARG is added/removed.
- Badge colors are hardcoded in both README.md and the sed pattern. If a
  component changes brand color, both must be updated.

## Evidence

- Docker, Playwright, and lean-ctx badges were added following this exact
  pattern in July 2026 (commit history for `dependency-update.yml`).
- The weekly scheduled run correctly updates badges when upstream versions
  change (example: PR #50 chore update).

## Related Files

- `.github/workflows/dependency-update.yml` — contains all three update points
- `README.md` — badge definitions (lines ~12-14)
- `docs/knowledge/tooling/dependency-update-workflow.md`

## Tags

`badge` `readme` `ci` `dependency-update` `shields.io` `automation`
