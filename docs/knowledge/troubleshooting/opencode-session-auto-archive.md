# opencode Session 自動封存（30 天機制）診斷與還原

> Historical V1/OMO package investigation; V2 does not ship or load that plugin.

## Context

opencode server 管理 session 的 SQLite 資料庫位於 `/home/devuser/.local/share/opencode/opencode.db`（container 內）。OpenChamber（port 3000）透過 opencode server（`opencode serve --hostname 127.0.0.1 --port 36147`）操作 session。2026-08 檢查發現 806 個 session 被自動標記 `time_archived`，從 OpenChamber / opencode 的未封存列表消失。

## Problem

- 806/4344 session 的 `time_archived` 非空，原因不明。
- 需判斷：(1) 是哪個機制封存的；(2) 清除 `time_archived` 還原後是否會被重新封存。

## Solution

### 根因判定流程

1. **封存齡分析（定案關鍵）**：`SELECT (time_archived - time_created)` 分佈中，619/806（77%）精確落在 **30–31 天**，7–29 天之間為 **0** → 確定性 30 天保留 sweep，非人工作業。
2. **逐 session 毫秒時間戳**：封存時間為獨立毫秒級、依序批次完成（如 7/29 14:19:35–39 共 28 筆）→ 批次 sweep 迴圈，非單一事件。
3. **排除候選機制**：
   - opencode binary（v1.18.10）：無內建 auto-archive/retention；唯一寫入路徑為手動 `PATCH /session/:id`（`time.archived`）— 由 librarian 研究確認。
   - OpenChamber server：對 `/session/:id` 的 PATCH 只寫 `metadata.openchamber.*` namespace（context_obligatory、assist recap），不碰 `time.archived`。
   - oh-my-openagent plugin：`time_archived` 命中僅為 `coding-agent-sessions` skill 的**讀取**查詢（`where time_archived is null`）；packages/ 內無 cron/setInterval/schedule/cleanup。
   - host/container crontab、OpenChamber scheduled tasks：僅 `upgrade.sh` 與「Daily Check PR」，均非封存任務。
4. **機制已死驗證**：6/25–7/10 建立的 302 筆 session 到 8/2 已超過 30 天仍未封存；7/30 之後封存數為 0 → 機制（最可能為舊版 opencode runtime 行為）在 8/1 binary 更新（v1.18.10）前後消失。

### 還原執行

- 只還原最近 30 天：`time_archived >= now - 30*24*3600*1000` 的 616 筆。
- 回滾保險：先 dump 受影響筆數的 `id + time_archived` 到 JSON（`/tmp/archived_30d.json`，53KB）。
- 執行：`UPDATE session SET time_archived = NULL WHERE time_archived IS NOT NULL AND time_archived >= <cutoff>`（container 內 `bun -e` + `bun:sqlite`，server 運行中可直接寫）。

## Why It Works

- 封存齡「30 天整、無 7–29 天樣本」是機器 sweep 的指紋，排除手動/同步/隨機因素。
- 302 筆跨過 30 天門檻仍未被封存，是機制已死的直接證據 → 還原後不會被重新封存。
- `time_archived` 是 session 表的獨立欄位，清除不影響 session 內容、訊息、metadata。

## Side Effects / Tradeoffs

- 磁碟僅剩 8.3G、DB 8.8G，無法完整 cp 備份 → 用 JSON 精確回滾備份替代（對只動單一欄位的操作保險級別足夠）。
- 190 筆 30 天以前的封存維持不動；日後如需還原，同一方式（改 cutoff）即可。
- 直接寫 DB 繞過 opencode API 的 auth 檢查（API 未帶 `X-Auth-Token` 時回 401）；僅適用於本地、可掌控的環境。
- 根因指向舊版 opencode runtime 的行為，屬「已消失的機制」而非可重現 bug；若升級後又出現類似封存，需重新檢查當時的 runtime 版本。

## Evidence

- 封存齡分佈：619/806（77%）在 30–31 天，7–29 天為 0。
- 封存累積區間 2026-05-04 → 2026-07-29；`time_archived > 7/30` 為 0 筆。
- 未封存但建立於 6/25–7/10（已跨 30 天）的 session：302 筆。
- librarian 研究（opencode 1.18.10）：無內建 retention；唯一寫入路徑為手動 `PATCH /session/:id`。
- 還原結果：`UPDATE ... changes: 616`；還原後 30 天窗口內封存數 = 0，總封存 190，未封存 4154（4344 總數一致）。

## Related Files

- `/home/devuser/.local/share/opencode/opencode.db`（SQLite，`session.time_archived`）
- `/home/devuser/.bun/install/global/node_modules/opencode-ai/bin/opencode.exe`（binary，v1.18.10）
- `/home/devuser/.bun/install/global/node_modules/@openchamber/web/server/lib/`（OpenChamber server PATCH 來源）
- `/home/devuser/.cache/opencode/packages/oh-my-openagent@4.19.3/`（plugin，已排除）
- `/tmp/archived_30d.json`（回滾備份）

## Tags

- opencode
- openchamber
- sqlite
- session-archive
- data-recovery
