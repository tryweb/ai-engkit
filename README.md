# CodeForge

A self-hosted AI development environment powered by [OpenCode](https://opencode.ai) and [OpenChamber](https://openchamber.dev/), running on Ubuntu 24.04 with Ollama integration.

![Ubuntu](https://img.shields.io/badge/Ubuntu-24.04-orange?style=for-the-badge&logo=ubuntu&logoColor=white)
![OpenCode](https://img.shields.io/badge/OpenCode-1.14.48-blue?style=for-the-badge&logoColor=white)
![OpenChamber](https://img.shields.io/badge/OpenChamber-1.11.7-blue?style=for-the-badge&logoColor=white)
![Ollama](https://img.shields.io/badge/Ollama-latest-blue?style=for-the-badge&logoColor=white)

## Features

- **OpenCode AI** — Terminal-based AI coding assistant
- **OpenChamber Web UI** — Browser-based interface for managing AI sessions ([openchamber.dev](https://openchamber.dev/))
- **Ollama Integration** — Local LLM inference with embedding support
- **OpenSpec** — Spec-driven development tooling
- **GitHub CLI** — Built-in `gh` (GitHub) and `glab` (GitLab) for repository management
- **CodeGraph** — Knowledge graph tool for mapping codebases (`@colbymchenry/codegraph` package, command: `codegraph`)
- **Superpowers** — Agentic skills framework for software development methodology
- **Full Dev Toolchain** — git, jq, tree, tmux, python3, ssh, rsync, and more
- **Persistent Configuration** — All settings and data survive container restarts
- **Zero-Config Setup** — Automatic initialization of default configs on first run

## Quick Start

```bash
curl -fsSL https://raw.githubusercontent.com/tryweb/Codeforge/refs/heads/main/install.sh | bash
```

Open [http://localhost:8000](http://localhost:8000) in your browser.

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
| `OLLAMA_PORT` | `11434` | Host port for Ollama API |
| `OPENCODE_SERVER_PASSWORD` | `devonly` | OpenCode API password |
| `OPENCHAMBER_UI_PASSWORD` | `chamber` | Web UI password |
| `OPENCODE_PLUGINS` | `oh-my-openagent` | Comma-separated plugin list |
| `WORKSPACE_PATH` | *(named volume)* | Host path for workspace bind mount |
| `OLLAMA_BASE_URL` | `http://ollama:11434` | Ollama service URL |

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
docker compose up -d
```

This allows you to edit files with your local IDE while the container runs.

| Volume | Container Path | Description |
|--------|---------------|-------------|
| `opencode-config` | `/home/devuser/.config/opencode` | OpenCode settings, plugins, agents |
| `opencode-data` | `/home/devuser/.local/share/opencode` | Database (sessions, conversations) |
| `opencode-cache` | `/home/devuser/.cache/opencode` | Model metadata, plugin cache |
| `openchamber-data` | `/home/devuser/.config/openchamber` | OpenChamber settings, themes |
| `workspace` | `/home/devuser/workspace` | Project workspace |

## Git Authentication

The container uses `credential.helper = store` for HTTPS operations (configured automatically by `entrypoint.d/04-init-git-ssh.sh` on first start). Credentials are persisted in a `git-config` named volume and survive container restarts.

**Important:** The container's git/SSH/gh configs are **isolated** from the host — they live in their own named volumes (`git-config`, `ssh-keys`, `gh-config`). Authenticate inside the container; host authentication does not propagate.

### First-time Setup

**HTTPS (easiest):**
```bash
# Inside the container
git clone https://github.com/your-org/private-repo.git
# Enter username + Personal Access Token (PAT) when prompted
# Credential is saved to ~/.git-credentials in the git-config volume
```

**SSH:**
```bash
# From the host, copy your key into the container
docker cp ~/.ssh/id_ed25519 ai-dev:/home/devuser/.ssh/
docker exec ai-dev chmod 600 /home/devuser/.ssh/id_ed25519
docker exec ai-dev ssh-add ~/.ssh/id_ed25519   # optional, for ssh-agent
```

**`gh` / `glab` CLI:**
```bash
# Inside the container
gh auth login      # GitHub
glab auth login    # GitLab
```

### Multiple Accounts

For per-host credentials, edit `~/.gitconfig` inside the container:

```ini
[credential "https://github.com"]
    username personal-user

[credential "https://gitlab.work.com"]
    username work-user
```

For SSH, use `~/.ssh/config` Host aliases with different keys.

### Updating or Clearing Credentials

```bash
# Erase a stored credential (interactive)
docker exec -it ai-dev bash -c 'git credential-store erase'

# Or edit the file directly
docker exec -it ai-dev vi ~/.git-credentials
```

### Security Notes

- `credential.helper = store` saves credentials in **plaintext** in `~/.git-credentials`. Prefer HTTPS Personal Access Tokens (PATs) with minimum required scopes over passwords.
- For higher security, prefer SSH keys.
- The container's credential volumes are **not shared** with the host — a compromised container cannot read host credentials, and host credentials are never exposed to the container.
- If you set up glab/gh as a credential helper on the **host**, see [TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md#glab-作為-git-credential-helper-的版本化路徑問題) for the versioned-path breakage issue.

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
- Push to `ghcr.io/{owner}/codeforge:{version}`
- Create a GitHub Release with notes

## Project Structure

```
├── .env.example              # Environment template
├── .github/workflows/ci.yml  # CI/CD pipeline
├── .opencode/skills/          # OpenCode skill definitions
│   └── release.md             # Release workflow skill
├── docker-compose.yml         # User-facing (uses pre-built image)
├── docker-compose.dev.yml     # Developer (builds from Dockerfile)
├── Dockerfile                 # Ubuntu 24.04 based image
├── entrypoint.sh              # Main entrypoint
├── entrypoint.d/              # Initialization scripts
│   ├── 00-fix-perms.sh       # Fix volume permissions
│   ├── 01-install-packages.sh # Dynamic package installation
│   └── 02-init-config.sh     # Auto-generate default configs
└── test/
    ├── run-tests.sh           # Integration test suite
    └── test-full.sh           # Full build-test pipeline
```

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
