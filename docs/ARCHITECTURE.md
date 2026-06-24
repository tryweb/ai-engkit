# 架構說明

本文檔說明 ai-engkit 專案的系統架構、元件間的關係及資料流程。

## 目錄

- [系統概覽](#系統概覽)
- [服務架構](#服務架構)
- [容器架構](#容器架構)
- [資料流](#資料流)
- [網路架構](#網路架構)
- [儲存架構](#儲存架構)
- [啟動流程](#啟動流程)
- [元件說明](#元件說明)

## 系統概覽

ai-engkit 是一個基於 Docker 的 AI 開發環境，整合了 OpenCode AI 助手（後端）、OpenChamber Web UI（前端的 Web 介面）以及預先安裝好的常用開發工具。

```mermaid
graph TB
    subgraph "使用者端"
        BROWSER["🌐 瀏覽器<br/>OpenChamber Web UI"]
        TERMINAL["💻 終端機<br/>OpenCode CLI"]
    end

    subgraph "Docker 環境"
        subgraph "ai-dev 容器"
            OC["OpenCode<br/>AI 助手 (後端)"]
            CH["OpenChamber<br/>Web 伺服器 (前端)"]
            API["API :4095"]
            TOOLS["開發工具<br/>git, python, tmux..."]
        end
    end
    
    subgraph "主機資源"
        HOST_DOCKER["Docker Socket"]
    end

    BROWSER -->|"HTTP/WS :3000"| CH
    CH -->|"WebSocket :4095"| API
    TERMINAL -->|"命令列"| OC
    OC -->|"API :4095"| API
    
    OC -.->|"透過 named volumes"| GIT_VOLS["git-config<br/>ssh-keys volumes"]
    OC -.->|"讀寫"| HOST_DOCKER

    style BROWSER fill:#e1f5fe
    style TERMINAL fill:#e8f5e9
    style OC fill:#fff3e0
    style CH fill:#f3e5f5
    style API fill:#e3f2fd
    style GIT_VOLS fill:#e8f5e9
```

## 服務架構

### 主要服務

```mermaid
graph LR
    subgraph "ai-dev 服務"
        direction TB
        PORT3000[":3000 OpenChamber<br/>Web UI"]
        OC_API[":4095 OpenCode<br/>API Server"]
        ENTRYPOINT["entrypoint.sh"]
        INIT_SCRIPTS["初始化腳本"]
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

### 服務依賴關係

```mermaid
graph TD
    A["ai-dev 啟動"] --> D["OpenCode API :4095 就緒"]
    D --> E["OpenChamber Web :3000 啟動"]
    E --> F["開啟 Web UI"]

    G["使用者訪問 :8000"] --> H["OpenChamber :3000"]
    H -->|"WebSocket/SSE"| I["OpenCode :4095"]
    
    style A fill:#fff3e0
    style D fill:#e3f2fd
    style E fill:#f3e5f5
    style H fill:#f3e5f5
    style I fill:#e3f2fd
```

## 容器架構

### ai-dev 容器內部結構

```mermaid
graph TB
    subgraph "ai-dev 容器 (Ubuntu 24.04)"
        USER["devuser (UID 1000)"]
        
        subgraph "應用層"
            OC_SERVER["OpenCode Server"]
            OC_PLUGINS["插件系統<br/>oh-my-openagent"]
            CH_SERVER["OpenChamber Server"]
        end

        subgraph "執行時"
            BUN["Bun Runtime"]
            HOMEBREW["Homebrew"]
            NODE_SHIM["Node Shim"]
        end

        subgraph "目錄結構"
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

## 資料流

### AI 對話流程

```mermaid
sequenceDiagram
    participant U as 使用者
    participant UI as OpenChamber Web UI
    participant API as OpenCode API
    participant OC as OpenCode Engine
    participant DB as 資料庫
    participant OL as LLM-Model

    U->>UI: 輸入提示詞
    UI->>API: WebSocket/SSE 請求
    API->>OC: 轉發請求
    OC->>DB: 儲存對話記錄
    OC->>OL: 生成請求 (嵌入)
    OL-->>OC: 向量結果
    OC->>OL: 生成請求 (LLM)
    OL-->>OC: 生成回應
    OC->>DB: 儲存回應
    OC-->>API: SSE 回應
    API-->>UI: SSE 回應
    UI-->>U: 顯示結果
```

## 網路架構

### 容器網路拓樸

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

    HOST_PORT_8000 -->|"映射"| CONTAINER_3000
    
    CONTAINER_3000 -->|"WebSocket/SSE"| CONTAINER_4095

    style HOST_PORT_8000 fill:#f3e5f5
    style CONTAINER_3000 fill:#f3e5f5
    style CONTAINER_4095 fill:#e3f2fd
```

### 環境變數配置

| 變數 | 用途 | 預設值 | 範圍 |
|------|------|--------|------|
| `CHAMBER_PORT` | Web UI 埠號 | 8000 | 主機 |
| `OPENCODE_SERVER_PASSWORD` | API 認證 | `devonly` | 應用層 |
| `OPENCHAMBER_UI_PASSWORD` | Web UI 認證 | `chamber` | 應用層 |

## 儲存架構

### Volume 配置

```mermaid
graph TB
    subgraph "Docker Volumes"
        VOL_WS["workspace<br/>專案檔案"]
        VOL_DATA["opencode-data<br/>資料庫"]
        VOL_CONFIG["opencode-config<br/>設定"]
        VOL_CACHE["opencode-cache<br/>快取"]
        VOL_OHMY["ohmyopencode-cache<br/>插件快取"]
        VOL_CHAMBER["openchamber-data<br/>UI 設定"]
        VOL_GIT["git-config<br/>Git 設定"]
        VOL_SSH["ssh-keys<br/>SSH 金鑰"]
        VOL_GH["gh-config<br/>GitHub CLI 設定"]
        VOL_GLAB["glab-config<br/>GitLab CLI 設定"]
        VOL_LC_DATA["lean-ctx-data<br/>向量索引/知識庫"]
        VOL_LC_STATE["lean-ctx-state<br/>事件日誌"]
    end

    subgraph "容器路徑"
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

### 資料持久化策略

| 資料類型 | 儲存位置 | 保留策略 | 備份建議 |
|---------|---------|---------|---------|
| 專案檔案 | workspace | 重要 | 定期備份到 Git |
| 對話記錄 | opencode-data | 重要 | 定期匯出 |
| 使用者設定 | opencode-config | 重要 | 納入版本控制 |
| Git 設定 | git-config | 重要 | 包含 .gitconfig, .git-credentials |
| SSH 金鑰 | ssh-keys | 重要 | 包含 known_hosts |
| GitHub CLI 設定 | gh-config | 重要 | 包含主機認證、快取 |
| GitLab CLI 設定 | glab-config | 重要 | 包含主機認證、快取 |
| 快取資料 | opencode-cache | 可重建 | 不需備份 |
| UI 設定 | openchamber-data | 一般 | 不需備份 |
| lean-ctx 向量索引/知識庫 | lean-ctx-data | 重要 | 包含 sessions, vectors, graphs, knowledge |
| lean-ctx 事件日誌/狀態 | lean-ctx-state | 一般 | 包含 events, journal, agent keys |

## 啟動流程

### 容器啟動順序

```mermaid
sequenceDiagram
    participant D as Docker Compose
    participant I as init scripts
    participant A as ai-dev

    D->>A: 啟動 ai-dev 容器
    A->>I: 執行 entrypoint.d 腳本
    
    Note over I: 00-fix-perms.sh<br/>修復權限
    
    Note over I: 01-install-packages.sh<br/>安裝額外套件
    
    Note over I: 02-init-config.sh<br/>初始化設定檔
    
    Note over I: 03-fix-docker-gid.sh<br/>修復 Docker GID (需要 sudo)

    Note over I: 04-init-git-ssh.sh<br/>初始化 Git/SSH 設定 (named volumes)
    
    Note over I: 05-init-gh-cli.sh<br/>初始化 GitHub CLI 設定 (named volume)

    Note over I: 06-init-glab-cli.sh<br/>初始化 GitLab CLI 設定 (named volume)

    Note over I: 06-setup-opencode-path.sh<br/>設定 opencode PATH

    I->>A: 初始化完成
    A->>A: 啟動 OpenCode Server
    A->>A: 啟動 OpenChamber Server
    A->>D: 服務就緒
```

### 初始化腳本執行順序

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
    GB --> H["執行 CMD"]

    B -->|"修復"| PERMS["Volume 權限"]
    C -->|"安裝"| PKGS["apt/brew/bun 套件"]
    D -->|"建立"| CONFIGS["預設設定檔"]
    E -->|"修正"| DOCKER["Docker 群組"]
    F -->|"初始化"| GITSETUP["Git/SSH 設定"]
    G -->|"初始化"| GH_SETUP["GitHub CLI 設定"]
    GA -->|"初始化"| GLAB_SETUP["GitLab CLI 設定"]
    GB -->|"設定"| PATH_SETUP["opencode PATH"]

    style A fill:#fff3e0
    style G fill:#c8e6c9
```

## 元件說明

### OpenCode

| 屬性 | 說明 |
|------|------|
| 功能 | AI 程式碼助手（後端引擎） |
| 版本 | 見 `Dockerfile` `ARG OPENCODE_VERSION` |
| 設定檔 | `~/.config/opencode/opencode.json` |
| 資料庫 | `~/.local/share/opencode/opencode.db` |
| API 埠號 | 4095 |
| 通訊協定 | HTTP + SSE (Server-Sent Events) |
| SDK | `@opencode-ai/sdk` |

### OpenChamber

| 屬性 | 說明 |
|------|------|
| 功能 | OpenCode 的 Web/Desktop UI（前端的 GUI） |
| 版本 | 見 `Dockerfile` `ARG OPENCHAMBER_VERSION` |
| 與 OpenCode 關係 | 獨立專案，透過 API 連線至 OpenCode |
| 服務埠號 | 3000 (映射至主機 8000) |
| 通訊方式 | WebSocket (terminal) + SSE (chat) |
| 前端框架 | React (Tauri for desktop) |

> 📝 **架構說明**：OpenChamber 並非 OpenCode 的一部分，而是獨立的專案（[openchamber/openchamber](https://github.com/openchamber/openchamber)）。它作為客戶端，透過 `@opencode-ai/sdk/v2` 連線至 OpenCode 伺服器，可選擇本地自動啟動或連線至遠端伺服器。

### 開發工具鏈

```mermaid
graph LR
    subgraph "版本控制"
        GIT["git"]
        GH["gh (GitHub CLI)"]
        GLAB["glab (GitLab CLI)"]
    end

    subgraph "執行環境"
        PYTHON["python3"]
        BUN["bun"]
        NODE["node (shim)"]
    end

    subgraph "終端工具"
        TMUX["tmux"]
        NEOVIM["nvim"]
        VIM["vim"]
        NANO["nano"]
    end

    subgraph "實用工具"
        JQ["jq"]
        TREE["tree"]
        CURL["curl"]
        WGET["wget"]
    end

    subgraph "容器工具"
        DOCKER["docker CLI"]
        COMPOSE["docker compose"]
    end

    style GIT fill:#e8f5e9
    style GH fill:#e8f5e9
    style GLAB fill:#e8f5e9
    style BUN fill:#fff3e0
    style DOCKER fill:#e3f2fd
```

### 插件系統

| 插件 | 功能 | 說明 | 版本管理 |
|------|------|------|----------|
| `oh-my-openagent` | 核心框架 | OpenCode 基礎功能擴展 | 支援 build 時指定版本 |

### Plugin 版本管理（開發用）

在建構 image 時可指定插件版本：

```bash
# 使用最新版本（預設）
docker compose -f docker-compose.dev.yml build

# 指定特定版本
OH_MY_OPENAGENT_VERSION=3.15.0 LANCEDB_OPENCODE_PRO_VERSION=0.7.0 \
  docker compose -f docker-compose.dev.yml build
```

## 配置選項

### 動態安裝套件

透過環境變數可在容器啟動時安裝額外套件：

```bash
# .env
APT_PACKAGES="htop,iotop"
BREW_PACKAGES="ghq"
BUN_PACKAGES="typescript"
```

### Workspace 選項

| 模式 | 設定 | 優點 | 缺點 |
|------|------|------|------|
| Named Volume | 不設定 `WORKSPACE_PATH` (v0.5.0 預設) | 容器管理，自動初始化 git/SSH 設定 | 需要 `docker cp` 存取 |
| Bind Mount | `WORKSPACE_PATH=./workspace` | 可直接用本機 IDE 編輯 | 權限問題較常見 |
| 主機路徑 | `WORKSPACE_PATH=/home/user/projects` | 存取現有專案 | 需注意權限 |

---

> 📖 **延伸閱讀**：詳見 [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) 了解常見問題。
