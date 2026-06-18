# 變更日誌

本檔案記錄 CodeForge 專案的所有重要變更。

格式基於 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.0.0/)，並且本專案遵循 [語義化版本](https://semver.org/lang/zh-TW/)。

## [Unreleased]

## [0.12.6] - 2026-06-18

### 修復
- auto-start dev container and detect container name in release skill

### 變更
- install glab from official release binary

## [0.12.5] - 2026-06-18

### 變更
- 升級 Docker Buildx 0.34.1 → 0.35.0
- 升級 OpenChamber 1.13.1 → 1.13.2

## [0.12.4] - 2026-06-17

### 變更
- 升級 OpenCode 1.17.7 → 1.17.8
- 更新 oh-my-openagent 最新追蹤版本 4.10.0 → 4.11.0
- 更新 lean-ctx 最新追蹤版本 v3.8.7 → v3.8.8

## [0.12.3] - 2026-06-17

### 變更
- 升級 OpenChamber 1.13.0 → 1.13.1

## [0.12.2] - 2026-06-16

### 變更
- 更新 lean-ctx 最新追蹤版本至 v3.8.7

## [0.12.1] - 2026-06-16

### 變更
- 升級 OpenChamber 1.12.4 → 1.13.0
- 升級 Playwright 1.60.0 → 1.61.0

## [0.12.0] - 2026-06-15

### 新增
- 新增 lean-ctx XDG Base Directory 支援（v3.8.5+）
  - Dockerfile: 新增 `BASH_ENV` / `CLAUDE_ENV_FILE`，讓 bash 自動載入 lean-ctx 環境
  - Dockerfile: 預建 `~/.local/share/lean-ctx`、`~/.local/state/lean-ctx`、`~/.cache/lean-ctx` 目錄
  - Dockerfile: 新增 `lean-ctx-data` / `lean-ctx-state` volumes，確保持久化向量索引、知識庫與 sessions
  - docker-compose.yml / docker-compose.dev.yml: 新增 `lean-ctx-data` / `lean-ctx-state` named volumes
  - entrypoint.d/00-fix-perms.sh: 新增 lean-ctx 目錄權限修復
  - entrypoint.d/02-init-config.sh: 自動偵測舊版 single-dir 佈局並執行 `lean-ctx doctor --fix` 遷移
  - docs/ARCHITECTURE.md: 新增 lean-ctx volumes 至架構圖與持久化策略表

### 移除
- 移除 Ollama 本地 LLM 推論引擎（docker-compose、Dockerfile、entrypoint、docs、tests）
- 移除 lancedb-opencode-pro OpenCode plugin（entrypoint、tests、docs）

## [0.11.10] - 2026-06-14

### 變更
- 升級 OpenCode 1.17.6 → 1.17.7

## [0.11.9] - 2026-06-14

### 變更
- 更新 APT 套件

## [0.11.8] - 2026-06-14

### 變更
- 更新 APT 套件

## [0.11.7] - 2026-06-14

### 變更
- 升級 OpenCode 1.17.4 → 1.17.6

## [0.11.6] - 2026-06-13

### 變更
- 更新 lean-ctx 最新追蹤版本至 v3.8.4
- 更新 APT 套件

## [0.11.5] - 2026-06-13

### 變更
- 更新 lean-ctx 最新追蹤版本至 v3.8.3
- 更新 APT 套件

## [0.11.4] - 2026-06-11

### 修復
- 分離 Playwright core 與 `@playwright/mcp` 的版本管理
  - 獨立管理 Playwright core（1.60.0）與 `@playwright/mcp`（0.0.76）版本，修正先前強制兩者版本必須一致的錯誤假設

### 變更
- 調整 CI：映像只建置一次，並透過 artifact 在 jobs 間共享

## [0.11.3] - 2026-06-11

### 變更
- 鎖定 Playwright 版本為 1.60.0，並新增執行期 smoke tests

## [0.11.2] - 2026-06-11

### 新增
- 新增 `vuln-scan` skill，用於漏洞掃描與版本稽核

### 變更
- 升級 Docker 29.4.1 → 29.5.3、Compose 5.1.2 → 5.1.4、Buildx 0.33.0 → 0.34.1

## [0.11.1] - 2026-06-11

### 變更
- 升級 OpenCode 1.16.2 → 1.17.3
- 升級 OpenChamber 1.12.3 → 1.12.4

## [0.11.0] - 2026-06-06

### 新增
- 將 Playwright 瀏覽器加入 Docker image，支援 MCP server 與測試流程
  - 安裝 Chromium 瀏覽器（約 291 MB）與 97 個系統相依套件
  - 同時支援 Playwright MCP 瀏覽器自動化與 Playwright 測試執行器

## [0.10.0] - 2026-06-06

### 新增
- 新增 lean-ctx MCP server，提供 context engineering 能力
  - 在 Dockerfile 透過 universal installer 安裝 lean-ctx v3.7.5
  - 在 entrypoint.d/02-init-config.sh 增加 lean-ctx MCP server 設定區塊
  - 提供 69 個 MCP tools（如 `ctx_read`、`ctx_shell`、`ctx_search`、`ctx_tree`）

### 變更
- 升級 OpenCode 1.16.0 → 1.16.2
- 升級 OpenChamber 1.12.1 → 1.12.3

## [0.9.3] - 2026-06-05

### 變更
- 升級 OpenCode 1.15.13 → 1.16.0

## [0.9.2] - 2026-06-05

### 變更
- 升級 `@openchamber/web` 1.11.7 → 1.12.1

## [0.9.1] - 2026-06-02

### 新增
- 將 Playwright MCP 烘焙到 image，讓 AI 代理能原生驅動瀏覽器
  - Dockerfile: 在 `/etc/opencode/opencode.json.default` 模板加入 Playwright MCP 設定
  - entrypoint.d/02-init-config.sh: 重生成 `~/.config/opencode/opencode.json` 時也帶入 Playwright MCP，避免被覆蓋
  - test/run-tests.sh: 新增兩個斷言，驗證 Playwright MCP 設定存在且使用 `bunx`
  - 以原生 MCP 工具取代「AI 自行撰寫 Playwright 腳本 + bash 執行」的舊工作流
  - 新開發者無需手動安裝 `@playwright/mcp`

### 變更
- 升級 `@openchamber/web` 1.10.4 → 1.11.7
- 升級 OpenCode 1.14.48 → 1.15.13（[release notes](https://github.com/anomalyco/opencode/releases/tag/v1.15.13)）
- 將 graphify（graphifyy）知識圖譜工具替換為 `@colbymchenry/codegraph`
  - Dockerfile: `uv tool install graphifyy` → `bun install -g @colbymchenry/codegraph`
  - README.md 與測試腳本同步更新
- 新增 Git Authentication 章節給首次使用者
- 修正文檔中的 credential volume 掛載說明
- 補充 glab credential helper 版本化路徑問題說明（#4）

### 修復
- 釐清 host 與 container 驗證資訊隔離行為

## [0.8.3] - 2026-05-13

### 修復
- 移除阻塞式 OpenCode warm-up 步驟，並提高 CI job timeout

## [0.8.2] - 2026-05-13

### 變更
- 升級 OpenCode 1.14.33 → 1.14.48
- 升級 OpenChamber 1.9.10 → 1.10.4

## [0.8.1] - 2026-05-06

### 修復
- 讓 skills 直接從 baked image 建立 symlink，而非複製到 cache
- 移除會與 named volumes 衝突的 tmpfs mounts
- 將 superpowers 烘焙到 image 中，避免被 volume mounts 覆蓋
- 保留 plugin cache 並提高 warm-up timeout

## [0.8.0] - 2026-05-05

### 新增
- 將 Superpowers plugin（Agentic skills 框架）加入預設 plugins
  - 提供 14 個 skills，如 brainstorming、systematic-debugging、test-driven-development 等
- `docker-compose.yml` 預設值加入 superpowers，不設定 `.env` 即可使用
- `entrypoint.d/02-init-config.sh` 自動建立 superpowers skills symlink
  - 修復 OpenCode #20940：plugin `config()` hook 修改 `skills.paths` 對 skill discovery 不可見
  - 讓所有既有專案都能自動發現 superpowers skills

### 變更
- `.env.example` 預設 plugins 改為 `oh-my-openagent,superpowers@git+https://github.com/obra/superpowers.git`
- 移除舊版 release 測試（插件已不再使用）

## [0.7.1] - 2026-05-04

### 修復
- 修正 CI integration tests 中 superpowers plugin 檢測失敗問題（使用 explicit shell 包裝 jq 命令）
- 修正 docker-compose.dev.yml 中 `OPENCODE_PLUGINS` 環境變數配置
- 修正 entrypoint.d/02-init-config.sh 一致性問題

## [0.7.0] - 2026-05-04

### 新增
- 透過 `uv tool install graphifyy` 安裝 graphify（知識圖譜工具）
- 新增 superpowers plugin（Agentic skills 框架）
- 新增 graphify 與 superpowers 驗證測試到 run-tests.sh

### 變更
- 移除舊版 plugin（曾導致 release test 失敗）

## [0.6.2] - 2026-04-25

### 變更
- 升級 OpenCode 至 1.14.33
- 升級 OpenChamber 至 1.9.10

## [0.6.1] - 2026-04-24

### 修復
- 修正 entrypoint.sh 重新執行 `exec sudo -E -u devuser -- env PATH="$PATH" "$@"` 時的群組繼承行為
- 修正 OpenChamber Web UI 終端機執行 `docker ps` 出現 `permission denied` 的問題

## [0.6.0] - 2026-04-23

### 新增
- 新增 Docker Buildx v0.32.1 安裝流程，支援 multi-platform builds
- 啟動時新增 `git credential.helper store` 設定

### 修復
- 修正 git credential helper 使用 `sudo -u devuser HOME=...`，避免寫入 `/root`

## [0.5.16] - 2026-04-22

### 變更
- 升級 OpenCode 至 1.14.20
- 升級 OpenChamber 至 1.9.7

## [0.5.15] - 2026-04-17

### 變更
- 升級 OpenCode 至 1.4.7

## [0.5.14] - 2026-04-15

### 變更
- 升級 OpenChamber 至 1.9.5

## [0.5.13] - 2026-04-12

### 修復
- 移除 `NAPI_RS_FORCE_WASI` 環境變數，修復 LanceDB 初始化問題（lancedb/lancedb#3267）
- 修復 CI workflow 中的 Docker Compose 問題

## [0.5.12] - 2026-04-11

### 新增
- 新增 README.md 的 memory plugin 設定說明

### 修復
- 移除 `entrypoint.sh` 中的 `sg docker` 包裝，解決環境變數繼承問題
  - 此問題導致 `memory_stats` 等工具回報 embedding service 離線錯誤
- 新增 `entrypoint.d/02-init-config.sh` 的 stale plugin cache 清理機制
- 在 `docker-compose.dev.yml` hardcode plugins，避免 host shell 汙染環境變數
- 修正 `.env.example` 中的 plugin 名稱（`oh-my-opencode` → `oh-my-openagent`）
- 修復 `test/test-memory-e2e.sh` 測試腳本

## [0.5.11] - 2026-04-10

### 新增
- 新增 glab-config volume，讓 glab（GitLab CLI）認證資料可以持久化
- 新增 06-init-glab-cli.sh 初始化腳本，自動建立 `~/.config/glab-cli` 目錄
- 更新 00-fix-perms.sh，加入 glab-cli、gh、ssh、git 的權限修復

## [0.5.10] - 2026-04-10

### 新增
- 升級 OpenCode 至 1.4.3

## [0.5.9] - 2026-04-10

### 安全性
- 升級 Docker CLI：v25.0.4 → v29.4.0（消除約 20 個 CVE alerts）
- 升級 Docker Compose：v2.24.5 → v5.1.2（消除約 68 個 CVE alerts，含 6 個 Critical）
- 新增 docs/backlog.md 記錄安全技術債務
- 新增 docs/SECURITY.md 版本追蹤章節

## [0.5.8] - 2026-04-10

### 新增
- 升級 OpenCode 至 1.3.12

### 修復
- 將 Docker Compose 改為 plugin 安裝（取代獨立的 `docker-compose` 二進位）
- 更新 test-memory-e2e.sh，改用 hook-based 測試方法
- 更新 release-memory-test.sh，改用 `docker compose` 命令

## [0.5.6] - 2026-04-08

### 新增
- 新增 05-init-gh-cli.sh 初始化腳本，自動建立 `~/.config/gh` 目錄
- 新增 gh-config-dev volume 至 docker-compose.dev.yml

### 變更
- entrypoint.sh 新增以 sudo 執行 05-init-gh-cli.sh
- 更新 docs/ARCHITECTURE.md，加上 gh-config volume 說明
- 更新 docs/TROUBLESHOOTING.md，加上 GitHub CLI 權限故障排除內容

## [0.5.5] - 2026-04-08

### 新增
- 新增 gh-config named volume，讓 gh auth 資料可以持久化

## [0.5.4] - 2026-04-08

### 新增
- 新增完整 Memory E2E 測試腳本（test-memory-e2e.sh）
- 新增 Memory plugin 重試機制（最多 3 次）
- 新增 release skill 的版本資訊提取步驟
- README.md 新增版本徽章

### 變更
- 將 OpenCode 降級至 1.3.7
- 將 OpenChamber 升級至 1.9.4
- 修正 Docker Compose 命令相容性問題
- 修正 release-memory-test.sh 容器名稱

### 修復
- 修正 Memory plugin 在 OpenCode 1.3.7 下的初始化問題
- 修正 release-memory-test.sh 測試失敗時應停止的邏輯

## [0.5.2] - 2026-04-07

### 修復
- 修正 CI workflow 中的 `sed` 命令，正確替換 container name

## [0.5.1] - 2026-04-07

### 新增
- release skill 新增檢查文檔更新步驟

### 變更
- 重新排序 release 步驟，先檢查文檔再 commit

### 修復
- 修正 dev 環境 `OLLAMA_BASE_URL` 被主機環境覆蓋的問題

## [0.5.0] - 2026-04-07

### 新增
- 新增多模型切換功能
- 新增 named volume 作為預設 workspace
- 新增 glab（GitLab CLI）

### 變更
- 使用 named volumes 作為預設儲存策略
- 更新 install.sh 與 .env.example
- 改善 entrypoint 腳本結構

## [0.3.3] - 2026-04-02

### 新增
- 初始版本發布
- 基於 Ubuntu 24.04 的 Docker 開發環境
- 整合 OpenCode AI 程式碼助手（v1.3.13）
- 整合 OpenChamber Web UI（v1.9.3）
- 整合本地 LLM 推論引擎（後續已移除）
- 支援 LanceDB 向量搜尋插件
- 內建 GitHub CLI
- 提供完整開發工具鏈（git、python、tmux、jq 等）
- 建立自動化 CI/CD 流程
- 建立漏洞掃描（Grype）
- 建立整合測試套件（39 個測試項目）

### 變更
- 採用雙容器設計（ai-dev + LLM 推論容器，後續已移除）
- 採用 Docker named volumes 資料持久化策略
- 支援 bind mount 本地開發模式
- 加入健康檢查與自動重啟
- 支援動態套件安裝

## [0.3.0] - 2026-04-02

### 新增
- 新增 `docs/SECURITY.md` 安全政策文件
- 新增 `docs/TROUBLESHOOTING.md` 故障排除指南
- 新增 `docs/ARCHITECTURE.md` 架構說明文件
- 新增 `docs/CONTRIBUTING.md` 貢獻指南

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

[Unreleased]: https://github.com/tryweb/Codeforge/compare/v0.12.5...HEAD
[0.3.0]: https://github.com/tryweb/Codeforge/releases/tag/v0.3.0
[0.3.3]: https://github.com/tryweb/Codeforge/compare/v0.3.0...v0.3.3
[0.5.0]: https://github.com/tryweb/Codeforge/compare/v0.3.3...v0.5.0
[0.5.1]: https://github.com/tryweb/Codeforge/compare/v0.5.0...v0.5.1
[0.5.2]: https://github.com/tryweb/Codeforge/compare/v0.5.1...v0.5.2
[0.5.4]: https://github.com/tryweb/Codeforge/compare/v0.5.2...v0.5.4
[0.5.5]: https://github.com/tryweb/Codeforge/compare/v0.5.4...v0.5.5
[0.5.6]: https://github.com/tryweb/Codeforge/compare/v0.5.5...v0.5.6
[0.5.8]: https://github.com/tryweb/Codeforge/compare/v0.5.6...v0.5.8
[0.5.9]: https://github.com/tryweb/Codeforge/compare/v0.5.8...v0.5.9
[0.5.10]: https://github.com/tryweb/Codeforge/compare/v0.5.9...v0.5.10
[0.5.11]: https://github.com/tryweb/Codeforge/compare/v0.5.10...v0.5.11
[0.5.12]: https://github.com/tryweb/Codeforge/compare/v0.5.11...v0.5.12
[0.5.13]: https://github.com/tryweb/Codeforge/compare/v0.5.12...v0.5.13
[0.5.14]: https://github.com/tryweb/Codeforge/compare/v0.5.13...v0.5.14
[0.5.15]: https://github.com/tryweb/Codeforge/compare/v0.5.14...v0.5.15
[0.5.16]: https://github.com/tryweb/Codeforge/compare/v0.5.15...v0.5.16
[0.6.0]: https://github.com/tryweb/Codeforge/compare/v0.5.16...v0.6.0
[0.6.1]: https://github.com/tryweb/Codeforge/compare/v0.6.0...v0.6.1
[0.6.2]: https://github.com/tryweb/Codeforge/compare/v0.6.1...v0.6.2
[0.7.0]: https://github.com/tryweb/Codeforge/compare/v0.6.2...v0.7.0
[0.7.1]: https://github.com/tryweb/Codeforge/compare/v0.7.0...v0.7.1
[0.8.0]: https://github.com/tryweb/Codeforge/compare/v0.7.1...v0.8.0
[0.8.1]: https://github.com/tryweb/Codeforge/compare/v0.8.0...v0.8.1
[0.8.2]: https://github.com/tryweb/Codeforge/compare/v0.8.1...v0.8.2
[0.8.3]: https://github.com/tryweb/Codeforge/compare/v0.8.2...v0.8.3
[0.9.1]: https://github.com/tryweb/Codeforge/compare/v0.8.3...v0.9.1
[0.9.2]: https://github.com/tryweb/Codeforge/compare/v0.9.1...v0.9.2
[0.9.3]: https://github.com/tryweb/Codeforge/compare/v0.9.2...v0.9.3
[0.10.0]: https://github.com/tryweb/Codeforge/compare/v0.9.3...v0.10.0
[0.11.0]: https://github.com/tryweb/Codeforge/compare/v0.10.0...v0.11.0
[0.11.1]: https://github.com/tryweb/Codeforge/compare/v0.11.0...v0.11.1
[0.11.2]: https://github.com/tryweb/Codeforge/compare/v0.11.1...v0.11.2
[0.11.3]: https://github.com/tryweb/Codeforge/compare/v0.11.2...v0.11.3
[0.11.4]: https://github.com/tryweb/Codeforge/compare/v0.11.3...v0.11.4
[0.11.5]: https://github.com/tryweb/Codeforge/compare/v0.11.4...v0.11.5
[0.11.6]: https://github.com/tryweb/Codeforge/compare/v0.11.5...v0.11.6
[0.11.7]: https://github.com/tryweb/Codeforge/compare/v0.11.6...v0.11.7
[0.11.8]: https://github.com/tryweb/Codeforge/compare/v0.11.7...v0.11.8
[0.11.9]: https://github.com/tryweb/Codeforge/compare/v0.11.8...v0.11.9
[0.11.10]: https://github.com/tryweb/Codeforge/compare/v0.11.9...v0.11.10
[0.12.0]: https://github.com/tryweb/Codeforge/compare/v0.11.10...v0.12.0
[0.12.1]: https://github.com/tryweb/Codeforge/compare/v0.12.0...v0.12.1
[0.12.2]: https://github.com/tryweb/Codeforge/compare/v0.12.1...v0.12.2
[0.12.3]: https://github.com/tryweb/Codeforge/compare/v0.12.2...v0.12.3
[0.12.4]: https://github.com/tryweb/Codeforge/compare/v0.12.3...v0.12.4
[0.12.5]: https://github.com/tryweb/Codeforge/compare/v0.12.4...v0.12.5
