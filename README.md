# ai-engkit

> **Your Self-hosted AI Engineering Kit for Dev & Ops**

ai-engkit is a self-hosted AI development environment that packages [OpenCode](https://opencode.ai), [OpenChamber](https://openchamber.dev/), browser automation, code navigation, and everyday developer tooling into a single Ubuntu 24.04 container.

It is designed for teams and individuals who want a reproducible AI coding workspace without rebuilding their toolchain from scratch.

![Ubuntu](https://img.shields.io/badge/Ubuntu-24.04-orange?style=for-the-badge&logo=ubuntu&logoColor=white)
![OpenCode](https://img.shields.io/badge/OpenCode-1.17.11-blue?style=for-the-badge&logoColor=white)
![OpenChamber](https://img.shields.io/badge/OpenChamber-1.13.7-blue?style=for-the-badge&logoColor=white)
 
## Features

- **OpenCode + OpenChamber** — Terminal agent and browser UI in one container
- **Preconfigured MCP stack** — Built-in CodeGraph, lean-ctx, and Playwright integrations
- **Agent plugins and skills** — OpenSpec, Superpowers, baked skills, and OpenCode plugin support
- **Docker-ready development** — Docker CLI, `docker compose`, and Buildx with Docker socket passthrough
- **Complete CLI toolchain** — git, `gh`, `glab`, Homebrew, bun, python3, ripgrep, jq, tmux, ssh, rsync, comment-checker, and common build tools
- **Browser automation** — Playwright + bundled Chromium (resolved at runtime via `pw-mcp` wrapper) for testing and web workflows
- **Extensible package install** — Add extra apt, brew, or bun packages at runtime
- **Persistent volumes** — Config, caches, workspace, and knowledge data survive container restarts
- **Isolated credentials** — Separate git / SSH / `gh` / `glab` volumes inside the container
- **Zero-config bootstrap** — Default config and baked skills are initialized automatically on first run

## Quick Start

```bash
curl -fsSL https://raw.githubusercontent.com/tryweb/ai-engkit/refs/heads/main/install.sh | bash
```

Open [http://localhost:8000](http://localhost:8000) in your browser.

## Upgrade

> **Tip:** Re-running `install.sh` on an existing installation (when `docker-compose.yml` is already present) automatically downloads `upgrade.sh` and delegates to it — so both commands reach the same upgrade flow. Use `upgrade.sh` for scripted/cron-driven upgrades and `install.sh` for first-time setup.

To update an existing installation to the latest version:

```bash
curl -fsSL https://raw.githubusercontent.com/tryweb/ai-engkit/refs/heads/main/upgrade.sh | bash
```

The upgrade script will:

1. **Back up** your current `docker-compose.yml` and `.env` to a timestamped directory (`backup_<timestamp>/`)
2. **Download** the latest `docker-compose.yml` from upstream
3. **Merge** any new environment variables into your `.env` (preserving your custom values)
4. **Pull** the latest container image
5. **Recreate** the container with `docker compose up -d --force-recreate`
6. **Clean up** dangling images to free disk space

If you need to roll back, the backup directory contains your previous configuration:

```bash
docker compose down
cp backup_<timestamp>/docker-compose.yml docker-compose.yml
cp backup_<timestamp>/.env .env
docker compose up -d
```

## Documentation Map

- [CONTRIBUTING.md](./CONTRIBUTING.md) — contributor guide (English)
- [docs/CONTRIBUTING_zh-TW.md](./docs/CONTRIBUTING_zh-TW.md) — contributor guide (繁體中文)
- [docs/CHANGELOG.md](./docs/CHANGELOG.md) — changelog
- [SECURITY.md](./SECURITY.md) — security policy (English)
- [docs/SECURITY_zh-TW.md](./docs/SECURITY_zh-TW.md) — security policy (繁體中文)
- [docs/TOOLING.md](./docs/TOOLING.md) — built-in MCP servers, CLI tools, package managers, and extension points
- [docs/GIT_AUTHENTICATION.md](./docs/GIT_AUTHENTICATION.md) — HTTPS / SSH / `gh` / `glab` setup inside the container
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — runtime architecture, data flow, storage, and startup behavior
- [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md) — known issues and fixes

## Development

Developers who want to build locally should use `docker-compose.dev.yml`:

```bash
docker compose -f docker-compose.dev.yml build --no-cache
docker compose -f docker-compose.dev.yml up -d
```

## Configuration

### Environment Variables

Copy `.env.example` to `.env` and customize:

| Variable | Default | Description |
|----------|---------|-------------|
| `CHAMBER_PORT` | `8000` | Host port for Web UI |
| `OPENCODE_SERVER_PASSWORD` | `devonly` | OpenCode API password |
| `OPENCHAMBER_UI_PASSWORD` | `chamber` | Web UI password |
| `OPENCODE_PLUGINS` | `oh-my-openagent,superpowers@git+https://github.com/obra/superpowers.git` | Comma-separated plugin list |
| `WORKSPACE_PATH` | *(unset → named volume `workspace`)* | Host path for workspace bind mount |
| `APT_PACKAGES` | *(empty)* | Extra apt packages installed at container startup |
| `BREW_PACKAGES` | *(empty)* | Extra Homebrew packages installed at container startup |
| `BUN_PACKAGES` | *(empty)* | Extra global bun packages installed at container startup |

### Plugin Version Management (Development)

When building from source (via `docker-compose.dev.yml`), you can specify plugin versions:

```bash
# Use latest versions (default)
docker compose -f docker-compose.dev.yml build

# Specify specific versions
OH_MY_OPENAGENT_VERSION=3.15.0 \
  docker compose -f docker-compose.dev.yml build
```

Available arguments:
- `OH_MY_OPENAGENT_VERSION` - oh-my-openagent plugin version (default: `latest`)

### Workspace

By default, the workspace uses a Docker named volume. To use a host directory for direct file editing:

```bash
# Use a bind mount to a local directory
echo "WORKSPACE_PATH=./workspace" >> .env
docker compose up -d --force-recreate
```

Leave `WORKSPACE_PATH` commented or unset to keep using the default named volume.

This allows you to edit files with your local IDE while the container runs.

| Volume | Container Path | Description |
|--------|---------------|-------------|
| `opencode-config` | `/home/devuser/.config/opencode` | OpenCode settings, plugins, agents |
| `opencode-data` | `/home/devuser/.local/share/opencode` | Database (sessions, conversations) |
| `opencode-cache` | `/home/devuser/.cache/opencode` | Model metadata, plugin cache |
| `openchamber-data` | `/home/devuser/.config/openchamber` | OpenChamber settings, themes |
| `git-config` | `/home/devuser/.config/git` | Git config and stored HTTPS credentials |
| `ssh-keys` | `/home/devuser/.ssh` | SSH keys and known_hosts |
| `gh-config` | `/home/devuser/.config/gh` | GitHub CLI auth state |
| `glab-config` | `/home/devuser/.config/glab-cli` | GitLab CLI auth state |
| `workspace` | `/home/devuser/workspace` | Project workspace |
| `ohmyopencode-cache` | `/home/devuser/.cache/oh-my-opencode` | Plugin cache |
| `lean-ctx-data` | `/home/devuser/.local/share/lean-ctx` | Vector index, knowledge base, sessions |
| `lean-ctx-state` | `/home/devuser/.local/state/lean-ctx` | Event logs, journal, agent keys |

## MCP and Knowledge Tooling

ai-engkit ships with a preconfigured MCP stack for code navigation and browser automation:

- **CodeGraph** — code graph and dependency analysis
- **lean-ctx** — context-aware read/search/shell workflow helpers
- **Playwright** — browser automation with Playwright-bundled Chromium (resolved via `pw-mcp` wrapper)

For deeper details, see:

- [docs/TOOLING.md](./docs/TOOLING.md)
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)
- [docs/knowledge/README.md](./docs/knowledge/README.md)
- [docs/knowledge/tooling/lean-ctx-xdg-layout.md](./docs/knowledge/tooling/lean-ctx-xdg-layout.md)

## Git Authentication

Git credentials are stored inside dedicated container volumes and do not reuse host-side auth automatically.

For HTTPS, SSH, `gh`, `glab`, multiple accounts, and security notes, see:

- [docs/GIT_AUTHENTICATION.md](./docs/GIT_AUTHENTICATION.md)
- [SECURITY.md](./SECURITY.md)
- [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md#glab-as-a-git-credential-helper-with-a-versioned-path)

## Ports

| Container Port | Default Host Mapping | Purpose |
|----------------|----------------------|---------|
| `3000` | `${CHAMBER_PORT:-8000}` | OpenChamber Web UI |
| `4095` | *(internal)* | OpenCode service port used inside the container stack |

## When to Use ai-engkit

- You want a ready-to-run AI coding environment with persistent state
- You need browser automation, code graph tooling, and agent plugins in one place
- You want Docker-based isolation without losing Git, SSH, or CLI workflows
- You want to extend the image at runtime with extra apt, brew, or bun packages

## Testing

### Run Tests Against Running Container

```bash
./test/run-tests.sh
```

### Full Build + Test Cycle

```bash
./test/test-full.sh
```

This builds the image from scratch, starts all services, runs verification tests, and cleans up.

## Release Process

```bash
/release
```

This runs the automated release skill which:
1. Runs local tests (including memory plugin E2E verification)
2. Calculates version bump (MAJOR/MINOR/PATCH)
3. Generates release notes
4. Prompts for confirmation
5. Tags and pushes to GitHub

GitHub Actions will automatically:
- Build and test the image
- Push to `ghcr.io/{owner}/ai-engkit:{version}`
- Create a GitHub Release with notes

## Project Structure

```
├── .env.example                # Environment template
├── .github/workflows/ci.yml    # CI/CD pipeline
├── .opencode/
│   ├── baked-skills/           # Pre-installed skills shipped in Docker image
│   │   ├── karpathy-guidelines/
│   │   ├── knowledge-capture/
│   │   └── enable-project-knowledge/
│   └── skills/                 # User-visible skill definitions (symlinks to baked-skills/)
│       ├── knowledge-capture.md
│       ├── release.md
│       └── vuln-scan.md
├── docker-compose.yml          # User-facing (uses pre-built image)
├── docker-compose.dev.yml      # Developer (builds from Dockerfile)
├── upgrade.sh                  # One-liner upgrade from existing installation
├── Dockerfile                  # Ubuntu 24.04 based image
├── entrypoint.sh               # Main entrypoint
├── entrypoint.d/               # Initialization scripts
│   ├── 00-fix-perms.sh         # Fix volume permissions
│   ├── 01-install-packages.sh  # Dynamic package installation
│   ├── 02-init-config.sh       # Auto-generate + baked-skills symlinks
│   ├── 03-fix-docker-gid.sh
│   ├── 04-init-git-ssh.sh
│   ├── 05-init-gh-cli.sh
│   ├── 06-init-glab-cli.sh
│   └── 06-setup-opencode-path.sh
├── docs/
│   ├── ARCHITECTURE.md
│   ├── CHANGELOG.md
│   ├── CONTRIBUTING_zh-TW.md
│   ├── GIT_AUTHENTICATION.md
│   ├── SECURITY_zh-TW.md
│   ├── TOOLING.md
│   ├── TROUBLESHOOTING.md
│   └── knowledge/               # Git-backed knowledge base (manual, human-readable)
│       ├── README.md
│       ├── _template.md
│       ├── architecture/
│       ├── patterns/
│       │   └── baked-skills-mechanism.md
│       ├── tooling/
│       └── troubleshooting/
└── test/
    ├── run-tests.sh             # Integration test suite
    ├── test-full.sh             # Full build-test pipeline
    └── test-memory-e2e.sh       # Memory plugin E2E test
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the English contributor guide, or [docs/CONTRIBUTING_zh-TW.md](./docs/CONTRIBUTING_zh-TW.md) for the Traditional Chinese version.

## License

MIT License

Copyright (c) 2026 Jonathan Tsai <tryweb@ichiayi.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
