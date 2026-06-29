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

ai-engkit is a Docker-based AI development environment that splits the workload across two containers: **ai-engine** (OpenCode API, MCP servers, CLI tools) and **ai-ui** (OpenChamber web UI). The two containers communicate over a shared Docker bridge network.

```mermaid
graph TB
    subgraph "User Side"
        BROWSER["🌐 Browser<br/>OpenChamber Web UI"]
        TERMINAL["💻 Terminal<br/>OpenCode CLI"]
    end

    subgraph "Docker Environment"
        subgraph "ai-engine Container"
            OC["OpenCode<br/>API Server"]
            API["API :4095"]
            TOOLS["Developer Tools<br/>git, python, tmux..."]
            MCP["MCP Servers<br/>CodeGraph, lean-ctx, Playwright"]
        end

        subgraph "ai-ui Container"
            CH["OpenChamber<br/>Web Server"]
        end
    end

    subgraph "Host Resources"
        HOST_DOCKER["Docker Socket"]
    end

    BROWSER -->|"HTTP/WS :3000"| CH
    CH -->|"ws://ai-engine:4095"| API
    TERMINAL -->|"CLI"| OC

    OC -.->|"via named volumes"| GIT_VOLS["git-config<br/>ssh-keys volumes"]
    OC -.->|"read/write"| HOST_DOCKER

    style BROWSER fill:#e1f5fe
    style TERMINAL fill:#e8f5e9
    style OC fill:#fff3e0
    style CH fill:#f3e5f5
    style API fill:#e3f2fd
    style GIT_VOLS fill:#e8f5e9
    style MCP fill:#ffcc80
```

## Service Architecture

### Primary Services

```mermaid
graph LR
    subgraph "ai-engine Service"
        direction TB
        OC_API[":4095 OpenCode<br/>API Server"]
        ENTRYPOINT["entrypoint.sh"]
        INIT_SCRIPTS["Initialization Scripts"]
    end

    subgraph "ai-ui Service"
        direction TB
        PORT3000[":3000 OpenChamber<br/>Web UI"]
    end

    PORT3000 -->|"WebSocket"| OC_API
    ENTRYPOINT --> INIT_SCRIPTS

    style PORT3000 fill:#f3e5f5
    style OC_API fill:#e3f2fd
```

### Service Dependencies

```mermaid
graph TD
    A["docker compose up -d"] --> B["ai-engine starts"]
    A --> C["ai-ui starts (depends_on ai-engine)"]
    B --> D["OpenCode API :4095 ready"]
    C --> E["OpenChamber Web :3000 starts"]
    D -->|"connected via"| E
    E --> F["Open the Web UI"]

    G["User accesses :8000"] --> H["OpenChamber :3000"]
    H -->|"ws://ai-engine:4095"| I["OpenCode :4095"]

    style A fill:#fff3e0
    style B fill:#e3f2fd
    style C fill:#f3e5f5
    style D fill:#e3f2fd
    style E fill:#f3e5f5
    style H fill:#f3e5f5
    style I fill:#e3f2fd
```

## Container Architecture

### Container Layout

```mermaid
graph TB
    subgraph "ai-engine Container (Ubuntu 24.04)"
        ENGINE_USER["devuser (UID 1000)"]

        subgraph "Engine Application Layer"
            OC_SERVER["OpenCode Server<br/>(API :4095)"]
            OC_PLUGINS["Plugin System<br/>oh-my-openagent"]
            MCP_SERVERS["MCP Servers<br/>CodeGraph / lean-ctx / Playwright"]
        end

        subgraph "Engine Runtime"
            BUN["Bun Runtime"]
            HOMEBREW["Homebrew"]
            DOCKER_CLI["Docker CLI"]
        end

        subgraph "Engine Volumes"
            E_WORKSPACE["~/workspace"]
            E_CONFIG["~/.config/"]
            E_DATA["~/.local/share/"]
            E_CACHE["~/.cache/"]
            E_SSH["~/.ssh/"]
            E_GIT["~/.config/git/"]
            E_GH["~/.config/gh/"]
            E_GLAB["~/.config/glab-cli/"]
        end
    end

    subgraph "ai-ui Container (Ubuntu 24.04)"
        UI_USER["devuser (UID 1000)"]
        CH_SERVER["OpenChamber Server<br/>(Web :3000)"]
        UI_BUN["Bun Runtime"]
        UI_VOL["~/.config/openchamber/"]
    end

    ENGINE_USER --> OC_SERVER
    OC_SERVER --> OC_PLUGINS
    OC_SERVER --> MCP_SERVERS
    OC_SERVER --> BUN
    BUN --> DOCKER_CLI
    HOMEBREW --> OC_SERVER

    OC_SERVER --> E_CONFIG
    OC_SERVER --> E_DATA
    OC_SERVER --> E_GIT
    OC_SERVER --> E_SSH
    OC_SERVER --> E_CACHE
    OC_SERVER --> E_WORKSPACE
    OC_SERVER --> E_GH
    OC_SERVER --> E_GLAB

    UI_USER --> CH_SERVER
    CH_SERVER --> UI_BUN
    CH_SERVER --> UI_VOL

    CH_SERVER -->|"ws://ai-engine:4095"| OC_SERVER

    style ENGINE_USER fill:#fff9c4
    style UI_USER fill:#fff9c4
    style OC_SERVER fill:#fff3e0
    style CH_SERVER fill:#f3e5f5
    style MCP_SERVERS fill:#ffcc80
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
        HOST_PORT_8000[":${CHAMBER_PORT:-8000} OpenChamber UI"]
    end

    subgraph "Docker ai-net Bridge Network"
        subgraph "ai-engine Container"
            ENGINE_API["4095 OpenCode<br/>API Server"]
        end

        subgraph "ai-ui Container"
            UI_WEB["3000 OpenChamber<br/>Web Server"]
        end
    end

    HOST_PORT_8000 -->|"mapped to :3000"| UI_WEB
    UI_WEB -->|"ws://ai-engine:4095"| ENGINE_API

    style HOST_PORT_8000 fill:#f3e5f5
    style UI_WEB fill:#f3e5f5
    style ENGINE_API fill:#e3f2fd
```

