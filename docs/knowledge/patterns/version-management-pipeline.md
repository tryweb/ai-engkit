# Local Version Management Pipeline

## Context

ai-engkit pins all dependency versions in `Dockerfile` as ARGs (DOCKER_VERSION,
OPENCODE_VERSION, LEANCTX_VERSION, etc.).  Previously, checking and updating
these versions required either the CI workflow (`dependency-update.yml`) or
manual lookup. There was no local workflow for checking, updating, and
validating version changes before release.

## Problem

- `entrypoint.d/02-init-config.sh` regenerates `opencode.json` at startup,
  making manual edits non-permanent — needed `OPENCODE_PROVIDER` env var.
- `check-versions.sh` had drifted from the CI workflow: missing
  `LEANCTX_VERSION` and "latest-tracked" packages.
- The `release` skill only updated OpenCode + OpenChamber badges and couldn't
  detect what actually changed in Dockerfile.
- No local skill existed to go from "check upstream" → "update Dockerfile" →
  "build and test" in one shot.

## Solution

A three-skill pipeline covering the full lifecycle:

```
check-versions.sh (script)    version inspection + diff + snapshot
  ↓
check-updates (skill)          apply updates → build → test → commit
  ↓
release (skill)               badges → CHANGELOG → tag → push
```

### 1. check-versions.sh — Unified version inspection

Extended with 4 flags:

| Flag | Function |
|------|----------|
| `--latest` | Check npm-tracked packages (oh-my-openagent, codegraph, openspec) |
| `--apt` | Query ubuntu:24.04 base image for available APT updates (requires docker) |
| `--snapshot` | Diff current versions against `version-snapshot.json` |
| `--snapshot-save` | Write a new snapshot after checking |
| `--all` | Enable all three above |

`LEANCTX_VERSION` was also added to close the drift with the CI workflow.

### 2. check-updates skill — One-shot update workflow

New skill (`.opencode/skills/check-updates.md`) that:
1. Runs `check-versions.sh outdated` to detect outdated pins
2. Shows the user what's outdated, asks which to update
3. Applies `sed -i` to Dockerfile ARGs (using JSON output from
   `check-versions.sh json` to get the correct latest version)
4. Builds the dev image (`docker compose -f docker-compose.dev.yml build`)
5. Runs integration tests (`test/run-tests.sh` in the dev container)
6. Commits the changes (user confirmation required)

Triggers: `"Check for upstream updates"`, `"Update Dockerfile versions"`,
`"Bump pinned dependencies"`.

### 3. OPENCODE_PROVIDER — Custom provider injection

New `OPENCODE_PROVIDER` env var, merged into `opencode.json` by
`entrypoint.d/02-init-config.sh` at startup. Enables deployers to inject
custom OpenCode providers (e.g., Ollama) without modifying the image.

### 4. Release skill enhancements

Three gaps closed:

- **Badge sync** (5.1): Reads all 5 pinned versions from Dockerfile ARGs
  directly instead of from the running container. Now updates OpenCode,
  OpenChamber, Docker, Playwright, and lean-ctx badges.
- **Version detection** (5.2 NEW): Compares each Dockerfile ARG against the
  last git tag's Dockerfile. Generates "Upgrade X from Y to Z" lines.
- **CHANGELOG generation** (5.5): Python script that inserts a `### Changed`
  section with auto-generated bump entries into the new version section.
  Handles idempotency (no duplicate version blocks), version link rebuilding,
  and footer preservation.

## Why It Works

- **Single source of truth**: All version data comes from `Dockerfile` ARGs.
  Badges, CHANGELOG, and snapshots all read from the same ARG values.
- **No container dependency**: Badge/CHANGELOG updates work without a running
  container (unlike the old `docker exec` approach).
- **Git-based diff**: Step 5.2 uses `git show <tag>:Dockerfile` for accurate
  before/after comparison, not guesswork.
- **Decoupled skills**: Each skill has one job. Users can run any subset.

## Side Effects / Tradeoffs

- **`version-snapshot.json`** is a local tracking file (`.gitignore`'d). It's
  not shared between machines, so the first run on each machine shows all
  tracked packages as "new".
- **`--apt` requires Docker** (the DooD socket). It runs `docker run --rm
  ubuntu:24.04 apt-get upgrade --just-print`, which downloads ~30MB on first
  run. Skipped gracefully if docker is unavailable.
- **CHANGELOG Python script** is embedded inline in the skill markdown.
  This makes the skill self-contained but harder to debug than a standalone
  script.

## Evidence

- `check-versions.sh` syntax and integration verified: `bash -n` passes,
  `json` → `sed` pipeline produces correct commands, `outdated` exits 1 with
  proper output.
- Release CHANGELOG script tested: creates version section, inserts
  `### Changed` block, rebuilds links correctly.
- OPENCODE_PROVIDER verified end-to-end: image build, container start,
  `opencode models` lists Ollama models, `opencode run -m ollama/gemma4:e2b`
  returns responses.

## Related Files

- `.opencode/scripts/check-versions.sh` — Core version inspection script
- `.opencode/skills/check-updates.md` — New update workflow skill
- `.opencode/skills/release.md` — Enhanced release skill (3 sections updated)
- `.opencode/skills/vuln-scan.md` — Quick reference updated for new flags
- `entrypoint.d/02-init-config.sh` — OPENCODE_PROVIDER merge logic
- `docker-compose.yml` / `docker-compose.dev.yml` — Env var passthrough
- `.env.example` — OPENCODE_PROVIDER example
- `.gitignore` — Added version-snapshot.json

## Tags

`version-management` `dockerfile` `opencode` `release` `changelog`
`provider-injection` `pipeline`
