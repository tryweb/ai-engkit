# V2 Plugin Bake — Routing + Todo Enforcer in the Image

## Context

The V2 line (`OMO_ENABLED=0`) carries no `oh-my-openagent`. Its two behavioral
plugins are self-built: `b1-routing` (per-agent fallback chain + head
enforcement) and `m3-enforcer` (todo continuation on idle). Sources live under
`trial/b1-routing/` and `trial/m3-enforcer/`; verification records are
`trial/B1-VERIFY.md` and `trial/M3-VERIFY.md`.

Until this change both plugins were deployed only into the trial workspace
(`/home/devuser/workspace/.opencode/plugins/`) via a manual `docker cp`, so a
rebuilt image or a fresh environment had no routing/enforcer at all.

## Problem

How do you ship these plugins inside the image so every V2 deployment gets them
without a manual step, and why can't the source be dropped in as-is?

Two facts — the second is the trap:

1. **Discovery**: OpenCode V2 auto-discovers direct `.ts`/`.js` files and
   immediate plugin package directories under every `.opencode/plugins/`
   directory, and the global equivalent `~/.config/opencode/plugins/`. It does
   **not** need an `opencode.json` entry for those.
2. **Resolution**: A local file plugin does **not** get the bare specifier
   `@opencode/plugin` resolved by the runtime. Loading a plugin whose bundle
   left `@opencode/plugin` external fails with
   `Cannot find package '@opencode/plugin' imported from <file>`. The official
   docs' `import { Plugin } from "@opencode/plugin"` example only works when the
   package is resolvable (bundled or installed) at the plugin's location.

The already-proven trial artifacts were ~290 KB **self-contained** bundles
(`@opencode/plugin` + `effect` inlined). The 28.9 KB `bun build --external
@opencode/plugin` form loads-fails. So the image must build the self-contained
form with a matching `@opencode/plugin` version.

## Solution

Build the bundles at image build time and deploy them at boot, V2-gated:

- **Dockerfile**: `bun add @opencode/plugin@${OPENCODE_CLI_VERSION}` in a
  throwaway build dir that contains the plugin sources, then
  `bun build ./src/<id>/index.ts --outfile /opt/opencode/v2-plugins/<id>.js
  --target bun --format esm` (no `--external`, so it inlines the API). The build
  dir is deleted; only the two `.js` files ship, owned by the app user.
- **`entrypoint.d/08-deploy-v2-plugins.sh`**: when `OMO_ENABLED=0`, `install`
  each `/opt/opencode/v2-plugins/*.js` into
  `$HOME/.config/opencode/plugins/`. On the V1/OMO line it exits immediately.

The build dir must contain the entry file so `bun`'s resolver finds the
`node_modules` it just created (a build run from outside the source tree fails
with `Could not resolve "@opencode/plugin"`).

## Why It Works

- Global-dir auto-discovery means no config edit is needed, and overwriting on
  every boot makes a plugin upgrade take effect on container recreate.
- Building against `@opencode/plugin@${OPENCODE_CLI_VERSION}` keeps the inlined
  API in lockstep with the installed CLI (the version gate already asserts the
  CLI major).
- Gating on `OMO_ENABLED=0` keeps the plugin surface mutually exclusive with the
  OMO line: V1 never loads native-V2 plugins.

## Side Effects / Tradeoffs

- The image grows by ~0.57 MB (two bundles) and the build pulls ~269 npm
  packages transiently (`@opencode/plugin` + deps) to bundle, then discards them.
- `install` overwrites any same-named file in the volume on every boot; a user
  who hand-edited those files loses the edit (intended for baked artifacts).
- B1 no-ops safely when `~/.config/opencode/routing.json` is absent (routing
  disabled, logs only); no default chain is baked. Chains are written by the
  Admin agent-models page.
- Sources still live under `trial/`; promoting them to a non-trial location is a
  follow-up before the final v2 release.

## Evidence

- Reproduction (throwaway project, OpenCode 2.0.24): a `.js` plugin importing
  `@opencode/plugin` fails —
  `failed to load plugin ... Cannot find package '@opencode/plugin' imported from ...`.
- Self-contained build (`bun build ... --target bun --format esm`, no
  `--external`) yields ~290 KB and loads from the global dir with no failure:
  `loading plugin id=~/.config/opencode/plugins/b1-routing.js` +
  `.../m3-enforcer.js`.
- `bun add @opencode/plugin@2.0.24` installs from npm (269 packages).
- CI scope: the `build-v2` smoke asserts the two `/opt/opencode/v2-plugins/*.js`
  files exist, and `test/test-v2-trial.sh cell1` asserts they are deployed to
  `~/.config/opencode/plugins/` (boot log:
  `V2 plugins deployed to ... b1-routing.js m3-enforcer.js`) **and that they
  actually load**: each plugin appends `setup start` to
  `~/.local/share/opencode/log/<id>.log` when the managed OpenCode server loads
  it, and cell1 waits (up to 60s) for that marker. "Deployed" and "loaded"
  remain separate claims, but both are now asserted in CI. Confirmed in CI run
  `37862545802`: cell1 logged `PASS: b1-routing plugin loaded (setup start
  logged)` and `PASS: m3-enforcer plugin loaded (setup start logged)`.
- `docker compose -f docker-compose.v2.yml config` parses after removing the
  `omo-config-v2` volume and the `OH_MY_OPENAGENT_VERSION` build arg.

## Related Files

- `Dockerfile` (V2 line plugins bake section)
- `entrypoint.d/08-deploy-v2-plugins.sh`
- `docker-compose.v2.yml`
- `trial/b1-routing/`, `trial/m3-enforcer/`
- `trial/B1-VERIFY.md`, `trial/M3-VERIFY.md`

## Tags

- opencode-v2
- plugin-api
- routing
- todo-enforcer
- image-bake
- deployment
