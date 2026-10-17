# V2 Env File Routing (Uniform `.env.v2`)

## Context

The V2 line ships a single template, `.env.v2.example`, and resolves every
consumer to the same filename, `.env.v2` — mirroring how V1 uses `.env`
everywhere. An earlier iteration bridged the gap with alias mounts and a
two-entry `env_file` list; that indirection is retired. One name resolves in
every context, so no context can silently load nothing.

## Problem

Previously the host file (`.env.v2`) and the in-container admin path
(`/opt/ai-engkit/.env`) had different names. Code that reads env and compose
`env_file` entries each needed a per-context alias, and any missing alias
failed silently (`required: false`): an Admin-side recreate dropped
`OPENCHAMBER_UI_PASSWORD`, OpenChamber refused to bind `0.0.0.0`, ai-dev
crash-looped, and the Projects list rendered empty while every API returned
200.

## Solution

Single filename end to end (V1 shape, V2 name):

| Consumer | Path used | Wiring |
|---|---|---|
| Host checkout file | `.env.v2` (from `.env.v2.example`) | created by `install-v2.sh` (`ENV_FILE=".env.v2"`) |
| ai-dev container env | `.env.v2` (relative `env_file`) | resolves against the checkout on host runs, against `/opt/ai-engkit` on Admin-side runs — the same filename exists in both |
| ai-admin read/write | `/opt/ai-engkit/.env.v2` | single bind `./.env.v2:/opt/ai-engkit/.env.v2:rw` |
| Compose `--env-file` flags | line-aware `resolveEnvPath()` | `.env.v2` on V2, `.env` on V1 |
| V2 dev stack / CI | `.env` (from `.env.v2.example`) | `docker-compose.v2.dev.yml` hard-requires `.env`; CI runs `cp .env.v2.example .env` |

Admin code resolves the path per line (`resolveEnvPath()` in
`src/admin/lib/env.ts`, backed by `isNativeV2Enabled()`), so the same image
keeps reading `/opt/ai-engkit/.env` on V1. Call sites evaluate it at call
time, never at module load, so tests can toggle lines via `OMO_ENABLED`.

Password semantics are unchanged and independent of filename:

- `ADMIN_PASSWORD` is read from the env file on every request
  (`src/admin/lib/auth.ts` `getPassword()`), so saving it in the env editor
  takes effect immediately without any restart.
- `OPENCHAMBER_UI_PASSWORD` is injected into ai-dev once at container
  creation via `env_file`; changing it requires the env editor's
  **Restart ai-dev** button (`POST /api/env/restart`) before OpenChamber
  picks it up.

## Why It Works

Compose resolves a relative `env_file` against the compose file's directory,
and both directories (host checkout, `/opt/ai-engkit`) now carry the same
filename — the exact property that kept V1 free of this bug class. There is
no alias to forget and no second entry to keep in sync; a missing file in
either context is a single obvious absence instead of a silent partial load.

## Side Effects / Tradeoffs

- `entrypoint.d/00-fix-perms.sh` touches both `/opt/ai-engkit/.env` and
  `.env.v2` (each guarded by existence) so old and new images stay bootable
  during rollout.
- The mount swap and the code change are atomic: deploying the new compose
  with the old image breaks Admin login (old code reads the now-unmounted
  `.env`), and vice versa. Roll them together.
- `.env` and `.env.v2` are both gitignored and never committed; only
  `.env.v2.example` is tracked.

## Evidence

- `docker-compose.v2.yml`: single `env_file: .env.v2`, single bind
  `./.env.v2:/opt/ai-engkit/.env.v2:rw`.
- `src/admin/lib/env.ts` `resolveEnvPath()`; call sites in `upgrade.ts`,
  `restart-ai-dev.ts`, `compose-overlay.ts`, `agent/commands.ts`,
  `db-maintenance.ts` evaluate it per call.
- Admin suite: 1340 pass / 0 fail (V1 mode); V2 mode failure count identical
  to pre-change baseline (57, all pre-existing and unrelated to env paths).
- `bun run typecheck` clean; host-side and Admin-side `config` both resolve
  a non-empty UI password (verified before rollout).

## Related Files

- `.env.v2.example` — the single tracked template (includes
  `BREW_PACKAGES` / `BUN_PACKAGES` diagnostics defaults)
- `docker-compose.v2.yml` — prod routing
- `docker-compose.v2.dev.yml` — dev routing (requires `.env`)
- `install-v2.sh` / `upgrade-v2.sh` — prod `ENV_FILE` definitions
- `src/admin/lib/env.ts` / `src/admin/lib/auth.ts` — line-aware read path
  and live password check
- `src/admin/routes/env.ts` — env editor save + restart endpoints

## Tags

`v2-branch` `env` `compose` `env_file` `openchamber` `admin` `password`
