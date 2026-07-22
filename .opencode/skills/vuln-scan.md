---
name: vuln-scan
description: GitHub code scanning alert triage + Dockerfile version pin update. Dismiss false positives, compile high-risk list, check latest releases for pinned versions.
---

# Vulnerability Scan & Version Update Skill

Two-mode skill: (A) triage GitHub code scanning alerts via `gh`, (B) check Dockerfile version pins against latest upstream releases.

## Triggers

- "Run vulnerability scan" / "check code scanning alerts"
- "Triage security issues" / "close false positives"
- "Check Dockerfile versions" / "update version pins"
- "分析弱點掃描" / "檢查 Dockerfile 版本"

---

## Quick Reference

For routine operations, use the helper scripts:

```bash
# Mode A — GitHub code scanning alerts (requires `gh auth login`)
.opencode/scripts/vuln-scan.sh count       # Total open alert count
.opencode/scripts/vuln-scan.sh list        # List open alerts grouped by path
.opencode/scripts/vuln-scan.sh dismiss     # Batch-dismiss all open alerts
.opencode/scripts/vuln-scan.sh verify      # Verify no open alerts remain

# Mode B — Dockerfile version pin check (no auth required for npm/GitLab; gh auth needed for GitHub)
.opencode/scripts/check-versions.sh check       # Full table: pinned vs latest
.opencode/scripts/check-versions.sh check --latest  # Plus latest-tracked npm packages
.opencode/scripts/check-versions.sh check --apt     # Plus ubuntu:24.04 base image APT updates
.opencode/scripts/check-versions.sh check --all --snapshot-save  # Full report + save snapshot
.opencode/scripts/check-versions.sh outdated     # Only outdated pins (exit 1 if any)
.opencode/scripts/check-versions.sh json         # Machine-readable JSON
```

`vuln-scan.sh` handles: pagination merging, parallel dismissal (xargs -P 8),
3× retry with backoff, progress tracking, and result verification.
`check-versions.sh` handles: per-ARG upstream lookup (GitHub / npm / GitLab),
graceful per-pin failure (no abort on a single network error), and three output
formats for different consumers.

---

## ⚠️ Critical: `gh api --paginate` Correct Usage

**`--slurp` conflicts with `--jq`.** Do NOT use them together.

### WRONG (broken)
```bash
# --jq processes each page independently → per-page fragments
gh api repos/tryweb/ai-engkit/code-scanning/alerts --paginate --jq 'length'
# → "100\n100\n100..." (per page total, not global total)

# --slurp + --jq → ERROR: not supported together
gh api ... --paginate --slurp --jq '...'
```

### CORRECT (pipe to jq -s for merging)
```bash
gh api repos/tryweb/ai-engkit/code-scanning/alerts --paginate \
  --jq '[.[] | select(.state == "open") | .number]' \
  2>/dev/null | jq -s 'add'
```

The pattern: `--paginate --jq 'FILTER' 2>/dev/null | jq -s 'add'`

---

## gh api Flags vs curl Flags

`gh api` does NOT support `-o` (output file) or `-w` (write-out).
Use these instead:

| `curl` flag | `gh api` equivalent |
|-------------|---------------------|
| `-o file` | redirect stdout: `> file` |
| `-w "%{http_code}"` | `--jq '.state'` (or pipe to `jq`) |
| `-s` / `--silent` | `--silent` (same) |
| `--fail` | use `--jq` + check exit code |

---

## Mode A: Code Scanning Alert Triage

Use when the user wants to review, dismiss false positives, and compile a
high-risk list from GitHub code scanning.

### 1. Query All Open Alerts

```bash
gh api repos/tryweb/ai-engkit/code-scanning/alerts --paginate \
  --jq '[.[] | select(.state == "open") | {number, rule: .rule.id, severity: .rule.security_severity_level, description: .rule.description, path: .most_recent_instance.location.path}]' \
  2>/dev/null | jq -s 'add'
```

For a quick summary by severity:

```bash
gh api repos/tryweb/ai-engkit/code-scanning/alerts --paginate \
  --jq '[.[] | select(.state == "open")] | group_by(.rule.security_severity_level) | map({severity: .[0].rule.security_severity_level, count: length}) | sort_by(.count) | reverse' \
  2>/dev/null | jq -s 'add | .[0]'
```

### 2. Group by Source Path

```bash
.opencode/scripts/vuln-scan.sh list
```

### 3. Identify False Positives

Common high-false-positive categories in this container:

| Package | Reason to Dismiss |
|---------|------------------|
| `xvfb`, `xserver-common`, `libxpm4` | X11 display server libs — headless container, no X server runs |
| `libcups2` | CUPS printing system — no printer in dev container |
| `libelf1` | ELF library — only used at build time |
| `libudev1`, `libsystemd0` | systemd devices/libs — container uses no init system |
| `libpixman-1-0` | pixman — only used by X11/cairo, irrelevant headless |

