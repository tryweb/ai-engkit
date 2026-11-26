#!/usr/bin/env bash
set -euo pipefail

# Optional downstream integration point. The default LeanCTX MCP command is
# unchanged unless the host explicitly points ai-dev at a wrapper in the
# persistent opencode-config volume.
wrapper="${LEANCTX_MCP_WRAPPER:-}"
if [[ -z "$wrapper" ]]; then
  exit 0
fi

if [[ "$wrapper" != /* ]]; then
  echo "[leanctx-mcp-wrapper] LEANCTX_MCP_WRAPPER must be an absolute in-container path" >&2
  exit 1
fi

if [[ -L "$wrapper" || ! -f "$wrapper" || ! -x "$wrapper" ]]; then
  echo "[leanctx-mcp-wrapper] LEANCTX_MCP_WRAPPER must name a regular executable file (not a symlink)" >&2
  exit 1
fi

exit 0
