# Tooling Guide

This document summarizes the tools that ship with AI-EngKit and where to extend them.

## Overview

AI-EngKit combines four layers of tooling in one container:

1. **AI workspace** — OpenCode, OpenChamber, OpenSpec, plugins, and baked skills
2. **MCP integrations** — CodeGraph, lean-ctx, Playwright, and the LSP bridge
3. **Developer CLI stack** — git, `gh`, `glab`, Docker CLI, Compose, Buildx, bun, Python, and shell tools
4. **Runtime extension points** — extra apt, Homebrew, and bun packages installed at container startup

## Built-in MCP Servers

AI-EngKit preconfigures these MCP servers for OpenCode:

| Tool | Purpose | Notes |
|------|---------|-------|
| **CodeGraph** | Code graph, symbol relationships, dependency analysis | Installed as `@colbymchenry/codegraph` |
| **lean-ctx** | Context-aware read/search/shell workflows | Includes persistent state and knowledge volumes |
| **Playwright** | Browser automation and UI testing | Playwright-bundled Chromium; `pw-mcp` wrapper resolves the executable path and launches `@playwright/mcp` with `--executable-path --no-sandbox --headless` |
| **LSP** (`mcp.lsp`) | Language-server tools over MCP: `diagnostics`, `goto_definition`, `find_references`, `symbols`, `prepare_rename`, `rename`, `status`, `install_decision` | Restored OMO LSP bridge, vendored from `@code-yeongyu/lsp-daemon@0.1.0` at `/opt/ai-engkit/vendor/lsp-daemon` (not published to npm). Separate from the native OpenCode `lsp` block |

Related files:

- `Dockerfile`
- `entrypoint.d/02-init-config.sh`
- `vendor/omo-lsp-daemon/README.md`
- `docs/knowledge/tooling/lean-ctx-xdg-layout.md`

### Native websearch (Exa)

OpenCode's built-in `websearch` tool is **native**, not an MCP server. It is
enabled by the `OPENCODE_ENABLE_EXA` environment variable (passed through
`.env`) and granted by `permission.websearch: "allow"` in the generated
`opencode.json`. `EXA_API_KEY` is optional and selects an authenticated Exa
account.

## Authority and Routing

CodeGraph is authoritative for indexed source, symbols, dependencies, and source/flow tracing. For correctness-sensitive source work, use native anchored reads and edits, direct LSP diagnostics, direct tests/builds, and direct git commands. These native surfaces are the authority for claims about diagnostics, tests, git, and writes.

lean-ctx remains available for memory and knowledge persistence (`ctx_knowledge`, `ctx_session`) and for non-authoritative exploration (`ctx_read`, `ctx_shell`). Raw hatches such as `LEAN_CTX_RAW=1` and `LEAN_CTX_DISABLED=1` are not guaranteed under daemon or configuration drift and do not establish correctness. MCP registration, permission inheritance, path jail, and memory/knowledge persistence remain unchanged.

The task-7 G0 verdict is immutably `disable-routing` because the required campaign stopped before execution (`campaignExecuted=false`, `campaignCommandCount=0`). This repository therefore has no runtime routing toggle: generated guidance is the routing state, and automatic Read, Search, and Shell routing is absent/disabled. Re-enable requires a new isolated passing G0-G4 evaluation followed by an explicit repository guidance decision; drift reports remain report-only and never re-enable routing.

The one-time migration changes only an eligible `lite`, `standard`, or `max` runtime compression value. It first writes `${LEANCTX_RUNTIME_CONFIG}.pre-migration-v1`, then writes `off` and `${LEANCTX_RUNTIME_CONFIG}.migration-v1`. To roll back in a disposable environment, restore that versioned backup and keep the marker so startup does not silently migrate it again; Apply and restart remain explicit administrator actions. Removing the marker is an intentional migration re-run, not a routing re-enable.

Use only a disposable runtime configuration when rehearsing rollback:

```bash
CONFIG=/tmp/opencode/lean-ctx-rollback/config.toml
cp -- "${CONFIG}.pre-migration-v1" "$CONFIG"
test -f "${CONFIG}.migration-v1"
```

Re-enable has no direct toggle. A candidate must first pass the checked-in live gates and isolated campaign, then receive an explicit repository-guidance decision:

