# Consumer Sweep When Deleting a Tracked File

## Context

On the V2-only branch, the V1 assets `docker-compose.yml` and `.env.example`
were deleted (`git rm`). Deleting a tracked file breaks every consumer that
references it by path — including consumers that do not show up in a naive
search because the reference lives in ignore files, CI setup steps, image
layers, or payload data inside the deleted file itself.

## Problem

After the deletion, CI failed in three successive places, each surfacing only
after the previous one was fixed:

1. `Build V2 image`: `failed to calculate checksum of ref ...:
   "/docker-compose.v2.yml": not found` at `Dockerfile:397`
   (`COPY docker-compose.v2.yml /docker-compose.v2.yml`). The retargeted
   `COPY` was correct, but `.dockerignore` excluded every compose file except
   the deleted one:
   `docker-compose*.yml` / `docker-compose*.yaml` / `!docker-compose.yml`.
2. `Compose isolation guard` and V2 jobs: CI setup steps ran
   `cp .env.example .env`, and the dev stack (`docker-compose.v2.dev.yml`
   ai-admin, short-syntax `env_file: [.env]`) hard-requires `.env`.
3. `test-v2.sh cell3`: `FAIL: catalog tool 'go' check failed:
   `command -v go && go version`. The deleted `.env.example` carried the V2
   diagnostics defaults `BREW_PACKAGES="go"` and
   `BUN_PACKAGES="pyright @biomejs/biome typescript@5.8.3"`, which
   `entrypoint.d/01-install-packages.sh` installs at container startup.
   `.env.v2.example` had no package defaults, so `cp .env.v2.example .env`
   silently produced an env without them.

## Solution

Before deleting a tracked file, sweep these consumer classes (all five
applied in this incident):

- `Dockerfile` `COPY` sources.
- `.dockerignore` allowlist exceptions (`!...` lines pointing at the old name).
- CI setup steps that materialize the file (`cp`, `touch`, `cat >`).
- Tests and guard scripts referencing the path
  (`test/test-compose-isolation.sh`,
  `src/admin/lib/compose-overlay.integration.test.ts` retargeted to
  `docker-compose.v2.yml`).
- Payload data hidden inside the deleted file: diff active keys between the
  deleted file and its replacement, and transplant anything the replacement
  lacks (here: the diagnostics packages moved verbatim into
  `.env.v2.example`). V1-only keys (`ADMIN_PORT`, `CHAMBER_PORT`,
  `OPENCODE_PLUGINS`) were correctly left behind.

## Why It Works

Each consumer fails at a different pipeline stage (build, guard, runtime
test), so a single green check never proves the deletion is safe. Enumerating
the five classes up front converts three CI round-trips into one review pass.
The key diff catches the non-obvious case: a file deleted for its name can
still be the sole carrier of data another line needs.

## Side Effects / Tradeoffs

- Line-aware code that names both assets (`upstreamComposePath()` returning
  `docker-compose.yml` vs `docker-compose.v2.yml`) must be kept — it is a
  runtime line switch, not a file dependency.
- V1 CI jobs, `dependency-update.yml`, and `test-overlay-host-upgrade.sh`
  still reference the deleted files but never execute on this branch; they
  were deliberately left for a separate cleanup to avoid affecting merges
  back to main.

## Evidence

- `gh run 39012073439` (build failure, checksum error) → fixed by
  `!docker-compose.v2.yml` in `.dockerignore`, verified with a minimal
  `docker build -f-` context check (`CONTEXT-OK`).
- `gh run 39012560881` (cell3 `go` check) → fixed by transplanting the two
  package lines byte-identical (`diff` → `IDENTICAL`).
- Post-fix: `test/test-compose-isolation.sh` → `PASS`; admin suite 37 pass /
  0 fail; `git diff --check` clean.
- Commits: `5fab072` (removal), `54f0603` (CI cleanup), `12c96ac`
  (dockerignore fix).

## Related Files

- `.dockerignore` — compose allowlist now `!docker-compose.v2.yml`
- `Dockerfile:396` — `COPY docker-compose.v2.yml /docker-compose.v2.yml`
- `.github/workflows/ci.yml` — V2 jobs use `cp .env.v2.example .env`
- `.env.v2.example` — carries `BREW_PACKAGES` / `BUN_PACKAGES` defaults
- `test/test-compose-isolation.sh` — V2 prod-vs-dev checks only
- `src/admin/lib/compose-overlay.integration.test.ts` — DooD contract on
  the V2 compose

## Tags

`ci` `dockerignore` `build-context` `file-deletion` `v2-branch` `guards`
