# 架構說明

本文檔說明 OpenChamber 專案的系統架構、元件間的關係及資料流程。

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

OpenChamber 是一個基於 Docker 的自託管 AI 開發環境，整合了 OpenCode AI 助手、OpenChamber Web UI 以及 Ollama 本地 LLM 推論引擎。

```mermaid
graph TB
    subgraph "使用者端"
        BROWSER["🌐 瀏覽器<br/>Web UI"]
        TERMINAL["💻 終端機<br/>CLI 工具"]
    end

    subgraph "Docker 環境"
        subgraph "ai-dev 容器"
            OC["OpenCode<br/>AI 助手"]
            CH["OpenChamber<br/>Web 伺服器"]
            TOOLS["開發工具<br/>git, python, tmux..."]
        end

        subgraph "ollama 容器"
            OLLAMA["Ollama<br/>LLM 推論引擎"]
            MODELS["模型檔案"]
        end
    end

    subgraph "主機資源"
        HOST_DOCKER["Docker Socket"]
    end

    BROWSER <-->|"HTTP/WS :3000"| CH
    TERMINAL -->|"命令列"| OC
    CH <-->|"API :11434"| OLLAMA
    OC <-->|"API :11434"| OLLAMA
    
    OC -.->|"透過 named volumes"| GIT_VOLS["git-config<br/>ssh-keys volumes"]
    OC -.->|"讀寫"| HOST_DOCKER

    style BROWSER fill:#e1f5fe
    style TERMINAL fill:#e8f5e9
    style OC fill:#fff3e0
    style CH fill:#f3e5f5
    style OLLAMA fill:#fce4ec
    style GIT_VOLS fill:#e8f5e9
```

## 服務架構

### 主要服務

```mermaid
graph LR
    subgraph "ai-dev 服務"
        direction TB
        PORT3000[":3000 Web 伺服器"]
        PORT4095[":4095 OpenCode API"]
        ENTRYPOINT["entrypoint.sh"]
        INIT_SCRIPTS["初始化腳本"]
    end

    subgraph "ollama 服務"
        direction TB
        PORT11434[":11434 API"]
        HEALTHCHECK["健康檢查"]
        PULL_MODEL["自動拉取模型"]
    end

    PORT3000 --> PORT4095
    ENTRYPOINT --> INIT_SCRIPTS
    PORT11434 --> HEALTHCHECK
    HEALTHCHECK --> PULL_MODEL

    style PORT3000 fill:#e3f2fd
    style PORT4095 fill:#e3f2fd
    style PORT11434 fill:#fce4ec
```

### 服務依賴關係

```mermaid
graph TD
    A["ai-dev 啟動"] --> B{"等待依賴"}
    B --> C["ollama healthy"]
    C --> D["初始化完成"]
    D --> E["開啟 Web UI"]

    F["使用者訪問"] --> G{":8000"}
    G --> H["ai-dev :3000"]
    
    style A fill:#fff3e0
    style E fill:#c8e6c9
    style H fill:#e3f2fd
```

## 容器架構

### ai-dev 容器內部結構

```mermaid
graph TB
    subgraph "ai-dev 容器 (Ubuntu 24.04)"
        USER["devuser (UID 1000)"]
        
        subgraph "應用層"
            OC_SERVER["OpenCode Server"]
            OC_PLUGINS["插件系統<br/>oh-my-opencode<br/>lancedb-opencode-pro"]
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

### ollama 容器結構

```mermaid
graph TB
    subgraph "ollama 容器"
        OLLAMA_SERVER["Ollama Server"]
        
        subgraph "模型管理"
            MODEL_DIR["/root/.ollama/"]
            NOMIC["nomic-embed-text<br/>嵌入模型"]
            USER_MODEL["使用者模型"]
        end

        subgraph "API 端點"
            API_TAGS["/api/tags<br/>模型列表"]
            API_GENERATE["/api/generate<br/>文字生成"]
            API_EMBED["/api/embed<br/>向量嵌入"]
        end
    end

    OLLAMA_SERVER --> MODEL_DIR
    MODEL_DIR --> NOMIC
    MODEL_DIR --> USER_MODEL
    OLLAMA_SERVER --> API_TAGS
    OLLAMA_SERVER --> API_GENERATE
    OLLAMA_SERVER --> API_EMBED

    style OLLAMA_SERVER fill:#fce4ec
    style NOMIC fill:#f8bbd9
