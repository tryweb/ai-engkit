# V2 Dev Bring-Up Pitfalls (v2dev stack)

## Context

`docker-compose.v2.dev.yml` builds one image (`ai-engkit-ai-v2dev`, bakes
`src/admin/` → `/opt/admin/`) and runs `ai-engkit-v2dev` (8003) +
`ai-engkit-admin-v2dev` (8083). Verified 2026-10-28 while validating the
per-host glab fix (commit `a418eca`).

## Problem

Fresh `up -d` fails or loops in four independent ways:

1. **Missing `.env`** — Compose v5 errors out (`env file ... not found`)
   despite `required: false` on the service entries. Create a minimal
   gitignored `.env` (`ADMIN_PASSWORD=...`) before the first up.
2. **File bind becomes a directory on the host** — if the daemon-side host
   path for `./admin-data/upgrade-base.yml` is absent, the daemon creates a
   **directory**, and the admin entrypoint dies with
   `cannot create .../compose-upgrade-base.yml: Is a directory`, restarting
   forever. Fix the host path (regular empty file), then also check the
   **named volume**: if the image seeds that path as a directory, remove it
   from the volume (`v2dev_admin-data-v2dev:/vol` probe + `rm -rf`), or the
   file bind keeps failing with `mount ... not a directory`.
3. **`openchamber serve` refuses LAN bind** — ai-dev entrypoint sets
   `OPENCHAMBER_HOST=0.0.0.0`, which exits(4) without UI auth. Set
   `OPENCHAMBER_UI_PASSWORD` (dev-only value in `.env`, never committed).
4. **Admin reads `.env.v2`, not `.env`** — in native V2 mode
   `resolveEnvPath()` → `/opt/ai-engkit/.env.v2`. The entrypoint only writes
   `.env`; if login says "Invalid password" despite correct
   `ADMIN_PASSWORD`, append it to `.env.v2` (or restart after fixing) —
   no image rebuild needed, the server reads the file per request.

## Verification (DooD networking)

Sibling published ports are **not** reachable via `localhost` from inside
this container (`curl localhost:8083` → connection refused). Use the
compose network gateway instead:

```sh
NET=$(docker inspect ai-engkit-admin-v2dev \
  --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}' \
  | awk '{print $1}')
GW=$(docker network inspect "$NET" \
  --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}')
curl -o /dev/null -w '%{http_code}\n' "http://$GW:8083/api/status" # 401, guard alive
```

Login (`POST /api/login` + `ADMIN_PASSWORD`) → `session` cookie → time
`GET /api/status`. With the planted empty-`gitlab.com` trigger, fixed
code answers 200 in ~0.5s; the old bare `glab auth status` hangs
(~30s on affected networks, fast 401 elsewhere — environment-dependent,
which is exactly why the empty host must never be probed).

## Side Effects / Tradeoffs

- `.env` is gitignored — safe to keep for dev, never commit.
- The dev admin's `/opt/ai-engkit/.env.v2` appeared at runtime carrying a
  real `CENTER_URL` + `CENTER_TOKEN` + `AGENT_ID=jonathan-198-dev`
  (source undetermined — not from this repo, image, or compose file), and
  the dev agent completed handshake with the real center as `*-dev`.
  Harmless for validation, but if a phantom dev agent shows on the center
  dashboard, it is this stack — not a new incident. Do not reuse its
  token elsewhere; rotate if it leaks beyond this host.

## Related Files

- `docker-compose.v2.dev.yml`, `Dockerfile` (bakes `src/admin/` → `/opt/admin/`)
- `src/admin/lib/env.ts` (`resolveEnvPath`), `src/admin/lib/glab-auth.ts`
