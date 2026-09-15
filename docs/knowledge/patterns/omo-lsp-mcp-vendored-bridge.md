# Restoring the OMO LSP MCP Bridge as a Vendored, Absolute-Path Server

## Context

The pre-slim OMO stack (`oh-my-openagent@4.19.4`) registered an MCP server named
`lsp`:

```json
{ "lsp": { "command": "node", "args": ["../../lsp-daemon/dist/cli.js", "mcp"], "cwd": ".", "startup_timeout_sec": 10 } }
```

The slim migration (`oh-my-opencode-slim@2.2.20`) dropped that MCP server, so
the `diagnostics`, `goto_definition`, `find_references`, `symbols`,
`prepare_rename`, and `rename` MCP tools disappeared from OpenCode. Native LSP
(the `lsp` config block) remained, but the MCP tools did not.

## Problem

The old command is **cache-relative** (`../../lsp-daemon/dist/cli.js` resolved
from a per-version OMO plugin cache directory) and therefore cannot be copied
into runtime config. Reinstalling from a registry is not possible:

```bash
curl -s -o /dev/null -w '%{http_code}\n' 'https://registry.npmjs.org/@code-yeongyu%2Flsp-daemon'     # 404
curl -s -o /dev/null -w '%{http_code}\n' 'https://registry.npmjs.org/@code-yeongyu%2Flsp-tools-mcp'  # 404
```

## Solution

1. **Vendor the prebuilt bundle** from the OMO plugin cache under a deliberate
   repository layout: `vendor/omo-lsp-daemon/dist/{cli.js,package.json}`. The
   bundle imports only `node:*` builtins, so it needs no `node_modules`;
   `dist/package.json` must sit next to `cli.js` because the bundle reads it to
   resolve the daemon version directory (`~/.omo/lsp-daemon/v0.1.0`).
2. **Install it at a stable absolute path** in the image
   (`/opt/ai-engkit/vendor/lsp-daemon`) and smoke-test `initialize` at build
   time.
3. **Generate `mcp.lsp` with the absolute command** in
   `entrypoint.d/02-init-config.sh`:

   ```json
   "lsp": { "type": "local", "command": ["node", "/opt/ai-engkit/vendor/lsp-daemon/dist/cli.js", "mcp"], "enabled": true, "timeout": 30000 }
   ```

   `mcp.lsp` is a distinct config key from the native `lsp` block, so the Admin
   LSP management path (npm language servers) is untouched.

The bundle exposes `status`, `diagnostics`, `goto_definition`,
`find_references`, `symbols`, `prepare_rename`, `rename`, and
`install_decision`. `tools/list` is answered locally by the proxy, so it can be
smoke-tested without a language server; `tools/call` spawns the shared per-user
daemon on demand.

## Why It Works

- The bundle is a Bun-built `--target node` ESM artifact with only `node:`
  builtins, so it is self-contained and portable across the image.
- An absolute image path removes any dependence on cache layout or the plugin
  install path, satisfying the "no cache-relative runtime config" constraint.
- Keeping `mcp.lsp` separate from the native `lsp` block means the two features
  evolve independently: MCP tool registration vs. OpenCode-managed language
  servers.
- A 30s per-request timeout covers cold language-server startup for
  `tools/call`; `tools/list` and `initialize` are instant.

## Side Effects / Tradeoffs

- A ~231 KB prebuilt bundle is checked into the repository. It is pinned by
  version and SHA-256 in `vendor/omo-lsp-daemon/README.md`; refresh only from a
  verified upstream source.
- Daemon state is written to `~/.omo/lsp-daemon/v0.1.0/` (the `omo-config`
  volume), the same location the upstream bundle used.
- Native Exa websearch is separate: it is an OpenCode-native tool enabled by
  `OPENCODE_ENABLE_EXA` and gated by `permission.websearch`, not an MCP server.

## Evidence

- Tests: `test/test-lsp-mcp-config.sh` (config assertions + `tools/list`
  smoke); `test/run-tests.sh` section 8.1b (container runtime).
- Diagnostics: `tools/list` returns the eight tools listed above;
  `tools/call status` reports configured/installed LSP servers.
- Logs / observed behavior: isolated bundle run with `HOME` redirected spawns
  the daemon and writes `~/.omo/lsp-daemon/v0.1.0/`.
- Docs / source references: `vendor/omo-lsp-daemon/README.md`;
  `entrypoint.d/02-init-config.sh`.

## Related Files

- `vendor/omo-lsp-daemon/README.md`
- `entrypoint.d/02-init-config.sh`
- `Dockerfile`
- `test/test-lsp-mcp-config.sh`
- `test/run-tests.sh`
- `docs/TOOLING.md`

## Tags

- mcp
- lsp
- vendoring
- opencode
- slim-migration
