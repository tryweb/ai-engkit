# Playwright MCP — Bundled Browser Wrapper

## Context

ai-engkit ships `@playwright/mcp` so AI agents can drive a real browser. The
Docker image is built on Ubuntu 24.04 and **has no system Google Chrome**
installed — only Playwright's bundled Chromium under `/ms-playwright/`. When
the MCP server starts, it must locate a browser executable.

This applies to any Docker-based image that wants to expose Playwright MCP
without shipping the full Google Chrome distribution.

## Problem

`@playwright/mcp`'s `--browser` flag accepts channel names only:

| Value | Resolves to |
|-------|-------------|
| `chrome` | System Google Chrome (default — looks for `/opt/google/chrome/chrome` and similar) |
| `msedge` | System Microsoft Edge |
| `firefox` / `webkit` | Playwright-bundled Firefox / WebKit |

The value `chromium` is **not** a valid `--browser` argument. With no flag, the
server defaults to `chrome` and tries to launch system Chrome. On this image
it fails with:

```
browserType.launch: Executable doesn't exist at /opt/google/chrome/chrome
```

Earlier attempts (e.g. `playwright install --only-shell chromium` to slim the
image) made things worse: the headless shell is not what the MCP's
new-headless mode launches — it expects the full Chromium binary.

## Solution

Add a wrapper script `/usr/local/bin/pw-mcp` that:

1. Resolves the actual bundled Chromium path at runtime under
   `/ms-playwright/chromium-<revision>/chrome-linux64/chrome` (the revision
   directory changes with every Playwright release).
2. Falls back to the headless shell if the full build is absent.
3. Bakes the `@playwright/mcp@<version>` reference at build time via
   `sed` so the wrapper is self-contained (no runtime env var dependency).
4. Launches `bunx -y @playwright/mcp@<pinned> --executable-path=<path>
   --no-sandbox --headless`.

Wire it into `opencode.json` (both baked default and runtime regenerator):

```json
"playwright": {
  "type": "local",
  "command": ["pw-mcp"],
  "enabled": true
}
```

The wrapper script (core shape — full version in repo):

```bash
#!/usr/bin/env bash
set -euo pipefail
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/ms-playwright}"
PLAYWRIGHT_MCP_VERSION="${PLAYWRIGHT_MCP_VERSION:-0.0.76}"

CHROME_BIN="$(find "${PLAYWRIGHT_BROWSERS_PATH}" \
    -type f -name chrome -path '*/chromium-*/chrome-linux64/*' 2>/dev/null | sort -V | tail -1)"

if [ -z "${CHROME_BIN}" ]; then
    CHROME_BIN="$(find "${PLAYWRIGHT_BROWSERS_PATH}" \
        -type f -name chrome-headless-shell -path '*/chromium_headless_shell-*/chrome-headless-shell-linux64/*' 2>/dev/null | sort -V | tail -1)"
fi

exec bunx -y "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" \
    --executable-path="${CHROME_BIN}" --no-sandbox --headless "$@"
```

## Why It Works

- **`--executable-path` overrides `--browser`**: The MCP's documented flag
  precedence is: explicit executable path > browser channel. Passing it
  sidesteps the system-Chrome lookup entirely.
- **Runtime resolution handles version drift**: Playwright bumps the
  `chromium-<revision>` suffix on every release. Hardcoding a path like
  `/ms-playwright/chromium-1228/...` breaks the next `playwright install`.
  Using `find` with a glob pattern (`chromium-*/chrome-linux64/chrome`)
  always finds whatever's there.
- **Build-time `sed` bakes the version**: The wrapper stays self-contained
  (no env-var requirement at runtime) so the test suite can grep the script
  for the pinned version and assert it matches the build arg.
- **Headless + `--no-sandbox`** are required: the Docker image has no
  X server and no namespace to drop into. Both are safe for the dev /
  automation use case the MCP targets.

## Side Effects / Tradeoffs

- **Image size**: Full Chromium is ~280 MB. The previous `--only-shell`
  attempt was ~114 MB but incompatible with the MCP's new-headless mode.
  Keep the full build and pay the disk cost. (Acceptable for a dev
  image; revisit if shipping as a production runtime.)
- **Indirection**: An extra `exec` layer between OpenCode and the MCP
  process. Harmless — exit codes and signals propagate. The only visible
  effect is `pgrep` shows `pw-mcp` rather than the underlying `bunx`/`node`
  child.
- **Playwright CLI ≠ MCP binary**: The Playwright CLI test (e.g.
  `playwright --version`) and the bundled browser work without the wrapper.
  The wrapper is only needed for the MCP server's `chrome` channel default.

## Evidence

- `v0.17.0` — Added `pw-mcp` wrapper, fixed 2 pre-existing test assertions
  that were still grepping the old `bunx` / `playwright` string format
- 51/51 integration tests pass against `docker compose -f docker-compose.dev.yml up`
- `pw-mcp --help` outputs the MCP server's `Usage: Playwright MCP [options]`
  — proves the wrapper fully launches the server with the resolved
  executable path
- `pw-mcp --version` returns `Version 0.0.76` — version is correctly baked
- Smoke test: `find /ms-playwright -name chrome -path "*/chrome-linux64/*"`
  returns `/ms-playwright/chromium-1228/chrome-linux64/chrome` after
  `playwright install`

## Related Files

- `scripts/pw-mcp.sh` — The wrapper itself (~36 lines, executable)
- `Dockerfile` (lines ~150-175) — `playwright install --with-deps chromium`
  + `COPY scripts/pw-mcp.sh` + `sed` to bake `PLAYWRIGHT_MCP_VERSION`
- `entrypoint.d/02-init-config.sh` — Regenerates `opencode.json` with
  `"command": ["pw-mcp"]` for `mcp.playwright`
- `test/run-tests.sh` — 3 new assertions: wrapper installed, config uses
  it, version is pinned
- `docs/CHANGELOG.md` — `v0.17.0` entry documents the change

## Tags

`#playwright` `#mcp` `#docker` `#browser-automation` `#wrapper-pattern`
`#opencode`
