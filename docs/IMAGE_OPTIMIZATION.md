# Image Optimization & Multi-Container Architecture Analysis

> **Status**: Draft / RFC
> **Date**: 2026-06-29
> **Context**: Analysis of the current 3.64 GB Docker image, waste identification, and paths toward a leaner architecture.
> **Principle**: ai-engkit intentionally provides a batteries-included AI development environment. Tool removals must preserve that experience; pure waste is different from useful tooling that happens to be large.

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

## 2. Single-Container Slimming

Each candidate is classified by whether it is pure waste, useful-but-large tooling, a security policy tradeoff, or currently blocked.

### 2.1 Recommended Quick Win

| # | Change | Est. Savings | Risk | Availability Impact |
|---|--------|-------------|------|---------------------|
| 1 | **Remove cross-platform opencode binaries** | **~474 MB** | Low | **None.** These optional-dependency stubs target other platform variants and cannot run in this Ubuntu glibc container. The working `opencode` binary stays. |

This is the only currently recommended Phase 1 size reduction because it removes unreachable bytes without reducing the baked toolset.

### 2.2 Useful Tooling: Keep Baked Unless Usage Data Says Otherwise

| Candidate | Size | Review Result | Reason |
|-----------|------|---------------|--------|
| `@code-yeongyu/comment-checker` | ~256 MB | **Keep for now / discuss separately** | It is a Claude Code hook and may be part of the expected AI-development workflow. Making it opt-in saves space, but turns a currently guaranteed tool into a startup-time install. If removed, update `test/run-tests.sh`, `README.md`, and `docs/TOOLING.md`. |
| Homebrew framework | ~199 MB | **Keep baked** | `BREW_PACKAGES` depends on it. Lazy install would survive `docker compose restart` only if already installed in the same container writable layer, but `docker compose down && up`, upgrades, and new containers would reinstall it. That first-use latency is worse UX than the 199 MB image cost. |
| Editors / htop / tree | ~20–30 MB | **Keep baked** | Small savings; these tools reduce friction during AI-assisted debugging. |

### 2.3 Security Policy: Do Not Treat `apt-get upgrade` as Waste

`ARG UPGRADE_PACKAGES=true` currently runs `apt-get upgrade` during the Docker build. CI also explicitly passes `UPGRADE_PACKAGES=true`, so published images remain fully upgraded even if the Dockerfile default changes.

Changing the default to `false` would mainly affect local builds, not release images. However, this is still a security-margin decision, not image bloat. The conservative recommendation is:

- keep `UPGRADE_PACKAGES=true` as the default;
- document that local developers may pass `--build-arg UPGRADE_PACKAGES=false` when they intentionally prefer faster/smaller local builds;
- keep CI/release builds on `UPGRADE_PACKAGES=true`.

### 2.4 Blocked or Low-ROI Options

| Attempt | Why Not Recommended |
|---------|---------------------|
| Playwright headless-shell only | Previously tried and reverted. `@playwright/mcp` expects the full Chromium binary, not only the headless shell. Blocked upstream. |
| Selective Playwright system deps instead of `--with-deps` | Could save space but risks missing runtime libraries and breaking browser automation. |
| Remove `build-essential` | Saves space, but native addon installs and emergency troubleshooting often depend on compiler tooling. Needs usage data first. |
| Distroless/minimal base image | Conflicts with the product goal: a broad AI development toolkit with shell, package managers, Playwright, and Docker tooling. |

---

## 3. Multi-Container Architecture (Phase 2)

### 3.1 Scenario A: Split OpenChamber UI (Recommended for Discussion)

```
Container 1: ai-engine (OpenCode + tools + MCP + Docker socket)
  - opencode-ai, codegraph, lean-ctx, git, python, docker CLI, gh/glab
  - keeps the batteries-included toolchain
  - runs: opencode serve

Container 2: ai-ui (OpenChamber only)
  - bun + @openchamber/web (~200 MB base + 40 MB pkg)
  - runs: openchamber serve (with OPENCODE_HOST / OPENCODE_SKIP_START)
  - port 3000 → host

Network: Docker bridge network, ai-ui → ai-engine:4095
```

**Feasibility**: ✅ **High** — OpenChamber v1.13.8+ supports `OPENCODE_HOST` / `OPENCODE_SKIP_START`  
**Prerequisite**: Bump `OPENCHAMBER_VERSION` from `1.13.7` to `≥1.13.8`  
**CI/CD**: Medium — multi-target Dockerfile or two Dockerfiles, separate build & push  
**UX impact**: Should remain `docker compose up -d`  
**Primary benefit**: independent UI/engine updates, not dramatic total byte reduction

### 3.2 Scenario B: Split Playwright/Chromium (Not Recommended)

**Feasibility**: ⚠️ **Low-Medium** — MCP uses local stdio; this would require HTTP/SSE transport, shared screenshot/upload paths, and startup ordering.  
**ROI**: Poor — complexity outweighs benefit.

### 3.3 Scenario C: Split CodeGraph as Sidecar (Not Recommended)

CodeGraph's `codegraph serve --mcp` only supports local stdio. No HTTP/SSE endpoint.  
**ROI**: Poor — CodeGraph is 193 MB and tightly coupled to the agent filesystem.

---

## 4. Recommended Roadmap

### Phase 1: Remove Pure Waste Only

```
1. Remove cross-platform opencode binary stubs  → -474 MB
─────────────────────────────────────────────────────
Expected image: 3.64 GB → ~3.1 GB
```

This is the only surgical change that clearly preserves the current user experience.

### Phase 2: Decide Product Policy, Not Just Size

Discuss these as product decisions before implementation:

- Should `comment-checker` remain part of the guaranteed AI toolchain despite its 256 MB footprint?
- Is Homebrew's 199 MB cost acceptable to keep `BREW_PACKAGES` fast and reliable?
- Should local builds expose an easy `UPGRADE_PACKAGES=false` path while release builds stay upgraded?
- Is splitting OpenChamber UI valuable for independent updates, even if total bytes do not drop much?

### Verification Criteria for Phase 1

Success is measured by:

- `docker images` shows the new tag at ~3.1 GB (vs 3.64 GB);
- `docker run` → `opencode --version` still works;
- `docker run` → `bun --version`, `git --version`, `gh --version`, `brew --version`, and `comment-checker --help` still work;
- `test/run-tests.sh` passes without removing existing tool-availability assertions;
- vulnerability scan results do not regress.
