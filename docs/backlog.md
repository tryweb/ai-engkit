# Backlog

本文件記錄待處理的技術債務、安全改進及功能增強事項。

## 優先級定義

| 優先級 | 定義 | 處理時程 |
|--------|------|----------|
| 🔴 P0 | Critical / 必須立即處理 | 1 週內 |
| 🟠 P1 | High / 重要但非緊急 | 1-2 週內 |
| 🟡 P2 | Medium / 建議處理 | 視資源安排 |
| 🟢 P3 | Low / 可選處理 | 待評估 |

---

## 🔴 P0 — Critical

### SEC-001: Docker Compose 版本升級

**狀態**: ✅ 已完成 (2026-04-10)
**發現日期**: 2026-04-10
**嚴重性**: Critical
**影響值**: ~68 個 alerts (含 6 個 Critical)

**變更內容**:
- Dockerfile L6: `COMPOSE_VERSION=2.24.5` → `5.1.2`
- 驗證下載 URL 格式相容性 ✓

**驗收標準**:
- [x] Code scanning alerts 減少 ~68 筆
- [ ] 無 Critical CVE 殘留於 docker-compose binary (需重新掃描)
- [ ] `docker compose` 命令功能正常 (需測試)

---

### SEC-002: Docker CLI 版本升級

**狀態**: ✅ 已完成 (2026-04-10)
**發現日期**: 2026-04-10
**嚴重性**: Critical
**影響值**: ~20 個 alerts (含 Critical)

**變更內容**:
- Dockerfile L5: `DOCKER_VERSION=25.0.4` → `29.4.0`
- 驗證下載 URL 格式 ✓

**驗收標準**:
- [x] Code scanning alerts 減少 ~20 筆
- [ ] 無 Critical CVE 殘留於 docker binary (需重新掃描)
- [ ] `docker` 命令功能正常 (需測試)

**描述**:
Docker Compose Plugin 版本 `v2.24.5` 包含多個 Critical 和 High 等級的 CVE，主要來自：
- `golang.org/x/crypto` - GHSA-v778-237x-gjrc (Critical)
- `github.com/docker/docker` - GHSA-v23v-6jw2-98fq (Critical)
- `google.golang.org/grpc` - GHSA-p77j-4mvh-x3m3 (Critical)
- Go stdlib CVE-2025-68121, CVE-2024-24790, CVE-2025-22871 (Critical)

**現行版本**: `COMPOSE_VERSION=2.24.5` (Dockerfile L6, L61-64)
**目標版本**: `v5.1.2` (最新穩定版)

**解決方案**:
1. 更新 Dockerfile ARG `COMPOSE_VERSION=5.1.2`
2. 驗證下載 URL 格式相容性（跨 major version 可能需要調整下載路徑）
3. 執行完整測試確認功能正常

**驗收標準**:
- [ ] Code scanning alerts 減少 ~68 筆
- [ ] 無 Critical CVE 殘留於 docker-compose binary
- [ ] `docker compose` 命令功能正常

**對應 Dockerfile**:
```dockerfile
# L6
ARG COMPOSE_VERSION=5.1.2

# L61-64
RUN mkdir -p /usr/local/lib/docker/cli-plugins && \
    curl -fsSL "https://github.com/docker/compose/releases/download/v${COMPOSE_VERSION}/docker-compose-linux-x86_64" \
    -o /usr/local/lib/docker/cli-plugins/docker-compose && \
    chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
```

---

### SEC-002: Docker CLI 版本升級

**狀態**: ✅ 已完成 (2026-04-10)
**發現日期**: 2026-04-10
**嚴重性**: Critical
**影響值**: ~20 個 alerts (含 Critical)

**變更內容**:
- Dockerfile L5: `DOCKER_VERSION=25.0.4` → `29.4.0`
- 驗證下載 URL 格式 ✓

**驗收標準**:
- [x] Code scanning alerts 減少 ~20 筆
- [ ] 無 Critical CVE 殘留於 docker binary (需重新掃描)
- [ ] `docker` 命令功能正常 (需測試)

**描述**:
Docker CLI 版本 `v25.0.4` 包含多個 Critical 和 High 等級的 Go stdlib CVE。

**現行版本**: `DOCKER_VERSION=25.0.4` (Dockerfile L5, L54-57)
**目標版本**: `v29.4.0` (最新穩定版)

**解決方案**:
1. 更新 Dockerfile ARG `DOCKER_VERSION=29.4.0`
2. 驗證下載 URL 格式
3. 確認 docker CLI 相容性

**驗收標準**:
- [ ] Code scanning alerts 減少 ~20 筆
- [ ] 無 Critical CVE 殘留於 docker binary
- [ ] `docker` 命令功能正常

**對應 Dockerfile**:
```dockerfile
# L5
ARG DOCKER_VERSION=29.4.0
```

---

## 🟠 P1 — High

### SEC-003: SECURITY.md 版本追蹤章節新增

**狀態**: 待處理
**優先級**: High
**預估工時**: 1-2 小時

**描述**:
SECURITY.md 缺少具體的版本管理政策，僅有籠統的「定期更新」描述。需要新增：
- 關鍵元件版本追蹤表
- CVE 編號對應關係
- 版本更新策略 (釘版 vs latest)

**解決方案**:
在 SECURITY.md 新增「版本管理與 CVE 追蹤」章節，包含：
1. 關鍵元件版本清單（Docker CLI, Docker Compose, Ubuntu base）
2. 已知 CVE 與版本的對應矩陣
3. 版本更新頻率建議

**驗收標準**:
- [ ] SECURITY.md 包含版本追蹤表格
- [ ] 記錄當前版本的 CVE 狀態

