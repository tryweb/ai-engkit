# Image Optimization & Multi-Container Architecture Analysis

> **Status**: Draft / RFC
> **Date**: 2026-06-29
> **Context**: Analysis of the current 3.64 GB Docker image, waste identification, and paths toward a leaner architecture.

---

## 1. Current Image Size Breakdown

Measured via `docker history` + per-layer `du` inspection of the ai-dev image:

| Rank | Component | Size | % | Notes |
|------|-----------|------|----|-------|
| 1 | **Bun npm packages** | 1.13 GB | 31% | opencode-ai + @openchamber/web + openspec + codegraph + all transitives |
| 2 | **Playwright Chromium** | 1.1 GB | 30% | Full Chromium (379 MB) + headless shell (262 MB) + ffmpeg + system deps via `--with-deps` |
| 3 | **APT system packages** | ~550 MB | 15% | python3, build-essential, git, vim, tmux, htop, etc. + `apt-get upgrade` |
| 4 | **Homebrew (empty Cellar)** | 199 MB | 5% | Only the framework; no formulae installed at build time |
| 5 | **Docker CLI + compose + buildx** | 135 MB | 4% | Static binaries |
| 6 | **gh + glab + marksman** | 110 MB | 3% | Static binaries |
| 7 | **Bun runtime** | 93 MB | 3% | `curl https://bun.sh/install` |
| 8 | **lean-ctx** | 74 MB | 2% | |
| 9 | Config / baked-scripts / superpowers | <5 MB | <1% | |
| **Total** | | **~3.64 GB** | 100% | |

### 1.1 Hidden Waste Inside the npm Layer

```
256M  @code-yeongyu/             ← comment-checker (a small CLI tool!)
193M  @colbymchenry/             ← codegraph
160M  opencode-linux-x64-baseline
157M  opencode-ai
157M  opencode-linux-x64-musl
157M  opencode-linux-x64-baseline-musl   ← 4 platform binaries, only 1 needed
 40M  @openchamber/web
```

**Key finding**: `opencode-ai` ships binaries for **4 platforms** (baseline, musl, baseline-musl, plus the main binary), but only one is ever used at runtime. This wastes ~470 MB.

---

## 2. Single-Container Slimming (Phase 1)

Quick wins that reduce image size without changing architecture.

### 2.1 Quick Wins

| Change | Est. Savings | Risk | Effort |
|--------|-------------|------|--------|
| Remove cross-platform opencode binaries | **~470 MB** | Low | Delete extra bins post-install or use `--no-optional` |
| Remove comment-checker (`@code-yeongyu`) | **~256 MB** | Low | Remove from `Dockerfile` line 161 |
| Remove Homebrew framework | **~199 MB** | Low–Med | Remove install from Dockerfile; document `BREW_PACKAGES` limitation |
| Playwright: headless shell only | **~379 MB** | Med | Need to verify `@playwright/mcp` + `pw-mcp` work with headless shell; previous attempt failed |
| **Subtotal** | **~1.3 GB saved** | | **Image → ~2.3 GB** |

### 2.2 Additional Savings

| Change | Est. Savings | Risk | Effort |
|--------|-------------|------|--------|
| Disable `apt-get upgrade` (default `UPGRADE_PACKAGES=false`) | 50–150 MB | Low | Tweak default env var |
| Remove `build-essential` from base image (install on demand) | 100–150 MB | Low | Move to `APT_PACKAGES` dynamic install |
| Remove editors (nano/vim), htop, tree | 20–30 MB | Low | Available via `APT_PACKAGES` |
| Selective Playwright system deps instead of `--with-deps` | 100–200 MB | Med | Hand-pick apt packages |

---

## 3. Multi-Container Architecture (Phase 2)

### 3.1 Scenario A: Split OpenChamber UI (Recommended)

```
Container 1: ai-engine (OpenCode + tools + MCP + Docker socket)
  - opencode-ai, codegraph, lean-ctx, git, python, docker CLI, gh/glab
  - ~2.4 GB (minus @openchamber/web, Homebrew)
  - Runs: opencode serve

Container 2: ai-ui (OpenChamber only)
  - bun + @openchamber/web (~200 MB base + 40 MB pkg)
  - ~400 MB
  - Runs: openchamber serve (with OPENCODE_HOST / OPENCODE_SKIP_START)
  - Port 3000 → host

Network: Docker bridge network, ai-ui → ai-engine:4095
```

**Feasibility**: ✅ **High** — OpenChamber v1.13.8+ supports `OPENCODE_HOST` / `OPENCODE_SKIP_START`  
**Total image size**: ~2.8 GB (but each container can be pulled independently)  
**Prerequisite**: Bump `OPENCHAMBER_VERSION` to ≥1.13.8  
**CI/CD**: Medium — multi-target Dockerfile or two Dockerfiles, separate build & push  
**UX impact**: None — still `docker compose up -d`

### 3.2 Scenario B: Split Playwright/Chromium (Not Recommended)

Splitting the 1.1 GB Chromium + Playwright stack into a separate `ai-browser` container.  
**Feasibility**: ⚠️ **Low-Medium** — MCP currently uses local stdio; would need HTTP/SSE transport, shared volume for screenshots, and startup ordering.

**ROI**: Poor — complexity far outweighs benefit unless browser automation is an optional, rarely-used feature.

### 3.3 Scenario C: Split CodeGraph as Sidecar (Not Recommended)

CodeGraph's `codegraph serve --mcp` only supports local stdio — no HTTP/SSE endpoint.  

**ROI**: Very poor — CodeGraph is only 193 MB and tightly coupled to the agent's file system.

---

## 4. Recommended Roadmap

### Phase 1 (Short effort, high return)
```
1. Remove cross-platform opencode binary bloat   → -470 MB
2. Remove comment-checker                         → -256 MB
3. Remove Homebrew                                → -199 MB
4. UPGRADE_PACKAGES=false by default              → -100 MB
  ─────────────────────────────────────────────────────
  Total: ~1 GB, image → ~2.6 GB
```

### Phase 2 (Medium effort, conditional)
Only pursue Scenario A (split UI) if:
- Users frequently update UI independently of engine
- Users want headless engine without Web UI
- The 3.64 GB pull size is causing real issues

### Not recommended
- Playwright headless-shell only — previously tried and failed, blocked upstream
- Scenario B/C (multi-container for browser/CodeGraph) — ROI too low
- Distroless/minimal base image — would break brew, playwright deps, etc.
