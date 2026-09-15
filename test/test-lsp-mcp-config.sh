#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
ENTRYPOINT="$REPO_ROOT/entrypoint.d/02-init-config.sh"
BUNDLE="$REPO_ROOT/vendor/omo-lsp-daemon/dist/cli.js"
BUNDLE_PKG="$REPO_ROOT/vendor/omo-lsp-daemon/dist/package.json"
EXPECTED_CLI="/opt/ai-engkit/vendor/lsp-daemon/dist/cli.js"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }
pass() { echo "PASS: $1"; }

extract_function() {
  local name="$1"
  sed -n "/^# BEGIN FUNCTION: ${name}$/,/^# END FUNCTION: ${name}$/p" "$ENTRYPOINT"
}

[ -f "$BUNDLE" ] || fail "vendored lsp bridge bundle missing: $BUNDLE"
[ -f "$BUNDLE_PKG" ] || fail "vendored lsp bridge package.json missing: $BUNDLE_PKG"
jq -e '.name == "@code-yeongyu/lsp-daemon" and .version == "0.1.0"' "$BUNDLE_PKG" >/dev/null \
  || fail "vendored package.json is not @code-yeongyu/lsp-daemon@0.1.0"
pass "vendored lsp bridge layout and provenance"

extract_function resolve_lsp_mcp_command > "$TMP_DIR/helpers.sh"
extract_function render_opencode_config >> "$TMP_DIR/helpers.sh"
# shellcheck disable=SC1090
source "$TMP_DIR/helpers.sh"

grep -qF 'OPCODE_CONFIG=$(render_opencode_config "$PLUGIN_JSON" "$LSP_BLOCK" "$LSP_MCP_COMMAND_JSON")' "$ENTRYPOINT" \
  || fail "entrypoint does not wire render_opencode_config with the resolved lsp MCP command"
pass "entrypoint wires the lsp MCP command into the generated config"

[ "$(resolve_lsp_mcp_command)" = "[\"node\",\"$EXPECTED_CLI\",\"mcp\"]" ] \
  || fail "default lsp MCP command is not the absolute vendored path: $(resolve_lsp_mcp_command)"
pass "lsp MCP command uses the absolute vendored path"

CONFIG="$(render_opencode_config \
  '["oh-my-opencode-slim@2.2.20"]' \
  '{"marksman":{"command":["marksman","server"],"extensions":[".md",".markdown"]}}' \
  "$(resolve_lsp_mcp_command)")"

jq -e '.mcp.lsp.type == "local" and .mcp.lsp.enabled == true' <<<"$CONFIG" >/dev/null \
  || fail "mcp.lsp is not a local enabled MCP server"
pass "mcp.lsp is a local enabled MCP server"

jq -e '.mcp.lsp.command[0] == "node" and .mcp.lsp.command[2] == "mcp"' <<<"$CONFIG" >/dev/null \
  || fail "mcp.lsp command is not 'node <cli> mcp'"
jq -e --arg cli "$EXPECTED_CLI" '.mcp.lsp.command[1] == $cli' <<<"$CONFIG" >/dev/null \
  || fail "mcp.lsp command does not use the vendored absolute path"
jq -e '.mcp.lsp.command[1] | (startswith("/") and (contains("/.cache/") | not))' <<<"$CONFIG" >/dev/null \
  || fail "mcp.lsp command must be an absolute non-cache path"
pass "mcp.lsp command is absolute and not cache-relative"

jq -e '.permission.websearch == "allow"' <<<"$CONFIG" >/dev/null \
  || fail "permission.websearch must be allow"
pass "permission.websearch is allow"

jq -e '.mcp | has("websearch") | not' <<<"$CONFIG" >/dev/null \
  || fail "websearch must not be registered as an MCP block"
pass "websearch is not an MCP block"

jq -e '.lsp.marksman.command[0] == "marksman"' <<<"$CONFIG" >/dev/null \
  || fail "native lsp block is missing marksman"
jq -e '.mcp.codegraph.enabled == true and .mcp.playwright.enabled == true and .mcp["lean-ctx"].enabled == true' <<<"$CONFIG" >/dev/null \
  || fail "existing MCP servers were not preserved"
pass "native lsp block and existing MCP servers preserved"

if command -v node >/dev/null 2>&1; then
  MCP_OUTPUT="$( {
    printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0"}}}'
    printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
    sleep 1
    printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
    sleep 2
  } | timeout 20 node "$BUNDLE" mcp 2>/dev/null )"
  for tool in status diagnostics goto_definition find_references symbols prepare_rename rename; do
    grep -q "\"name\":\"$tool\"" <<<"$MCP_OUTPUT" || fail "tools/list does not expose $tool"
  done
  pass "tools/list exposes the restored LSP tool set"
else
  echo "SKIP: node not on PATH; tools/list smoke not run"
fi

echo "PASS: lsp MCP config and smoke checks"
