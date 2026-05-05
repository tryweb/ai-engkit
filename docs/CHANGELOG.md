# 變更日誌

本檔案記錄 CodeForge 專案的所有重要變更。

格式基於 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.0.0/)，並且本專案遵循 [語義化版本](https://semver.org/lang/zh-TW/)。

## [Unreleased]

## [0.8.1] - 2026-05-06

### 修復
- fix(ci): symlink skills directly from baked image instead of copying to cache
- fix(ci): remove tmpfs mounts that conflict with named volumes
- fix(ci): bake superpowers into image to survive volume mounts
- fix(ci): preserve plugin cache and increase warm-up timeouts

## [0.8.0] - 2026-05-05

### 新增
- Superpowers plugin (Agentic skills 框架) 加入預設 plugins
  - 14 個 skills: brainstorming, systematic-debugging, test-driven-development, etc.
- `docker-compose.yml` 預設值加入 superpowers，不設定 `.env` 即可使用
- `entrypoint.d/02-init-config.sh` 自動建立 superpowers skills symlink
  - 解決 OpenCode #20940 bug：plugin config() hook 修改 skills.paths 對 skill discovery 不可見
  - 所有既有專案都能自動發現 superpowers skills

### 變更
- `.env.example` 預設 plugins 改為 `oh-my-openagent,superpowers@git+https://github.com/obra/superpowers.git`
- 移除 `lancedb-opencode-pro` 相關 release 測試（插件已不再使用）

## [0.7.1] - 2026-05-04

### 修復
- 修正 CI integration tests 中 superpowers plugin 檢測失敗問題（使用 explicit shell 包裝 jq 命令）
- 修正 docker-compose.dev.yml 中 OPENCODE_PLUGINS 環境變數配置
- 修正 entrypoint.d/02-init-config.sh 一致性問題

## [0.7.0] - 2026-05-04

### 新增
- 安裝 graphify（知識圖譜工具）透過 uv tool install graphifyy
- 新增 superpowers plugin（Agentic skills 框架）
- 新增 graphify 和 superpowers 驗證測試至 run-tests.sh

### 變更
- 移除 lancedb-opencode-pro plugin（導致 release test 失敗）

## [0.6.2] - 2026-04-25

### 變更
- OpenCode 版本更新至 1.14.33
- OpenChamber 版本更新至 1.9.10

## [0.6.1] - 2026-04-24

### 修復
- 修正 entrypoint.sh 中 `exec sudo -E -u devuser -- env PATH="$PATH" "$@"` 重新執行，讓 `openchamber serve` 繼承 entrypoint.d 腳本修改後的 `/etc/group` 附屬群組（docker GID）
- 此問題導致 OpenChamber WebUI 終端機執行 `docker ps` 出現 `permission denied`

## [0.6.0] - 2026-04-23

### 新增
- Add docker buildx v0.32.1 installation for multi-platform builds
- Add git credential.helper store configuration on startup

### 修復
- Fix git credential.helper to use sudo -u devuser HOME=... (avoid writing to /root)

## [0.5.16] - 2026-04-22

### 變更
- OpenCode 版本更新至 1.14.20
- OpenChamber 版本更新至 1.9.7

## [0.5.15] - 2026-04-17

### 變更
- OpenCode 版本更新至 1.4.7

## [0.5.14] - 2026-04-15

### 變更
- OpenChamber 版本更新至 v1.9.5

## [0.5.13] - 2026-04-12

### 修復
- 移除 `NAPI_RS_FORCE_WASI` 環境變數以修復 LanceDB 初始化問題 (lancedb/lancedb#3267)
- 修復 CI workflow 中的 docker compose 問題

## [0.5.12] - 2026-04-11

### 修復
- 移除 `entrypoint.sh` 中的 `sg docker` 包裝，解決環境變數繼承問題
  - 此問題導致 `memory_stats` 等 tool 回報 "ollama embedding service appears to be offline"
- 新增 `entrypoint.d/02-init-config.sh` 中的 stale plugin cache 清理機制
- `docker-compose.dev.yml` hardcode plugins 避免 host shell 污染環境變數
- 修正 `.env.example` 中的 plugin 名稱 (`oh-my-opencode` → `oh-my-openagent`)
- 修復 `test/test-memory-e2e.sh` 測試腳本

### 新增
- 新增 memory plugin 設定說明到 README.md

## [0.5.11] - 2026-04-10

### 新增
- 新增 glab-config volume 讓 glab (GitLab CLI) 認證資料可以持久化
- 新增 06-init-glab-cli.sh 初始化腳本，自動建立 ~/.config/glab-cli 目錄
- 更新 00-fix-perms.sh 加入 glab-cli, gh, ssh, git 的權限修復

## [0.5.10] - 2026-04-10

### 新增
- OpenCode 版本更新至 1.4.3

## [0.5.9] - 2026-04-10

### 安全修復
- Docker CLI 升級：v25.0.4 → v29.4.0（消除 ~20 個 CVE alerts）
- Docker Compose 升級：v2.24.5 → v5.1.2（消除 ~68 個 CVE alerts，含 6 個 Critical）
- 新增 docs/backlog.md 記錄安全技術債務
- 新增 docs/SECURITY.md 版本追蹤章節

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
