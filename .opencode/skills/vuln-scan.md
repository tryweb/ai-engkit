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

## Mode A: Code Scanning Alert Triage

Use when the user wants to review, dismiss false positives, and compile a high-risk list from GitHub code scanning.

### 1. Query All Open Alerts

```bash
gh api repos/tryweb/Codeforge/code-scanning/alerts --paginate --jq '.[] | {number, rule: .rule.id, severity: .rule.security_severity_level, description: .rule.description, package: (.most_recent_instance.message.text | capture("(?<pkg>[^ ]+)"))}'
```

For a quick summary by severity and package category:

```bash
gh api repos/tryweb/Codeforge/code-scanning/alerts --paginate --jq 'group_by(.rule.security_severity_level) | map({severity: .[0].rule.security_severity_level, count: length}) | sort_by(.count) | reverse'
```

### 2. Categorize by Source

Group results into categories by examining the rule ID or message text:
- **Chrome/Playwright**: CVEs in Chromium browsers (Playwright)
- **System packages**: CVEs in apt-installed libs (glibc, openssl, zlib, libcups, libxpm, etc.)
- **Docker binaries**: CVEs in docker/compose/buildx binaries
- **Homebrew**: CVEs from brew-installed tools (gh, glab)
- **Python/pip**: CVEs in Python packages

### 3. Identify False Positives

Common high-false-positive categories in this container:

| Package | Reason to Dismiss |
|---------|------------------|
| `xvfb`, `xserver-common`, `libxpm4` | X11 display server libs — headless container, no X server runs |
| `libcups2` | CUPS printing system — no printer in dev container |
| `libelf1` | ELF library — only used at build time |
| `libudev1`, `libsystemd0` | systemd device/libs — container uses no init system |
| `libpixman-1-0` | pixman — only used by X11/cairo, irrelevant headless |

Dismiss with:

```bash
gh api -X PATCH repos/tryweb/Codeforge/code-scanning/alerts/{number} \
  -f state="dismissed" \
  -f dismissed_reason="won't fix" \
  -f dismissed_comment="Not exploitable in headless dev container — $REASON"
```

### 4. Compile High-Risk Report

For remaining alerts, produce a prioritized summary:

```
## High-Risk Vulnerability Report

### Critical (N items)
- CVE-XXXX-XXXX — pkg — severity — description

### High (N items)
- ...

### Recommended Actions
1. Chrome/Playwright: `bunx playwright install chromium` in container
2. System packages: `apt-get upgrade` in Dockerfile
3. Docker binaries: update DOCKER_VERSION in Dockerfile
4. ...
```

### 5. Categorize by Severity for Report

```bash
gh api repos/tryweb/Codeforge/code-scanning/alerts --paginate \
  --jq '[.[] | select(.state == "open")] | group_by(.rule.security_severity_level) | map({severity: .[0].rule.security_severity_level, items: [.[] | {number, rule: .rule.id, description: .rule.description}]}) | sort_by(.severity) | reverse'
```

---

## Mode B: Dockerfile Version Pin Check

Use when the user wants to check if pinned versions in `Dockerfile` are outdated.

### 1. Extract Current Pins

From `Dockerfile` (ARG lines ~5-9):

| ARG | Purpose | Source URL |
|-----|---------|-----------|
| `DOCKER_VERSION` | Docker CLI static binary | https://github.com/docker/docker/releases |
| `COMPOSE_VERSION` | Docker Compose plugin | https://github.com/docker/compose/releases |
| `BUILDX_VERSION` | Docker Buildx plugin | https://github.com/docker/buildx/releases |
| `OPENCODE_VERSION` | npm: opencode-ai | https://www.npmjs.com/package/opencode-ai |
| `OPENCHAMBER_VERSION` | npm: @openchamber/web | https://www.npmjs.com/package/@openchamber/web |

### 2. Check Latest Versions

**Docker CLI:**
```bash
# Get latest stable from GitHub releases (exclude rc/beta/alpha)
gh release list --repo docker/docker --limit 5 --json tagName,isLatest
```

**Compose:**
```bash
gh release list --repo docker/compose --limit 5 --json tagName,isLatest
```

**Buildx:**
```bash
gh release list --repo docker/buildx --limit 5 --json tagName,isLatest
```

**OpenCode (npm):**
```bash
# Or: npm view opencode-ai version
npm view opencode-ai versions --json | jq -r 'last'
```

**OpenChamber (npm):**
```bash
npm view @openchamber/web versions --json | jq -r 'last'
```

### 3. Compare & Report

Format output as a table:

```
| Package | Pinned | Latest | Needs Update? |
|---------|--------|--------|---------------|
| DOCKER  | X.Y.Z  | A.B.C  | ✅ / ⬆️ → A.B.C |
| COMPOSE | X.Y.Z  | A.B.C  | ✅ / ⬆️ → A.B.C |
| BUILDX  | X.Y.Z  | A.B.C  | ✅ / ⬆️ → A.B.C |
| OPENCODE | X.Y.Z | A.B.C  | ✅ / ⬆️ → A.B.C |
| OPENCHAMBER | X.Y.Z | A.B.C | ✅ / ⬆️ → A.B.C |
```

For each outdated pin, show the diff command:

```bash
gh release view v{VERSION} --repo docker/{repo} --json body --jq '.body' | head -20
```

### 4. Apply Updates

For each version that needs updating, edit `Dockerfile`:

```bash
sed -i 's/^ARG DOCKER_VERSION=.*$/ARG DOCKER_VERSION=NEW_VERSION/' Dockerfile
sed -i 's/^ARG COMPOSE_VERSION=.*$/ARG COMPOSE_VERSION=NEW_VERSION/' Dockerfile
sed -i 's/^ARG BUILDX_VERSION=.*$/ARG BUILDX_VERSION=NEW_VERSION/' Dockerfile
```

**Do NOT update OPENCODE_VERSION or OPENCHAMBER_VERSION** unless the user explicitly requests it — they follow a different release cadence and may have use-specific version requirements.

### 5. Rebuild (Optional, ask user)

```bash
docker compose -f docker-compose.dev.yml build ai-dev
```

Verify after build:

```bash
docker run --rm codeforge-ai-dev docker --version
docker run --rm codeforge-ai-dev docker compose version
docker run --rm codeforge-ai-dev docker buildx version
```

---

## Rules

- Never change OPENCODE_VERSION or OPENCHAMBER_VERSION without explicit user request
- Always ask before dismissing alerts — show the list of proposed dismissals first
- Always verify version updates by reading the updated file after edit
- Never rebuild without asking (Mode A doesn't need build; Mode B asks in step 5)
- For Mode A: only dismiss alerts in the "won't fix" category above; leave all others open
- If `gh` is not authenticated, stop and ask user to run `gh auth login` first
