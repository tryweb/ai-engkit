# Git Credential Helper for glab Token

## Context

The admin dashboard runs `git fetch origin --depth 1` inside the `ai-engkit`
container to validate remotes when users set a project's Git remote URL via the
Projects page (`/projects`). These commands are executed via `docker exec` through
`execInAiDev()` in `/opt/admin/lib/docker.ts` — a non-interactive environment.

glab CLI stores GitLab access tokens in `~/.config/glab-cli/config.yml`. Git
itself does not read this file. The `credential.helper=store` mechanism writes
tokens in plaintext to `~/.git-credentials`, creating a security concern.

## Problem

Two separate authentication systems, no bridge between them:

```
glab CLI:  token in ~/.config/glab-cli/config.yml  (glab-only)
git:       credential.helper=store → ~/.git-credentials (plaintext)
```

When the admin UI runs a plain `git fetch origin` (not through glab), git
queries its credential helpers. With `credential.helper=store` and an empty
`~/.git-credentials`, git has no credentials for HTTPS remotes. Combined with
`GIT_TERMINAL_PROMPT=0` (no interactive prompts), git fails with:

```
fatal: could not read Username for 'https://gitlab.example.com': No such device or address
```

Previously solved by writing the token directly to `~/.git-credentials`:
```
https://user:TOKEN@gitlab.example.com
```
This works but stores the access token in plaintext on disk — the `store`
helper is a simple text file with no encryption.

## Solution

A **git credential helper script** (`git-credential-glab`) that implements git's
credential helper protocol by reading tokens from glab's `config.yml` at runtime:

```
git fetch origin --depth 1
  → git checks credential.https://host.helper=glab
  → git-credential-glab reads stdin for hostname
  → reads ~/.config/glab-cli/config.yml via python3 yaml
  → outputs username=<user>, password=<token> on stdout
  → git authenticates successfully
  → token never written to disk
```

### Implementation

The helper is a 30-line shell script at `scripts/git-credential-glab` in the
repo, baked into the image at build time (`~/.local/bin/git-credential-glab`
via `COPY` in the Dockerfile). It survives container recreation because
`~/.local/bin` is not a VOLUME — a runtime-deployed copy would be wiped on
`docker compose up -d --force-recreate`, which `upgrade.sh` runs on every
upgrade. Git discovers it automatically because `~/.local/bin` is in `PATH`
and git looks for `git-credential-<name>` executables.

```sh
#!/bin/sh
GLAB_CONFIG="${HOME}/.config/glab-cli/config.yml"
HOST=""
while IFS="=" read -r key value; do
  case "$key" in
    host) HOST="$value" ;;
  esac
done
[ -z "$HOST" ] && exit 0
[ ! -f "$GLAB_CONFIG" ] && exit 0
python3 -c "
import yaml, sys, os
glab_cfg = os.path.expanduser('~/.config/glab-cli/config.yml')
with open(glab_cfg) as f:
    cfg = yaml.safe_load(f)
hosts = cfg.get('hosts', {})
hostname = sys.argv[1]
if hostname in hosts:
    h = hosts[hostname]
    token = h.get('token', '')
    if token:
        user = h.get('user', 'oauth2')
        print(f'username={user}')
        print(f'password={token}')
" "$HOST"
```

Git is configured per-host so the helper only runs for relevant remotes:

```
git config --global credential.https://gitlab.example.com.helper glab
git config --global credential.http://gitlab.example.com.helper glab
```

The global `credential.helper=store` is **removed** to prevent git from caching
credentials back to plaintext after the helper returns them.

### Git config applied on glab login

The helper script itself is baked into the image, so only the git config is
applied after a successful `glab auth login` — see
`setupGlabCredentialHelper(hostname)` in `src/admin/lib/glab-auth.ts`:

```typescript
async function setupGlabCredentialHelper(hostname: string): Promise<void> {
  // 1. Remove global credential.helper=store
  // 2. Set per-host credential helper for http:// and https://
  // 3. Clear any residual ~/.git-credentials
}
```

