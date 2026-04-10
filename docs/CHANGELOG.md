# 變更日誌

本檔案記錄 CodeForge 專案的所有重要變更。

格式基於 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.0.0/)，並且本專案遵循 [語義化版本](https://semver.org/lang/zh-TW/)。

## [Unreleased]

## [0.5.8] - 2026-04-10

### 修復
- 安裝 Docker Compose 作為 plugin（取代獨立的 docker-compose 二進制檔案）
- 更新 test-memory-e2e.sh 使用 hook-based 測試方法
- 更新 release-memory-test.sh 使用 `docker compose` 命令

### 新增
- OpenCode 版本更新至 1.3.12

## [0.5.6] - 2026-04-08

### 新增
- 新增 05-init-gh-cli.sh 初始化腳本，自動建立 ~/.config/gh 目錄
- 新增 gh-config-dev volume 至 docker-compose.dev.yml

### 變更
- entrypoint.sh 新增 05-init-gh-cli.sh 使用 sudo 執行
- 更新 docs/ARCHITECTURE.md 加入 gh-config volume 說明
- 更新 docs/TROUBLESHOOTING.md 加入 GitHub CLI 權限故障排除

## [0.5.5] - 2026-04-08

### 新增
- 新增 gh-config named volume 讓 gh auth 資料可以持久化

## [0.5.4] - 2026-04-08

### 新增
- 新增完整 Memory E2E 測試腳本 (test-memory-e2e.sh)
- 新增 Memory plugin 重試機制 (最多 3 次)
- Release skill 新增版本資訊提取步驟
- README.md 新增版本徽章

### 變更
- OpenCode 版本降級至 1.3.7 (相容 lancedb-opencode-pro)
- OpenChamber 版本升級至 1.9.4
- 修正 docker-compose 命令相容性問題
- 修正 release-memory-test.sh 容器名稱 (codeforge-dev, ollama-dev)

### 修復
- 修正 Memory plugin 在 OpenCode 1.3.7 下的初始化問題
- 修正 release-memory-test.sh 測試失敗應停止的邏輯

## [0.5.2] - 2026-04-07

### 修復
- 修正 CI workflow 中的 sed 命令，正確替換 container name

## [0.5.1] - 2026-04-07

### 新增
- Release skill 新增檢查文檔更新步驟

### 變更
- 重新排序 release 步驟，先檢查文檔再 commit

### 修復
- 修正 dev 環境 OLLAMA_BASE_URL 被主機環境覆蓋的問題

## [0.5.0] - 2026-04-07

### 新增
- 新增多模型切換功能
- 新增 named volume 作為預設 workspace
- 新增 glab (GitLab CLI)

### 變更
- 使用 named volumes 作為預設儲存策略
- 更新 install.sh 與 .env.example

### 架構
- 改善 entrypoint 腳本

## [0.3.3] - 2026-04-02

### 新增
- 初始版本發布
- 基於 Ubuntu 24.04 的 Docker 開發環境
- 整合 OpenCode AI 程式碼助手 (v1.3.13)
- 整合 OpenChamber Web UI (v1.9.3)
- 整合 Ollama 本地 LLM 推論引擎
- 支援 LanceDB 向量搜尋插件
- 內建 GitHub CLI
- 完整的開發工具鏈（git, python, tmux, jq 等）
- 自動化 CI/CD 流程
- 漏洞掃描（Grype）
- 整合測試套件（39 個測試項目）

### 架構
- 雙容器設計（ai-dev + ollama）
- Docker named volumes 資料持久化
- 支援 bind mount 本地開發模式
- 健康檢查與自動重啟
- 動態套件安裝支援

## [0.3.0] - 2026-04-02

### 新增
- `docs/SECURITY.md` - 安全政策文件
- `docs/TROUBLESHOOTING.md` - 故障排除指南
- `docs/ARCHITECTURE.md` - 架構說明文件
- `docs/CONTRIBUTING.md` - 貢獻指南

### 變更
- 改善 README.md 文件結構


---

## 版本格式說明

### 類型

- `新增` - 新功能
- `變更` - 現有功能的變更
- `棄用` - 即將移除的功能
- `移除` - 已移除的功能
- `修復` - Bug 修復
- `安全性` - 安全相關變更

### 範例

```markdown
## [1.1.0] - 2026-04-15

### 新增
- 新增 GPU 支援
- 新增多模型切換功能

### 變更
- 升級 Ollama 至最新版本

### 修復
- 修正容器重啟問題
- 修正權限錯誤
```

---

> 📖 本日誌格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.0.0/) 規範。
