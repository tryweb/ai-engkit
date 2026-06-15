# 安全政策

本文檔說明 OpenChamber 專案的安全考量、風險評估及最佳實踐。

## 目錄

- [安全架構](#安全架構)
- [風險評估矩陣](#風險評估矩陣)
- [資料存取範圍](#資料存取範圍)
- [安全最佳實踐](#安全最佳實踐)
- [漏洞回報流程](#漏洞回報流程)
- [安全設定檢查清單](#安全設定檢查清單)

## 安全架構

### 系統權限架構

```mermaid
graph TB
    subgraph "主機 (Host)"
        DOCKER["/var/run/docker.sock"]
        HOST_CREDS["~/.gitconfig / ~/.git-credentials<br/>~/.ssh/ / ~/.config/gh/"]
    end

    subgraph "容器 (Container) - devuser"
        C_DOCKER["/var/run/docker.sock<br/>(可存取)"]
        C_SSH["~/.ssh/<br/>(named volume ssh-keys)"]
        C_GIT["~/.gitconfig / ~/.git-credentials<br/>(named volume git-config)"]
        C_GH["~/.config/gh/<br/>(named volume gh-config)"]
        C_WS["workspace/"]
        C_DATA["opencode-data/"]
        C_CONFIG["opencode-config/"]
    end

    DOCKER -->|"掛載"| C_DOCKER
    HOST_CREDS -.->|"不掛載（隔離）"| C_SSH
    HOST_CREDS -.->|"不掛載（隔離）"| C_GIT
    HOST_CREDS -.->|"不掛載（隔離）"| C_GH

    style DOCKER fill:#ffcccc
    style C_DOCKER fill:#ffcccc
    style HOST_CREDS fill:#ccffcc
    style C_SSH fill:#e8f5e9
    style C_GIT fill:#e8f5e9
    style C_GH fill:#e8f5e9
```

> **設計重點**：容器內的 SSH 金鑰、git 認證、GitHub CLI 認證皆使用**獨立的 named volume**（`ssh-keys`、`git-config`、`gh-config`），由 `entrypoint.d/04-init-git-ssh.sh` 等腳本在首次啟動時建立空白檔案。**主機的認證資料完全不會被掛載進容器**，形成雙向隔離：容器被入侵時無法存取主機金鑰；主機的認證資料也不會暴露給容器內的程序。唯一跨邊界共享的是 Docker socket（必要的管理需求）。

### 安全威脅模型

```mermaid
graph LR
    subgraph "威脅來源"
        EXT["外部網路"]
        CONT["容器內程序"]
        IMG["第三方映像檔"]
    end

    subgraph "保護目標"
        HOST["主機系統"]
        CREDS["認證資訊"]
        DATA["開發資料"]
        DOCKER["Docker 守護程序"]
    end

    EXT -->|"網路存取"| CONT
    CONT -->|"可能逃逸"| HOST
    CONT -->|"直接存取"| CREDS
    CONT -->|"讀寫"| DATA
    CONT -->|"套件安裝"| IMG
    CONT -->|"API 呼叫"| DOCKER

    style EXT fill:#ffcc99
    style HOST fill:#99ffcc
    style CREDS fill:#ff9999
```

## 風險評估矩陣

| 風險項目 | 嚴重性 | 可能性 | 風險等級 | 緩解措施 |
|---------|--------|--------|---------|---------|
| Docker socket 存取 | 高 | 中 | 🔴 高 | 僅在信任環境使用 |
| SSH 金鑰存取 | 高 | 低 | 🟡 中 | 容器使用獨立 named volume `ssh-keys`（不掛載主機金鑰） |
| Git credential 洩漏 | 中 | 低 | 🟡 中 | 容器使用獨立 named volume（不與主機共用），降低雙向洩漏風險 |
| 容器逃逸 | 高 | 低 | 🟡 中 | 使用官方映像 + 定期更新 |
| 供應鏈攻擊 | 高 | 低 | 🟡 中 | 鎖定版本 + 漏洞掃描 |
| 預設密碼未更改 | 中 | 高 | 🟡 中 | 啟動時提醒修改 |

## 資料存取範圍

### 跨邊界共享資源（host bind mount）

| 路徑 | 掛載模式 | 說明 | 風險等級 |
|------|----------|------|---------|
| `/var/run/docker.sock` | 讀寫 | Docker API（唯一從主機掛載的資源） | 🔴 高 |

### 容器內獨立認證 volume（不從主機掛載）

| Volume 名稱 | 容器路徑 | 對應的 symlink | 說明 | 風險等級（容器被入侵時） |
|------|----------|------|---------|---------|
| `ssh-keys` | `~/.ssh/` | — | SSH 金鑰 | 🔴 高 |
| `git-config` | `~/.config/git/` | `~/.gitconfig`、`~/.git-credentials` | Git 認證資料 | 🔴 高 |
| `gh-config` | `~/.config/gh/` | — | GitHub CLI 認證 | 🟡 中 |

### 容器內部資料卷

```mermaid
graph TB
    subgraph "Docker Volumes（容器重啟後保留）"
        VOL_DATA["opencode-data<br/>對話記錄、資料庫"]
        VOL_CONFIG["opencode-config<br/>設定檔、插件"]
        VOL_CACHE["opencode-cache<br/>模型快取"]
        VOL_CHAMBER["openchamber-data<br/>主題、設定"]
        VOL_WS["workspace<br/>專案檔案"]
    end

    subgraph "主機目錄（若使用 bind mount）"
        HOST_WS["./workspace<br/>或自訂路徑"]
    end

    HOST_WS -.->|"可選"| VOL_WS

    style VOL_DATA fill:#e6f3ff
    style VOL_CONFIG fill:#e6f3ff
    style VOL_WS fill:#fff2e6
```

## 安全最佳實踐

### 1. 密碼設定

```bash
# 修改預設密碼
cat > .env << 'EOF'
OPENCODE_SERVER_PASSWORD=您的強密碼
OPENCHAMBER_UI_PASSWORD=您的強密碼
EOF
```

**密碼要求：**
- 長度至少 12 字元
- 包含大小寫字母、數字、特殊符號
- 不要使用常見密碼或個人資料

### 2. 網路隔離

```yaml
# docker-compose.yml 建議修改
services:
  ai-dev:
    # 移除不必要的埠號對外暴露
    ports:
      - "127.0.0.1:${CHAMBER_PORT:-8000}:3000"  # 僅本機存取
      - "127.0.0.1:${OLLAMA_PORT:-11434}:11434"  # 僅本機存取
```

### 3. SSH 金鑰管理

```mermaid
flowchart LR
    A["建立專用金鑰"] --> B["加入 SSH config"]
    B --> C["測試連線"]
    C --> D["使用金鑰"]
    D --> E["定期輪換"]

    subgraph "最佳實踐"
        F["使用 ssh-agent"]
        G["設定金鑰過期時間"]
        H["啟用雙因素認證"]
    end

    D --> F
    D --> G
    D --> H

    style A fill:#e6ffe6
    style E fill:#ffe6e6
```

### 4. Docker 安全

```bash
# 檢查容器權限
docker inspect ai-dev --format '{{.HostConfig.Privileged}}'
# 應該輸出 false

# 檢查能力設定
docker inspect ai-dev --format '{{.HostConfig.CapAdd}}'
# 應該是空的或最小化
```

### 5. 映像檔安全

- 使用官方映像檔（`ubuntu:24.04`）
- CI 已整合 Grype 漏洞掃描
- 定期更新至最新版本

## 漏洞回報流程

```mermaid
sequenceDiagram
    participant R as 回報者
    participant T as 維護者
    participant S as 安全修補

    R->>T: 發現漏洞
    Note over R,T: 請勿公開問題
    T->>T: 評估嚴重性
    alt 嚴重漏洞
        T->>S: 建立私有修補分支
        S->>S: 開發修補
        S->>S: 內部測試
        S->>T: 發布修補版本
        T->>R: 通知修補完成
        T->>R: 公開漏洞資訊
    else 一般問題
        T->>T: 建立公開 Issue
        T->>S: 正常修復流程
    end
```

### 回報方式

1. **安全性漏洞**：請透過以下方式私密回報
   - Email: tryweb@ichiayi.com
   - 主題：`[SECURITY] OpenChamber 漏洞回報`

2. **一般問題**：使用 GitHub Issues

### 回報內容應包含

- 漏洞描述
- 重現步驟
- 影響範圍
- 建議修補方案（如有）

## 安全設定檢查清單

### 初次部署

- [ ] 變更 `OPENCODE_SERVER_PASSWORD` 預設值
- [ ] 變更 `OPENCHAMBER_UI_PASSWORD` 預設值
- [ ] 確認不需要 SSH 金鑰時，移除相關掛載
- [ ] 評估是否需要 Docker socket 存取
- [ ] 設定防火牆限制存取來源

### 定期檢查

- [ ] 每月更新映像檔版本
- [ ] 檢查依賴套件漏洞
- [ ] 審查存取日誌
- [ ] 輪換密碼和金鑰

### 開發環境 vs 生產環境

| 項目 | 開發環境 | 生產環境 |
|------|---------|---------|
| Docker socket | 可啟用 | 應禁用 |
| SSH 金鑰 | 可掛載 | 不建議 |
| 埠號綁定 | 0.0.0.0 | 127.0.0.1 |
| 預設密碼 | 可接受 | 必須修改 |
| 日誌級別 | DEBUG | WARN/ERROR |

## 版本管理與 CVE 追蹤

### 關鍵元件版本

Dockerfile 中的版本號應定期更新以修補安全漏洞。以下是目前的版本與建議：

| 元件 | Dockerfile 行號 | 目前版本 | 最新穩定版 | 狀態 |
|------|-----------------|---------|-----------|------|
| Docker CLI | L5, L54-57 | 29.4.0 | 29.4.0 | 🟢 已是最新 |
| Docker Compose Plugin | L6, L61-64 | 5.1.2 | 5.1.2 | 🟢 已是最新 |
| Ubuntu Base | L1 | 24.04 | 24.04 | 🟢 穩定 |
| OpenCode | L7 | 1.3.12 | see opencode.ai | 需評估 |
| OpenChamber | L8 | 1.9.4 | see openchamber.dev | 需評估 |
| Bun | L90 | latest | latest | 🟢 自動更新 |

### 已知 CVE 清單

以下列出關鍵元件的已知 CVE（僅列 Critical/High）：

#### Docker Compose Plugin (v5.1.2) — ✅ 已升級

**狀態**: 2026-04-10 升級至 v5.1.2，原 v2.24.5 的 ~68 個 alerts 已消除。

> **注意**: 新版本仍可能有新 CVE，請定期檢查 GitHub Security Advisories。

#### Docker CLI (v29.4.0) — ✅ 已升級

**狀態**: 2026-04-10 升級至 v29.4.0，原 v25.0.4 的 ~20 個 alerts 已消除。

> **注意**: 新版本仍可能有新 CVE，請定期檢查 GitHub Security Advisories。

#### Ubuntu apt 套件

apt 套件層的 CVE 需依賴 Ubuntu upstream 修補，`UPGRADE_PACKAGES=true` 已是正確策略。

主要受影響套件：
- `build-essential` / `binutils`: ~40 個 alerts (High)
- `python3-pip`: 4 個 alerts (High)
- `vim` / `vim-runtime`: 3 個 alerts (High)
- `openssh-client`: 1 個 alert (High)

> **建議**: 評估移除非必要套件（vim, python3-pip），考慮 multi-stage build 隔離編譯工具

### 版本更新流程

```mermaid
flowchart TD
    A[收到 CVE 通知] --> B{嚴重性}
    B -->|Critical| C[立即處理]
    B -->|High| D[排入 sprint]
    B -->|Medium/Low| E[定期檢視]
    
    C --> F[更新 Dockerfile ARG]
    D --> F
    F --> G[本地測試]
    G --> H{測試通過?}
    H -->|是| I[提交 PR]
    H -->|否| J[問題排查]
    J --> F
    I --> K[CI/CD 驗證]
    K --> L[合併至 main]
    
    style C fill:#ff9999
    style D fill:#ffcc99
    style E fill:#ccff99
```

### 更新檢查命令

```bash
# 檢查 Docker CLI 最新版本
curl -s https://api.github.com/repos/moby/moby/releases/latest | jq -r '.tag_name'

# 檢查 Docker Compose 最新版本
curl -s https://api.github.com/repos/docker/compose/releases/latest | jq -r '.tag_name'

# 檢查 Ubuntu 套件更新
apt-get update && apt-get list --upgradable

# 執行漏洞掃描
grype codeforge:latest
```

### 待處理事項

詳細的技術債務和安全改進事項請參閱 [backlog.md](./backlog.md)。

---

## 相關資源

- [Docker 安全最佳實踐](https://docs.docker.com/engine/security/)
- [OWASP 容器安全](https://owasp.org/www-project-container-security/)
- [Ubuntu 安全指南](https://ubuntu.com/security)
- [GitHub Security Advisories](https://github.com/advisories)

---

> ⚠️ **重要提醒**：本專案設計用於受信任的開發環境。在不受信任的網路環境中使用前，請務必審慎評估安全風險。
