# V2 Branch Wiring — One Source of Truth for the V2 Branch Name

## Context

`ci.yml` routes work to the V1 or V2 line by branch name: `build` runs for the
V1 line, and `build-v2`/`trial-v2`/`scan-v2`/`push-v2-trial` run for the V2
line. The V2 branch started as `trial/opencode-v2` and is expected to be renamed
once the line stabilizes.

## Problem

The branch name was hardcoded in seven places in `ci.yml` (the `build` gate ×2,
the `build-v2` gate ×3, the `push-v2-trial` gate, and the `on.push.branches`
list). Renaming the branch without editing every copy makes the V2 jobs match
nothing — **the V2 pipeline silently stops running** (no error, just no jobs).

## Solution

- A repository variable **`V2_BRANCH`** is the single source of truth for every
  gate. The `if:` conditions read it via the `vars` context, e.g.
  `github.ref == format('refs/heads/{0}', vars.V2_BRANCH)`.
- `on.push.branches` **must** stay a literal: GitHub does not expose the `vars`
  context to the `on:` trigger. It carries a sync comment pointing here.
- A `config-guard` job fails the run when `V2_BRANCH` is unset, so the variable
  cannot be deleted without a loud failure (an empty `vars.V2_BRANCH` would
  otherwise disable the whole V2 pipeline).
- The `check-updates` skill no longer keys on a literal; it points at this doc
  and the variable.

## Rename Procedure (checklist)

Renaming the V2 branch touches exactly two functional spots plus the variable:

1. Rename the branch:
   `gh api -X POST repos/:owner/:repo/branches/<old>/rename -f new_name=<new>`
   (GitHub keeps a temporary redirect from the old name) — or `git branch -m`
   + push the new name + delete the old remote branch.
2. Set the variable:
   `gh variable set V2_BRANCH --body "<new>"`.
3. Edit **one** literal in `ci.yml`:
   `on.push.branches: [main, <new>]`.
4. Update the "currently …" hint in
   `.opencode/skills/check-updates/SKILL.md` (cosmetic).
5. Verify: push to the new branch and confirm `build-v2` (and the other V2
   jobs) trigger and pass; confirm `build` stays skipped.

## Why It Works

Gate expressions resolve at run time from `vars`, so a rename only changes the
value, not the workflow. The one unavoidable literal is isolated to the trigger
and annotated. The guard converts the silent-failure mode into a red run.

## Side Effects / Tradeoffs

- The `V2_BRANCH` variable is a required repository setting; losing it fails
  `config-guard` until restored. (Deliberate: loud over silent.)
- `config-guard` runs on every CI run, including V1-only ones (a few seconds).
- Until the rename, `V2_BRANCH` and the `on.push.branches` literal must agree;
  `config-guard` does not check the literal (it cannot read `on:`), so step 3 of
  the checklist is the one manual step that must not be forgotten.

## Evidence

- Before: seven `trial/opencode-v2` literals in `ci.yml`; no guard.
- After: six gate comparisons use `vars.V2_BRANCH`; `on.push.branches` keeps the
  literal with a sync comment; `config-guard` added. `V2_BRANCH` set to
  `trial/opencode-v2` via `gh variable set`.
- `python3 -c yaml.safe_load` passes on `ci.yml`.

## Related Files

- `.github/workflows/ci.yml` — `config-guard`, `build`/`build-v2`/`push-v2-trial` gates, `on.push.branches`
- `.opencode/skills/check-updates/SKILL.md` — release-line detection hint
- `docs/knowledge/tooling/opencode-v2-migration-watch.md` — the V2 line context

## Tags

- opencode-v2
- ci
- github-actions
- branch-rename
- repo-variable
- wiring