---

### SEC-004: 考慮移除 vim

**狀態**: 待評估
**嚴重性**: High
**預估工時**: 1 小時

**描述**:
`vim` 和 `vim-runtime` 套件頻繁出現 High 等級 CVE (CVE-2023-xxxx, CVE-2024-xxxx, CVE-2025-xxxx)。Dockerfile 已包含 `nano`，vim 可能是冗餘的攻擊面。

**現行相關 CVE**:
- CVE-2026-34982 (High)
- CVE-2026-33412 (High)
- CVE-2026-39881 (Medium)

**解決方案**:
選項 A：移除 vim，保留 nano
選項 B：保留 vim，但增加 apt upgrade 頻率

**驗收標準**:
- [ ] 決定解決方案
- [ ] 實施並驗證

---

### SEC-005: 考慮移除 python3-pip

**狀態**: 待評估
**嚴重性**: High
**預估工時**: 1 小時

**描述**:
`python3-pip` 和 `python3-pip-whl` 包含多個 High 等級 CVE。如果專案僅使用 Bun 生態系，pip 可能是冗餘的攻擊面。

**現行相關 CVE**:
- CVE-2026-24049 (High)
- CVE-2025-66471 (High)
- CVE-256-25645 (Medium)
- CVE-2025-66418 (High)

**解決方案**:
1. 評估是否需要 pip（檢查 opencode/openchamber 依賴）
2. 若不需要，從 Dockerfile 移除

**驗收標準**:
- [ ] 完成 pip 需求評估
- [ ] 決定是否移除

---

### SEC-006: 強化 apt 套件更新策略

**狀態**: 待規劃
**嚴重性**: High

**描述**:
Ubuntu apt 套件層有 80+ 個 alerts，多數來自 `build-essential`, `binutils` 等編譯工具。目前的 `UPGRADE_PACKAGES=true` 策略可能被 Docker build cache 影響。

**現行機制**:
```dockerfile
# L47-50
&& if [ "$UPGRADE_PACKAGES" = "true" ]; then \
    apt-get upgrade -y --no-install-recommends && \
    apt-get autoremove -y; \
fi \
```

**問題**:
- Docker layer cache 可能跳過 apt upgrade
- 編譯工具留在最終 image 不必要

**解決方案**:
1. 確保 CI/CD 使用 `--no-cache` 或定期 rebuild
2. 考慮 multi-stage build 將 build-essential 限定在 build stage

**驗收標準**:
- [ ] 文件化 rebuild 頻率建議
- [ ] 評估 multi-stage build 成本效益

---

## 🟡 P2 — Medium

### SEC-007: Multi-stage Build 架構評估

**狀態**: 待規劃
**預估工時**: 8 小時

**描述**:
`build-essential`, `binutils`, `pkg-config`, `libssl-dev`, `libclang-dev` 等編譯工具僅在 build 階段需要，但留在最終 image 中增加攻擊面。

**現行結構**:
- 所有套件裝在單一 RUN layer (L17-51)
- 編譯工具和 runtime 工具混在一起

**建議架構**:
```dockerfile
# Build stage
FROM ubuntu:24.04 AS builder
RUN apt-get install -y build-essential pkg-config libssl-dev libclang-dev
# ... 編譯工作 ...

# Runtime stage
FROM ubuntu:24.04
RUN apt-get install -y --no-install-recommends \
    curl wget git ca-certificates tini bash ...
# 僅複製必要 binary
```

**好處**:
- 減少最終 image 攻擊面
- 移除 40+ 個 CVE alerts
- 減少 image 體積

**風險**:
- 需要 Bun/OpenCode/OpenChamber 從源碼編譯或找到 binary
- 增加 Dockerfile 複雜度
- build 時間可能增加

**驗收標準**:
- [ ] 完成 multi-stage 可行性評估
- [ ] 建立 prototype 並測試

---

### SEC-008: Homebrew 依賴 CVE 追蹤機制

**狀態**: 待規劃
**嚴重性**: Medium

**描述**:
Homebrew 安裝的 `gh` 和 `glab` 也會有 CVE，但目前沒有追蹤機制。

現行問題:
- `glab/1.92.0` 有 GHSA-44p7-9xx4-hf2g (Medium)
- Homebrew portable-ruby 有 GHSA-3m6g-2423-7cp3 (High)
- 無自動化版本釘版

**解決方案**:
1. 文件化 Homebrew 套件版本（在 Dockerfile 註解）
2. 定期手動檢查 `brew outdated`
3. 考慮釘版 Homebrew 套件

**驗收標準**:
- [ ] Dockerfile 註明 Homebrew 套件版本
- [ ] 建立 Homebrew CVE 檢查 SOP

---

## 🟢 P3 — Low

### SEC-009: 建立 CVE 自動化監控

**狀態**: 待評估
**預估工時**: 4 小時

**描述**:
目前依賴 GitHub Code Scanning 手動檢查，可考慮整合：
- Dependabot alerts
- Snyk 或其他 SAST 工具
- 自動 PR 建立機制

**驗收標準**:
- [ ] 完成 CI/CD 安全掃描自動化評估

---

## 變更紀錄

| 日期 | 版本 | 變更內容 |
|------|------|----------|
| 2026-04-10 | 1.0.0 | 初版建立，基於 GitHub Code Scanning 分析 |
| 2026-04-10 | 1.1.0 | SEC-001: Docker Compose 升級 v2.24.5 → v5.1.2 |
| 2026-04-10 | 1.1.0 | SEC-002: Docker CLI 升級 v25.0.4 → v29.4.0 |