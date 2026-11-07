# GitHub CLI Logged In but git push Fails with "could not read Username"

## Context

ai-engkit authenticates GitHub via the `gh` CLI device flow (Admin UI
Git Hosting page or `docker exec gh auth login`). The token lives in the
`gh-config` volume (`~/.config/gh/hosts.yml`) and `gh api` works. The git
identity (`user.name`/`user.email`) is configured separately on the same
Admin page.

## Problem

`gh auth status` reports `Logged in to github.com account <user>`, yet
every `git push`/`pull` to a github.com remote fails with:

```
fatal: could not read Username for 'https://github.com': No such device or address
```

`git ls-remote` on the same public repo succeeds, which misleads toward a
scope problem — but the actual token scopes (`gist, read:org, repo`) are
sufficient.

## Solution

`gh auth login` authenticates the CLI but never touches git config. No
component wired git to gh:

- `entrypoint.d/05-init-gh-cli.sh` only created `~/.config/gh/`.
- No `gh auth setup-git` call existed anywhere in `src/admin`.
- `git config credential.helper` was empty, so git had no credential
  source for github.com remotes.

Two complementary fixes (either heals an environment; together they cover
all entry paths):

1. **Admin status-endpoint wiring** — `GET /api/auth/gh/status` calls
   `ensureGhCredentialHelper()` (`src/admin/lib/gh-auth.ts`) whenever the
   login is valid. The device flow completes in the browser, so the first
   status poll observing `valid` is the only server-side success signal.
   Best-effort: failures are logged, never break status reads; already-wired
   environments cost one local `git config` check.
2. **Entrypoint backfill** — `05-init-gh-cli.sh` runs `gh auth setup-git`
   as devuser on boot when `gh auth status` succeeds and the helper is
   missing. Covers logins done via `docker exec` and environments that
   never revisit the Admin page.

Emergency fix for an already-broken environment (no rebuild needed):

```bash
gh auth setup-git
git push  # now uses `gh auth git-credential`
```

## Why It Works

`gh auth setup-git` registers
`credential.https://github.com.helper = !gh auth git-credential` in
`~/.gitconfig` (symlinked to the `git-config` volume, so it survives
recreate), while the token stays in the `git-config`-independent
`gh-config` volume. git resolves credentials on demand per remote instead
of caching tokens to disk. The check-then-wire guard keeps both call sites
idempotent.

This mirrors the GitLab side, where `setupGlabCredentialHelper()` runs
after every successful glab login and the helper script is baked into the
image.

## Side Effects / Tradeoffs

- `gh auth logout` does not unwire the helper; the leftover config is
  inert (gh has no token to serve) and is re-verified on next valid login.
- gist.github.com helper is wired alongside github.com by `setup-git`;
  harmless.
- The Admin UI scope display (`Scopes: gist`) can lag the real token
  scopes; verify with `gh auth status`, not the dashboard badge.

## Evidence

- Broken env: `git config --global credential.helper` empty,
  `gh auth status` logged in with scopes `'gist', 'read:org', 'repo'`,
  `git push` → `could not read Username`; `git ls-remote` on the public
  repo succeeded (auth only required for write).
- After `gh auth setup-git`: `credential.https://github.com.helper`
  present in `~/.gitconfig`, `git push` → `740fa84..88ab69a main -> main`.
- `bun test lib/gh-auth.test.ts` — 12 pass (3 new wiring tests);
  `tsc --noEmit` clean; `bash -n 05-init-gh-cli.sh` clean.

## Related Files

- `src/admin/lib/gh-auth.ts` — `ensureGhCredentialHelper()`
- `src/admin/routes/gh-auth.ts` — status-endpoint wiring
- `src/admin/lib/gh-auth.test.ts` — wiring tests
- `entrypoint.d/05-init-gh-cli.sh` — boot backfill
- `entrypoint.d/04-init-git-ssh.sh` — `~/.gitconfig` symlink to volume
- `src/admin/lib/glab-auth.ts` — `setupGlabCredentialHelper()` (GitLab precedent)
- `docs/knowledge/troubleshooting/credential-helper-lost-on-container-recreate.md` — GitLab variant

## Tags

`gh` `git` `credential-helper` `device-flow` `entrypoint` `admin-dashboard` `troubleshooting`
