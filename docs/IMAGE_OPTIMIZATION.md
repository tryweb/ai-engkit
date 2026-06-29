# Image Optimization & Multi-Container Architecture Analysis

> **Status**: Draft / RFC
> **Date**: 2026-06-29
> **Context**: Analysis of the current 3.64 GB Docker image, waste identification, and paths toward a leaner architecture.
> **Principle**: Every bundled tool must justify its weight against the alternative of on-demand install. The goal is to preserve the "batteries-included" developer experience while eliminating true bloat.

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

Verified by running the live container:

```
256M  @code-yeongyu/             ← comment-checker (Claude Code hook)
193M  @colbymchenry/             ← codegraph
160M  opencode-linux-x64-baseline
160M  opencode-ai                ← actual runtime package (the one we need)
157M  opencode-linux-x64-musl
157M  opencode-linux-x64-baseline-musl   ← 3 extra platform binaries, only 1 needed
 40M  @openchamber/web
```

**Key finding**: `opencode-ai`'s optional dependencies ship binaries for **4 platforms** (baseline, musl, baseline-musl, plus the main `opencode-ai`). The container runs on `linux/amd64` with glibc — the other three platform stubs will **never** execute. This wastes **~474 MB** of truly unreachable data.

---

## 2. Single-Container Slimming (Phase 1)

Each candidate evaluated against two criteria:
- **Size saved**: how much the image shrinks
- **Availability impact**: what the user loses if we remove it from the baked image

### 2.1 Quick Wins (Low Risk, High Return)

| # | Change | Est. Savings | Risk | Availability Impact |
|---|--------|-------------|------|-------------------|
| 1 | **Remove cross-platform opencode binaries** | **~474 MB** | Low | **None.** These are optional-dependency stubs for other platforms that cannot run in this container. The working `opencode` binary stays. |
| 2 | **Make comment-checker opt-in** (via `BUN_PACKAGES`) | **~256 MB** | Low | Users who need it add `BUN_PACKAGES=@code-yeongyu/comment-checker` to `.env`. Previously baked → now on-demand. |
| 3 | **Lazy-install Homebrew** (only when `BREW_PACKAGES` is set) | **~199 MB** | Low | `BREW_PACKAGES` still works exactly as before — first use triggers Homebrew install in `01-install-packages.sh`. No config change needed. |
| 4 | **Disable `apt-get upgrade` by default** (`UPGRADE_PACKAGES=false`) | 50–150 MB | Low | Smaller layer cache, faster builds. Security patches through base image tag pinning instead. |
| | **Subtotal (1+2+3+4)** | **~1.0–1.1 GB** | | **Target image: ~2.5–2.6 GB** |

### 2.2 Additional Savings (Lower ROI)

| Change | Est. Savings | Risk | Rationale |
|--------|-------------|------|-----------|
| Remove `build-essential` (install on demand via `APT_PACKAGES`) | 100–150 MB | Low | Only needed during `bun install` of native addons; not a daily tool |
| Remove editors (nano/vim), htop, tree | 20–30 MB | Low | Each is <10 MB; savings modest. Editors are commonly used during dev. |
| Selective Playwright system deps instead of `--with-deps` | 100–200 MB | Med | Hand-pick apt packages. Risk of missing a dep and breaking Playwright. |

### 2.3 Blocked (Not Actionable)

| Attempt | Why Blocked |
|---------|-------------|
| Playwright headless-shell only | Previously tried and reverted. `@playwright/mcp` expects the full Chromium binary, not the headless shell. Blocked upstream. |
| Distroless/minimal base image | Would break Homebrew, `pw-mcp`, Playwright system deps, and most CLI tools. |

---

## 3. Multi-Container Architecture (Phase 2)

### 3.1 Scenario A: Split OpenChamber UI (Recommended)

```
Container 1: ai-engine (OpenCode + tools + MCP + Docker socket)
  - opencode-ai, codegraph, lean-ctx, git, python, docker CLI, gh/glab
  - ~2.2 GB (post-Phase-1)
  - Runs: opencode serve

Container 2: ai-ui (OpenChamber only)
  - bun + @openchamber/web (~200 MB base + 40 MB pkg)
  - ~400 MB
  - Runs: openchamber serve (with OPENCODE_HOST / OPENCODE_SKIP_START)
  - Port 3000 → host

Network: Docker bridge network, ai-ui → ai-engine:4095
```

**Feasibility**: ✅ **High** — OpenChamber v1.13.8+ supports `OPENCODE_HOST` / `OPENCODE_SKIP_START`  
**Total image size**: ~2.6 GB (but each container pulled independently)  
**Prerequisite**: Bump `OPENCHAMBER_VERSION` from `1.13.7` to `≥1.13.8`  
**CI/CD**: Medium — multi-target Dockerfile or two Dockerfiles, separate build & push  
**UX impact**: None — still `docker compose up -d`

### 3.2 Scenario B: Split Playwright/Chromium (Not Recommended)

**Feasibility**: ⚠️ **Low-Medium** — MCP uses local stdio; needs HTTP/SSE transport + shared volume for screenshots + startup ordering.  
**ROI**: Poor — complexity far outweighs benefit.

### 3.3 Scenario C: Split CodeGraph as Sidecar (Not Recommended)

CodeGraph's `codegraph serve --mcp` only supports local stdio. No HTTP/SSE endpoint.  
**ROI**: Very poor — CodeGraph is 193 MB and tightly coupled to the agent's filesystem.

---

## 4. Recommended Roadmap

### Phase 1: Single-Container Slimming (Short effort, ~1 GB savings)

```
1. Remove cross-platform opencode binary stubs  → -474 MB  (pure waste)
2. Make comment-checker opt-in (BUN_PACKAGES)   → -256 MB  (availability preserved)
3. Lazy-install Homebrew on BREW_PACKAGES usage  → -199 MB  (BREW_PACKAGES still works)
4. UPGRADE_PACKAGES=false by default             → -100 MB
  ─────────────────────────────────────────────────────
  Total: ~1.0 GB, image: 3.64 GB → ~2.6 GB
```

**Side effects to handle if implemented:**
- **comment-checker removal**: Also update `test/run-tests.sh` (3 assertions), `README.md`, and `docs/TOOLING.md`
- **Homebrew lazy install**: Modify `entrypoint.d/01-install-packages.sh` to install brew on first `BREW_PACKAGES` usage

### Phase 2: Multi-Container (Conditional — Scenario A)

Only pursue if:
- Users frequently update UI independently of engine
- Users want headless engine without Web UI
- The image size is causing real CI/CD or pull-time issues

### Verification criteria

For Phase 1, success is measured by:
- `docker images` shows the new tag at ~2.6 GB (vs 3.64 GB)
- `docker run` → `opcode --version` still works (binary not broken)
- `docker run` → `bun --version` + `git --version` + `gh --version` still work
- `docker run` → `comment-checker --help` → fails (expect: opt-in, not baked)
- `test/run-tests.sh` passes after test updates
- `BREW_PACKAGES=htop docker compose up -d` → htop is available inside container
