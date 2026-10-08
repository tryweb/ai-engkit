# GitHub HTTPS Auth and the Git Credential Helper

## Context

ai-engkit authenticates GitHub HTTPS pushes with the `gh` CLI. The token lives
in the `gh-config` volume (`~/.config/gh/hosts.yml`); git must be told to read
it through a credential helper. The GitLab side has the analogous baked
`scripts/git-credential-glab` + per-host `credential.<host>.helper=glab`.

## Problem

Two independent gaps made GitHub HTTPS pushes fail even after "connecting
GitHub" in Admin:

1. **No git credential helper was wired.** `gh auth login` run non-interactively
   (the Admin device flow runs it with no TTY stdin) skips its own
   "Authenticate Git with your GitHub credentials?" prompt, so git never learns
   the token:
   ```
   fatal: could not read Username for 'https://github.com': terminal prompts disabled
   ```
   Fix: `gh auth setup-git`, which writes
   `credential.https://github.com.helper = !/usr/local/bin/gh auth git-credential`
   (plus the same for gist) into the persisted git config.

2. **The token lacked the `workflow` scope.** GitHub refuses to let an OAuth App
   create or update `.github/workflows/*` without it:
   ```
   ! [remote rejected] ... refusing to allow an OAuth App to create or update
     workflow `.github/workflows/ci.yml` without `workflow` scope
   ```
   The Admin connect flow ran `gh auth login --web` with no `--scopes`, so the
   token only got gh's default minimum (`repo`, `read:org`, `gist`).

## Solution

- **Request the scope at connect**: `startDeviceFlow` now runs
  `gh auth login --web --hostname github.com --scopes workflow` (`--scopes` is
  additive to the default set).
- **Wire the helper on connect**: `ensureGitCredentialHelper()` runs
  `gh auth setup-git` behind a `git config --global --get-all … || …` guard
  (one-time no-op). It is invoked from the `/api/auth/gh/status` route when the
  status is `authenticated` — the endpoint the UI polls while connecting.
- **Wire the helper on boot**: `entrypoint.d/05-init-gh-cli.sh` runs the same
  guarded setup when `gh auth status` already succeeds, so a restored-volume
  container gets the helper without an Admin visit.
- The git config lives in the `git-config` volume (`~/.gitconfig` →
  `~/.config/git/.gitconfig`), so the helper survives container recreation.

## Why It Works

- `gh auth setup-git` is the canonical way to make git use the gh token; its
  config is per-host and persisted, so it only needs applying once.
- Running it where authentication is observed (Admin status poll, or entrypoint
  when already logged in) covers both the interactive connect and a fresh boot.

## Side Effects / Tradeoffs

- `workflow` scope lets the token modify CI pipelines — appropriate for this
  workspace, but it is a deliberate broadening of the default minimum.
- The Admin fix only affects new authorizations; an existing token must be
  re-authorized or `gh auth refresh -s workflow` to gain the scope.
- `gh auth setup-git` requires `gh` on PATH and a writable global git config; in
  the container both hold (git-config volume, `/usr/local/bin/gh`).

## Evidence

- Before: `gh auth status` → `Token scopes: 'gist', 'read:org', 'repo'`;
  `gh config --get-all credential.https://github.com.helper` → empty; push →
  `could not read Username`.
- After `gh auth refresh -s workflow`: `X-Oauth-Scopes: gist, read:org, repo,
  workflow`; `git push` → `3b51e16..c1f7373 trial/opencode-v2` (exit 0).
- Admin scope display bug: `grep -oP "Token scopes: '\K[^']+"` captured only
  the first scope; replaced with `sed -n 's/.*Token scopes: //p'` +
  `parseScopes()`. Unit tests: 9 pass.
- `entrypoint.d/05-init-gh-cli.sh` re-run in an authenticated container is a
  clean no-op (guard short-circuits).

## Related Files

- `src/admin/lib/gh-auth.ts` — `startDeviceFlow`, `parseScopes`, `ensureGitCredentialHelper`
- `src/admin/routes/gh-auth.ts` — status route wires the helper when authenticated
- `entrypoint.d/05-init-gh-cli.sh` — boot-time helper wiring
- `entrypoint.d/04-init-git-ssh.sh` — git-config volume + symlinks
- `scripts/git-credential-glab`, `docs/knowledge/architecture/git-credential-glab-helper.md` — GitLab analogue

## Tags

- github
- gh-cli
- credentials
- git-credential-helper
- oauth-scopes
- admin
