# OpenChamber New-Session Default Model Not Applied (kimi-k3 instead of big-pickle)

> **Historical incident:** This diagnosis was captured on the legacy OMO
> runtime. Fresh installs now use Native agents/routing and do not load OMO;
> use it only when investigating an existing installation still on that line.

## Context

ai-engkit v1.9.0 seeds OpenChamber settings with `"defaultModel": "opencode/big-pickle"` so new sessions default to Big Pickle. OpenChamber 1.17.1 resolves the new-session default model in `@openchamber/web/server/lib/openchamber-sessions/routes.js` (`resolveDefaultSelection`). Deployed installs keep their settings in the persistent `openchamber-data` Docker volume at `/home/devuser/.config/openchamber/settings.json`.

## Problem

After upgrading to v1.9.0 (and restarting the container), new OpenChamber sessions still defaulted to `opencode-go/kimi-k3` instead of `opencode/big-pickle`. The version was not the issue — v1.9.1 does not exist; the Big Pickle seed is already in v1.9.0 (commit `67a94b4`).

Root-cause chain, each link verified:

1. The seed block in `entrypoint.d/02-init-config.sh` only ran when `settings.json` did **not exist** (`if [ ! -f ... ]` guard). The persistent volume already had a settings.json predating the seed, so the seed never fired — and can never fire on that install again.
2. The current settings.json had **no `defaultModel` key** (a July 3 backup, `settings.json.bak-jtipam-fix:187`, still carried `"defaultModel": "opencode/big-pickle"`; it was lost in a later settings rewrite).
3. Without `settings.defaultModel`, `resolveDefaultSelection` fell to precedence ②: the default agent's model. The `build` agent is `hidden: true` + `subagent` mode, so the first non-hidden **primary** agent won — "Sisyphus - ultraworker", whose model is `opencode-go/kimi-k3`. Precedence ④ fallback (`opencode/big-pickle`) was never reached, even though the `opencode` provider was present.
4. The `kimi-k3` assignment comes from the oh-my-openagent plugin (v4.19.3): `AGENT_MODEL_REQUIREMENTS` in `dist/index.js` picks the best available model per agent from a `fallbackChain`, **overriding** the agent frontmatter models (`big-pickle`, `deepseek-v4-flash-free`). With the `opencode-go` provider available, sisyphus/prometheus/atlas/metis/sisyphus-junior/plan all get `opencode-go/kimi-k3`.

## Solution

Immediate fix (deployed install, no restart needed):

```bash
# on the host, inside the container
cp /home/devuser/.config/openchamber/settings.json /home/devuser/.config/openchamber/settings.json.pre-bigpickle-fix
jq '.defaultModel = "opencode/big-pickle"' /home/devuser/.config/openchamber/settings.json > /tmp/s.json && mv /tmp/s.json /home/devuser/.config/openchamber/settings.json
```

OpenChamber reads settings from disk per request (`readSettingsFromDiskMigrated`), so the change is live for the next new session.

Root-cause fix (repo, applies on next image build): the create-if-absent seed was replaced by `ensure_openchamber_default_settings` in `entrypoint.d/lib-openchamber-settings.bash`, called from `entrypoint.d/02-init-config.sh`:

- settings.json missing → seed a fresh file with `defaultModel` and `showOpenCodeUpdateNotifications: false` (original behavior).
- settings.json present but missing a key → backfill just the missing key(s), preserving all other keys (upgrades now self-heal).
- settings.json with both keys present → untouched (a user-chosen value must win).
- Symlinked file → skipped with a warning; non-JSON file → skipped with a warning (fails soft, never blocks container boot).

## Why It Works

`resolveDefaultSelection` precedence is: ① `settings.defaultModel` → ② default agent's model → ③ opencode config `model` → ④ `opencode/big-pickle` fallback → ⑤ first provider's first model. `opencode/big-pickle` is a real model in the opencode catalog (`opencode models` lists it), so as soon as `settings.defaultModel` is present, precedence ① resolves and the agent/plugin layer never gets consulted.

OpenChamber 1.17.1's settings whitelist (`server/lib/opencode/settings-helpers.js`) explicitly preserves `defaultModel`, so a settings rewrite will not strip it again.

## Side Effects / Tradeoffs

- The backfill never overwrites an existing `defaultModel` — if a user deliberately chose another model, it stays.
- The repo-side fix only reaches deployed hosts after the image is rebuilt; the one-line `jq` edit above is the immediate remedy for existing installs.
- `kimi-k3` on agents is plugin behavior (best-available-model selection), not a bug; it affects agent delegation, not the new-session default.
- Agent frontmatter `model:` values are overridden by the oh-my-openagent plugin at runtime — do not expect frontmatter models to be authoritative while that plugin is loaded.
- Agent models (delegation, agent switching) are decided by the oh-my-openagent plugin's `AGENT_MODEL_REQUIREMENTS` fallback chains × connected providers (the `opencode auth` store / env), not by any ai-engkit config file. The inert OMO model-defaults migration (`AI_ENGKIT_APPLY_OMO_MODEL_DEFAULTS`) was removed — see `omo-model-default-migration-inert.md`.
- Relationship to OMO agent models: the openchamber default and OMO agent models are independent pipelines, but they touch at `resolveDefaultSelection` precedence ② (reads the agent's model). While `settings.defaultModel` is absent, whatever the OMO layer assigns (migration config or plugin `AGENT_MODEL_REQUIREMENTS`) becomes the new-session default. Setting `defaultModel` (precedence ①) overrides the whole agent layer — fixing the openchamber default never requires touching OMO config, and vice versa. OMO *permissions* defaults (`.opencode/omo.jsonc.default`) do not carry models at all (see `patterns/omo-agent-permission-defaults.md`); the OMO *model* migration is a separate opt-in mechanism.

## Evidence

- `jq '.defaultModel' settings.json` after edit → `"opencode/big-pickle"`.
- `opencode models` lists `opencode/big-pickle` alongside `opencode-go/kimi-k3`, `moonshotai/kimi-k3`.
- `/config/providers` includes the `opencode` provider (needed for the fallback check).
- `test/test-openchamber-settings-seed.sh`: 7/7 assertions pass (seed, backfill preserves unrelated keys and nested arrays, user-chosen model untouched, symlink skipped, non-JSON soft-fails).
- OMO regression `test/test-omo-model-default-migration.sh` passes; `bash -n` clean on both entrypoint files.
- `resolveDefaultSelection` source at `@openchamber/web` 1.17.1 `server/lib/openchamber-sessions/routes.js` (constants `FALLBACK_PROVIDER_ID='opencode'`, `FALLBACK_MODEL_ID='big-pickle'`).

## Related Files

- `entrypoint.d/02-init-config.sh`
- `entrypoint.d/lib-openchamber-settings.bash`
- `test/test-openchamber-settings-seed.sh`
- `.github/workflows/ci.yml`
- `/home/devuser/.config/openchamber/settings.json` (runtime, host `192.168.11.196`)

## Tags

- openchamber
- default-model
- big-pickle
- kimi-k3
- entrypoint
- settings-seed
- backfill
- oh-my-openagent
- troubleshooting