```bash
OUT="$PWD/.omo/evidence/lean-ctx-reliability-gate/re-enable-candidate"
./test/leanctx-reliability-gate.sh --gates
./test/leanctx-reliability-gate.sh --campaign --execute-campaign --out-dir "$OUT"
```

These commands do not themselves re-enable routing. Review `$OUT/verdict.json`; routing remains disabled unless the deterministic verdict is `retain` and repository guidance is deliberately updated.

See `.opencode/AGENTS.md.default` for the generated user guidance and `docs/knowledge/tooling/lean-ctx-shell-silent-write-drop.md` for the verified silent-write failure boundary.

## Built-in Developer CLI Tools

### Source control and repo workflows

- `git`
- `gh`
- `glab`
- `openssh-client`

See [GIT_AUTHENTICATION.md](./GIT_AUTHENTICATION.md) for auth setup and credential volumes.

### Container and build workflows

- Docker CLI
- `docker compose`
- Docker Buildx
- `build-essential`
- `pkg-config`
- `libssl-dev`
- `libclang-dev`

AI-EngKit is designed for Docker socket passthrough, so containerized workflows can still call Docker from inside the workspace.

### General development utilities

- bun
- Homebrew
- Python 3 + `pip` + `venv`
- `ripgrep`, `jq`, `tree`, `tmux`, `rsync`, `curl`, `wget`
- `vim`, `nano`, `less`, `htop`, `lsof`
- `comment-checker`

## OpenCode Plugins and Skills

Default plugin setup:

- `oh-my-opencode-slim`
- `superpowers@git+https://github.com/obra/superpowers.git`

AI-EngKit also bakes in project-visible skills such as:

- `karpathy-guidelines`
- `knowledge-capture`
- `enable-project-knowledge`
- `enable-finalize-maintenance`

Related files:

- `.env.example`
- `.opencode/baked-skills/`
- `entrypoint.d/02-init-config.sh`

## Runtime Extension Points

You can add extra packages at container startup with environment variables:

| Variable | Installs | Example |
|----------|----------|---------|
| `APT_PACKAGES` | apt packages | `APT_PACKAGES="fd-find bat"` |
| `BREW_PACKAGES` | Homebrew packages | `BREW_PACKAGES="fd bat"` |
| `BUN_PACKAGES` | global bun packages | `BUN_PACKAGES="typescript eslint"` |

These are processed by `entrypoint.d/01-install-packages.sh`.

The Admin **LSP Server Management** page (`/lsp`) is the operator-facing way to drive the OpenCode `lsp` block. It presents a typed catalog of supported language servers (`src/admin/lib/lsp-catalog.ts`), lets you enable servers and pin versions (from registry-discovered versions, newest first), and applies the desired set through `POST /api/lsp/apply`. Enablement/pinning is persisted as the `LSP_SERVERS` JSON override in `.env` (`{ "serverKey": { "enabled": bool, "version": string|null } }`; `null` version = latest/unpinned), install rides `BUN_PACKAGES`, and `entrypoint.d/02-init-config.sh` regenerates the `lsp` block from the enabled entries at startup, sourcing `BUN_PACKAGES`/`LSP_SERVERS` from `lsp-managed.env` in the opencode-config volume (written on every successful apply) unless already defined in the container environment. The reconciler (`src/admin/lib/lsp-reconciler.ts`) reports per-server drift — `missing_install`, `version_mismatch`, `not_enabled_in_lsp` — computed live from installed versions and the generated `lsp` block.

## Persistence and State

Several tools keep their own persistent data:

- OpenCode config and package cache
- OpenChamber config
- lean-ctx data and state volumes
- git / SSH / `gh` / `glab` auth volumes

This keeps the workspace disposable while preserving the parts that should survive restarts.

The reliability decision does not remove or bypass the lean-ctx MCP registration, Admin editor/drift API, `ctx_knowledge`, `ctx_session`, permission inheritance, path jail, or shell-write policy. `lean-ctx-data` and `lean-ctx-state` remain persistent boundaries; no production volume is deleted. Configuration drift is report-only, and configuration Apply or service restart is never implicit after migration or evaluation.

## Where to Look Next

- [../README.md](../README.md) — project overview and quick start
- [./ARCHITECTURE.md](./ARCHITECTURE.md) — service and storage design
- [./GIT_AUTHENTICATION.md](./GIT_AUTHENTICATION.md) — auth details
- [./TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — known issues