```

## 資料流

### AI 對話流程

```mermaid
sequenceDiagram
    participant U as 使用者
    participant UI as Web UI
    participant OC as OpenCode
    participant DB as 資料庫
    participant OL as Ollama

    U->>UI: 輸入提示詞
    UI->>OC: WebSocket 請求
    OC->>DB: 儲存對話記錄
    OC->>OL: 生成請求 (嵌入)
    OL-->>OC: 向量結果
    OC->>OL: 生成請求 (LLM)
    OL-->>OC: 生成回應
    OC->>DB: 儲存回應
    OC-->>UI: 串流回應
    UI-->>U: 顯示結果
```

### 嵌入向量流程（LanceDB）

```mermaid
flowchart LR
    A["文件/程式碼"] --> B["文本分割"]
    B --> C["嵌入模型<br/>nomic-embed-text"]
    C --> D["向量資料庫<br/>LanceDB"]
    D --> E["語意搜尋"]
    E --> F["上下文注入"]
    F --> G["LLM 生成"]

    style A fill:#e8f5e9
    style D fill:#e3f2fd
    style G fill:#fff3e0
```

## 網路架構

### 容器網路拓樸

```mermaid
graph TB
    subgraph "Host Network"
        HOST_PORT_8000[":8000"]
        HOST_PORT_11434[":11434"]
    end

    subgraph "Docker Bridge Network"
        subgraph "ai-dev"
            CONTAINER_3000["3000 (Web UI)"]
            CONTAINER_4095["4095 (OpenCode API)"]
        end

        subgraph "ollama"
            CONTAINER_11434["11434 (Ollama API)"]
        end
    end

    HOST_PORT_8000 -->|"映射"| CONTAINER_3000
    HOST_PORT_11434 -->|"映射"| CONTAINER_11434
    
    CONTAINER_3000 -.->|"內部"| CONTAINER_11434
    CONTAINER_4095 -.->|"內部"| CONTAINER_11434

    style HOST_PORT_8000 fill:#e8eaf6
    style HOST_PORT_11434 fill:#e8eaf6
    style CONTAINER_11434 fill:#fce4ec
```

### 環境變數配置

| 變數 | 用途 | 預設值 | 範圍 |
|------|------|--------|------|
| `CHAMBER_PORT` | Web UI 埠號 | 8000 | 主機 |
| `OLLAMA_PORT` | Ollama API 埠號 | 11434 | 主機 |
| `OLLAMA_BASE_URL` | Ollama 內部 URL | `http://ollama:11434` | 容器網路 |
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
        VOL_OLLAMA["ollama-data<br/>模型檔案"]
        VOL_GIT["git-config<br/>Git 設定"]
        VOL_SSH["ssh-keys<br/>SSH 金鑰"]
    end

    subgraph "容器路徑"
        C_WS["~/workspace"]
        C_DATA["~/.local/share/opencode"]
        C_CONFIG["~/.config/opencode"]
        C_CACHE["~/.cache/opencode"]
        C_OHMY["~/.cache/oh-my-opencode"]
        C_CHAMBER["~/.config/openchamber"]
        O_OLLAMA["/root/.ollama"]
        C_GIT["~/.config/git<br/>~/.gitconfig"]
        C_SSH["~/.ssh"]
    end

    VOL_WS --> C_WS
    VOL_DATA --> C_DATA
    VOL_CONFIG --> C_CONFIG
    VOL_CACHE --> C_CACHE
    VOL_OHMY --> C_OHMY
    VOL_CHAMBER --> C_CHAMBER
    VOL_OLLAMA --> O_OLLAMA
    VOL_GIT --> C_GIT
    VOL_SSH --> C_SSH

    style VOL_WS fill:#fff3e0
    style VOL_DATA fill:#e3f2fd
    style VOL_OLLAMA fill:#fce4ec
    style VOL_GIT fill:#e8f5e9
    style VOL_SSH fill:#e8f5e9
