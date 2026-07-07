# Upgrade Script Pattern for Docker-Compose Projects

## Context

ai-engkit ships an `install.sh` for first-time setup, but users previously had no upgrade path. Rerunning `install.sh` as an upgrade caused three problems:

1. `docker-compose.yml` was **skipped** (file exists guard) — upstream changes never arrived.
2. `.env` was **interactively overwritten** — existing config destroyed.
3. `docker compose up -d` with `:latest` does not automatically pull new images — stale container.

## Solution

A separate `upgrade.sh` with these design properties:

| Property | Implementation |
|----------|---------------|
| **Non-interactive** | No `read` prompts. Assumes existing `.env` is correct. |
| **Backup-first** | `cp docker-compose.yml backup_<ts>/` and `cp .env backup_<ts>/` before any write. |
| **Merge-only env** | Parse `.env.example` for new keys; only append keys missing from `.env`. |
| **Explicit pull** | `docker compose pull` before `docker compose up -d --force-recreate`. |
 | **Self-update** | Downloads and replaces itself before any other operation (skipped when piped to shell). Guarded by `UPGRADE_SELF_UPDATED` env var to prevent re-exec loops. |
| **Idempotent** | Safe to rerun; skipped operations produce no-ops. |
| **Rollback display** | Prints the exact `cp` commands to restore from backup. |

## Why It Works

- **Backup-first** makes the script risk-free — no irreversible changes.
- **Merge-only env** solves the tension between "upstream added a new env var" and "user customized existing ones".
- **Non-interactive** means users can `curl upgrade.sh \| bash` without a terminal, matching the install UX.
- **Shared check functions** (`check_system`, `check_docker`) are duplicated between `install.sh` and `upgrade.sh` — acceptable because both scripts are `curl | bash` targets that must be self-contained.

## Side Effects / Tradeoffs

- **Duplicated code**: `check_system` and `check_docker` are copied verbatim. A shared lib would require a separate file download, adding complexity. Tradeoff accepted.
- **Overwrites `docker-compose.yml`**: If users customized their compose file (e.g., extra services, different ports), those changes are lost. The backup preserves the original.
- **No dry-run mode**: Could be added later with `--dry-run` flag that skips `docker compose` commands.

## Evidence

- `bash -n upgrade.sh` — shell syntax clean.
- `upgrade.sh` follows the same `REPO_URL` convention and `set -euo pipefail` discipline as `install.sh`.
- Tested on a fresh clone: backup, download, env merge, pull, recreate all succeed.
- Rollback instructions verified by manual `cp` + `docker compose up -d`.

## Related Files

- `upgrade.sh` — the script
- `install.sh` — shares `check_system()` and `check_docker()`
- `README.md` — Upgrade section documents the one-liner

## Tags

`upgrade` `install` `docker-compose` `env-merge` `backup-strategy`
