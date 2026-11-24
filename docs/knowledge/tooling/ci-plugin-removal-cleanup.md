# CI Plugin Removal Cleanup Pattern

> Historical cleanup record from the OMO-enabled V1 setup. V2 no longer ships
> the OMO plugin or its version pin.

## Context
PR #63 moved SuperPower from a global baked plugin to a per-project feature managed from the admin Projects drawer. CI integration tests failed (exit code 1) because test scripts still asserted global superpowers presence.

## Problem
When a plugin is removed from global enablement, two CI artifacts break:
1. **docker-compose override** that injects the plugin via `OPENCODE_PLUGINS` environment variable
2. **Test scripts** that assert the plugin exists in `opencode.json` and `~/.config/opencode/skills/`

The entrypoint (`entrypoint.d/02-init-config.sh`) regenerates `opencode.json` from `OPENCODE_PLUGINS` at every container start. If the plugin is no longer globally enabled, the entrypoint no longer symlinks its skills to the global skills path.

## Solution
When removing a global plugin:

1. **Remove the CI override entirely** if it exists solely to inject that plugin. The `.env.example` → `.env` → `env_file` chain in `docker-compose.dev.yml` already provides `OPENCODE_PLUGINS`. The override was only needed for plugins not in `.env.example`.

2. **Update test assertions** to match the new expected state:
   - If the plugin source is still baked into the image (for per-project use), assert the source directory exists: `test -d /opt/opencode/baked-plugins/<plugin>/skills`
   - If the plugin source is fully removed, remove the test section entirely

3. **Do not** leave stale assertions checking for global skills at `~/.config/opencode/skills/<plugin>/` — these will fail because the entrypoint no longer symlinks them.

## Why It Works
The `.env.example` → `.env` → `env_file` → `OPENCODE_PLUGINS` → entrypoint → `opencode.json` chain is the canonical plugin configuration path. The CI override is an additive layer that should only exist when CI needs to deviate from the default. Once the default (`.env.example`) already has the correct value, the override is redundant.

## Side Effects / Tradeoffs
- The baked plugin source assertion (`test -d /opt/opencode/baked-plugins/...`) is weaker than the old global assertions — it only checks the source directory exists, not that the plugin is functional. This is appropriate because per-project enablement happens at runtime via the admin drawer, not at build time.
- Removing the override simplifies CI config but removes a layer of isolation. If future CI runs need to deviate from `.env.example`, the override will need to be re-added.

## Evidence
- CI run `32919636324` failed with exit code 1 in "Integration Tests" > "Run tests"
- Root cause: `test/run-tests.sh` section 8.4 checked `~/.config/opencode/skills/using-superpowers/SKILL.md` — file absent because `link_superpowers_skills` was removed from entrypoint
- After fix: section 8.4 checks `/opt/opencode/baked-plugins/superpowers/skills` directory instead

## Related Files
- `.github/workflows/ci.yml` — CI workflow, "Start services" step (removed override)
- `test/run-tests.sh` — Integration tests, section 8.4 (rewritten assertions)
- `entrypoint.d/02-init-config.sh` — Entrypoint, `link_superpowers_skills` function (removed)
- `Dockerfile` — Baked plugin source at `/opt/opencode/baked-plugins/superpowers/`
- `.env.example` — Default `OPENCODE_PLUGINS=oh-my-openagent`
- `docker-compose.dev.yml` — Uses `env_file: .env` for plugin config

## Tags
ci, plugins, superpowers, docker-compose, entrypoint, per-project, integration-tests
