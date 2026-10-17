#!/usr/bin/env bash
# Resolve a stable release tag (vMAJOR.MINOR.PATCH) for the CURRENT release line.
#
# ai-engkit keeps parallel release lines: v1.* ships from `main`, while v2.*
# lives on its own branch. "Highest tag in the repo" therefore belongs to a
# DIFFERENT line — a v1.21.1 release wrongly resolved its predecessor as v2.0.2,
# and "commits since <tag>" / "next version" walked the wrong range. Every
# release lookup must stay on the line being released, so this helper only
# considers tags reachable from HEAD and, when given a reference tag, the same
# MAJOR.
#
# Usage:
#   release-line-tag.sh                 latest stable tag on this line
#                                       (highest vX.Y.Z reachable from HEAD)
#   release-line-tag.sh <ref-tag>       previous stable tag on <ref-tag>'s line
#                                       (highest v<ref-major>.Y.Z reachable from
#                                       HEAD and strictly lower than <ref-tag>)
#
# Prints nothing and exits 0 when no matching tag exists (callers treat that as
# "first release").
set -euo pipefail

REF="${1:-}"

# Stable semver tags reachable from HEAD, highest version first. The anchored
# pattern already excludes prereleases (v1.2.3-rc1) and non-semver tags, so no
# separate rc/beta filter is needed.
mapfile -t TAGS < <(
  git tag --merged HEAD --sort=-version:refname 2>/dev/null \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' || true
)

if [ -z "$REF" ]; then
  printf '%s\n' "${TAGS[0]:-}"
  exit 0
fi

# Derive the "v<major>." prefix from the reference tag (accepts v1.21.1 or 1.21.1).
MAJOR_PREFIX="v${REF#v}"
MAJOR_PREFIX="${MAJOR_PREFIX%%.*}."

# TAGS is descending; the first strictly-lower same-major tag is the predecessor.
for tag in "${TAGS[@]:-}"; do
  [ -n "$tag" ] || continue
  [ "$tag" = "$REF" ] && continue
  case "$tag" in "$MAJOR_PREFIX"*) ;; *) continue ;; esac
  if [ "$(printf '%s\n%s\n' "$tag" "$REF" | sort -V | head -1)" = "$tag" ]; then
    printf '%s\n' "$tag"
    exit 0
  fi
done

exit 0
