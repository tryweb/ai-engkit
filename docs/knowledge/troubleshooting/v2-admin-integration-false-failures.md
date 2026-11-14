# V2 admin live integration: false 401 / unreachable failures

## Context

`test/test-v2-admin-integration.sh` is the Admin live-check gate for the
check-updates workflow (V2 line). It repeatedly failed immediately after
`docker compose -f docker-compose.v2.dev.yml up -d`, blocking version-bump
commits although the stack itself was healthy.

## Problem

Three independent script defects, not stack defects:

1. **Password default hijacked by ambient env.** The old script used
   `ADMIN_PASSWORD="${ADMIN_PASSWORD:-testadmin123}"`. A session exporting the
   real `ADMIN_PASSWORD` (24-char value from the repo `.env`, mirrored into the
   container env) overrode the default. The server resolves its password in a
   different order (`src/admin/lib/auth.ts getPassword`): persisted file first
   (`/opt/ai-engkit/.env.v2` on the V2 line, selected by `OMO_ENABLED=0`;
   `.env` on V1), then container env. Persisted file held `testadmin123`,
   ambient env held the real password → `timingSafeEqual` mismatch → 401.
   Evidence: admin log `POST /api/login → 401` then `200` minutes later with
   an identical request; container env password ≠ `.env.v2` password.
2. **localhost URLs unreachable under DooD.** Defaults `localhost:8003/8083`
   fail (`curl exit 7`): compose ports publish on the host daemon, not in this
   container. `test-v2.sh` cell1 already derived the bridge gateway; the
   integration script did not.
3. **No readiness gate.** One-shot curls right after `compose up` race the
   ai-admin entrypoint (`find /opt/ai-engkit … chown` before `bun run`), and
   no diagnostics were printed on failure (401 vs 400 vs 500 indistinguishable).

## Solution

Hardened `test/test-v2-admin-integration.sh`:

- URL resolution: explicit `CHAMBER_V2_URL`/`ADMIN_V2_URL` > localhost probe >
  bridge gateway (from `docker inspect ai-engkit-v2dev`, falling back to
  `v2dev_default`/`v2_default` networks) — same idiom as cell1.
- Readiness gate: bounded 90 s wait on OpenChamber `/` and Admin `/healthz`.
- Password resolution mirrors the server: explicit `ADMIN_PASSWORD_TEST` >
  `docker exec` reading `.env.v2` (V2) / `.env` (V1, per `OMO_ENABLED`) >
  container env; empty result fails loudly. Ambient `ADMIN_PASSWORD` is
  deliberately **ignored**.
- Every assertion prints HTTP status + response body on failure
  (`FAIL: login rejected (status=401, body: …)`).

## Why It Works

The script now derives every input the same way the server does (URL reachability,
boot timing, password precedence), so a healthy stack can no longer produce a
mismatched input; real failures surface with actionable status + body output.

## Side Effects / Tradeoffs

- The script now depends on `docker exec ai-engkit-admin-v2dev` for password
  resolution when `ADMIN_PASSWORD_TEST` is unset; in CI without that container
  name, set `ADMIN_PASSWORD_TEST` explicitly.
- Ambient `ADMIN_PASSWORD` is intentionally ignored — pass `ADMIN_PASSWORD_TEST`
  to override the derived value.

## Evidence

- Ambient-hijack environment (session had `ADMIN_PASSWORD` set): script passes
  3/3 runs; old script 401'd (admin log: `POST /api/login → 401` at 02:50:44,
  `200` at 02:59:15 with identical request parameters).
- Negative test: `ADMIN_PASSWORD_TEST=wrongpass` → clean
  `FAIL: login rejected (status=401, body: {"error":"Invalid password"})`.

## Related Files

- `test/test-v2-admin-integration.sh` (hardened)
- `src/admin/lib/auth.ts` (`getPassword` — the precedence chain mirrored)
- `test/test-v2.sh` (cell1 gateway-derivation idiom reused)

## Tags

v2, admin, integration-test, dood, auth, false-failure, check-updates