### 4. Batch Dismissal

**Preferred: use the helper script (handles pagination, retry, parallel):**

```bash
.opencode/scripts/vuln-scan.sh dismiss
```

**Manual single-alert dismissal:**

```bash
gh api -X PATCH repos/tryweb/ai-engkit/code-scanning/alerts/{number} \
  -f state="dismissed" \
  -f dismissed_reason="won't fix" \
  -f dismissed_comment="Not exploitable in headless dev container — $REASON"
```

**Manual batch dismissal (with progress):**

```bash
# 1. Save all open alert numbers
gh api repos/tryweb/ai-engkit/code-scanning/alerts --paginate \
  --jq '[.[] | select(.state == "open") | .number]' \
  2>/dev/null | jq -s 'add' > /tmp/alerts.json

# 2. Dismiss in parallel (xargs -P 8)
jq -r '.[]' /tmp/alerts.json | xargs -P 8 -I {} sh -c '
  gh api -X PATCH "repos/tryweb/ai-engkit/code-scanning/alerts/{}" \
    -f state="dismissed" \
    -f dismissed_reason="won t fix" \
    -f dismissed_comment="Container image scan accepted risk" \
    --silent 2>/dev/null && echo "OK:{}" || echo "FAIL:{}"
'

# 3. Verify
.opencode/scripts/vuln-scan.sh verify
```

### 5. Verify Dismissal

Always verify after any dismissal operation:

```bash
.opencode/scripts/vuln-scan.sh verify
```

Or manually:

```bash
gh api repos/tryweb/ai-engkit/code-scanning/alerts --paginate \
  --jq '[.[] | select(.state == "open") | .number]' \
  2>/dev/null | jq -s 'add | length'
```

Output should be `0`. If not, remaining alerts need individual review.

### 6. Compile High-Risk Report (for remaining alerts)

```bash
gh api repos/tryweb/ai-engkit/code-scanning/alerts --paginate \
  --jq '[.[] | select(.state == "open")] | group_by(.rule.security_severity_level) | map({severity: .[0].rule.security_severity_level, items: [.[] | {number, rule: .rule.id, path: .most_recent_instance.location.path}]}) | sort_by(.severity) | reverse' \
  2>/dev/null | jq -s 'add'
```

Output format:

```
## High-Risk Vulnerability Report

### Critical (N items)
- CVE-XXXX-XXXX — path — severity — ...

### High (N items)
- ...

### Recommended Actions
1. Chrome/Playwright: bump PLAYWRIGHT_VERSION in Dockerfile
2. System packages: `apt-get upgrade` at build time
3. Docker binaries: update DOCKER_VERSION / COMPOSE_VERSION / BUILDX_VERSION
4. ...
```

---

## Mode B: Dockerfile Version Pin Check

Use when the user wants to check if pinned versions in `Dockerfile` are outdated.
**Always prefer the helper script** — it handles the registry lookups, error
recovery, and output formatting in one shot.

### 1. Run the helper script

```bash
.opencode/scripts/check-versions.sh check
```

This walks every `ARG <NAME>=...` in `Dockerfile` and prints a table like:

```
PACKAGE                PINNED       LATEST       SOURCE                           STATUS
-------                ------       ------       ------                           ------
DOCKER_VERSION         29.6.0       29.6.0       github:docker/docker             OK current
COMPOSE_VERSION        5.1.4        5.1.4        github:docker/compose            OK current
...
```

For machine consumption (e.g. CI), use `json`. For "is anything outdated?"
checks, use `outdated` (exit 1 if anything needs bumping).

### 2. Sources (kept in sync with the script)

| ARG | Source | Registry |
|-----|--------|----------|
| `DOCKER_VERSION` | github:docker/docker | `gh release view` (strip `docker-` + `v` prefix) |
| `COMPOSE_VERSION` | github:docker/compose | `gh release view` |
| `BUILDX_VERSION` | github:docker/buildx | `gh release view` |
| `GH_VERSION` | github:cli/cli | `gh release view` |
| `MARKSMAN_VERSION` | github:artempyanykh/marksman | `gh release view` (date-based) |
| `OPENCODE_VERSION` | npm:opencode-ai | `https://registry.npmjs.org/opencode-ai/latest` |
| `OPENCHAMBER_VERSION` | npm:@openchamber/web | `https://registry.npmjs.org/@openchamber/web/latest` |
| `PLAYWRIGHT_VERSION` | npm:playwright | `https://registry.npmjs.org/playwright/latest` |
| `PLAYWRIGHT_MCP_VERSION` | npm:@playwright/mcp | `https://registry.npmjs.org/@playwright/mcp/latest` |
| `GLAB_VERSION` | gitlab:gitlab-org/cli | `https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/releases/permalink/latest` |
| `LEANCTX_VERSION` | github:yvgude/lean-ctx | `gh release view --repo yvgude/lean-ctx --json tagName --jq .tagName` (strip `v` prefix) |

