# V2 Env File Routing (.env vs .env.v2)

## Context

The V2 line ships a single template, `.env.v2.example`, but the two V2
stacks require different host filenames. Copying the template to the wrong
name produces a stack that starts with silently missing variables
(`required: false` swallows the absence) or refuses to start at all (short
`env_file` syntax is required).

## Problem

Which filename does each consumer resolve?

- `docker-compose.v2.yml` (prod) ai-dev declares
  `env_file: { path: .env.v2, required: false }`.
- `docker-compose.v2.dev.yml` (dev) ai-dev declares
  `env_file: { path: .env, required: false }`, while ai-admin declares
  short-syntax `env_file: [.env]` (required — compose errors when missing).
- Admin TypeScript (`src/admin/lib/env.ts`, `ENV_PATH`) always reads and
  writes `/opt/ai-engkit/.env`, regardless of stack.
- `install-v2.sh` / `upgrade-v2.sh` define `ENV_FILE=".env.v2"`.

## Solution

One template, two destinations — chosen by stack:

| Stack | Host file | How it is consumed | Bring-up command |
|---|---|---|---|
| V2 prod | `.env.v2` (from `.env.v2.example`) | ai-dev via `env_file: .env.v2`; ai-admin via bind `./.env.v2:/opt/ai-engkit/.env:rw` | `docker compose --env-file .env.v2 -f docker-compose.v2.yml up -d` |
| V2 dev / CI | `.env` (from `.env.v2.example`) | ai-dev via `env_file: .env`; ai-admin via required `env_file: [.env]` | `cp .env.v2.example .env && docker compose -f docker-compose.v2.dev.yml up -d` |

Password semantics differ by key, independent of filename:

- `ADMIN_PASSWORD` is read from `/opt/ai-engkit/.env` on every request
  (`src/admin/lib/auth.ts` `getPassword()`), so saving it in the env editor
  takes effect immediately without any restart.
- `OPENCHAMBER_UI_PASSWORD` is injected into ai-dev once at container
  creation via `env_file`; changing it requires the env editor's
  **Restart ai-dev** button (`POST /api/env/restart`) before OpenChamber
  picks it up.

## Why It Works

Compose resolves a relative `env_file` against the compose file's directory,
and the admin container sees the V2 prod env only through the
`./.env.v2:/opt/ai-engkit/.env` bind. Keeping one template with two
documented destinations avoids maintaining two divergent example files while
satisfying both the prod `required: false` path and the dev required path.

## Side Effects / Tradeoffs

- Two live filenames (`.env`, `.env.v2`) can coexist in one checkout; each
  stack ignores the other's file, which is confusing but intentional.
- `.env` and `.env.v2` are both gitignored and never committed; only
  `.env.v2.example` is tracked.
- The dev stack's required `.env` means `test/test-compose-isolation.sh`
  fails fast with `cp .env.v2.example .env` instructions when the file is
  absent, instead of failing later inside compose.

## Evidence

- `docker-compose.v2.yml:40-42` (`path: .env.v2`), `:60`
  (`./.env.v2:/opt/ai-engkit/.env:rw`).
- `docker-compose.v2.dev.yml:46-48` (`path: .env`), `:66-67`
  (`env_file: [.env]`).
- `install-v2.sh:12-13` (`ENV_FILE=".env.v2"`,
  `ENV_EXAMPLE=".env.v2.example"`).
- CI `build-v2` / `test-v2`: `cp .env.v2.example .env`, then the isolation
  guard passes and `test-v2.sh` cell3 finds `go` via `BREW_PACKAGES`.
- Observed failure mode: ai-dev recreated without the UI password loops
  with `OpenChamber refuses to bind to 0.0.0.0 without UI authentication`
  and port 8002 serves nothing.

## Related Files

- `.env.v2.example` — the single tracked template (includes
  `BREW_PACKAGES` / `BUN_PACKAGES` diagnostics defaults)
- `docker-compose.v2.yml` — prod routing
- `docker-compose.v2.dev.yml` — dev routing
- `install-v2.sh` / `upgrade-v2.sh` — prod `ENV_FILE` definitions
- `src/admin/lib/env.ts` / `src/admin/lib/auth.ts` — admin read path and
  live password check
- `src/admin/routes/env.ts` — env editor save + restart endpoints

## Tags

`v2-branch` `env` `compose` `env_file` `openchamber` `admin` `password`
