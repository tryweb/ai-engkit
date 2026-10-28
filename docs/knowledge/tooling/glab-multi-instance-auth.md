# GitLab Multi-Instance Authentication with glab CLI

## Context

ai-engkit admin dashboard provides a GitLab Auth page (`/auth/gitlab`) for
managing `glab` CLI authentication. Users may have multiple self-hosted GitLab
instances (e.g., `gitlab-238.ichiayi.com`, `gitlab.tp.everplast.net`) in
addition to or instead of `gitlab.com`.

The `glab` CLI stores all configured hosts in a single YAML config file at
`~/.config/glab-cli/config.yml`.

## Problem

Several issues with the original single-host device-code-flow design:

1. **Default gitlab.com noise**: `glab` always creates a default `gitlab.com`
   host entry in `config.yml` with no token. `glab auth status` returns a
   non-zero exit code because of this empty host, even when other instances
   are properly authenticated.

2. **Single hostname input**: The original UI only allowed one hostname at a
   time with no way to manage multiple instances or remove old ones.

3. **gitlab.com 401 errors**: `glab` tries to call `gitlab.com/api/v4/user`
   on every `glab auth status` check, producing misleading 401 errors.

4. **Token-only auth for self-hosted**: Self-hosted instances typically use
   Personal Access Tokens rather than the device code OAuth flow. The original
   implementation only supported device code.

## Solution

### 1. Config-driven instance discovery (instead of `glab auth status`)

Parsing `glab auth status` output is fragile — it shows all hosts including
empty defaults. The solution is a two-phase approach:

- **Phase 1**: Parse `config.yml` via Python's `yaml.safe_load()` to find
  hosts that have a `token` field (real authenticated instances).
- **Phase 2**: Run `glab auth status --hostname <host>` **per token-bearing
  host** (parallel, 5s timeout each) and extract usernames from lines
  matching `Logged in to <host> as <user>`.

> Never run a bare `glab auth status` on any status/heartbeat path. It
> iterates **all** hosts including the token-less default `gitlab.com`
> entry and can hang ~30s (`API call failed: context deadline exceeded`)
> instead of fast-401 — observed 2026-10-28 on jonathan-198, where it
> stalled `collectStatus` at its 10s ceiling and caused center command
> timeouts while heartbeats still arrived. Per-host probing answers in
> <1s for healthy hosts (verified: 483ms for 2 hosts).

```typescript
// Phase 1: Read token-bearing hosts from config.yml
const hosts = await listTokenBearingGlabHosts(command); // empty gitlab.com excluded

// Phase 2: Probe each host individually (never bare `glab auth status`)
const summary = await getGlabAuthStatus(command); // 5s/host, parallel
```

This filters out the default `gitlab.com` entry automatically since it has no
token.

### 2. UI with instance table + add/remove

The GitLab Auth page now has two sections:

- **Configured Instances** — table showing hostname, username, status badge,
  and a "Remove" button per row
- **Add Instance** — form with hostname + Personal Access Token fields

### 3. Token-based `glab auth login`

When a token is provided, use:
```bash
glab auth login --hostname <host> --token <token>
```

When no token (device code flow), the existing `glab auth login --hostname <host>`
is used.

### 4. Safe host removal via Python YAML

`glab auth logout --hostname <host>` does not fully remove a host entry from
`config.yml` — it only clears credentials. To completely remove a host, the
config file must be edited directly. Using Python's `yaml` library ensures
valid YAML output (sed-based approaches corrupt the file structure):

```typescript
await execInAiDev(`python3 -c '
import yaml
with open("/home/devuser/.config/glab-cli/config.yml") as f:
    data = yaml.safe_load(f)
hosts = data.get("hosts", {})
h = "<hostname>"
if h in hosts:
    del hosts[h]
    data["hosts"] = hosts
    with open("/home/devuser/.config/glab-cli/config.yml", "w") as f:
        yaml.dump(data, f, default_flow_style=False, allow_unicode=True)
'`);
```

## Why It Works

- **config.yml is the source of truth** for which hosts have tokens. Empty
  default hosts have no token field, so they're naturally excluded.
- **Python yaml.safe_load** preserves comments and formatting while ensuring
  valid YAML structure. sed-based deletion breaks the file because YAML
  indentation is meaningful.
- **Two-phase parsing** keeps the code simple: Phase 1 identifies which hosts
  are real, Phase 2 decorates them with usernames from `glab auth status`.

## Side Effects / Tradeoffs

- **Python dependency**: The admin container must have `python3` and `pyyaml`
  installed. These are present in the ai-engkit image.
- **Empty-host hygiene**: `glab` recreates its default empty `gitlab.com`
  entry and `glab auth logout --hostname` only clears credentials without
  removing the key. `loginGlabWithToken` now calls `pruneEmptyGlabHosts`
  after every successful login; `getGlabAuthStatus`/`listGlabInstances`
  additionally never probe token-less hosts, so a leftover empty entry
  cannot stall status again.
- **Token scope**: `glab` calls `GET /api/v4/user` with the token. If the
  token lacks `read_user` scope, the host will show with empty username and
  `glab auth status` reports a non-zero exit. The token still works for
  git operations but the admin UI won't show the username.

## Evidence

- Tested with `gitlab-238.ichiayi.com` (authenticated as jonathan) and
  `gitlab.tp.everplast.net` (403 insufficient_scope — token still stored
  but username not retrievable)
- Add → Remove cycle tested: `gitlab.com` added with a placeholder token,
  then removed. Config.yml remained valid after removal (verified with
  `glab auth status`).
- `gitlab.com` default host is filtered out of the UI list because it has
  no token in config.yml.

## Related Files

- `src/admin/routes/glab-auth.ts` — Status API, login, logout endpoints
- `src/admin/views/glab-auth.tsx` — Multi-instance UI with table + form
- `docs/knowledge/tooling/ssh-key-agent-workflow.md` — Related SSH key auth

## Tags

`#gitlab` `#glab` `#oauth` `#personal-access-token` `#yaml` `#auth`
