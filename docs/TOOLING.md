# Tooling Guide

This document summarizes the tools that ship with ai-engkit and where to extend them.

## Overview

ai-engkit combines four layers of tooling across two containers: `ai-engine` (AI workspace, MCP, CLI tools) and `ai-ui` (Web UI):

1. **AI workspace** — OpenCode, OpenChamber, OpenSpec, plugins, and baked skills
2. **MCP integrations** — CodeGraph, lean-ctx, and Playwright
3. **Developer CLI stack** — git, `gh`, `glab`, Docker CLI, Compose, Buildx, bun, Python, and shell tools
4. **Runtime extension points** — extra apt, Homebrew, and bun packages installed at container startup

## Built-in MCP Servers

ai-engkit preconfigures these MCP servers for OpenCode:

| Tool | Purpose | Notes |
|------|---------|-------|
| **CodeGraph** | Code graph, symbol relationships, dependency analysis | Installed as `@colbymchenry/codegraph` |
| **lean-ctx** | Context-aware read/search/shell workflows | Includes persistent state and knowledge volumes |
| **Playwright** | Browser automation and UI testing | Playwright-bundled Chromium; `pw-mcp` wrapper resolves the executable path and launches `@playwright/mcp` with `--executable-path --no-sandbox --headless` |

Related files:

- `Dockerfile`
- `entrypoint.d/02-init-config.sh`
- `docs/knowledge/tooling/lean-ctx-xdg-layout.md`

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

ai-engkit is designed for Docker socket passthrough, so containerized workflows can still call Docker from inside the workspace.

### General development utilities

- bun
- Homebrew
- Python 3 + `pip` + `venv`
- `ripgrep`, `jq`, `tree`, `tmux`, `rsync`, `curl`, `wget`
- `vim`, `nano`, `less`, `htop`, `lsof`
- `comment-checker`

## OpenCode Plugins and Skills

Default plugin setup:

- `oh-my-openagent`
- `superpowers@git+https://github.com/obra/superpowers.git`

ai-engkit also bakes in project-visible skills such as:

- `karpathy-guidelines`
- `knowledge-capture`
- `enable-project-knowledge`

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

## Persistence and State

Several tools keep their own persistent data:

- OpenCode config and package cache
- OpenChamber config
- lean-ctx data and state volumes
- git / SSH / `gh` / `glab` auth volumes

This keeps the workspace disposable while preserving the parts that should survive restarts.

## Where to Look Next

- [../README.md](../README.md) — project overview and quick start
- [./ARCHITECTURE.md](./ARCHITECTURE.md) — service and storage design
- [./GIT_AUTHENTICATION.md](./GIT_AUTHENTICATION.md) — auth details
- [./TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — known issues
