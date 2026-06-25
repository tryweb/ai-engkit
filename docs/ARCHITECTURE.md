# Architecture Guide

This document explains the ai-engkit system architecture, the relationships between components, and the main data flows.

## Table of Contents

- [System Overview](#system-overview)
- [Service Architecture](#service-architecture)
- [Container Architecture](#container-architecture)
- [Data Flow](#data-flow)
- [Network Architecture](#network-architecture)
- [Storage Architecture](#storage-architecture)
- [Startup Flow](#startup-flow)
- [Component Reference](#component-reference)

## System Overview

ai-engkit is a Docker-based AI development environment that combines the OpenCode AI assistant (backend), the OpenChamber web UI (frontend), and a preinstalled day-to-day developer toolchain.

```mermaid
graph TB
    subgraph "User Side"
        BROWSER["🌐 Browser<br/>OpenChamber Web UI"]
        TERMINAL["💻 Terminal<br/>OpenCode CLI"]
    end

    subgraph "Docker Environment"
        subgraph "ai-dev Container"
            OC["OpenCode<br/>AI Assistant (Backend)"]
            CH["OpenChamber<br/>Web Server (Frontend)"]
            API["API :4095"]
            TOOLS["Developer Tools<br/>git, python, tmux..."]
        end
    end

    subgraph "Host Resources"
        HOST_DOCKER["Docker Socket"]
    end

    BROWSER -->|"HTTP/WS :3000"| CH
    CH -->|"WebSocket :4095"| API
    TERMINAL -->|"CLI"| OC
    OC -->|"API :4095"| API

    OC -.->|"via named volumes"| GIT_VOLS["git-config<br/>ssh-keys volumes"]
    OC -.->|"read/write"| HOST_DOCKER

    style BROWSER fill:#e1f5fe
    style TERMINAL fill:#e8f5e9
    style OC fill:#fff3e0
    style CH fill:#f3e5f5
    style API fill:#e3f2fd
    style GIT_VOLS fill:#e8f5e9
```

## Service Architecture

### Primary Services

```mermaid
graph LR
    subgraph "ai-dev Service"
        direction TB
        PORT3000[":3000 OpenChamber<br/>Web UI"]
        OC_API[":4095 OpenCode<br/>API Server"]
        ENTRYPOINT["entrypoint.sh"]
        INIT_SCRIPTS["Initialization Scripts"]
    end

    PORT3000 -->|"WebSocket"| OC_API
    OC_API -->|"API :11434"| PORT11434
    ENTRYPOINT --> INIT_SCRIPTS
    PORT11434 --> HEALTHCHECK
    HEALTHCHECK --> PULL_MODEL

    style PORT3000 fill:#f3e5f5
    style OC_API fill:#e3f2fd
    style PORT11434 fill:#fce4ec
```

### Service Dependencies

```mermaid
graph TD
    A["ai-dev starts"] --> D["OpenCode API :4095 ready"]
    D --> E["OpenChamber Web :3000 starts"]
    E --> F["Open the Web UI"]

    G["User accesses :8000"] --> H["OpenChamber :3000"]
    H -->|"WebSocket/SSE"| I["OpenCode :4095"]

    style A fill:#fff3e0
    style D fill:#e3f2fd
    style E fill:#f3e5f5
    style H fill:#f3e5f5
    style I fill:#e3f2fd
```

## Container Architecture

### ai-dev Internal Layout

```mermaid
graph TB
    subgraph "ai-dev Container (Ubuntu 24.04)"
        USER["devuser (UID 1000)"]

        subgraph "Application Layer"
            OC_SERVER["OpenCode Server"]
            OC_PLUGINS["Plugin System<br/>oh-my-openagent"]
            CH_SERVER["OpenChamber Server"]
        end

        subgraph "Runtime"
            BUN["Bun Runtime"]
            HOMEBREW["Homebrew"]
            NODE_SHIM["Node Shim"]
        end

        subgraph "Directory Layout"
            WORKSPACE["~/workspace"]
            CONFIG["~/.config/"]
            DATA["~/.local/share/"]
            CACHE["~/.cache/"]
            SSH["~/.ssh/ (named volume)"]
            GIT["~/.config/git/ (named volume)"]
        end
    end

    USER --> OC_SERVER
    USER --> CH_SERVER
    OC_SERVER --> OC_PLUGINS
    OC_SERVER --> BUN
    CH_SERVER --> BUN
    BUN --> NODE_SHIM
    HOMEBREW --> CH_SERVER

    OC_SERVER --> CONFIG
    OC_SERVER --> DATA
    OC_SERVER --> GIT
    OC_SERVER --> SSH
    OC_SERVER --> CACHE
    CH_SERVER --> CONFIG
    OC_SERVER --> SSH
    OC_SERVER --> WORKSPACE

    style USER fill:#fff9c4
    style OC_SERVER fill:#fff3e0
    style CH_SERVER fill:#f3e5f5
```

## Data Flow

### AI Conversation Flow

```mermaid
sequenceDiagram
    participant U as User
    participant UI as OpenChamber Web UI
    participant API as OpenCode API
    participant OC as OpenCode Engine
    participant DB as Database
    participant OL as LLM Model

    U->>UI: Enter a prompt
    UI->>API: WebSocket/SSE request
    API->>OC: Forward request
    OC->>DB: Store conversation record
    OC->>OL: Generate request (embedding)
    OL-->>OC: Vector result
    OC->>OL: Generate request (LLM)
    OL-->>OC: Generated response
    OC->>DB: Store response
    OC-->>API: SSE response
    API-->>UI: SSE response
    UI-->>U: Display result
```

## Network Architecture

### Container Network Topology

```mermaid
graph TB
    subgraph "Host Network"
        HOST_PORT_8000[":8000 OpenChamber UI"]
    end

    subgraph "Docker Bridge Network"
        subgraph "ai-dev"
            CONTAINER_3000["3000 OpenChamber<br/>Web Server"]
            CONTAINER_4095["4095 OpenCode<br/>API Server"]
        end
    end

    HOST_PORT_8000 -->|"mapped to"| CONTAINER_3000

    CONTAINER_3000 -->|"WebSocket/SSE"| CONTAINER_4095

    style HOST_PORT_8000 fill:#f3e5f5
    style CONTAINER_3000 fill:#f3e5f5
    style CONTAINER_4095 fill:#e3f2fd
```

### Environment Variables

| Variable | Purpose | Default | Scope |
|------|------|--------|------|
| `CHAMBER_PORT` | Web UI port | 8000 | Host |
| `OPENCODE_SERVER_PASSWORD` | API authentication | `devonly` | Application |
| `OPENCHAMBER_UI_PASSWORD` | Web UI authentication | `chamber` | Application |

## Storage Architecture

### Volume Configuration

```mermaid
graph TB
    subgraph "Docker Volumes"
        VOL_WS["workspace<br/>Project files"]
        VOL_DATA["opencode-data<br/>Database"]
        VOL_CONFIG["opencode-config<br/>Configuration"]
        VOL_CACHE["opencode-cache<br/>Cache"]
        VOL_OHMY["ohmyopencode-cache<br/>Plugin cache"]
        VOL_CHAMBER["openchamber-data<br/>UI settings"]
        VOL_GIT["git-config<br/>Git settings"]
        VOL_SSH["ssh-keys<br/>SSH keys"]
        VOL_GH["gh-config<br/>GitHub CLI settings"]
        VOL_GLAB["glab-config<br/>GitLab CLI settings"]
        VOL_LC_DATA["lean-ctx-data<br/>Vector index / knowledge base"]
        VOL_LC_STATE["lean-ctx-state<br/>Event logs"]
    end

    subgraph "Container Paths"
        C_WS["~/workspace"]
        C_DATA["~/.local/share/opencode"]
        C_LC_DATA["~/.local/share/lean-ctx"]
        C_LC_STATE["~/.local/state/lean-ctx"]
        C_CONFIG["~/.config/opencode"]
        C_CACHE["~/.cache/opencode"]
        C_OHMY["~/.cache/oh-my-opencode"]
        C_CHAMBER["~/.config/openchamber"]
        C_GIT["~/.config/git<br/>~/.gitconfig"]
        C_SSH["~/.ssh"]
        C_GH["~/.config/gh"]
        C_GLAB["~/.config/glab-cli"]
    end

    VOL_WS --> C_WS
    VOL_DATA --> C_DATA
    VOL_CONFIG --> C_CONFIG
    VOL_CACHE --> C_CACHE
    VOL_OHMY --> C_OHMY
    VOL_CHAMBER --> C_CHAMBER
    VOL_GIT --> C_GIT
    VOL_SSH --> C_SSH
    VOL_GH --> C_GH
    VOL_GLAB --> C_GLAB
    VOL_LC_DATA --> C_LC_DATA
    VOL_LC_STATE --> C_LC_STATE

    style VOL_WS fill:#fff3e0
    style VOL_DATA fill:#e3f2fd
    style VOL_GIT fill:#e8f5e9
    style VOL_SSH fill:#e8f5e9
    style VOL_GH fill:#e8f5e9
    style VOL_GLAB fill:#e8f5e9
```

### Persistence Strategy

| Data Type | Storage Location | Retention | Backup Recommendation |
|---------|---------|---------|---------|
| Project files | workspace | Critical | Back up regularly to Git |
| Conversation history | opencode-data | Critical | Export regularly |
| User configuration | opencode-config | Critical | Keep under version control |
| Git settings | git-config | Critical | Includes `.gitconfig`, `.git-credentials` |
| SSH keys | ssh-keys | Critical | Includes `known_hosts` |
| GitHub CLI settings | gh-config | Critical | Includes host auth and cache |
| GitLab CLI settings | glab-config | Critical | Includes host auth and cache |
| Cache data | opencode-cache | Rebuildable | No backup needed |
| UI settings | openchamber-data | Normal | No backup needed |
| lean-ctx vector index / knowledge base | lean-ctx-data | Critical | Includes sessions, vectors, graphs, knowledge |
| lean-ctx event logs / state | lean-ctx-state | Normal | Includes events, journal, agent keys |

## Startup Flow

### Container Startup Order

```mermaid
sequenceDiagram
    participant D as Docker Compose
    participant I as init scripts
    participant A as ai-dev

    D->>A: Start the ai-dev container
    A->>I: Run entrypoint.d scripts

    Note over I: 00-fix-perms.sh<br/>Fix permissions

    Note over I: 01-install-packages.sh<br/>Install extra packages

    Note over I: 02-init-config.sh<br/>Initialize config files

    Note over I: 03-fix-docker-gid.sh<br/>Fix Docker GID (requires sudo)

    Note over I: 04-init-git-ssh.sh<br/>Initialize Git/SSH settings (named volumes)

    Note over I: 05-init-gh-cli.sh<br/>Initialize GitHub CLI settings (named volume)

    Note over I: 06-init-glab-cli.sh<br/>Initialize GitLab CLI settings (named volume)

    Note over I: 06-setup-opencode-path.sh<br/>Set up opencode PATH

    I->>A: Initialization complete
    A->>A: Start OpenCode Server
    A->>A: Start OpenChamber Server
    A->>D: Services ready
```

### Initialization Script Order

```mermaid
flowchart LR
    A["entrypoint.sh"] --> B["00-fix-perms.sh"]
    B --> C["01-install-packages.sh"]
    C --> D["02-init-config.sh"]
    D --> E["03-fix-docker-gid.sh"]
    E --> F["04-init-git-ssh.sh"]
    F --> G["05-init-gh-cli.sh"]
    G --> GA["06-init-glab-cli.sh"]
    GA --> GB["06-setup-opencode-path.sh"]
    GB --> H["Run CMD"]

    B -->|"fix"| PERMS["Volume permissions"]
    C -->|"install"| PKGS["apt/brew/bun packages"]
    D -->|"create"| CONFIGS["Default config files"]
    E -->|"fix"| DOCKER["Docker group"]
    F -->|"initialize"| GITSETUP["Git/SSH settings"]
    G -->|"initialize"| GH_SETUP["GitHub CLI settings"]
    GA -->|"initialize"| GLAB_SETUP["GitLab CLI settings"]
    GB -->|"configure"| PATH_SETUP["opencode PATH"]

    style A fill:#fff3e0
    style G fill:#c8e6c9
```

## Component Reference

### OpenCode

| Attribute | Description |
|------|------|
| Purpose | AI coding assistant (backend engine) |
| Version | See `ARG OPENCODE_VERSION` in `Dockerfile` |
| Config file | `~/.config/opencode/opencode.json` |
| Database | `~/.local/share/opencode/opencode.db` |
| API port | 4095 |
| Protocol | HTTP + SSE (Server-Sent Events) |
| SDK | `@opencode-ai/sdk` |

### OpenChamber

| Attribute | Description |
|------|------|
| Purpose | Web/Desktop UI for OpenCode (frontend GUI) |
| Version | See `ARG OPENCHAMBER_VERSION` in `Dockerfile` |
| Relationship to OpenCode | Separate project that connects to OpenCode over API |
| Service port | 3000 (mapped to host port 8000) |
| Transport | WebSocket (terminal) + SSE (chat) |
| Frontend framework | React (Tauri for desktop) |

> 📝 **Architecture note**: OpenChamber is not part of OpenCode. It is a separate project ([openchamber/openchamber](https://github.com/openchamber/openchamber)) that acts as a client and connects to the OpenCode server through `@opencode-ai/sdk/v2`, either by starting a local server automatically or by connecting to a remote one.

### Developer Toolchain

```mermaid
graph LR
    subgraph "Version Control"
        GIT["git"]
        GH["gh (GitHub CLI)"]
        GLAB["glab (GitLab CLI)"]
    end

    subgraph "Runtime"
        PYTHON["python3"]
        BUN["bun"]
        NODE["node (shim)"]
    end

    subgraph "Terminal Tools"
        TMUX["tmux"]
        NEOVIM["nvim"]
        VIM["vim"]
        NANO["nano"]
    end

    subgraph "Utility Tools"
        JQ["jq"]
        TREE["tree"]
        CURL["curl"]
        WGET["wget"]
    end

    subgraph "Container Tools"
        DOCKER["docker CLI"]
        COMPOSE["docker compose"]
    end

    style GIT fill:#e8f5e9
    style GH fill:#e8f5e9
    style GLAB fill:#e8f5e9
    style BUN fill:#fff3e0
    style DOCKER fill:#e3f2fd
```

### Plugin System

| Plugin | Purpose | Description | Version Management |
| `oh-my-openagent` | Core framework | Extends baseline OpenCode functionality | Supports build-time version pinning |

### Plugin Version Management (Development)

You can specify plugin versions when building the image:

```bash
# Use the latest version (default)
docker compose -f docker-compose.dev.yml build

# Pin a specific version
OH_MY_OPENAGENT_VERSION=3.15.0 LANCEDB_OPENCODE_PRO_VERSION=0.7.0 \
  docker compose -f docker-compose.dev.yml build
```

## Configuration Options

### Dynamic Package Installation

Install extra packages at container startup through environment variables:

```bash
# .env
APT_PACKAGES="htop,iotop"
BREW_PACKAGES="ghq"
BUN_PACKAGES="typescript"
```

### Workspace Options

| Mode | Setting | Advantages | Drawbacks |
|------|------|------|------|
| Named Volume | Leave `WORKSPACE_PATH` unset (default since v0.5.0) | Managed by Docker, auto-initializes Git/SSH settings | Requires `docker cp` for direct host access |
| Bind Mount | `WORKSPACE_PATH=./workspace` | Editable directly with a local IDE | Permission issues are more common |
| Host Path | `WORKSPACE_PATH=/home/user/projects` | Reuses an existing project directory | Requires careful permission management |

---

> 📖 **Further reading**: See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) for common issues.
