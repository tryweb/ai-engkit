# OpenChamber Registrations Pruned on Plain Restart (Workspace Mount Race)

## Context

OpenChamber's `validateProjectEntries` (in its bundled `settings-runtime.js`) drops any `projects[]` entry in `~/.config/openchamber/settings.json` whose path fails `fs.stat` **at the moment a projects-bearing settings persist runs**. The ai-dev container's workspace is a host bind mount (`/home/jonathan/workspace` → `/home/devuser/workspace`); at container boot the mount may not be fully visible yet.

Observed 2026-08-08 on prod: a plain `docker compose up -d` (no upgrade, same image) pruned **22 of 26** registrations ~3 s after container start. All project directories on disk were fine. This is distinct from the 2026-08-06 incident (version-migration reset) — here the image never changed and `settings.json` was not re-initialized; only registrations whose stat failed in the transient window were removed.

## Problem

- The prune trigger is a **boot-time race**, not a version change. Any restart (plain `up -d`, host reboot, crash-recovery restart) can hit it; upgrades are just one restart flavor.
- The failure window is short (~seconds): OpenChamber boots, workspace mount lags, the first projects-bearing persist stats paths, gets `ENOENT`, and writes a pruned list back into the volume. By the time a human checks, the mount is visible and the dirs are intact — the loss looks inexplicable.
- Manual sync (admin `/api/projects/sync`) repairs the list after the fact but requires a human to notice; the window can reopen on every future restart.
- The historical admin upgrade backup snapshot only `compose.yml` + `.env`, not the settings volume. Current upgrades snapshot the OpenChamber settings before recreation, but a plain restart still has no upgrade backup step.

## Solution

Add an **add-only, idempotent reconcile** at container start that re-adds whatever the transient window dropped, before and after OpenChamber boots:

1. New entrypoint hook `entrypoint.d/07-reconcile-openchamber.sh` (runs before CMD; Dockerfile already COPYs `entrypoint.d/` wholesale, so no Dockerfile change needed):
   - **Synchronous pass** immediately at entrypoint: workspace is usually visible by then, so registrations are repaired **before** OpenChamber serves — it then never prunes at all.
   - **Bounded background retry loop** (8 × 5 s): if the mount was slow (the exact incident race), it waits for the workspace listing to appear, then reconciles again.
2. Reuse the existing reconcile script `scripts/reconcile-openchamber-projects.sh` (it lists workspace dirs, merges missing entries into `projects[]` with `addedAt`/`lastOpenedAt`; honors `$SETTINGS` / `$WORKSPACE` overrides used by tests and manual recovery).
3. Guard with `[ ! -x "$RECONCILE" ]` → skip. In the admin container `/opt/ai-engkit` is shadowed by the `admin-data-dev` volume and the script may be absent; the guard makes the hook a no-op there (it has no workspace mount anyway).

Reconcile is add-only: it never removes entries, so it is safe to run anytime, including concurrently with OpenChamber's own writes.

## Why It Works

- Ordering: the synchronous pass runs in `entrypoint.d/` **before** `openchamber serve` starts, so the registry is complete before the first persist cycle — the prune trigger never sees missing paths.
- The retry loop covers the residual race where the bind mount is not visible even at entrypoint time; each iteration re-checks `workspace_ready` (a non-empty dir listing under `$WORKSPACE`) before reconciling, and exits early once a run reports `added=0`.
- Add-only merge semantics mean the worst case is re-adding a registration that already exists (idempotent no-op), never deleting one.
- The registry lives in the named volume (`jonathan_openchamber-data`), which survives container recreate — the fix protects it across any future restart.

## Side Effects / Tradeoffs

- Re-added entries get fresh `addedAt`/`lastOpenedAt` and are **appended** to the end of `projects[]`, so project order can differ from a manual arrangement (semantically harmless; OpenChamber labels are auto-generated from directory names).
- Boot logs gain up to 9 reconcile lines (`restored N` on recovery, `consistent, nothing to restore` otherwise); the loop self-terminates.
- If the workspace mount is **permanently** unavailable (not just slow), the hook logs `gave up after retries` and OpenChamber may still prune — this is a mount/host problem, not something reconcile should mask.
- Does not protect sessions or scheduled tasks (stored elsewhere: opencode SQLite DB, per-project files).

## Evidence

- 2026-08-08 prod incident: 22/26 registrations pruned ~3 s after container start (boot `08:49:23Z`), all workspace dirs intact; same image, no upgrade involved.
- Manual restore + deploy: settings.json back to 26/26; prod container recreated onto the fixed image (`8a8eac87`), boot log `[reconcile-openchamber] consistent, nothing to restore`; OpenChamber serving 200; `bun test` 37 pass; `bash -n` clean.
- Dev-env verification (`docker-compose.dev.yml`, image `ai-engkit-ai-dev`):
  - Incident simulation: removed `test-002` registration (2→1), `up -d --force-recreate` → log `restored 1 project registration(s)` then `consistent`; settings back to 2/2, both dirs present.
  - Normal restart: `consistent` ×2, no changes.
  - Admin container: `script not found, skipping` (no workspace mount, volume shadows script); server healthy (`302 → /login`).
- `entrypoint.d/07-reconcile-openchamber.sh` in image byte-identical to repo (verified via `md5sum`).

## Related Files

- `entrypoint.d/07-reconcile-openchamber.sh` — the boot reconcile hook (sync pass + bounded retry loop)
- `scripts/reconcile-openchamber-projects.sh` — add-only workspace↔registry merge
- `docs/knowledge/troubleshooting/openchamber-projects-lost-after-upgrade.md` — the **upgrade** variant (version migration reset; manual admin sync). Different root cause and mechanism; read both.
- `docs/knowledge/patterns/openchamber-project-auto-registration.md` — how individual entries are written (`jq` merge, `path_`+base64 ids, ms timestamps)
- `docs/knowledge/tooling/openchamber-project-data-architecture.md` — where OpenChamber state lives
- `docs/knowledge/troubleshooting/openchamber-projects-sync-container-targeting.md` — prod vs dev admin targeting for manual sync

## Tags

`openchamber` `projects` `settings-json` `registration` `boot-race` `mount` `entrypoint` `reconcile` `restart` `add-only`
