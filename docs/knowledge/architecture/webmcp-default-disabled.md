# Keep WebMCP Disabled by Default

## Context

AI-EngKit bundles Playwright MCP for browser automation. Since `@playwright/mcp`
0.0.82, WebMCP is **opt-out**: the MCP server collects the tools a page
registers through the WebMCP API and exposes them as first-class `webmcp_<tool>`
MCP tools unless `--no-webmcp` (config `webmcp: false`, env
`PLAYWRIGHT_MCP_WEBMCP=false`) is passed. The earlier `browser_webmcp_list` /
`browser_webmcp_call` tools were removed in 0.0.82.

`scripts/pw-mcp.sh` therefore passes `--no-webmcp` explicitly. The page-side
WebMCP API (`document.modelContext`) additionally requires Chromium to be
launched with the experimental `--enable-features=WebMCP` flag (Chrome origin
trial), which the wrapper does not pass — but the server-layer opt-out is the
enforced boundary, not the browser flag.

## Problem

WebMCP exposes tools authored by the active web page, including their names,
descriptions, schemas, and execution results. Those values are page-controlled
agent input, not a trusted security boundary. A malicious or compromised page
can use tool metadata or output for tool poisoning and indirect prompt
injection, while tools may perform authenticated or consequential actions.

Since 0.0.82 these tools appear automatically in the agent's tool list with a
`tools/list_changed` notification whenever a page registers them. The MCP server
adds advisory markers (`[UNTRUSTED: ...]`, `readOnly`/`consequential`-style
annotations) and sanitizes tool names and schemas, but those are labels on
page-supplied data, not a consent or isolation boundary.

AI-EngKit is a high-trust environment: the agent can automate arbitrary URLs,
may use persistent configuration, and the container mounts the Docker socket.
Enabling WebMCP by default would expand the agent's action surface without a
corresponding browser-enforced consent model.

## Solution

Keep WebMCP disabled in the default Playwright wrapper by passing `--no-webmcp`
to `playwright-mcp`. After 0.0.82 this is an explicit server-layer opt-out, not
reliance on the browser feature flag being absent. If WebMCP is needed for
controlled site testing, use a separate headed browser profile with:

- a non-persistent context and test credentials;
- an explicit origin allowlist;
- human confirmation for write or consequential calls;
- audit logging of origin, tool name, input, output, and result;
- agent-side handling that treats all page-provided metadata and output as
  untrusted content.

## Why It Works

Passing `--no-webmcp` in `scripts/pw-mcp.sh` keeps page-authored tools out of
the agent context regardless of how the bundled Chromium evolves (e.g. if a
future Playwright build enables WebMCP by default). It follows the conservative
pattern used by experimental browser tooling: expose the capability for opt-in
testing without changing the default trust boundary.

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
- The mainline wrapper must remember to re-add `--no-webmcp` if `playwright-mcp`
  is ever upgraded to a version that inverts the flag (both `--no-webmcp` and
  `--webmcp` forms should be verified against `playwright-mcp --help`).

## Evidence

- `Dockerfile` pins `PLAYWRIGHT_MCP_VERSION=0.0.82`.
- `scripts/pw-mcp.sh` passes `--no-webmcp`, `--headless`, and `--no-sandbox`
  and does not pass a WebMCP browser feature flag.
- v0.0.82 release notes: WebMCP tools become real MCP tools, opt-out via
  `--no-webmcp` / `webmcp: false` / `PLAYWRIGHT_MCP_WEBMCP=false`; old
  `browser_webmcp_list` / `browser_webmcp_call` no longer exposed over MCP.
- Playwright's own WebMCP tests launch Chromium with
  `args: ['--enable-features=WebMCP']` — the API is not on by default in the
  bundled browser.
- WebMCP is an experimental/draft browser feature (Chrome origin trial from
  Chrome 149); Chrome documents origin isolation, permissions policy, and
  unresolved agent consent and prompt-injection concerns.
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
