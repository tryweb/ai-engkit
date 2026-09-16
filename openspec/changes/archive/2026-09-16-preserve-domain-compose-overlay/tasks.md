## 1. Compose Overlay Resolution

- [x] 1.1 Add a single-overlay configuration reader for `AI_ENGKIT_COMPOSE_OVERLAY` and verify missing, unreadable, non-canonical, and inaccessible paths fail closed without exposing secret values.
- [x] 1.2 Add a shared effective Compose resolver that orders the staged upstream base before the local overlay and verify its generated arguments are deterministic.
- [x] 1.3 Validate the overlay alone with `docker compose ... config --no-consistency --format json`, inspect the normalized overlay-only JSON for the allowed `ai-dev` fields, then validate the ordered base-plus-overlay config and require `ai-dev`; verify protected fields and Admin/domain worker services are rejected before mutation.
- [x] 1.4 Add unit tests for path resolution, DooD-visible paths, service presence, allowed keys, protected keys, and sanitized validation errors.

## 2. Admin Lifecycle Integration

- [x] 2.1 Update the Admin upgrade pipeline to stage the upstream base instead of overwriting the domain-owned overlay, validate the effective configuration, and recreate `ai-dev` with both files; verify no write or recreate occurs after validation failure.
- [x] 2.2 Route `restart-ai-dev`, DB maintenance startup, and agent-triggered ai-dev recreates through the shared effective Compose resolver; verify each lifecycle path includes the overlay.
- [x] 2.3 Preserve the prior base, overlay reference/content, `.env`, provider keys, and OpenChamber settings in mode-0700 backup directories with mode-0600 sensitive files; verify the backup is created before recreation and secrets/content never enter logs.
- [x] 2.4 Extend rollback to attempt restoration of every effective configuration input and restart the previous Compose configuration; verify health failure restores the prior service when possible and reports incomplete rollback details when not.
- [x] 2.5 Add upgrade status and event messages for overlay-active, validation, and rollback outcomes without logging `.env` values or overlay contents; verify API/SSE responses are actionable and sanitized.

## 3. Deployment and Host-Path Wiring

- [x] 3.1 Add the production mounts `./extensions:/opt/ai-engkit/extensions:ro` and `./admin-data/upgrade-base.yml:/opt/ai-engkit/compose-upgrade-base.yml:rw`, create the host paths during setup, and document the fixed path contract; verify a DooD-style fixture renders the expected host paths and preserves `/opt/ai-engkit` as the Compose project directory.
- [x] 3.2 Update `upgrade.sh` to require `jq`, stage and validate the target base plus overlay (including required overlay mounts), back up the old effective inputs, then recreate `ai-admin` and `ai-dev` with base plus overlay; verify every prerequisite failure occurs before replacing the active base.
- [x] 3.3 Document ownership and V1 limits: one overlay, `ai-dev` integration only, allowed fields, protected fields, and domain-owned worker lifecycle; verify the documented ep-design example uses the confirmed runtime environment names.

## 4. End-to-End Verification

- [x] 4.1 Add an external-network integration fixture where `ai-dev` and a domain worker resolve each other through `ep-design_interop`; verify `http://ai-dev:4095` reachability after upgrade and restart.
- [x] 4.2 Verify the OpenCode runtime configuration with the actual supported environment variables and run skill discovery plus an authenticated real-job check after recreation.
- [x] 4.3 Run focused Admin upgrade/restart tests, typecheck, and the repository test suite; verify existing no-overlay installations retain their current behavior.
- [x] 4.4 Run `openspec validate preserve-domain-compose-overlay --type change --strict` and verify all scenarios and task artifacts are accepted.
