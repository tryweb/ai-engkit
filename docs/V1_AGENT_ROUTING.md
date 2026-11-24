# V1 Agent Routing Configuration

Fresh installs use Native agents. The Admin Agent Models feature stores model
chains in `~/.config/opencode/routing.json`; this is the authoritative Native
configuration. OMO is not loaded on the Native line.

OpenCode's generated native agent config is synchronized to the first model in
each chain. The remaining entries are retained in `routing.json`, but are not
automatically tried as failover models by OpenCode itself; a separate routing
consumer would be needed for runtime fallback behavior.

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
native `/agent` assignments match the primary model in routing configuration after a restart.

If `routing.json` is absent, startup leaves the generated agent assignments
unchanged. Native startup reconciliation does not auto-select or replace
models; model changes are made through the native Agent Models apply flow.
