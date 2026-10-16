#!/usr/bin/env bash
# lib-reserved-bun-packages.bash — managed-core package-name guard.
#
# The AI-EngKit core (OpenChamber + OpenCode) is image-managed and installed in
# a dedicated prefix, not the user Bun global prefix. A startup BUN_PACKAGES
# request must never (re)install a core package into the user prefix, which
# would shadow the managed core. This library rejects such requests before any
# install runs. It does not wrap the Bun command and does not block unrelated
# packages.

# shellcheck shell=bash

AI_ENGKIT_CORE_PACKAGE_NAMES=(opencode-ai @opencode/cli @openchamber/web)

# bun_package_name SPEC -> package name with any @version suffix removed.
# Handles scoped names (`@scope/name@version`) and plain names (`name@version`).
bun_package_name() {
  local spec="$1"
  case "$spec" in
    @*/*@*) printf '%s' "${spec%@*}" ;;
    @*) printf '%s' "$spec" ;;
    *@*) printf '%s' "${spec%@*}" ;;
    *) printf '%s' "$spec" ;;
  esac
}

# find_reserved_bun_package SPEC... -> prints the first reserved name found and
# returns 0; returns 1 when the request contains no reserved core package.
find_reserved_bun_package() {
  local spec name candidate
  for spec in "$@"; do
    name="$(bun_package_name "$spec")"
    for candidate in "${AI_ENGKIT_CORE_PACKAGE_NAMES[@]}"; do
      if [[ "$name" == "$candidate" ]]; then
        printf '%s' "$name"
        return 0
      fi
    done
  done
  return 1
}

# assert_no_reserved_bun_packages SPEC... -> nonzero with a clear error before
# any mutation when a managed-core package name is requested.
assert_no_reserved_bun_packages() {
  local reserved
  if ! reserved="$(find_reserved_bun_package "$@")"; then
    return 0
  fi
  {
    echo "ERROR: BUN_PACKAGES requested managed-core package '${reserved}'."
    echo "The AI-EngKit core (opencode-ai, @opencode/cli, @openchamber/web) is image-managed and installed"
    echo "in a dedicated prefix; it cannot be installed or replaced through BUN_PACKAGES."
    echo "Deploy a new AI-EngKit image to change the core version. Refusing the request before any install."
  } >&2
  return 1
}
