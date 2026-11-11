# Admin V2 顯示缺功能時先查容器映像版本

## Context

V2 prod 疊（`docker-compose.v2.yml`，project `v2`）的 `ai-dev` 與 `ai-admin`
共用同一個 image 變數（`ghcr.io/tryweb/ai-engkit:${AI_ENGKIT_VERSION:-v2}`），
但兩個容器可以在不同時間用不同 tag 建立，導致 Admin UI 缺少已合併的功能
（例如 opencode-go 每帳號用量徽章）。

## Problem

`http://<host>:8082/providers` 的 OpenCode Go 區沒有每帳號 `Monthly % · resets`
徽章，而原始碼 HEAD 明明有完整實作（`providers.tsx` 徽章、`providers-page.js`
`refreshGoUsage`、`GET /api/providers/opencode-go/usage` v2 路徑）。
原因是 `ai-engkit-admin-v2` 跑的是 10-17 的 `:v2` 舊映像（用量功能 10-21 才進
2.0.4），而 `ai-engkit-v2`（ai-dev）早已跑 `:v2.0.20`。

## Solution

1. 先確認執行中容器的映像：`docker inspect <name> --format '{{.Config.Image}}'`
   並進容器 grep 關鍵字（如 `grep -c refreshGoUsage /opt/admin/static/providers-page.js`）。
2. 若有已發佈的新 tag（含該功能），只重建該服務容器即可，ai-dev 不必動：
   用舊容器的 inspect 原樣重放（binds 用 host 絕對路徑、具名 volume 用 name、
   只帶 compose 設定的 env、labels 照抄並更新 `com.docker.compose.image`），
   先 `docker create` 再 stop/rename/start 做原子切換。
3. 切換後驗證：登入 `/providers` 應含 `data-go-usage` 徽章，
   `/api/providers/opencode-go/usage` 應回 6 個帳號的 `monthly.label`。

## Why It Works

Admin 的 providers 頁是 bun 即時轉譯 `server.ts`，靜態 JS/CSS 也在映像內，
所以功能有無完全取決於容器映像的新舊；用量查詢本身在 ai-dev 內執行
（sqlite → curl），ai-dev 早已具備所需工具，不需重啟。

## Side Effects / Tradeoffs

- 在容器內用 DooD `docker create/run` 重建時，不可用相對路徑 compose binds
  （見 `dood-bindmount-admin-override.md`）；必須用 inspect 出來的 host 絕對路徑。
- 下次有人在 host 跑預設 tag（`:v2`）的 `compose up` 會把 admin 還原回舊映像；
  治本是把 `:v2` 浮動 tag 重新發佈到新版，或把部署釘到 `:v2.0.20`。
- 本次用 `Cmd: [-- /entrypoint.sh ...]` + `Entrypoint: [tini]` 表達，
  與原 `Entrypoint: [tini -- entrypoint.sh]` 等價（diff 僅為表示法）。

## Evidence

- Tests: `bun test lib/opencode-go-usage.test.ts lib/opencode-go-usage-v2.test.ts views/providers.test.tsx` — 30 pass
- Diagnostics: prod 8082 `/providers` 含 6 個 `data-go-usage` 徽章；
  usage API 回 `Monthly 93%/15%/20%/99%/0%/37%`，與 v1 參照截圖一致
- Logs / observed behavior: 切換前 `grep -c refreshGoUsage` 為 0（10-17 映像），
  切換後（`:v2.0.20`）為 3；容器 `running/healthy`
- Docs / source references: `src/admin/lib/opencode-go-usage-v2.ts`,
  `src/admin/routes/providers.ts`（`GET /api/providers/opencode-go/usage`）

## Related Files

- `docker-compose.v2.yml`
- `src/admin/views/providers.tsx`
- `src/admin/static/providers-page.js`
- `src/admin/lib/opencode-go-usage-v2.ts`

## Tags

- admin-v2
- opencode-go
- docker-imaging
- dood
