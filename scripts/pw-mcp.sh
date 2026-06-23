#!/usr/bin/env bash
# Wrapper for @playwright/mcp that resolves the Playwright-bundled Chromium at
# runtime and passes it via --executable-path. Required because:
#   1. @playwright/mcp's --browser flag maps to Chrome/Firefox/WebKit/Edge
#      channels, not to the Playwright-bundled Chromium binary.
#   2. The bundled Chromium lives at /ms-playwright/chromium-<revision>/...
#      where <revision> changes with every Playwright release.
#   3. This image has no system Google Chrome installed, so the MCP server
#      would otherwise fail to locate a browser.
set -euo pipefail

PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/ms-playwright}"
PLAYWRIGHT_MCP_VERSION="${PLAYWRIGHT_MCP_VERSION:-latest}"

# Prefer full bundled Chromium; fall back to the headless shell if absent.
CHROME_BIN="$(find "${PLAYWRIGHT_BROWSERS_PATH}" \
    -type f -name chrome -path '*/chromium-*/chrome-linux64/*' 2>/dev/null | sort -V | tail -1)"

if [ -z "${CHROME_BIN}" ]; then
    CHROME_BIN="$(find "${PLAYWRIGHT_BROWSERS_PATH}" \
        -type f -name chrome-headless-shell -path '*/chromium_headless_shell-*/chrome-headless-shell-linux64/*' 2>/dev/null | sort -V | tail -1)"
fi

if [ -z "${CHROME_BIN}" ] || [ ! -x "${CHROME_BIN}" ]; then
    echo "pw-mcp: no bundled Chromium found under ${PLAYWRIGHT_BROWSERS_PATH}" >&2
    echo "pw-mcp: expected paths like chromium-<rev>/chrome-linux64/chrome" >&2
    exit 127
fi

export PLAYWRIGHT_BROWSERS_PATH

exec bunx -y "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" \
    --executable-path="${CHROME_BIN}" \
    --no-sandbox \
    --headless \
    "$@"
