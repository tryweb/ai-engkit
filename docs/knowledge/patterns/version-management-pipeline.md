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
- `OH_MY_OPENAGENT_VERSION` was a Dockerfile pin but was only recorded in the
  `--latest` snapshot path, so normal `outdated` checks and CI could not
  propose a Dockerfile update for it.
- The `release` skill needed to detect what actually changed in Dockerfile
  instead of relying on presentation-only README metadata.
- No local skill existed to go from "check upstream" → "update Dockerfile" →
  "build and test" in one shot.

## Solution

A three-skill pipeline covering the full lifecycle:

```
check-versions.sh (script)    version inspection + diff + snapshot
  ↓
check-updates (skill)          apply updates → build → test → commit
  ↓
release (skill)               CHANGELOG → tag → push
```

### 1. check-versions.sh — Unified version inspection

Extended with 4 flags:

| Flag | Function |
|------|----------|
| `--latest` | Check npm-tracked packages without Dockerfile pins (codegraph, openspec) |
| `--apt` | Query ubuntu:24.04 base image for available APT updates (requires docker) |
| `--snapshot` | Diff current versions against `version-snapshot.json` |
| `--snapshot-save` | Write a new snapshot after checking |
| `--all` | Enable all three above |

`LEANCTX_VERSION` was also added to close the drift with the CI workflow.

#### Dockerfile pin registration rule

Every versioned `ARG` in `Dockerfile` must be registered in both:

1. `.opencode/scripts/check-versions.sh`: `lookup`, `source_label`, and
   `collect_rows`, so `check`, `outdated`, and `json` compare the pin with its
   upstream source.
2. `.github/workflows/dependency-update.yml`: `PINNED_NAMES`, its source
   lookup, expected pin count, and snapshot generation, so scheduled CI can
   build, test, and propose the Dockerfile update.

Do not put a Dockerfile pin in `--latest`; that path only snapshots packages
without a Dockerfile pin. `OH_MY_OPENAGENT_VERSION` is the reference example:
it moved from latest-tracked npm monitoring to the normal pinned dependency
path, where `oh-my-openagent` is compared through npm.

#### Derived pins

Most pins compare against their upstream's newest release. `BUN_VERSION` is
the exception: it is a derived pin. Its target is the Bun release OpenChamber
requires, read from the `packageManager` field (`"bun@X.Y.Z"`) of
`package.json` at the OpenChamber git tag on
`github.com/openchamber/openchamber`. It is never Bun's own latest release.

- Local: `check-versions.sh` derives the target from the `OPENCHAMBER_VERSION`
  pinned in `Dockerfile`, so the Bun requirement must be rechecked whenever
  OpenChamber changes.
- CI: `dependency-update.yml` expects exactly 15 pinned ARGs and derives the
  Bun target from the candidate OpenChamber version when both pins update in
  the same run (pinned version as fallback).
- Drift is exact-equality: pinned ahead OR behind the required version both
  count as outdated, because the image must ship the Bun version OpenChamber
  declares.

#### Auto-release gate

`dependency-update.yml` Job 4 (handle-updates) has an auto-release path that
tags a dependency-only patch release directly against the tip of `main`
(no PR). Because it tags HEAD as-is, any human commit merged since the last
release would be silently bundled into that "dependency updates" release —
shipped with dependency-only release notes and missing from the semantic
version history (v1.18.6 packaged 4 such commits: feat(admin) LSP grouping,
style(admin) responsive tables, fix(admin) LSP block-change count, ci ripgrep).

Guard added 2026-09 (`Check unreleased commits` step): before the auto-release
decision, the workflow walks `git log <last-stable-tag>..HEAD --no-merges` and
drops only `chore:` / `docs:` subjects. If any significant commit remains
(feat/fix/style/ci/build/...), the decision routes to a new
`release-gate-issue` action: auto-release is skipped and an issue lists the
unreleased commits so a human cuts a proper release (the `release` skill).
Only when the range is exclusively chore/docs (or empty) does auto-release fire.
No stable tag at all also blocks auto-release (conservative: whole history is
unreleased).

The same guard covers the second auto-release producer: `ci.yml`'s `auto-tag`
job (which tags `main` after a `chore: update Dockerfile pinned versions` PR
merge) runs an identical `Check unreleased commits` gate and skips tagging
when significant commits exist, posting a warning annotation instead.
Promotion (`promote.yml`) stays manual and is unaffected — a blocked
auto-release only delays when a promotable tag exists.

Note on resumption: a blocked run still uploads `version-snapshot.json`, so
auto-release resumes not on "no significant commits remain" but on a later
scheduled run that detects new upstream updates.

#### OMO schema reference sync rule

`.opencode/omo.jsonc.default` pins its `$schema` URL to a versioned OMO tag
(e.g. `https://raw.githubusercontent.com/code-yeongyu/oh-my-openagent/v4.19.3/assets/omo.schema.json`).
That tag is **not** tracked by `check-versions.sh` — only the Dockerfile ARG is —
so an OMO bump left the schema reference silently lagging the installed plugin.

