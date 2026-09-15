# Keep WebMCP Disabled by Default

## Context

AI-EngKit bundles Playwright MCP for browser automation. The current
`@playwright/mcp` pin includes `browser_webmcp_list` and
`browser_webmcp_call`, but `scripts/pw-mcp.sh` launches bundled Chromium with
headless mode and does not enable the WebMCP browser feature.

## Problem

WebMCP exposes tools authored by the active web page, including their names,
descriptions, schemas, and execution results. Those values are page-controlled
agent input, not a trusted security boundary. A malicious or compromised page
can use tool metadata or output for tool poisoning and indirect prompt
injection, while tools may perform authenticated or consequential actions.

AI-EngKit is a high-trust environment: the agent can automate arbitrary URLs,
may use persistent configuration, and the container mounts the Docker socket.
Enabling WebMCP by default would expand the agent's action surface without a
corresponding browser-enforced consent model.

## Solution

Keep WebMCP disabled in the default Playwright wrapper. Treat the WebMCP tools
already present in `@playwright/mcp` as dormant unless a dedicated experimental
profile explicitly enables the browser feature.

If WebMCP is needed for controlled site testing, use a separate headed browser
profile with:

- a non-persistent context and test credentials;
- an explicit origin allowlist;
- human confirmation for write or consequential calls;
- audit logging of origin, tool name, input, output, and result;
- agent-side handling that treats all page-provided metadata and output as
  untrusted content.

## Why It Works

Keeping the feature flag out of `scripts/pw-mcp.sh` preserves the existing
Playwright MCP behavior and avoids silently adding page-authored tools to the
agent context. It also follows the conservative pattern used by experimental
browser tooling: expose the capability for opt-in testing without changing the
default trust boundary.

Origin and permissions controls reduce exposure but do not make page-provided
tool descriptions trustworthy. They must therefore be combined with isolated
browser state and explicit action confirmation.

## Side Effects / Tradeoffs

- Controlled WebMCP workflows are unavailable in the default headless profile.
- WebMCP experiments require a separate headed setup and additional test
  coverage.
- Structured site tools may be more reliable than UI clicking for approved
  first-party test sites, but that benefit does not justify enabling them for
  arbitrary browsing by default.

## Evidence

- `Dockerfile` pins `PLAYWRIGHT_MCP_VERSION=0.0.81`.
- `scripts/pw-mcp.sh` passes `--headless` and does not pass a WebMCP feature
  flag.
- The current WebMCP implementation is an experimental/draft browser feature;
  Chrome documents origin isolation, permissions policy, and unresolved agent
  consent and prompt-injection concerns.
- Chrome documentation: <https://developer.chrome.com/docs/ai/webmcp>
- Chrome security guidance: <https://developer.chrome.com/docs/ai/webmcp/secure-tools>
- WebMCP imperative API: <https://developer.chrome.com/docs/ai/webmcp/imperative-api>
- WebMCP specification: <https://webmachinelearning.github.io/webmcp/>

## Related Files

- `Dockerfile`
- `scripts/pw-mcp.sh`
- `test/run-tests.sh`

## Tags

`webmcp`, `playwright`, `browser-automation`, `security`, `prompt-injection`, `architecture`
