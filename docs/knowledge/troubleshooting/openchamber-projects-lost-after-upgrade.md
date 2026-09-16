# OpenChamber Project Count Drops After Image Upgrade (Registration Reset, Data Intact)

## Context

OpenChamber's project **list** is the `projects[]` array in `~/.config/openchamber/settings.json` inside the ai-dev container. On the prod stack (192.168.11.196) that file lives in the named volume `jonathan_openchamber-data`; the actual project **data** lives in workspace directories (`/home/jonathan/workspace` bind-mounted to `/home/devuser/workspace`).

Upgrade path used: `docker compose pull` + `up -d`, which recreates `ai-engkit` (OpenChamber UI) and `ai-engkit-admin` (admin dashboard) from `ghcr.io/tryweb/ai-engkit:latest`.

Observed 2026-08-06: after upgrading to v1.11.6 (image built 09:24:56Z, containers recreated 10:00:41Z, host booted 07:42Z), OpenChamber showed fewer projects than before. The release range just deployed crosses OpenChamber 1.17.2 → 1.18.0/1.18.1 (v1.11.3/v1.11.4).

## Problem

- The registration list and the project data are **two different things**. A version change can re-initialize `settings.json` — a fresh 1.18-era file contains only `{"defaultModel": ..., "showOpenCodeUpdateNotifications": false}` with **no `projects` array** — so the UI project count drops while every project directory on disk stays untouched. The drop looks like data loss; it is not.
- At the time of this incident, the admin upgrade backup (`src/admin/lib/upgrade.ts`) snapshot only `compose.yml` + `.env`, **not** the OpenChamber settings volume. Current upgrades also snapshot `settings.json` before recreation, but this historical incident predates that safeguard.
- Host reboot and compose recreate can both look like "the upgrade". Pin the event with `docker inspect <ctr> --format '{{.State.StartedAt}}'` and image `Created` before blaming a version.

## Solution

1. **Verify data first — never assume loss.**
   ```bash
   # Project directories (data)
   docker exec ai-engkit sh -c 'find /home/devuser/workspace -maxdepth 1 -mindepth 1 -type d ! -name ".*"'
   # Registered projects (list)
   docker exec ai-engkit sh -c 'jq -r ".projects[].path" /home/devuser/.config/openchamber/settings.json'
   ```
   In sync = every workspace dir has a registration; the workspace-root entry (`/home/devuser/workspace`, label `Workspace`) explains the +1 (e.g. 25 dirs vs 26 entries).
2. **Run the sync on the prod admin (port 8380) only.** The dev admin (8081) syncs the dev container (`ai-engkit-dev`, isolated `workspace-dev` volume) and can never restore prod projects — see the container-targeting knowledge entry.
3. **Dry-run, then add only what is missing:**
   ```bash
   GET  /api/projects/sync          # authenticated → {"missingInOC":[...],"staleInOC":[...]}
   POST /api/projects/sync {"add":[...],"remove":[]}
   ```
   If both lists are empty, do nothing. Never remove `staleInOC` entries without manually validating each path — a stale entry may be a renamed or temporarily unmounted project the user still wants.
4. **Refresh the OpenChamber UI** (host 8000 → container 3000). Entries appear without a restart.
5. **Before the next upgrade**: verify the automatic `settings.json` snapshot, image digest, and mount list; record the pre-upgrade registration count.

## Why It Works

- `execInAiDev()` runs `docker exec ai-engkit …` from the admin container, so the sync reads/writes the **same** `settings.json` and workspace the OpenChamber UI uses (prod admin only).
- The current merge (`src/admin/lib/openchamber-projects.ts`, "atomic and deduplicate" since v1.11.3) writes `addedAt`/`lastOpenedAt` for new entries, so re-added entries after an upgrade carry fresh timestamps while surviving entries keep theirs — partial loss shows up as mixed timestamps.
- OpenChamber watches `settings.json`, so a UI refresh (no container restart) renders the restored list.

## Side Effects / Tradeoffs

- Sync repairs only the registry list; sessions and scheduled tasks live elsewhere (opencode SQLite DB, per-project files) and are unaffected.
- The sync POST is idempotent — safe to re-run.
- Without a pre-upgrade snapshot, attributing the reset to "OpenChamber 1.18 migration" is correlation, not proof; say so in incident reports.
- Older knowledge (`openchamber-projects-sync-container-targeting.md`, 2026-08-02) documents sync writing entries **without** timestamps; that predates v1.11.3 and no longer holds for current code.

## Evidence

- 2026-08-06 upgrade: image created 09:24:56Z (v1.11.6), containers recreated 10:00:41Z, host boot 07:42Z.
- Workspace: 25 project dirs intact (mtimes through the same day); `settings.json`: 26 entries (25 dirs + workspace root).
- Entries with `addedAt` ≈ 10:02:08Z (86 s after recreate) consistent with re-registration after the upgrade; `everplast-it`'s entry predates the upgrade (`lastOpenedAt` 07:08Z) → **partial** registration loss, not a total wipe.
- A minimal fresh settings.json (no `projects` array) observed in the admin container's anonymous config volume — the 1.18-era shape.
- `compose.yml`/`.env` byte-identical to the 2026-08-05 backup → not a config change.
- Repo Dockerfile/entrypoint do not touch `settings.json`; the historical backup at incident time covered only compose + `.env`.

## Related Files

- `src/admin/lib/openchamber-projects.ts` — atomic `projects[]` merge (add/remove, shape-validated)
- `src/admin/routes/project-sync.ts` — GET/POST `/api/projects/sync`
- `src/admin/lib/docker.ts` — `execInAiDev()` sibling container targeting
- `src/admin/lib/upgrade.ts` — current upgrade backup contents, including OpenChamber settings and overlay inputs
- `docs/knowledge/troubleshooting/openchamber-projects-sync-container-targeting.md` — prod vs dev admin targeting; older timestamp-gap note
- `docs/knowledge/tooling/openchamber-project-data-architecture.md` — where OpenChamber state lives
- `docs/knowledge/patterns/openchamber-project-auto-registration.md` — create-endpoint registration with timestamps
- `docs/knowledge/patterns/compose-change-upgrade-checklist.md` — other upgrade blast-radius checks

## Tags

`openchamber` `upgrade` `projects` `settings-json` `registration` `data-loss-false-alarm` `sync` `volume` `docker-compose`
