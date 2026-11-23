# CI Workflow Missing .env File Causes docker compose Failure

> Status: the dependency-update workflow was retired in 2026-11. The `.env`
> fix remains relevant to `ci.yml`; workflow-specific references are historical.

## Context

ai-engkit uses `docker-compose.dev.yml` for both CI integration tests and the dependency-update workflow. The `ai-admin` service in `docker-compose.dev.yml` has:

```yaml
ai-admin:
  env_file:
    - .env
```

This is a **required** `env_file` (no `required: false`), so `docker compose up -d` fails if `.env` doesn't exist.

## Problem

The `dependency-update.yml` workflow's `build-and-test` job runs `docker compose up -d` without first creating a `.env` file. This causes:

```
env file /home/runner/work/ai-engkit/ai-engkit/.env not found:
stat /home/runner/work/ai-engkit/ai-engkit/.env: no such file or directory
```

The `ci.yml` workflow avoids this by having an explicit step:

```yaml
- name: Create .env for CI
  run: |
    cp .env.example .env
    sed -i 's/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=testadmin123/' .env
```

The dependency-update workflow was missing this step.

## Solution

Add the same "Create .env for CI" step to `dependency-update.yml` `build-and-test` job, before the "Start services" step:

```yaml
- name: Create .env for CI
  run: |
    cp .env.example .env
    sed -i 's/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=testadmin123/' .env
```

## Why It Works

- `docker-compose.dev.yml` has `env_file: - .env` on `ai-admin` (required by default)
- `ai-dev` has `env_file: - path: .env, required: false` (optional, won't fail)
- Creating `.env` from `.env.example` before `docker compose up` satisfies the `ai-admin` requirement
- The `.env` file persists through the job, so the Cleanup step (`docker compose down`) also works

## Side Effects / Tradeoffs

- None. This is a minimal fix that matches the existing CI workflow pattern.
- The `.env` file is gitignored, so it doesn't affect the repository.

## Evidence

- Failed run: https://github.com/tryweb/ai-engkit/actions/runs/30223302782
- Error: `env file .env not found: stat .env: no such file or directory`
- Fix: Added "Create .env for CI" step before "Start services"
- Both `ci.yml` and `dependency-update.yml` now have identical `.env` creation steps

## Related Files

- `.github/workflows/dependency-update.yml` (line 463-466: added step)
- `.github/workflows/ci.yml` (line 82-85: existing pattern)
- `docker-compose.dev.yml` (line 42: `ai-admin` env_file requirement)

## Tags

- ci
- docker-compose
- env-file
- workflow
- troubleshooting
