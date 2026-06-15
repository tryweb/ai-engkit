# 變更日誌

本檔案記錄 CodeForge 專案的所有重要變更。

格式基於 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.0.0/)，並且本專案遵循 [語義化版本](https://semver.org/lang/zh-TW/)。

## [Unreleased]

### 新增
- feat: lean-ctx XDG Base Directory 支援 (v3.8.5+)
  - Dockerfile: 新增 `BASH_ENV` / `CLAUDE_ENV_FILE` 讓 bash 自動載入 lean-ctx 環境
  - Dockerfile: 預建 `~/.local/share/lean-ctx`, `~/.local/state/lean-ctx`, `~/.cache/lean-ctx` 目錄
  - Dockerfile: 新增 `lean-ctx-data` / `lean-ctx-state` VOLUMEs 確保存留向量索引、知識庫、sessions
  - docker-compose.yml / dev.yml: 新增 `lean-ctx-data` / `lean-ctx-state` named volumes
  - entrypoint.d/00-fix-perms.sh: 新增 lean-ctx 目錄的權限修復
  - entrypoint.d/02-init-config.sh: 自動偵測舊版 single-dir 佈局並執行 `lean-ctx doctor --fix` 遷移
  - docs/ARCHITECTURE.md: 新增 lean-ctx volumes 至架構圖與持久化策略表

## [0.11.9] - 2026-06-14
- update apt packages

## [0.11.8] - 2026-06-14
- update apt packages


## [0.11.6] - 2026-06-13
- update LEANCTX_VERSION to v3.8.4
- update apt packages


## [0.11.5] - 2026-06-13
- update LEANCTX_VERSION to v3.8.3
- update apt packages


## [0.11.4] - 2026-06-11

### 修復
- fix: separate @playwright/mcp version from Playwright core version

  獨立管理 Playwright core（1.60.0）與 @playwright/mcp（0.0.76）版本，修正先前強制兩者版本必須一致的錯誤假設。

### 變更
- ci: build image once and share via artifact across jobs

## [0.11.3] - 2026-06-11
- chore: pin Playwright version to 1.60.0 and add runtime smoke tests

## [0.11.2] - 2026-06-11
- 升級 docker 29.4.1 → 29.5.3, compose 5.1.2 → 5.1.4, buildx 0.33.0 → 0.34.1
- 新增 vuln-scan skill 用於漏洞掃描和版本稽核

## [0.11.1] - 2026-06-11

### 變更
- 升級 opencode 1.16.2 → 1.17.3
- 升級 openchamber 1.12.3 → 1.12.4

## [0.11.0] - 2026-06-06

### 新增
- feat: add Playwright browsers to Docker image for MCP server and testing
  - Install Chromium browser (~291 MB) and 97 system dependency packages via `playwright install-deps chromium` and `playwright install chromium`
  - Enables both Playwright MCP server browser automation and Playwright test runner usage

## [0.10.0] - 2026-06-06

### 新增
- feat: add lean-ctx MCP server for context engineering
  - Install lean-ctx v3.7.5 via universal installer in Dockerfile
  - Add lean-ctx MCP server block in entrypoint.d/02-init-config.sh
  - Provides 69 MCP tools (ctx_read, ctx_shell, ctx_search, ctx_tree, etc.)

### 變更
- 升級 opencode 1.16.0 → 1.16.2
- 升級 openchamber 1.12.1 → 1.12.3

## [0.9.3] - 2026-06-05

### 變更
- 升級 opencode 1.15.13 → 1.16.0

## [0.9.2] - 2026-06-05

### 變更
- 升級 @openchamber/web 1.11.7 → 1.12.1

## [0.9.1] - 2026-06-02

### 新增
- feat(tooling): 將 Playwright MCP 烘焙到 image,讓 AI 代理能原生驅動瀏覽器
  - Dockerfile: `/etc/opencode/opencode.json.default` 模板加入 playwright MCP 設定(以 `jq` 經 BuildKit heredoc 寫入)
  - entrypoint.d/02-init-config.sh: 每次重生成的 `~/.config/opencode/opencode.json` 也帶上 playwright MCP(避免被覆蓋)
  - test/run-tests.sh: 新增 2 個斷言驗證 playwright MCP 設定存在且使用 `bunx`(因 image 用 Bun 取代 Node.js)
  - 取代過去「AI 自己寫 Playwright 腳本 + bash 跑」的工作流,直接呼叫 `browser_navigate` / `browser_click` / `browser_snapshot` 等原生 MCP 工具
  - 開箱即用,新開發者不需手動 `bunx -y @playwright/mcp@latest` 安裝

### 變更
- 升級 @openchamber/web 1.10.4 → 1.11.7
- 升級 opencode 1.14.48 → 1.15.13（[release notes](https://github.com/anomalyco/opencode/releases/tag/v1.15.13)：Anthropic Opus 4.7+ adaptive reasoning 修正、session metadata API、config 目錄向上載入、TUI 對齊修正）
- 將 graphify（graphifyy）知識圖譜工具替換為 @colbymchenry/codegraph
  - Dockerfile: uv tool install graphifyy → bun install -g @colbymchenry/codegraph
  - README.md 與測試腳本同步更新

### 修復
- fix(install): clarify host vs container authentication isolation

### 文檔
- docs(readme): add Git Authentication section for first-time users
- docs(security): correct credential volume mount description
- docs(troubleshooting): document glab credential helper versioned-path issue (#4)

## [0.8.3] - 2026-05-13

### 修復
- fix(ci): remove blocking opencode warm-up step and increase job timeouts

## [0.8.2] - 2026-05-13

### 變更
- 升級 opencode 1.14.33 → 1.14.48
- 升級 openchamber 1.9.10 → 1.10.4

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
  - 此問題導致 `memory_stats` 等 tool 回報 embedding service 離線錯誤
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
- 修正 release-memory-test.sh 容器名稱

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
- 整合本地 LLM 推論引擎（已移除）
- 支援 LanceDB 向量搜尋插件
- 內建 GitHub CLI
- 完整的開發工具鏈（git, python, tmux, jq 等）
- 自動化 CI/CD 流程
- 漏洞掃描（Grype）
- 整合測試套件（39 個測試項目）

### 架構
- 雙容器設計（ai-dev + LLM 推論容器，後已移除）
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

[0.9.2]: https://github.com/tryweb/Codeforge/compare/v0.9.1...v0.9.2

[0.9.3]: https://github.com/tryweb/Codeforge/compare/v0.9.2...v0.9.3

[0.10.0]: https://github.com/tryweb/Codeforge/compare/v0.9.3...v0.10.0

[0.11.0]: https://github.com/tryweb/Codeforge/compare/v0.10.0...v0.11.0

[0.11.1]: https://github.com/tryweb/Codeforge/compare/v0.11.0...v0.11.1

[0.11.2]: https://github.com/tryweb/Codeforge/compare/v0.11.1...v0.11.2
