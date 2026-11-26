# Proposal

## Why

AI-EngKit regenerates `opencode.json` on every `ai-dev` start and currently hardcodes the LeanCTX MCP command to `lean-ctx`. This overwrites a downstream wrapper configured directly in the persistent config volume, so integrations cannot reliably customize LeanCTX's launch path across container restarts.

## What Changes

- Add a documented optional `LEANCTX_MCP_WRAPPER` setting to AI-EngKit's `.env` / `ai-dev` process-environment contract.
- Keep the default behavior unchanged (`lean-ctx`); when the setting is present, generate the LeanCTX MCP command using the supplied absolute in-container executable path.
- Validate explicit overrides before writing `opencode.json`; an invalid/non-executable override must fail startup configuration clearly rather than silently fall back.
- Cover default, configured, and invalid override behavior with entrypoint tests; document volume/path ownership and restart semantics.
- Preserve all other generated MCP entries and the existing image-managed config-generation lifecycle.

This creates an AI-EngKit standard integration point; it does not ship or manage the wrapper itself. A consuming application remains responsible for installing its wrapper into the persistent OpenCode config volume and setting `LEANCTX_MCP_WRAPPER` through its AI-EngKit deployment configuration.

## Capabilities

### New Capabilities

- `opencode-mcp-integration`: durable, validated environment-based customization of the LeanCTX MCP command while AI-EngKit continues to generate the rest of `opencode.json`.

### Modified Capabilities

None.

## Impact

- `docker-compose.yml`, `.env.example`, `entrypoint.d/02-init-config.sh`, and its isolated shell test harness.
- README configuration reference and OpenSpec spec for the new MCP integration contract.
- Downstream consumers (such as ep-design-ai-srv) may use the new variable without patching generated `opencode.json`; the setting is explicitly injected into `ai-dev`, not added to `ai-admin`'s Compose environment. No Docker socket or secret changes are required.
