# AI-EngKit

> **A reproducible, self-hosted AI engineering workspace for developers and small teams.**

AI-EngKit packages [OpenCode](https://opencode.ai), [OpenChamber](https://openchamber.dev/), MCP tooling, browser automation, Git workflows, and common build tools into a persistent Ubuntu 24.04 Docker environment.

It is for people who want a ready-to-run AI coding workspace without assembling and maintaining the toolchain by hand. It is **not** a hosted AI service and is designed for trusted development environments.

[![CI](https://github.com/tryweb/ai-engkit/actions/workflows/ci.yml/badge.svg)](https://github.com/tryweb/ai-engkit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Ubuntu](https://img.shields.io/badge/Ubuntu-24.04-orange?logo=ubuntu&logoColor=white)](https://ubuntu.com/)

## Why AI-EngKit?

- **Browser-based AI workspace** — OpenChamber provides a full-featured web UI; the OpenCode CLI runs inside the container for advanced users who `docker exec` in.
- **Pre-wired engineering tools** — CodeGraph, lean-ctx, Playwright, GitHub/GitLab CLI, Docker, and everyday build utilities are included.
- **Persistent by default** — configuration, sessions, caches, credentials, workspace files, and knowledge data live in separate Docker volumes.
- **Operationally manageable** — the Admin Dashboard handles environment settings, authentication, project initialization, version inspection, and upgrades; optional center-agent connection enables remote management of multiple instances.
- **Extensible without rebuilding** — add apt, Homebrew, or bun packages through environment variables at startup.

## Requirements and security boundary

Before installing, have:

- Docker Engine with Docker Compose V2
- At least 2 CPU cores, 4 GB RAM, and 30 GB free disk space (8 GB RAM and 100 GB disk recommended)
- An AVX2-capable CPU, required by the OpenCode runtime

> **Security warning:** AI-EngKit mounts the Docker socket so agents and the Admin Dashboard can manage sibling containers. This is a high-trust capability, not a security sandbox. Keep the dashboard and services on a trusted network, change all passwords, and read [SECURITY.md](./SECURITY.md) before exposing anything beyond localhost.

## Quick start

Install the current production channel from `main`:

```bash
curl -fsSL https://raw.githubusercontent.com/tryweb/ai-engkit/refs/heads/main/install.sh | bash
```

The installer checks system requirements, asks for the OpenChamber and Admin passwords when they are not already set, creates the persistent volumes, and starts the services.

After installation:

- OpenChamber: [http://localhost:8000](http://localhost:8000)
- Admin Dashboard: [http://localhost:8080](http://localhost:8080)

The installer-generated `.env` is the source of truth for your ports and credentials. Do not use the example passwords in a network-accessible deployment; `OPENCHAMBER_UI_PASSWORD` is `chamber` and `OPENCODE_SERVER_PASSWORD` is `devonly` in the example configuration, and both should be replaced. `ADMIN_PASSWORD` must also be set to a deployment-specific value.

## What is included?

### Core workspace

- OpenCode AI agent (backend) with OpenChamber web UI (frontend); the CLI is available inside the container via `docker exec`
- CodeGraph, lean-ctx, and Playwright MCP integrations
- OpenSpec, Superpowers, baked skills, and OpenCode plugin support
- `git`, `gh`, `glab`, Docker Compose, Buildx, Homebrew, bun, Python, ripgrep, jq, tmux, SSH, rsync, and common build tools
- Bundled Playwright Chromium, resolved at runtime through the `pw-mcp` wrapper

### Admin Dashboard

The `ai-admin` service runs as a separate service from the main `ai-dev` container, using the same image and shared operational volumes. No separate Admin image is required.

It provides:

- Version and container health overview
- Masked environment-variable editing
- Backup-aware image upgrades with health polling
- Workspace project initialization
- GitHub and GitLab device-code authentication
- Git identity, credentials, and SSH public-key management

<p align="center">
  <img src="./docs/images/admin-dashboard.png" width="900" alt="AI-EngKit Admin Dashboard overview">
</p>

See the [architecture guide](./docs/ARCHITECTURE.md) for the service and storage model.

## Upgrade and rollback

Upgrade an existing installation with the same supported release flow:

```bash
curl -fsSL https://raw.githubusercontent.com/tryweb/ai-engkit/refs/heads/main/upgrade.sh | bash
```

The upgrade script backs up the Compose inputs and `.env`, downloads the latest Compose configuration, merges newly introduced variables without overwriting custom values, pulls the image, recreates the service, waits for the container to be running, and removes dangling images. When a domain overlay is configured, the base, overlay, and environment inputs are backed up together and the effective base-plus-overlay configuration is recreated. Re-running `install.sh` on an existing installation delegates to this upgrade flow.

To restore the backed-up Compose and environment settings, stop the services first. For an Admin-managed backup, use the files under `backups/pre-<timestamp>/`:

```bash
docker compose down
cp backups/pre-<timestamp>/.env .env
cp backups/pre-<timestamp>/compose.yml docker-compose.yml
# No overlay: start the restored base-only configuration.
docker compose up -d
```

For an overlay installation, restore the staged base and the backed-up overlay
before starting services. Do not run the base-only command above:

```bash
cp backups/pre-<timestamp>/compose-upgrade-base.yml admin-data/upgrade-base.yml
cp backups/pre-<timestamp>/overlay/<name> extensions/<name>
docker compose --project-directory . \
  -f admin-data/upgrade-base.yml -f extensions/<name> up -d
```

Host `upgrade.sh` backups use `backup_<TIMESTAMP>/` and print the corresponding restore paths. Restoring configuration files does not restore Docker images or persistent volume data. To deploy a previous image as well, set `AI_ENGKIT_VERSION` to the desired release tag before starting the services.

### Domain Compose overlay

Domain deployments can preserve one local Compose overlay across upgrades, restarts, and maintenance recreates by setting `AI_ENGKIT_COMPOSE_OVERLAY` in `.env`. The overlay is validated before any recreate and may only extend the `ai-dev` service (environment, networks, named volumes, labels, healthcheck); it cannot change the image, ports, privilege settings, Docker socket mounts, or the Admin/domain worker services. The host `upgrade.sh` path is overlay-aware: it requires `jq`, validates the target base and overlay on the host, backs up the current effective inputs, and then recreates `ai-admin` and `ai-dev` from the base-plus-overlay configuration without silently falling back to base-only. The Admin API reports overlay status; there is no overlay editor or UI warning flow. See [Domain Compose Overlay](./docs/DOMAIN_COMPOSE_OVERLAY.md).

## Configuration

Copy `.env.example` to `.env` when configuring a checkout manually. The installer normally creates it for you. The optional package variables below can be added to `.env` even when they are not present in the example file.

| Variable | Default / behavior | Purpose |
|----------|--------------------|---------|
| `CHAMBER_PORT` | `8000` | Host port for OpenChamber |
| `ADMIN_PORT` | `8080` | Host port for the Admin Dashboard |
| `AI_ENGKIT_VERSION` | unset (`latest`) | Optional image/release tag to pin |
| `OPENCODE_SERVER_PASSWORD` | `devonly` in example | OpenCode API password; replace it |
| `OPENCHAMBER_UI_PASSWORD` | `chamber` in example | OpenChamber password; installer prompts for it |
| `ADMIN_PASSWORD` | **required** | Admin Dashboard password; installer prompts for it |
| `AI_ENGKIT_COMPOSE_OVERLAY` | unset (disabled) | One local overlay for the `ai-dev` service |
| `OPENCODE_PLUGINS` | bundled plugin list | Comma-separated OpenCode plugins |
| `OPENCODE_PROVIDER` | unset | Custom provider JSON injected into `opencode.json` |
| `WORKSPACE_PATH` | named volume | Set a host path for a bind-mounted workspace |
| `BACKUP_RETENTION` | `5` | Number of upgrade backups to retain |
| `APT_PACKAGES` | unset | Extra apt packages installed at startup |
| `BREW_PACKAGES` | unset | Extra Homebrew packages installed at startup |
| `BUN_PACKAGES` | unset | Extra global bun packages installed at startup |
| `CENTER_URL` | unset | WebSocket URL for center-agent remote management |
| `CENTER_TOKEN` | unset | Registration token for center authentication |

### Workspace and persistent data

By default, the workspace uses the named `workspace` volume. To edit files directly with a host IDE:

```bash
echo "WORKSPACE_PATH=/home/user/projects" >> .env
docker compose up -d --force-recreate
```

> **Docker-out-of-Docker (DooD) note:** Use an absolute host path, not `./workspace`. Relative paths resolve from the admin container's Compose directory (`/opt/ai-engkit`), which can mount the wrong host directory during upgrades.

Important persistent volumes include:

| Volume | Container path | Contents |
|--------|----------------|----------|
| `opencode-config` | `/home/devuser/.config/opencode` | OpenCode settings, plugins, agents |
| `opencode-data` | `/home/devuser/.local/share/opencode` | Sessions and conversations |
| `openchamber-data` | `/home/devuser/.config/openchamber` | OpenChamber settings and themes |
| `git-config` / `ssh-keys` | Git and SSH config paths | Git identity, credentials, keys |
| `gh-config` / `glab-config` | GitHub/GitLab CLI paths | CLI authentication state |
| `workspace` | `/home/devuser/workspace` | Projects and source files |
| `lean-ctx-data` / `lean-ctx-state` | lean-ctx data paths | Index, knowledge base, logs, and state |

For HTTPS, SSH, multiple accounts, and credential isolation, see [Git authentication](./docs/GIT_AUTHENTICATION.md).

### Providers

The Admin Dashboard **Providers** page (`/providers`) edits `OPENCODE_PROVIDER` through structured cards with a raw-JSON fallback per provider, and manages API keys for key-managed providers: Opencode Go, OpenAI API, Nvidia API, and OpenRouter. OpenAI also supports the ChatGPT Pro/Plus headless OAuth connection.

- Provider definitions still live in `OPENCODE_PROVIDER` in `.env` and are injected into `opencode.json` on startup.
- Provider API keys are stored in `admin-data/provider-keys.json` (directory-mounted into the admin container as `/opt/ai-engkit/admin-data`, with the file set to `0600`), deliberately not in `.env` so keys never leak through `docker inspect`.
- The active key for a key-managed provider is written to the opencode auth store (`~/.local/share/opencode/auth.json`) and applied by restarting the ai-dev container; the page shows a restart-required state and offers the same restart flow as Secrets.
- When a key-managed provider has an existing key in the auth store, the dashboard supports importing it into the provider-key registry; provider metadata also mirrors an auth-store-only API key into the registry.

## Ports

| Container port | Default host mapping | Purpose |
|----------------|----------------------|---------|
| `3000` | `${CHAMBER_PORT:-8000}` | OpenChamber Web UI |
| `3000` | `${CHAMBER_DEV_PORT:-8001}` | OpenChamber Web UI in development |
| `4095` | internal | OpenCode service |
| `8080` | `${ADMIN_PORT:-8080}` | Admin Dashboard |
| `8080` | `${ADMIN_DEV_PORT:-8081}` | Admin Dashboard in development |

## Documentation

- [Architecture](./docs/ARCHITECTURE.md) — services, data flow, storage, and startup behavior
- [Domain Compose Overlay](./docs/DOMAIN_COMPOSE_OVERLAY.md) — one local overlay for domain `ai-dev` integrations
- [Tooling](./docs/TOOLING.md) — MCP servers, CLI tools, package managers, and extension points
- [Security policy](./SECURITY.md) — threat model, trust assumptions, and reporting
- [Troubleshooting](./docs/TROUBLESHOOTING.md) — known issues and fixes
- [Git authentication](./docs/GIT_AUTHENTICATION.md) — HTTPS, SSH, `gh`, and `glab`
- [Changelog](./docs/CHANGELOG.md) — release history

Traditional Chinese guides are available for [contributing](./docs/CONTRIBUTING_zh-TW.md) and [security](./docs/SECURITY_zh-TW.md).

## Development and testing

Build and run the development stack:

```bash
docker compose -p dev -f docker-compose.dev.yml build --no-cache
docker compose -p dev -f docker-compose.dev.yml up -d
```

Run the available checks:

```bash
./test/run-tests.sh          # tests against a running container
./test/test-admin.sh         # Admin Dashboard integration tests
./test/test-full.sh          # full build, test, and cleanup cycle
```

`run-tests.sh` and `test-admin.sh` target the development Compose project and require its services to be running. `test-full.sh` is for disposable development environments: before rebuilding, it removes the dev project's containers and named volumes with `down -v`, including persisted development workspace and configuration data.

See [CONTRIBUTING.md](./CONTRIBUTING.md) before submitting changes.

## License

MIT License. See [LICENSE](./LICENSE).
