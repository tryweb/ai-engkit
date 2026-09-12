# Dev Environment Verification Limitations

## Context

ai-engkit has two deployment modes:

| | Production (`docker-compose.yml`) | Dev (`docker-compose.dev.yml`) |
|---|---|---|
| Container image | `image: ghcr.io/tryweb/ai-engkit:latest` | `build: .` (from source) |
| Docker mode | Host Docker (same filesystem) | DooD (sibling container) |
| `.env` mount | Bind mount (`./.env:/opt/ai-engkit/.env:rw`) | `env_file: .env` + startup dump |
| Compose file mount | `./docker-compose.yml:/opt/ai-engkit/compose.yml:rw` | Same (was missing, now fixed) |

## Problem

Two features cannot be meaningfully verified in dev because the environment
differs from production in fundamental ways:

### 1. Upgrade Pipeline

Production: `docker pull :latest → backup → merge_env → recreate → health → cleanup`
Dev:         docker pull (waste) → backup → merge_env → **rebuild from source** → health → cleanup

The `recreate` step runs `docker compose up -d --force-recreate ai-dev`.
In production (uses `image:`), this pulls + restarts.
In dev (uses `build:`), this triggers a full Dockerfile build (2-5 min).

Even if dev rebuild succeeds, it only proves the Dockerfile builds — not that
the pull-based upgrade flow works.

### 3. DB Maintenance (Retention) Backup

The db-maintenance pipeline's first step resolves a backup target. Production
and prod-like envs bind-mount `backups` (`./backups:/opt/ai-engkit/backups:rw`),
so the backup path resolves. Dev uses **named volumes** (DooD sibling
deployment), so the backup step cannot resolve its target and `runMaintenance`
fails there — **this is a pre-existing environment limitation, not a
regression** (confirmed on the dev env during retention-gate verification).

Consequences for dev verification of retention/db-maintenance:

- Backup + real deletion cannot be exercised end-to-end in dev.
- The fail-closed design means the run aborts before any deletion side effect —
  safe, but dev can only prove UI/gate/marker mechanics (e.g. the
  `hasPriorSuccess` lock, manual-run escape, unlock after success) with a
  substitute marker.
- Real backup + deletion runs must be verified on a prod-shaped env such as
  `192.168.11.194` (host inventory:
  `docs/knowledge/troubleshooting/admin-restart-self-destruct.md`).

### 2. Environment Variable Application

Production: `docker compose up -d --force-recreate ai-dev` re-reads `.env` → new vars apply
Dev:         same command triggers a build because compose file says `build: .`
             Build is slow and unnecessary; vars would apply without it

## Decision

We do NOT modify code to make these features verifiable in dev.

**Rationale:**

1. **False confidence** — passing verification in dev does not guarantee the
   same behavior in production. Build-based "upgrade" and image-pull-based
   upgrade are different operations.

2. **Code complexity** — working around dev/prod differences in the pipeline
   code violates single-responsibility. The pipeline should not know which
   environment it runs in (see `operations-pipeline-environment-agnostic.md`).

3. **Dev has different semantics** — `build: .` means dev is for source
   iteration, not upgrade testing. The `? unavailable` badge on the Dashboard
   already signals this.

4. **Env vars can still be tested manually** — editing `.env` via the dashboard
   and inspecting the file directly (`cat /opt/ai-engkit/.env`) works in both
   modes. Only the "apply via restart" step has the build issue.

## What to Test in Dev vs Production

| Feature | Dev | Production |
|---------|-----|------------|
| Env editor UI | ✅ Read/write .env | ✅ Same |
| Env var persistence | ✅ Manual verification via `docker exec` | ✅ Full compose restart |
| Upgrade UI + badge | ✅ `? unavailable` shown (correct) | ✅ `▲ Upgrade` with version check |
| Upgrade pipeline | ❌ Not meaningful (rebuilds from source) | ✅ Full pull → recreate flow |
| SSE progress stream | ✅ Can test | ✅ Same |
| backup / merge_env steps | ✅ Can test (pure logic) | ✅ Same |
| DB maintenance backup + deletion | ❌ Backup step fails (named volume) | ✅ Full run (verify on prod-like env, e.g. .194) |
| Retention gate UI (lock/unlock) | ✅ Can test (substitute marker) | ✅ Same |

## Related Files

- `docs/knowledge/architecture/operations-pipeline-environment-agnostic.md`
- `docs/knowledge/architecture/admin-env-editor-dataflow.md`
- `docs/knowledge/troubleshooting/dood-bindmount-admin-override.md`
- `docker-compose.yml`
- `docker-compose.dev.yml`

## Tags

`#dev-vs-prod` `#verification` `#testing` `#dood` `#upgrade` `#env-editor` `#db-maintenance`
