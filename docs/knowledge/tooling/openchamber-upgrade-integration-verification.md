# OpenChamber Upgrade Integration Verification

## Context

AI-EngKit installs `@openchamber/web` in `Dockerfile` and couples the runtime
to OpenChamber through Docker startup, `settings.json`, project registration,
the Admin Dashboard, and end-to-end tests. An OpenChamber version bump must
therefore be validated as an integration change, not only as an npm install.

## Problem

An upgrade can build successfully while breaking one of the local contracts:

- Bun or OpenChamber version metadata no longer matches the Dockerfile pins.
- `settings.json` loses required keys or changes the `projects[]` shape.
- Startup reconciliation drops or duplicates registered projects.
- Admin tests report misleading 401 failures because the persistent admin
  volume's `.env` password differs from the Compose default.

## Solution

Run this procedure for every OpenChamber upgrade:

1. **Change one pin.** Update `ARG OPENCHAMBER_VERSION` in `Dockerfile`; do not
   update unrelated dependencies in the same change. On the V2 line the pin
   lives in the `docker-compose.v2.dev.yml` build args, not in `Dockerfile`.
1b. **Register the new version with the update guard.** `scripts/patch-openchamber-update-guard.py`
   is fail-closed: `VERSION_PATCHES` lists every supported OpenChamber version
   and the build dies at step 18/49 with
   `unsupported pinned version 'X.Y.Z'` until the new one is added. Unpack the
   published tarball, classify the three anchors with the module's own
   `check_version`/`classify`, then add `"X.Y.Z": PATCHES_V2` with a comment
   naming which guarded file drifted (if any). Unchanged files need no new
   patch table; anchor drift must still fail the build closed.
1c. **Check the OpenCode floor.** OpenChamber release notes state the minimum
   supported OpenCode version (e.g. `2.5.3` → "Bundled OpenCode updated to
   2.2.0, now the minimum supported version"). Never ship an older
   `OPENCODE_CLI_VERSION` than that floor.
2. **Check derived versions.** Run:

   ```bash
   .opencode/scripts/check-versions.sh check
   ```

   Confirm `OPENCHAMBER_VERSION` and its derived `BUN_VERSION` are `OK current`.
3. **Build and recreate both services.**

   ```bash
   docker compose -p dev -f docker-compose.dev.yml build ai-dev
   docker compose -p dev -f docker-compose.dev.yml up -d ai-dev ai-admin
   ```

4. **Run runtime smoke tests.**

   ```bash
   ./test/run-tests.sh ai-engkit-dev
   ./test/test-openchamber-settings-seed.sh
   bun test src/admin/routes/projects-registration-guard.test.ts \
     src/admin/routes/project-sync.test.ts
   ```

5. **Run Admin and browser checks.** If the persistent admin volume has its own
     `.env`, pass that password to the test process without printing it:

   ```bash
   ADMIN_PASSWORD="$(docker exec ai-engkit-admin-dev sh -c \
     "sed -n 's/^ADMIN_PASSWORD=//p' /opt/ai-engkit/.env 2>/dev/null")" \
     ./test/test-admin.sh
   ADMIN_PASSWORD="$(docker exec ai-engkit-admin-dev sh -c \
     "sed -n 's/^ADMIN_PASSWORD=//p' /opt/ai-engkit/.env 2>/dev/null")" \
     ./test/test-admin-ui.sh
   (cd e2e && ADMIN_PASSWORD="$(docker exec ai-engkit-admin-dev sh -c \
     "sed -n 's/^ADMIN_PASSWORD=//p' /opt/ai-engkit/.env 2>/dev/null")" \
     bunx playwright test admin-p1-p2.spec.ts)
   ```

6. **Compare settings and registrations across restart.** Record a summary of
   `defaultModel`, `showOpenCodeUpdateNotifications`, project count, unique
   project IDs, unique project paths, and sorted project entries; restart
   `ai-dev`; record the same summary and require an exact match.

## Why It Works

The checks cover the complete local contract: image contents and versions,
settings migration/backfill, API-level registration guards, Admin routes and
UI, and browser-visible behavior. Comparing the normalized settings summary
before and after restart detects both destructive migration and duplicate
registration without depending on volatile timestamps or unrelated settings.

## Side Effects / Tradeoffs

- `docker compose up -d` recreates the development containers but preserves
  named volumes; do not use `down -v` during this verification.
- Admin tests can mutate their test fixtures and provider state; use the
  existing test cleanup and inspect the persistent volume afterward.
- The Compose default `ADMIN_PASSWORD` is not authoritative once a persistent
  `/opt/ai-engkit/.env` exists; using the stored value avoids false 401 failures
  without resetting credentials.
- A passing build does not prove `settings.json` compatibility; the restart
  comparison remains mandatory.

## Evidence

The OpenChamber `1.19.0 → 1.20.0` upgrade was validated with:

- Docker image build succeeded; both services ran from the rebuilt image.
- `test/run-tests.sh`: **128 passed, 0 failed**; runtime reported
  `openchamber version (1.20.0)`.
- Settings seed/backfill tests passed.
- Project registration and sync tests: **15 passed, 0 failed**.
- Version check reported `OPENCHAMBER_VERSION=1.20.0` and
  `BUN_VERSION=1.3.14` as current.
- Admin API: **21 passed, 0 failed**; Admin UI: **69 passed, 0 failed**.
- `admin-p1-p2.spec.ts`: **7 passed**.
- `settings.json` remained stable across restart: 4 projects, 4 unique IDs,
  and 4 unique paths before and after.

## Related Files

- `Dockerfile`
- `docker-compose.dev.yml`
- `.opencode/scripts/check-versions.sh`
- `entrypoint.d/lib-openchamber-settings.bash`
- `scripts/reconcile-openchamber-projects.sh`
- `src/admin/lib/openchamber-projects.ts`
- `src/admin/routes/projects-registration-guard.test.ts`
- `src/admin/routes/project-sync.test.ts`
- `test/run-tests.sh`
- `test/test-admin.sh`
- `test/test-admin-ui.sh`
- `e2e/admin-p1-p2.spec.ts`

## Tags

`openchamber` `upgrade` `docker` `settings` `project-registration` `regression-testing`
