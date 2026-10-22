# Git Authentication

GitLab HTTPS authentication uses the on-demand `git-credential-glab` helper (per-host `credential.https://<host>.helper`, applied by `setupGlabCredentialHelper()` in `src/admin/lib/glab-auth.ts` after `glab auth login`). Tokens live only in glab's `config.yml`; the legacy global `credential.helper = store` is unset and `~/.git-credentials` is kept empty so no plaintext credential persists. Git identity and the `git-config` named volume survive container restarts.

**Important:** The container's git/SSH/gh configs are **isolated** from the host — they live in their own named volumes (`git-config`, `ssh-keys`, `gh-config`). Authenticate inside the container; host authentication does not propagate.

## First-time Setup

### HTTPS (easiest)

```bash
# Inside the container
git clone https://github.com/your-org/private-repo.git
# Enter username + Personal Access Token (PAT) when prompted
# Credential is saved to ~/.git-credentials in the git-config volume
```

### SSH

```bash
# From the host, copy your key into the container
docker cp ~/.ssh/id_ed25519 ai-dev:/home/devuser/.ssh/
docker exec ai-dev chmod 600 /home/devuser/.ssh/id_ed25519
docker exec ai-dev ssh-add ~/.ssh/id_ed25519   # optional for passphrase-protected keys
```

The ai-dev startup flow automatically reloads existing private keys with an
empty passphrase into ssh-agent after container restart. Passphrase-protected
keys are intentionally skipped and must be added interactively.

### `gh` / `glab` CLI

```bash
# Inside the container
gh auth login      # GitHub
glab auth login    # GitLab
```

## Managed GitLab Token Rotation

AI-EngKit owns GitLab token inspection and rotation. Callers in EP should use
the managed Git channel, not rotate or persist GitLab credentials themselves.
The credential helper reads the current token from glab's config at runtime and
does not write a replacement token to `~/.git-credentials`.

### Required token policy

Use a GitLab token with exactly the access needed by the managed flow:

- `read_repository`
- `self_rotate`
- Do not grant `api` for this flow.

Use test tokens only for tests. Never use a production token in a test, fixture,
example, or troubleshooting command. Documentation examples must use a
placeholder such as `glpat-EXAMPLE`.

### Rotation settings

The scheduler checks Git hosting auth once per day by default and rotates a
GitLab token when its remaining lifetime is at or below seven days. It requests
a replacement with a 30-day lifetime.

| Environment variable | Default | Purpose |
| --- | ---: | --- |
| `GITLAB_TOKEN_ROTATION_THRESHOLD_DAYS` | `7` | Rotate at or below this remaining lifetime. |
| `GITLAB_TOKEN_ROTATION_LIFETIME_DAYS` | `30` | Lifetime requested for the replacement token. |
| `GIT_HOSTING_AUTH_CHECK_INTERVAL_MS` | `86400000` | Auth-check interval, in milliseconds. |
| `GITLAB_IMPERSONATION_ROTATION_CONFIRMED_HOSTS` | empty | Comma-separated hostnames explicitly approved for impersonation-token rotation. |

Rotation is supported on GitLab 17.9 and later. The confirmed-host setting is
required for impersonation tokens. Normalize entries as hostnames, without a
scheme or path.

### Rotation flow and hazards

The service inspects the current token, checks its status, expiry, GitLab
version, scopes, and impersonation approval, then calls GitLab's self-rotate
endpoint only when rotation is due. It stores the replacement through glab and
verifies that the Git credential helper can retrieve it.

Rotation has irreversible failure modes:

- The replacement token is returned once. Do not expect the token to be shown
  again after the response is gone.
- GitLab immediately invalidates the old token when rotation succeeds.
- Retrying after a timeout, connection failure, malformed response, or server
  error can reuse an invalid token family. Treat the result as ambiguous and
  do not retry automatically.
- If persistence or helper verification fails, stop and reauthenticate through
  the managed GitLab auth flow. Do not copy tokens into shell history or files.

### GitHub limitations

GitHub authentication is check-only. AI-EngKit can report whether the `gh`
credential is valid, expired, revoked, or unreachable, and can report a trusted
expiry when GitHub provides one. It does not rotate GitHub PATs. Reauthorize
with the GitHub device flow when requested. Support for GitHub's fine-grained
PAT or App-based rotation is future work and is not part of this contract.

### Troubleshooting

The auth state reports these GitLab rotation outcomes:

- `invalid_expired`: Reauthenticate the affected GitLab host, then run the
  managed check again.
- `insufficient_scope`: Create or replace the test or operator token with
  `read_repository` and `self_rotate`, without adding `api`.
- `unsupported_version`: Upgrade GitLab to 17.9 or later before enabling
  rotation.
- `impersonation_unconfirmed`: Add the normalized hostname to
  `GITLAB_IMPERSONATION_ROTATION_CONFIRMED_HOSTS` only after operator approval.
- `persistence_failed`: Do not retry rotation. Confirm glab login and the
  per-host credential helper, then reauthenticate if the replacement was not
  persisted.
- `ambiguous_rotation`: Assume the old token may already be invalid and the
  family may already have rotated. Do not retry. Check glab state and complete
  operator reauthentication.
- `unreachable`: Check DNS, network access, and GitLab availability, then run a
  fresh inspection. Do not repeat a rotation request after an ambiguous result.

For GitHub, `invalid-revoked-expired` means reauthorize with the device flow;
`unreachable` means check network access and try the status check later. GitHub
expiry may be `unknown`, which is not proof that the token is expired.

## Multiple Accounts

For per-host credentials, edit `~/.gitconfig` inside the container:

```ini
[credential "https://github.com"]
    username personal-user

[credential "https://gitlab.work.com"]
    username work-user
```

For SSH, use `~/.ssh/config` Host aliases with different keys.

## Updating or Clearing Credentials

```bash
# Erase a stored credential (interactive)
docker exec -it ai-dev bash -c 'git credential-store erase'

# Or edit the file directly
docker exec -it ai-dev vi ~/.git-credentials
```

## Security Notes

- `credential.helper = store` saves credentials in **plaintext** in `~/.git-credentials`. Prefer HTTPS Personal Access Tokens (PATs) with minimum required scopes over passwords.
- For higher security, prefer SSH keys.
- The container's credential volumes are **not shared** with the host — a compromised container cannot read host credentials, and host credentials are never exposed to the container.
- If you set up glab/gh as a credential helper on the **host**, see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md#glab-as-a-git-credential-helper-with-a-versioned-path) for the versioned-path breakage issue.

## Credential Volumes

| Volume | Container Path | Content |
|--------|---------------|---------|
| `git-config` | `/home/devuser/.config/git` | Git config, `.git-credentials` |
| `ssh-keys` | `/home/devuser/.ssh` | SSH keys, `known_hosts` |
| `gh-config` | `/home/devuser/.config/gh` | GitHub CLI auth state |
| `glab-config` | `/home/devuser/.config/glab-cli` | GitLab CLI auth state |