Fixed in v4.19.4 upgrade (`07018b6`): both `check-updates` skill step 3 and the
`dependency-update.yml` "Update Dockerfile version ARGs" step now sed the schema
URL to the new tag whenever `OH_MY_OPENAGENT_VERSION` changes. The CI step
detects the OMO pin in the `pinned-updates` JSON with
`jq -e 'any(.[]; .name == "OH_MY_OPENAGENT_VERSION")'` before applying the sed.

The `$schema` field is editor-only (runtime merge ignores it), so a stale tag
does not break containers — but it degrades IDE validation of the default file.

### 2. check-updates skill — One-shot update workflow

New skill (`.opencode/skills/check-updates/SKILL.md`) that:
1. Runs `check-versions.sh outdated` to detect outdated pins
2. Shows the user what's outdated, asks which to update
3. Applies `sed -i` to Dockerfile ARGs (using JSON output from
   `check-versions.sh json` to get the correct latest version)
4. Builds the dev image (`docker compose -p dev -f docker-compose.dev.yml build`)
5. Runs integration tests (`test/run-tests.sh` in the dev container)
6. Commits the changes (user confirmation required)

Triggers: `"Check for upstream updates"`, `"Update Dockerfile versions"`,
`"Bump pinned dependencies"`.

### 3. OPENCODE_PROVIDER — Custom provider injection

New `OPENCODE_PROVIDER` env var, merged into `opencode.json` by
`entrypoint.d/02-init-config.sh` at startup. Enables deployers to inject
custom OpenCode providers (e.g., Ollama) without modifying the image.

### 4. Release skill enhancements

Two gaps closed:

- **Version detection** (5.1): Compares each Dockerfile ARG against the
  last git tag's Dockerfile. Generates "Upgrade X from Y to Z" lines.
- **CHANGELOG generation** (5.4): Python script that inserts a `### Changed`
  section with auto-generated bump entries into the new version section.
  Handles idempotency (no duplicate version blocks), version link rebuilding,
  and footer preservation.

## Why It Works

- **Single source of truth**: All version data comes from `Dockerfile` ARGs.
  CHANGELOG entries and snapshots read from the same ARG values.
- **No container dependency**: CHANGELOG updates work without a running
  container (unlike the old `docker exec` approach).
- **Git-based diff**: Step 5.1 uses `git show <tag>:Dockerfile` for accurate
  before/after comparison, not guesswork.
- **Decoupled skills**: Each skill has one job. Users can run any subset.
- **Complete update path**: Registering a pin in both local and CI checkers
  prevents an upstream update from being observed but never proposed as a
  Dockerfile change.

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
- **Registration duplication is deliberate**: The local script and CI workflow
  have separate execution environments, so each needs its own source mapping
  and pin list. Keep their behavior aligned when adding or removing a pin.

## Evidence

- `check-versions.sh` syntax and integration verified: `bash -n` passes,
  `json` → `sed` pipeline produces correct commands, `outdated` exits 1 with
  proper output.
- OMO pin registration verified: `check-versions.sh json` reports
  `OH_MY_OPENAGENT_VERSION` with `pinned`, `latest`, `source`, and `status`;
  for the verified image it reported `4.19.3 → 4.19.3` from
  `npm:oh-my-openagent`.
- OMO 4.19.4 upgrade (`07018b6`) verified end-to-end: `check-versions.sh json`
  reported `pinned: 4.19.4, latest: 4.19.4, status: current`; dev image built;
  `test/run-tests.sh` passed 151/151 including the "OMO plugin declaration
  matches runtime pin" assertion; CI workflow YAML parsed cleanly with the new
  schema-sync step.
- `.github/workflows/dependency-update.yml` parsed successfully after its pin
  count changed from 11 to 12; the workflow now expects 15 pinned ARGs with
  `BUN_VERSION` registered.
- Release CHANGELOG script tested: creates version section, inserts
  `### Changed` block, rebuilds links correctly.
- OPENCODE_PROVIDER verified end-to-end: image build, container start,
  `opencode models` lists Ollama models, `opencode run -m ollama/gemma4:e2b`
  returns responses.

## Related Files

- `.opencode/scripts/check-versions.sh` — Core version inspection script
- `.opencode/skills/check-updates/SKILL.md` — New update workflow skill
- `.github/workflows/dependency-update.yml` — Scheduled pinned-version updates
- `test/run-tests.sh` — Verifies generated OMO plugin pin matches runtime env
- `.opencode/skills/release/SKILL.md` — Enhanced release skill (3 sections updated)
- `.opencode/skills/vuln-scan/SKILL.md` — Quick reference updated for new flags
- `entrypoint.d/02-init-config.sh` — OPENCODE_PROVIDER merge logic
- `docker-compose.yml` / `docker-compose.dev.yml` — Env var passthrough
- `.env.example` — OPENCODE_PROVIDER example
- `.opencode/omo.jsonc.default` — Baked OMO config whose `$schema` tag must sync with `OH_MY_OPENAGENT_VERSION`
- `.gitignore` — Added version-snapshot.json

## Tags

`version-management` `dockerfile` `opencode` `oh-my-openagent` `release`
`changelog` `provider-injection` `pipeline` `dependency-update`
