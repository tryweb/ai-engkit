# V1 Agent Routing Configuration

The V1 routing proof of concept stores fallback chains in
`~/.config/opencode/routing.json`. The future V1 routing plugin consumes this
file; this document defines the migration-facing subset and is not a plugin
implementation.

## Schema

The top-level `version` is `1`. `defaults` is optional when reading (the
defaults below apply), and `chains` maps OpenCode agent names to routing chains.
Every chain has 1..10 entries. Each entry requires `model` in
`provider/model` form and may include a non-empty `variant`.

```json
{
  "version": 1,
  "defaults": {
    "cooldownSeconds": 60,
    "maxFallbackAttempts": 3,
    "notifyOnFallback": false
  },
  "chains": {
    "explore": {
      "chain": [
        { "model": "anthropic/claude-sonnet-4", "variant": "high" },
        { "model": "openai/gpt-4.1" }
      ]
    }
  }
}
```

The defaults are a 60-second cooldown, at most 3 fallback attempts, and no
fallback notification. Agent-level overrides use `cooldownSeconds`,
`maxFallbackAttempts`, and `notifyOnFallback`.

## Native startup synchronization

Native startup does not use, migrate, or synchronize model values from
`~/.omo/omo.jsonc`. `routing.json` is the sole source for native routing
chains. After regenerating `opencode.json`, entrypoint seeds each non-empty chain's head into
`agent.<name>.model` and, when present, `agent.<name>.variant` so OpenCode's
native `/agent` assignments match the routing configuration after a restart.

If `routing.json` is absent, startup leaves the generated agent assignments
unchanged. Native startup reconciliation does not auto-select or replace
models; model changes are made through the native Agent Models apply flow.
