# V2 Line Self-Registers context7 (No OMO-Injected MCPs)

## Context

The V1 line runs the `oh-my-openagent` plugin, which injects three remote MCP
servers at runtime: `websearch` (Exa), `context7`, and `grep_app`. They never
appear in `opencode mcp list` and are not present in `~/.config/opencode/opencode.json`.

The V2 line (`OMO_ENABLED=0`) runs no plugin, so all three silently disappear.
This matters whenever an agent needs current third-party library documentation —
the V1 habit of "ask context7" has no counterpart unless one is added.

## Problem

Two decisions, both about V2 config normalization:

1. How does a remote MCP get registered on the V2 line when nothing injects it?
2. How is it restricted to a single agent, given that the config generator also
   owns a V1-shaped `agent` map and other agents use the legacy `permission` field?

The trap is that V2's tolerant normalization has sharp edges: mixing the two
formats *inside one agent* silently drops one of them.

## Solution

1. `entrypoint.d/02-init-config.sh` registers context7 **on the V2 line only**,
   as a V2-shape remote server, plus a global permission deny:

   ```json
   {
     "mcp": { "servers": { "context7": {
       "type": "remote", "url": "https://mcp.context7.com/mcp", "oauth": false } } },
     "permissions": [ { "action": "context7_*", "resource": "*", "effect": "deny" } ]
   }
   ```

   The addition is emitted as a literal (`V2_EXTRA`) inside the region the
   `V2_MANAGED_CONFIG` merge slice already covers, so the entrypoint test's
   concatenated slice stays self-contained.

2. `.opencode/agents/librarian.md` grants it back with the **V2 `permissions`
   array** (agent rules are appended last, so the last matching rule wins):

   ```yaml
   permissions:
     - { action: "context7_*", resource: "*", effect: "allow" }
     - { action: webfetch,     resource: "*", effect: "allow" }
     - { action: websearch,    resource: "*", effect: "allow" }
     - { action: edit,         resource: "*", effect: "deny" }
     - { action: shell,        resource: "*", effect: "deny" }
   ```

3. Replace the other two injected servers instead of re-adding them:
   `websearch` → the native OpenCode `websearch` tool (needs a provider key,
   e.g. `EXA_API_KEY`; the image ships the tool but no key);
   `grep_app` → `gh search code` (the image's `gh` is already authenticated).

## Why It Works

- **Mixed members inside `mcp` are recognized.** `mcp.servers.context7` (V2)
  coexists with the V1-shape `mcp.codegraph` / `mcp.playwright` / `mcp.lean-ctx`;
  V2 normalizes all four into `mcp.servers.*`.
- **Permission precedence.** Rules are evaluated in order and the last match
  wins; global-config rules are appended before agent rules, so librarian's
  `context7_* allow` overrides the global `context7_* deny`.
- **`oauth: false` is required.** V2 enables OAuth on remote servers by default.
  context7's endpoint is anonymous (`initialize` returns HTTP 200 without
  credentials), so without `oauth: false` it sits unusable as "needs
  authentication".
- **The config survives the boot pipeline.** The V2 merge preserves only
  `.agent` and `.providers`, and `scripts/migrate-omo-to-native.sh` mutates only
  `.agent[...]` with a jq merge — neither touches `mcp` or top-level `permissions`.

## Side Effects / Tradeoffs

- The V2 `mcp` block gains a fourth key (`servers`); `test/test-v2.sh` asserts
  the key list and now expects `["codegraph","lean-ctx","playwright","servers"]`.
- On first use context7 reports `pending` and turns `connected` on a later
  `opencode mcp list` — a cold remote handshake, not a failure.
- The global deny is absolute: non-librarian agents cannot call context7 at all.
- `opencode mcp list` is **project-scoped** — run from `/home/devuser` it prints
  "No MCP servers configured" even though the global config lists them; run it
  from a project directory (e.g. `/home/devuser/workspace`) to see real status.
- Agent files are discovered from **more than one** `.opencode/agents/` on the
  path: the repo copy and the workspace mirror
  (`/home/devuser/workspace/.opencode/agents/` — the image `WORKDIR` is
  `/home/devuser/workspace`). Both are read, so `GET /api/agent` lists each
  agent's rules twice, and a stale mirror silently re-contributes the previous
  rule set. Mirror repo agents into the workspace (as `test/test-v2.sh` cell1
  does with `docker cp`) whenever agent files change.

## Evidence

- Tests: `entrypoint.d/02-init-config.test.sh` and
  `src/admin/lib/v2-startup-config.test.ts` (2 pass) after the change.
- Diagnostics: `GET /api/config` on the running V2 server normalizes the
  generated file to `mcp.servers.keys = [context7]` + the `permissions` deny,
  with no leftover legacy `mcp` keys.
- Logs / observed behavior (against the running `ai-engkit-v2dev` container,
  applying exactly the entrypoint merge, then restoring):
  - `jq -c '.mcp|keys|sort'` → `["codegraph","lean-ctx","playwright","servers"]`
  - `opencode mcp list` (from the project dir) → `○ context7 pending`, then
    `✓ context7 connected` on the next attempt.
  - `curl -X POST https://mcp.context7.com/mcp` `initialize` → `http_code=200`.
  - `GET /api/agent` → librarian resolves `context7_* => allow` and the new
    docs-lookup flow is present in its system prompt.
- Normalization probes that shaped the design:
  - one agent with both `permission:` and `permissions:` → the V1 `permission`
    part is **dropped** (only `permissions` survives);
  - one file with both `agent.librarian.{model,permission}` and
    `agents.librarian.permissions` → the V2 `agents` entry wins wholesale and
    the V1 model is dropped, so the agent-scoped grant must live in the agent
    markdown, never beside the generator's V1 `agent` map.

## Related Files

- `entrypoint.d/02-init-config.sh` (V2-only MCP + permissions emission)
- `.opencode/agents/librarian.md` (context7 grant + docs-lookup flow)
- `test/test-v2.sh` (cell1 seed assertion, cell2 config assertions)
- `docs/TOOLING.md` (built-in MCP table)

## Tags

- opencode-v2
- mcp
- context7
- permissions
- agent-config
- omo-migration
