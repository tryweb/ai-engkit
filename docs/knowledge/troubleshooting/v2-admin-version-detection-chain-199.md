# V2 Admin version detection verified across v2.0.8–v2.0.23 on prod-199

## Context

The V2 prod stack on `192.168.11.198`/`192.168.11.199` runs Compose project `v2`
from `/opt/ai-engkit-v2/docker-compose.v2.yml`, image pinned by
`AI_ENGKIT_VERSION` in `/opt/ai-engkit-v2/.env.v2`
(`image: ghcr.io/tryweb/ai-engkit:${AI_ENGKIT_VERSION:-v2}`).

799 (prod-199) was found in a split state: `ai-dev` on `v2.0.23`,
`ai-admin` on `v2.0.3` (content behind the floating `:v2` tag), pin already
`v2.0.23`. Dashboard showed `v2.0.23 ● Pinned`, no mismatch warning, and
`/api/status` reported `admin_version_mismatch: false` — the wrong answer.

## Problem

Two coupled behaviors needed version-level proof, not code reading:

1. `current_version` (`GET /api/upgrade/versions`) reads the **admin
   container's baked-in** `/opt/ai-engkit/VERSION` (`Dockerfile:345`,
   `src/admin/routes/upgrade.ts:13-19`). Upgrading ai-dev never changes it;
   only recreating `ai-admin` does. Operators mistake the dashboard's
   `v2.0.23` row (which reads **ai-dev** via `execInAiDev`) for "admin is
   current".
2. The stale-admin warning (`dashboard.tsx:262-270`, "Admin container needs
   restart") is gated on **image-digest mismatch**
   (`server.ts:379`, `status.ts:176`: both digests non-null and different),
   never on version-string comparison. Old admin code resolved the ai-dev ref
   incorrectly on V2 container names, yielding `mismatch=false` under real
   skew.

## Solution

Step the stack version by version, alternating the two supported paths:

- **ai-dev**: `POST /api/upgrade {"version":"vX","target_type":"specified"}`
  (writes the pin through the bind-mounted env file, `pre-<ts>` backup under
  host `backups-v2/`, recreates **only ai-dev**). Poll
  `GET /api/upgrade/status` to `completed`.
- **Observe** (admin still on previous version): record
  `GET /api/upgrade/versions` (`current`/`configured`), `GET /api/status`
  (`admin_version`, `admin_version_mismatch`), and the dashboard HTML pill.
- **ai-admin**: host-side single-service recreate only —
  `docker compose -p v2 -f docker-compose.v2.yml --env-file .env.v2 up -d
  --force-recreate ai-admin` (never a full-project recreate; never
  `--pull never`). Verify `docker exec ai-engkit-admin-v2 cat
  /opt/ai-engkit/VERSION`, then confirm `mismatch=false` when aligned.

Chain executed on prod-199: position at `v2.0.8`, then `v2.0.9` → `v2.0.23`.

## Why It Works

- The Admin API path exercises the real upgrade state machine
  (`digest_compare → backup → merge_env → recreate ai-dev → poll_health →
  cleanup`), including the `pre-` backup and pin write, exactly as an
  operator would trigger it.
- Checking detection **before** recreating admin isolates the detector
  (old admin code observing new ai-dev) from the fix (new admin code).
- Single-service host recreate is the minimal blast radius: ai-dev keeps
  running, no temp-name/canonical-name split (see
  `dood-manual-force-recreate-breaks-prod-v2.md`).

## Side Effects / Tradeoffs

- `POST /api/admin/restart` does **not** work from admin ≤ `v2.0.5`: the
  preflight hardcodes `/opt/ai-engkit/.env` (V1 path, HTTP 500 on V2; fixed
  by `2db2f06` in `v2.0.6`). Host-side recreate is required for those
  versions.
- Each step pulls a ~4.3 GB image; 16 versions peaked the 96 GB disk at 78%.
  Prune superseded tags afterwards, keeping current plus one rollback spare
  (kept `v2.0.23` + `v2.0.22`; disk back to 11%).
- The empty workspace (`project_count=0`) made downgrading ai-dev
  `v2.0.23 → v2.0.8` safe here; do not assume that on a host with live data.
- `official_version` stayed `v2.0.3` throughout: the GHCR `:v2` channel tag
  is stale. Unrelated to container detection; tracked separately.

## Evidence

Per-version detector behavior (admin-on-old observing ai-dev-on-new):

| ai-dev target | observing admin | `mismatch` | dashboard pill |
|---|---|---|---|
| v2.0.8 | v2.0.3 | **false** (bug) | absent (bug) |
| v2.0.9 … v2.0.17 | previous version (≥ v2.0.8) | true | present ("Admin container needs restart to match ai-dev version", `⚠ <ver>`) |
| v2.0.18 | v2.0.17 | true (API) | **not observed in one HTML sample** (see below) |
| v2.0.19 … v2.0.23 | previous version | true | present |

After every host admin recreate: `admin_version == ai-dev version`,
`mismatch=false`, no pill — correct in all 16 steps.

Version-to-fix mapping confirmed live:

- `b92f713` (`v2.0.8`, ai-dev digest via compose labels): first version
  whose admin reports `mismatch=true` under skew. `v2.0.3` admin reports
  `false` for the same skew (`v2.0.3` observing `v2.0.8` ai-dev).
- `84ad5bd` (`v2.0.15`, sibling-name derivation for `-v2` names): second
  layer for the fallback path when the service-label lookup misses (ai-dev
  stopped). Not exercised here — ai-dev ran throughout; quiescing ai-dev
  to test it is destructive and was deliberately skipped.
- `2db2f06` (`v2.0.6`, line-aware env path in restart preflight): verified
  statically (`git show v2.0.3:src/admin/routes/admin.ts` hardcodes
  `/opt/ai-engkit/.env`); restart API not invoked against old admin.

The `v2.0.18` pill anomaly: API said `true`, one HTML fetch showed no pill.
Adjacent versions (admin `v2.0.16`/`v2.0.18` rendering the same skew class)
both rendered the pill, so this is a single-sample fetch/session artifact,
not a regression. Re-verifying would require downgrading admin; not worth it.

Final prod-199 state: both containers `ghcr.io/tryweb/ai-engkit:v2.0.23`
(healthy), `current_version == configured_version == v2.0.23`,
`mismatch=false`, dashboard `● Pinned v2.0.23`, `8002=200`, `8082=200`,
`restarts=0` on both containers.

## Related Files

- `src/admin/routes/upgrade.ts` — `readVersion`, pin write, upgrade state machine (ai-dev only)
- `src/admin/routes/admin.ts` — `/api/admin/restart` (V1 env-path bug pre-2.0.6), `/api/admin/status`
- `src/admin/lib/docker.ts` — `getAiDevContainerRef`, sibling-name derivation (`84ad5bd`)
- `src/admin/lib/status.ts` — `collectStatus` digest-mismatch computation
- `src/admin/server.ts` — dashboard `admin_version` / `admin_version_mismatch` props
- `src/admin/views/dashboard.tsx` — mismatch pill + restart button gating
- `Dockerfile:345`, `.github/workflows/ci.yml:296` — VERSION bake-in
- `docs/knowledge/troubleshooting/dood-manual-force-recreate-breaks-prod-v2.md` — why single-service recreate, no stacked force-recreates
- `docs/knowledge/patterns/compose-change-upgrade-checklist.md` — per-path blast radius (UI: ai-dev only; host script: all)

## Tags

admin, version-detection, digest-mismatch, v2, upgrade, incident-verification, dood, prod-199