### Environment Variables

| Variable | Purpose | Default | Scope | Container |
|------|------|--------|------|----------|
| `CHAMBER_PORT` | Web UI host port | 8000 | Host | `ai-ui` |
| `OPENCODE_SERVER_PASSWORD` | API authentication | `devonly` | Application | `ai-engine` |
| `OPENCHAMBER_UI_PASSWORD` | Web UI authentication | `chamber` | Application | `ai-ui` |
| `OPENCODE_HOST` | OpenCode API URL (for remote connect) | `http://ai-engine:4095` | Service link | `ai-ui` |
| `OPENCODE_SKIP_START` | Skip auto-starting OpenCode locally | `true` | Service link | `ai-ui` |

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

    subgraph "ai-engine Paths"
        E_WS["~/workspace"]
        E_DATA["~/.local/share/opencode"]
        E_LC_DATA["~/.local/share/lean-ctx"]
        E_LC_STATE["~/.local/state/lean-ctx"]
        E_CONFIG["~/.config/opencode"]
        E_CACHE["~/.cache/opencode"]
        E_OHMY["~/.cache/oh-my-opencode"]
        E_CHAMBER["~/.config/openchamber"]
        E_GIT["~/.config/git<br/>~/.gitconfig"]
        E_SSH["~/.ssh"]
        E_GH["~/.config/gh"]
        E_GLAB["~/.config/glab-cli"]
    end

    subgraph "ai-ui Paths"
        U_CHAMBER["~/.config/openchamber"]
    end

    VOL_WS --> E_WS
    VOL_DATA --> E_DATA
    VOL_CONFIG --> E_CONFIG
    VOL_CACHE --> E_CACHE
    VOL_OHMY --> E_OHMY
    VOL_CHAMBER --> E_CHAMBER
    VOL_CHAMBER --> U_CHAMBER
    VOL_GIT --> E_GIT
    VOL_SSH --> E_SSH
    VOL_GH --> E_GH
    VOL_GLAB --> E_GLAB
    VOL_LC_DATA --> E_LC_DATA
    VOL_LC_STATE --> E_LC_STATE

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
    participant EI as engine init scripts
    participant E as ai-engine
    participant U as ai-ui

    D->>E: Start ai-engine container
    E->>EI: Run entrypoint.d scripts

    Note over EI: 00-fix-perms.sh<br/>Fix permissions

    Note over EI: 01-install-packages.sh<br/>Install extra packages

    Note over EI: 02-init-config.sh<br/>Initialize config files

    Note over EI: 03-fix-docker-gid.sh<br/>Fix Docker GID

    Note over EI: 04-init-git-ssh.sh<br/>Git/SSH settings

    Note over EI: 05-init-gh-cli.sh<br/>GitHub CLI settings

    Note over EI: 06-init-glab-cli.sh<br/>GitLab CLI settings

    Note over EI: 06-setup-opencode-path.sh<br/>Set up PATH

    EI->>E: Initialization complete
    E->>E: Start OpenCode API server (:4095)

    D->>U: Start ai-ui (depends_on ai-engine)
    U->>U: Start OpenChamber Web (:3000)
    U->>E: Connect to ws://ai-engine:4095

    E->>D: Engine ready
    U->>D: UI ready
```

### Initialization Script Order

```mermaid
flowchart LR
    subgraph "ai-engine Startup"
        A["entrypoint.sh"] --> B["00-fix-perms.sh"]
        B --> C["01-install-packages.sh"]
        C --> D["02-init-config.sh"]
        D --> E["03-fix-docker-gid.sh"]
        E --> F["04-init-git-ssh.sh"]
        F --> G["05-init-gh-cli.sh"]
        G --> GA["06-init-glab-cli.sh"]
        GA --> GB["06-setup-opencode-path.sh"]
        GB --> H["opencode serve --hostname 0.0.0.0"]
    end

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