## Why It Works

- **Single source of truth**: The token lives only in glab's `config.yml`. No
  duplication, no sync issues.
- **Zero plaintext on disk**: The credential helper reads the token at runtime
  and returns it to git via stdout. The token is never written to a separate file.
- **Standard git protocol**: Git's credential helper protocol is the intended
  mechanism for this — same pattern used by GitHub CLI (`gh auth git-credential`),
  GitLab CLI (`glab auth configure-docker`), and others.
- **Per-host scoping**: URL-scoped git config limits the helper to specific
  hosts, avoiding interference with other remotes (GitHub, etc.).

## Side Effects / Tradeoffs

- **Python dependency**: The helper requires `python3` with `yaml` module in
  the ai-engkit container (present by default).
- **One-time git-config gap**: The git config (per-host helper) is only
  applied when `glab auth login` runs. If glab was configured manually
  (editing config.yml), the per-host helper is not set. The helper script
  itself is always present (baked into the image), so re-running glab auth
  login via the admin UI — or setting the two per-host config lines manually
  — restores git access without redeploying any files.
- **No `store` caching**: Without `credential.helper=store`, git re-queries
  the helper on every operation. For frequently accessed repos, this adds
  ~50ms per credential check. Acceptable for development workflows.
- **No interactive fallback**: If the helper fails (e.g., token expired), git
  has no credential source and fails. Users must re-authenticate via the
  GitLab Auth page.

## Evidence

- `~/.git-credentials` stays at 0 bytes after `git fetch` ✅
- Credential helper correctly returns token from glab config ✅
- `git fetch origin --depth 1` exits 0 with `GIT_TERMINAL_PROMPT=0` ✅
- Tested on ai-engkit-194 with remote repo auth ✅
- Container recreation (`docker compose up -d --force-recreate`) no longer
  breaks git auth — the helper survives in the image layer ✅

## Related Files

- `scripts/git-credential-glab` — the credential helper script (single source,
  baked into the image via Dockerfile COPY)
- `src/admin/lib/glab-auth.ts` — `setupGlabCredentialHelper()`,
  `listGlabInstances()`, `loginGlabWithToken()`, `readGlabToken()`
- `src/admin/routes/projects.ts` — `PUT /api/projects/:name/git-remote` handler
  (removed `GIT_TERMINAL_PROMPT=0`)
- `src/admin/routes/git-config.ts` — removed `/api/git/credentials` endpoint
- `src/admin/views/git-config.tsx` — removed "Stored Credentials" UI section
- `docs/knowledge/tooling/glab-multi-instance-auth.md` — related glab auth setup
- `docs/knowledge/tooling/ssh-key-agent-workflow.md` — SSH key alternative

## Managed Rotation Boundary

AI-EngKit owns GitLab token inspection and rotation. EP callers use the managed
Git channel and must not rotate or persist credentials themselves. Rotation
requires `read_repository` and `self_rotate`, and must not use the broader
`api` scope. Test tokens are for tests only.

The scheduler defaults are `GITLAB_TOKEN_ROTATION_THRESHOLD_DAYS=7`,
`GITLAB_TOKEN_ROTATION_LIFETIME_DAYS=30`, and
`GIT_HOSTING_AUTH_CHECK_INTERVAL_MS=86400000`. Impersonation rotation also
requires the hostname in `GITLAB_IMPERSONATION_ROTATION_CONFIRMED_HOSTS`.
The replacement token is one-time output, immediately invalidates the old
token, and must not be retried after an ambiguous response because the token
family may already have been reused.

GitHub is check-only today. The system can report validity and trusted expiry,
but it does not rotate GitHub PATs. A future GitHub App flow is outside this
contract.

## Tags

`#git` `#credentials` `#glab` `#security` `#credential-helper` `#gitlab` `#auth`
