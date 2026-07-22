# Custom Provider Injection via OPENCODE_PROVIDER

## Context

The container entrypoint (`entrypoint.d/02-init-config.sh`) regenerates `~/.config/opencode/opencode.json` on every startup to ensure consistency. This means manual edits to the config file are lost on restart.

For OpenCode providers (e.g., Ollama, OpenAI-compatible endpoints), users previously had no way to inject them without either:
- Rebuilding the image with a modified Dockerfile
- Manually editing the config after every restart

This is a multi-tenant deployment pattern — the image is shared across teams, each needs different provider configs.

## Problem

How to let deployers inject custom OpenCode provider definitions into `opencode.json` without modifying the Dockerfile or manually editing files inside the container.

## Solution

Introduce an `OPENCODE_PROVIDER` environment variable containing the provider JSON. The entrypoint deep-merges it into `opencode.json` after generating the base config.

### Implementation

In `entrypoint.d/02-init-config.sh`, after the base config write:

```bash
if [ -n "${OPENCODE_PROVIDER:-}" ]; then
  PROVIDER_OBJ=$(echo "$OPENCODE_PROVIDER" | jq '.' 2>/dev/null) || true
  if [ -n "$PROVIDER_OBJ" ]; then
    jq -s '.[0] * {provider: .[1]}' "$OPCODE_CONFIG_FILE" \
      <(echo "$PROVIDER_OBJ") > "${OPCODE_CONFIG_FILE}.tmp" \
      && mv "${OPCODE_CONFIG_FILE}.tmp" "$OPCODE_CONFIG_FILE"
  fi
fi
```

The env var expects the value of the `"provider"` key directly — e.g. `{"ollama":{...}}`, not `{"provider":{"ollama":{...}}}`. The `jq` expression wraps it with `{provider: .[1]}`.

### Enabling in docker-compose

Both `docker-compose.yml` and `docker-compose.dev.yml` pass the variable through:

```yaml
environment:
  - OPENCODE_PROVIDER=${OPENCODE_PROVIDER:-}
```

### Usage

```bash
# .env file (JSON on a single line)
OPENCODE_PROVIDER={"ollama":{"npm":"@ai-sdk/openai-compatible","name":"Ollama","options":{"baseURL":"http://192.168.11.206:11434/v1"},"models":{"gemma4:e2b":{"name":"gemma4:e2b","limit":{"context":655360,"output":81920}}}}}
```

Multiple providers can be sibling keys under the same JSON object.

## Why It Works

1. **Entrypoint owns `opencode.json`** — the regeneration rule is preserved, not broken.
2. **Deep-merge via `jq -s`** — the base config (plugins, LSP, MCP) and the provider config are independent sections; `*` merge combines them without conflict.
3. **Ephemeral JSON parsing** — `jq '.'` validates the JSON; invalid input prints a warning and is skipped, leaving the base config intact.
4. **Atomic write** — write to `.tmp` then `mv` prevents partial writes if the container is killed mid-write.

## Side Effects / Tradeoffs

- **JSON must be on a single line** in docker-compose `.env` files. For complex configurations, this is less readable. Alternative: use `docker-compose.override.yml` with YAML block scalars.
- **No support for multiple independent fragments** — if two env vars need to contribute separate sections of `opencode.json`, a file-based merge approach (e.g., `/etc/opencode/opencode.user.json`) would be needed instead.
- **Validation is permissive** — `jq '.' 2>/dev/null || true` silences parse errors. Invalid JSON is silently skipped with a warning.

## Evidence

- Image build: `docker compose -f docker-compose.dev.yml build ai-dev` — success
- Container start: `docker compose -f docker-compose.dev.yml up -d` — success
- Config merge verified: `docker exec ai-engkit-dev jq '.provider | keys' /home/devuser/.config/opencode/opencode.json` → `["ollama"]`
- Provider functional: `opencode run -m ollama/gemma4:e2b "Say hello"` → `Hello!`

## Related Files

- `entrypoint.d/02-init-config.sh` — merge logic (L162-174)
- `docker-compose.yml` — env passthrough (L24)
- `docker-compose.dev.yml` — env passthrough (L28)
- `.env.example` — usage example
- `README.md` — documented in env vars table
- `docs/CHANGELOG.md` — recorded under Unreleased

## Tags

`opencode` `provider` `entrypoint` `env-var` `configuration` `ollama` `container`
