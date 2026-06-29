# Git Authentication

The container uses `credential.helper = store` for HTTPS operations (configured automatically by `entrypoint.d/04-init-git-ssh.sh` on first start). Credentials are persisted in a `git-config` named volume and survive container restarts.

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
docker cp ~/.ssh/id_ed25519 ai-engkit-engine:/home/devuser/.ssh/
docker exec ai-engkit-engine chmod 600 /home/devuser/.ssh/id_ed25519
docker exec ai-engkit-engine ssh-add ~/.ssh/id_ed25519   # optional, for ssh-agent
```

### `gh` / `glab` CLI

```bash
# Inside the container
gh auth login      # GitHub
glab auth login    # GitLab
```

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
docker exec -it ai-engkit-engine bash -c 'git credential-store erase'

# Or edit the file directly
docker exec -it ai-engkit-engine vi ~/.git-credentials
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
