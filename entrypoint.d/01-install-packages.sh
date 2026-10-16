#!/usr/bin/env bash
set -euo pipefail

strip_quotes() {
  local string="$1"
  string=${string#\"}
  string=${string%\"}
  string=${string#\'}
  string=${string%\'}
  echo "$string"
}

if [[ -n ${APT_PACKAGES:-} ]]; then
  echo "Installing apt packages"
  sudo apt-get update
  sudo apt-get install -y $(strip_quotes "$APT_PACKAGES")
  sudo rm -rf /var/lib/apt/lists/*
  echo
fi

if [[ -n ${BREW_PACKAGES:-} ]]; then
  echo "Installing brew packages"
  brew install $(strip_quotes "$BREW_PACKAGES")
  echo
fi

# Admin persists BUN_PACKAGES to lsp-managed.env inside the opencode-config
# volume on every Apply; import it here when the container environment does
# not already define BUN_PACKAGES, so compose values keep precedence.
if [ -z "${BUN_PACKAGES:-}" ]; then
  BUN_PACKAGES="$(grep -E '^BUN_PACKAGES=' "$HOME/.config/opencode/lsp-managed.env" 2>/dev/null | tail -n 1 | cut -d= -f2- || true)"
fi

if [[ -n ${BUN_PACKAGES:-} ]]; then
  # shellcheck source=entrypoint.d/lib-reserved-bun-packages.bash
  source "$(dirname "$0")/lib-reserved-bun-packages.bash"
  read -r -a request <<< "$(strip_quotes "$BUN_PACKAGES")"
  # Refuse a request that names the managed core before installing anything,
  # so a mixed request cannot partially mutate the user prefix.
  assert_no_reserved_bun_packages "${request[@]}"
  echo "Installing bun packages"
  bun install -g "${request[@]}"
  echo
fi