### 3. Manual lookup (when the script can't reach a source)

If a source returns `check_failed` because the network is blocked or the
script doesn't have the right tool installed, you can query directly. **Do not
guess endpoints** — use the documented APIs above.

```bash
# GitHub release (any repo)
gh release view --repo <org>/<repo> --json tagName --jq '.tagName'

# npm package
curl -fsSL "https://registry.npmjs.org/<package>/latest" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])'

# GitLab release (URL-encode the project path)
curl -fsSL "https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/releases/permalink/latest" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"])'
```

> **Why the URL-encoded form?** GitLab's REST API uses `path%2Fsubpath` (the
> slash encoded as `%2F`) when referring to a project by its full path.
> `https://gitlab.com/api/v4/projects/gitlab-org/cli` (unescaped) returns 404.

### 4. Apply Updates

For each version that needs updating, edit `Dockerfile`:

```bash
sed -i 's/^ARG DOCKER_VERSION=.*$/ARG DOCKER_VERSION=NEW_VERSION/' Dockerfile
sed -i 's/^ARG COMPOSE_VERSION=.*$/ARG COMPOSE_VERSION=NEW_VERSION/' Dockerfile
sed -i 's/^ARG BUILDX_VERSION=.*$/ARG BUILDX_VERSION=NEW_VERSION/' Dockerfile
```

**Do NOT update OPENCODE_VERSION or OPENCHAMBER_VERSION** unless the user
explicitly requests it — they follow a different release cadence and may have
use-specific version requirements.

### 5. Rebuild (Optional, ask user)

```bash
docker compose -f docker-compose.dev.yml build ai-dev
```

Verify after build:

```bash
docker run --rm ai-engkit-dev docker --version
docker run --rm ai-engkit-dev docker compose version
docker run --rm ai-engkit-dev docker buildx version
```

---

## Error Handling Guide

### "gh: This API operation needs the ... scope"
- **Cause**: `gh` token lacks sufficient permissions.
- **Fix**: Re-authenticate with `gh auth refresh -h github.com -s admin:repo_hook`
  or use a PAT with `repo` and `security_events` scopes.

### "Alert is already dismissed" (HTTP 400)
- **Cause**: Alert was already closed in a previous run.
- **Fix**: No action needed — skip. The script classifies these as SKIP.

### Rate limiting (HTTP 403 / 429)
- **Cause**: Too many API calls too fast.
- **Fix**: Reduce VULN_PARALLEL or increase delay between calls.
  The script retries 3× with exponential backoff.

### Empty results / wrong counts
- **Cause**: Missing `jq -s 'add'` pipe — each page processed separately.
- **Fix**: Always pipe through `jq -s 'add'` after `--paginate --jq`.

### "the --slurp option is not supported with --jq"
- **Cause**: `gh` CLI doesn't allow combining `--slurp` and `--jq`.
- **Fix**: Drop `--slurp` and use `2>/dev/null | jq -s 'add'` instead.

### check-versions.sh reports `? check_failed` for some pins
- **Cause**: A network call failed for that pin (GitHub / npm / GitLab).
  Possible reasons: rate limit, no network, missing `gh` auth, or the registry
  endpoint is down.
- **Fix**: Re-run after fixing connectivity. The script is designed to keep
  going past per-pin failures — only the failed pin is marked `check_failed`;
  the others report normally. If the failure is a wrong API endpoint (e.g.
  GitLab 404), see "GitLab `gitlab-org/cli` returns 404" below.

### GitLab `gitlab-org/cli` returns 404
- **Cause**: The project path must be URL-encoded — `gitlab-org/cli` becomes
  `gitlab-org%2Fcli` in the API URL. An unencoded slash is treated as part of
  the URL path, not a separator.
- **Fix**: Use `https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/releases/permalink/latest`.
  Do **not** guess the project ID — the canonical project path is
  `gitlab-org/cli` (verified via `https://gitlab.com/api/v4/projects/gitlab-org%2Fcli` → `id: 34675721`).

### `check-versions.sh outdated` always exits 1 even when nothing is outdated
- **Cause**: An older version of the script had a final `[[ ... ]]` test whose
  exit code leaked. Fixed by an explicit `exit 0` / `exit 1` branch.
- **Fix**: Use the latest version of the script — exit 0 means "no outdated
  pins", exit 1 means "at least one outdated".

---

## Rules

- Never change OPENCODE_VERSION or OPENCHAMBER_VERSION without explicit user request
- Always ask before dismissing alerts — show the list of proposed dismissals first
- Always verify version updates by reading the updated file after edit
- Never rebuild without asking (Mode A doesn't need build; Mode B asks in step 5)
- For Mode A: only dismiss alerts in the "won't fix" category above; leave all others open
- If `gh` is not authenticated, stop and ask user to run `gh auth login` first
- **Always pipe through `jq -s 'add'` after `--paginate --jq`** — never use `--slurp`
