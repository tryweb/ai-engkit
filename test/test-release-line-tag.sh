#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/.github/scripts/release-line-tag.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
git init -q -b main
git config user.email "test@example.com"
git config user.name "Test"

# v1 line on main.
echo a > f && git add f && git commit -qm "c1" && git tag v1.0.0
echo b > f && git commit -qam "c2" && git tag v1.20.2
echo c > f && git commit -qam "c3" && git tag v1.21.0
echo d > f && git commit -qam "c4" && git tag v1.21.1

# Parallel v2 line on an unmerged branch (must never leak into v1 lookups).
git checkout -q -b v2
echo e > f && git commit -qam "c5" && git tag v2.0.1
echo f > f && git commit -qam "c6" && git tag v2.0.2
git checkout -q main

# On the v1 line: the latest stable tag is the highest v1 tag.
[ "$(bash "$SCRIPT")" = "v1.21.1" ]

# The exact reported bug: v1.21.1's predecessor is v1.21.0, NOT v2.0.2.
[ "$(bash "$SCRIPT" v1.21.1)" = "v1.21.0" ]
[ "$(bash "$SCRIPT" v1.21.0)" = "v1.20.2" ]
[ "$(bash "$SCRIPT" v1.20.2)" = "v1.0.0" ]

# First release on the line has no predecessor.
[ -z "$(bash "$SCRIPT" v1.0.0)" ]

# On the v2 line the helper follows that line instead.
git checkout -q v2
[ "$(bash "$SCRIPT")" = "v2.0.2" ]
[ "$(bash "$SCRIPT" v2.0.2)" = "v2.0.1" ]
# v2.0.1's predecessor is not v1.21.1 (different major line).
[ -z "$(bash "$SCRIPT" v2.0.1)" ]

echo "PASS: release-line-tag resolves the previous tag on the same major line"
