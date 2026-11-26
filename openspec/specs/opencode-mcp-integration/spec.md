## Purpose

Defines a durable AI-EngKit integration point for selecting the LeanCTX MCP executable across container restarts while keeping AI-EngKit's generated OpenCode configuration authoritative.

## Requirements

### Requirement: LeanCTX MCP wrapper path is configurable through AI-EngKit deployment configuration
The `ai-dev` service SHALL accept an optional `LEANCTX_MCP_WRAPPER` environment setting and the entrypoint SHALL use it as the sole executable in the final `mcp.lean-ctx.command` array when non-empty, reapplying it after later startup configuration writers. When unset or empty, the initial generated command SHALL remain `['lean-ctx']` and AI-EngKit SHALL preserve the existing behavior of later LeanCTX initialization without an additional command rewrite.

#### Scenario: Default LeanCTX command remains compatible
- **WHEN** `LEANCTX_MCP_WRAPPER` is unset or empty
- **THEN** initial generated `opencode.json` contains `mcp.lean-ctx.command` equal to `['lean-ctx']`
- **AND** AI-EngKit does not post-process the command after the existing `lean-ctx init` behavior

#### Scenario: Explicit wrapper path is persisted across restart
- **WHEN** `LEANCTX_MCP_WRAPPER` contains a valid in-container wrapper path and `ai-dev` starts
- **THEN** generated `opencode.json` contains `mcp.lean-ctx.command` equal to a one-element array containing that exact path
- **AND** the exact wrapper command remains after later startup configuration writers complete
- **AND** recreating `ai-dev` with the same Compose environment preserves that command

### Requirement: Explicit LeanCTX MCP wrapper paths are validated fail-closed
When `LEANCTX_MCP_WRAPPER` is non-empty, the entrypoint SHALL require an absolute path to an existing executable regular file before writing generated `opencode.json`; invalid overrides SHALL report the setting and block startup configuration rather than silently falling back to the default.

#### Scenario: Relative wrapper path is rejected
- **WHEN** `LEANCTX_MCP_WRAPPER` is set to a relative path
- **THEN** startup configuration fails with an actionable validation error and does not write a new `opencode.json`

#### Scenario: Missing or non-executable wrapper path is rejected
- **WHEN** `LEANCTX_MCP_WRAPPER` points to a missing file, non-regular file, or file without execute permission
- **THEN** startup configuration fails with an actionable validation error and does not write a new `opencode.json`

### Requirement: LeanCTX override preserves unrelated generated MCP configuration
Selecting `LEANCTX_MCP_WRAPPER` SHALL change only the executable used for the generated LeanCTX MCP entry; codegraph, context7, playwright, plugins, LSP, permissions, and provider configuration SHALL retain their existing generated behavior.

#### Scenario: Wrapper override leaves other MCP servers unchanged
- **WHEN** `LEANCTX_MCP_WRAPPER` is set to a valid wrapper path
- **THEN** generated `opencode.json` retains the same codegraph, context7, and playwright entries as the default configuration
- **AND** the LeanCTX entry differs only in its `command` value

### Requirement: Compose exposes the LeanCTX MCP wrapper as an ai-dev-only option
The supported Compose contract SHALL inject `LEANCTX_MCP_WRAPPER` from the host environment into the `ai-dev` process environment, document it in `.env.example` and operator documentation, and SHALL NOT add it to the `ai-admin` service environment or require it for a normal installation. The existing `.env` file mount on `ai-admin` SHALL remain unchanged.

#### Scenario: ai-dev receives the configured override
- **WHEN** the host sets `LEANCTX_MCP_WRAPPER` and starts the standard Compose project
- **THEN** the variable is available to `ai-dev` for entrypoint config generation
- **AND** an unset variable leaves existing deployments unchanged
- **AND** the resolved Compose configuration contains the variable under `ai-dev.environment` and not under `ai-admin.environment`

#### Scenario: Symlinked wrapper path is rejected
- **WHEN** `LEANCTX_MCP_WRAPPER` points to a symlink, even when its target is an executable file
- **THEN** startup configuration is blocked with an actionable validation error before writing a new `opencode.json`
