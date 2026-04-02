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
        SSH["~/.ssh/"]
        GIT["~/.gitconfig<br/>~/.git-credentials"]
        GH["~/.config/gh/"]
        DOCKER["/var/run/docker.sock"]
    end

    subgraph "容器 (Container) - devuser"
        C_SSH["~/.ssh/ (唯讀)"]
        C_GIT["~/.gitconfig (唯讀)<br/>~/.git-credentials (唯讀)"]
        C_GH["~/.config/gh/ (唯讀)"]
        C_DOCKER["/var/run/docker.sock<br/>(可存取)"]
        C_WS["workspace/"]
        C_DATA["opencode-data/"]
        C_CONFIG["opencode-config/"]
    end

    SSH -->|"唯讀掛載"| C_SSH
    GIT -->|"唯讀掛載"| C_GIT
    GH -->|"唯讀掛載"| C_GH
    DOCKER -->|"共用"| C_DOCKER

    style SSH fill:#ffcccc
    style C_SSH fill:#ffcccc
    style DOCKER fill:#ff9999
    style C_DOCKER fill:#ff9999
```

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
| SSH 金鑰存取 | 高 | 低 | 🟡 中 | 掛載為唯讀 |
| Git credential 洩漏 | 中 | 低 | 🟡 中 | 唯讀掛載 + 環境隔離 |
| 容器逃逸 | 高 | 低 | 🟡 中 | 使用官方映像 + 定期更新 |
| 供應鏈攻擊 | 高 | 低 | 🟡 中 | 鎖定版本 + 漏洞掃描 |
| 預設密碼未更改 | 中 | 高 | 🟡 中 | 啟動時提醒修改 |

## 資料存取範圍

### 已掛載至容器的主機路徑

| 路徑 | 掛載模式 | 說明 | 風險等級 |
|------|----------|------|---------|
| `~/.ssh/` | 唯讀 | SSH 金鑰及設定 | 🔴 高 |
| `~/.ssh/known_hosts` | 讀寫 | 已知主機列表 | 🟢 低 |
| `~/.gitconfig` | 唯讀 | Git 全域設定 | 🟢 低 |
| `~/.git-credentials` | 唯讀 | Git 認證資訊 | 🔴 高 |
| `~/.config/gh/` | 唯讀 | GitHub CLI 設定 | 🟡 中 |
| `/var/run/docker.sock` | 讀寫 | Docker API | 🔴 高 |

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

- 使用官方映像檔（`ollama/ollama:latest`、`ubuntu:24.04`）
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

## 相關資源

- [Docker 安全最佳實踐](https://docs.docker.com/engine/security/)
- [OWASP 容器安全](https://owasp.org/www-project-container-security/)
- [Ubuntu 安全指南](https://ubuntu.com/security)

---

> ⚠️ **重要提醒**：本專案設計用於受信任的開發環境。在不受信任的網路環境中使用前，請務必審慎評估安全風險。
