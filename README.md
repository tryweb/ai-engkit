# CodeForge

A self-hosted AI development environment powered by [OpenCode](https://opencode.ai) and [OpenChamber](https://openchamber.dev/), running on Ubuntu 24.04 with Ollama integration.

## Features

- **OpenCode AI** — Terminal-based AI coding assistant
- **OpenChamber Web UI** — Browser-based interface for managing AI sessions ([openchamber.dev](https://openchamber.dev/))
- **Ollama Integration** — Local LLM inference with embedding support
- **OpenSpec** — Spec-driven development tooling
- **GitHub CLI** — Built-in `gh` for repository management
- **Full Dev Toolchain** — git, jq, tree, tmux, python3, ssh, rsync, and more
- **Persistent Configuration** — All settings and data survive container restarts
- **Zero-Config Setup** — Automatic initialization of default configs on first run

## Quick Start

```bash
# Clone the repository
git clone https://github.com/tryweb/codeforge.git
cd codeforge

# Configure environment (optional)
cp .env.example .env

# Start with pre-built image
docker compose up -d
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
| `OPENCODE_PLUGINS` | `oh-my-opencode,lancedb-opencode-pro` | Comma-separated plugin list |
| `WORKSPACE_PATH` | *(named volume)* | Host path for workspace bind mount |
| `OLLAMA_BASE_URL` | `http://ollama:11434` | Ollama service URL |

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

## Testing

### Run Tests Against Running Container

```bash
./test/run-tests.sh
```

### Full Build + Test Cycle

```bash
./test/test-full.sh
```

This builds the image from scratch, starts all services, runs 39 verification tests, and cleans up.

## Release Process

1. Ensure all tests pass locally:
   ```bash
   ./test/run-tests.sh
   ```

2. Create and push a version tag:
   ```bash
   git tag v0.1.0
   git push origin main --tags
   ```

3. GitHub Actions will automatically:
   - Build and test the image
   - Push to `ghcr.io/{owner}/codeforge:{version}`
   - Create a GitHub Release with notes

## Project Structure

```
├── .env.example              # Environment template
├── .github/workflows/ci.yml  # CI/CD pipeline
├── docker-compose.yml        # User-facing (uses pre-built image)
├── docker-compose.dev.yml    # Developer (builds from Dockerfile)
├── Dockerfile                # Ubuntu 24.04 based image
├── entrypoint.sh             # Main entrypoint
├── entrypoint.d/             # Initialization scripts
│   ├── 00-fix-perms.sh       # Fix volume permissions
│   ├── 01-install-packages.sh # Dynamic package installation
│   └── 02-init-config.sh     # Auto-generate default configs
└── test/
    ├── run-tests.sh          # Integration test suite
    └── test-full.sh          # Full build-test pipeline
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