```

### 資料持久化策略

| 資料類型 | 儲存位置 | 保留策略 | 備份建議 |
|---------|---------|---------|---------|
| 專案檔案 | workspace | 重要 | 定期備份到 Git |
| 對話記錄 | opencode-data | 重要 | 定期匯出 |
| 使用者設定 | opencode-config | 重要 | 納入版本控制 |
| Git 設定 | git-config | 重要 | 包含 .gitconfig, .git-credentials |
| SSH 金鑰 | ssh-keys | 重要 | 包含 known_hosts |
| 快取資料 | opencode-cache | 可重建 | 不需備份 |
| AI 模型 | ollama-data | 可重建 | 不需備份 |
| UI 設定 | openchamber-data | 一般 | 不需備份 |

## 啟動流程

### 容器啟動順序

```mermaid
sequenceDiagram
    participant D as Docker Compose
    participant O as ollama
    participant I as init scripts
    participant A as ai-dev

    D->>O: 啟動 ollama 容器
    O->>O: 啟動 ollama 服務
    O->>O: 拉取 nomic-embed-text 模型
    O->>D: 健康檢查通過
    
    D->>A: 啟動 ai-dev 容器
    A->>I: 執行 entrypoint.d 腳本
    
    Note over I: 00-fix-perms.sh<br/>修復權限
    
    Note over I: 01-install-packages.sh<br/>安裝額外套件
    
    Note over I: 02-init-config.sh<br/>初始化設定檔
    
    Note over I: 03-fix-docker-gid.sh<br/>修復 Docker GID (需要 sudo)

    Note over I: 04-init-git-ssh.sh<br/>初始化 Git/SSH 設定 (named volumes)
    
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
    F --> G["執行 CMD"]
    
    B -->|"修復"| PERMS["Volume 權限"]
    C -->|"安裝"| PKGS["apt/brew/bun 套件"]
    D -->|"建立"| CONFIGS["預設設定檔"]
    E -->|"修正"| DOCKER["Docker 群組"]
    F -->|"初始化"| GITSETUP["Git/SSH 設定"]

    style A fill:#fff3e0
    style G fill:#c8e6c9
```

## 元件說明

### OpenCode

| 屬性 | 說明 |
|------|------|
| 功能 | 終端機 AI 程式碼助手 |
| 版本 | 1.3.13 |
| 設定檔 | `~/.config/opencode/opencode.json` |
| 資料庫 | `~/.local/share/opencode/opencode.db` |
| API 埠號 | 4095 (內部) |

### OpenChamber

| 屬性 | 說明 |
|------|------|
| 功能 | 瀏覽器 Web UI |
| 版本 | 1.9.3 |
| 設定檔 | `~/.config/openchamber/settings.json` |
| 服務埠號 | 3000 (映射至主機 8000) |
| 前端框架 | React |

### Ollama

| 屬性 | 說明 |
|------|------|
| 功能 | 本地 LLM 推論引擎 |
| 版本 | latest |
| 模型儲存 | `/root/.ollama/` |
| API 埠號 | 11434 |
| 預設模型 | nomic-embed-text (嵌入) |

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

| 插件 | 功能 | 說明 |
|------|------|------|
| `oh-my-opencode` | 核心框架 | OpenCode 基礎功能擴展 |
| `lancedb-opencode-pro` | 向量搜尋 | 基於 LanceDB 的程式碼索引 |

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
