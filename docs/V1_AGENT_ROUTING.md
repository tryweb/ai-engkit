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
`maxFallbackAttempts`, and `notifyOnFallback`. V1 currently migrates only the
head model and variant from OMO; it does not infer fallback entries.

## One-time OMO Migration

Run `scripts/migrate-omo-to-routing-v1.sh` in the target user's environment.
It reads `~/.omo/omo.jsonc`, writes `routing.json`, and seeds each migrated
agent's head into `opencode.json` under `agent.<name>.model` and, when present,
`agent.<name>.variant`. It does not remove or modify the OMO source file.

If a routing file already has one or more chains, migration exits successfully
without changing either destination. A missing or invalid OMO input is a
successful soft-skip. OMO `models` and `fallback_models` values are ignored
with a warning; only scalar `model` and `variant` are migrated.

This deliberately remains a standalone PoC. It is not wired into
`entrypoint.d`, and does not include the V2 plugin's server integration.
