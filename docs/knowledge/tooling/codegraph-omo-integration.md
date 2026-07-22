# CodeGraph + OMO Integration in ai-engkit

## Context

ai-engkit 同時搭載兩套 CodeGraph MCP 註冊機制：
1. entrypoint `02-init-config.sh` 寫入 `opencode.json` 的 `mcp.codegraph`
2. OMO plugin 自帶的 `.mcp.json`（`required: false`）

需要釐清誰實際生效、是否有衝突、以及最佳配置。

## Problem

- Dockerfile line 274 `codegraph install --target=opencode --yes` 是 no-op（entrypoint 永遠覆蓋其輸出）
- 兩個同名 `"codegraph"` MCP server 共存，需確認優先級
- Global binary (v1.5.0) 與 OMO pin (v1.4.1) 版本不一致
- OMO 宣稱 auto-provision，實際是否生效

## Solution

### 1. 已執行的修改

移除 Dockerfile line 274-275（`codegraph install --target=opencode --yes`），
因為 entrypoint `02-init-config.sh` 每次容器啟動都完整重建 `opencode.json`，
build-time 註冊結果永遠被覆蓋。

### 2. 兩個 MCP 註冊的共存機制

| 來源 | 設定 | 優先級 |
|---|---|---|
| `opencode.json` (entrypoint) | `{"codegraph": {"command":["codegraph","serve","--mcp"], "enabled":true}}` | **實際生效** |
| OMO `.mcp.json` | `{"codegraph": {"command":"node","args":["...serve.js"], "required":false}}` | 備用保險絲 |

Entrypoint 的 `enabled: true` 優先。OMO 的 `required: false` 只在 entrypoint 那組完全不可用時介入。

**關鍵證據**: container 啟動時 log 顯示 `server unavailable: key=codegraph type=local status=failed`，
但後續 session 中 codegraph MCP 仍可正常運作（on-demand restart 成功）。

### 3. OMO auto-provision 不觸發的原因

OMO binary resolution order:
```
OMO_CODEGRAPH_BIN env → bundled → ~/.omo/codegraph/bin → PATH
```

因為 global binary (`bun install -g @colbymchenry/codegraph`) 已在 PATH，
OMO `resolveCodegraphCommand` 回傳 `source="path"`，跳過 provision。

`.omo/codegraph/` 目錄從未被建立——不需要，也沒觸發。

### 4. OMO auto-init 運作機制

OpenCode session start 時：

```
SessionStart hook (stdin: {"cwd": "/path/to/project"})
  → 檢查 project 是否有 .codegraph/
  → 無 → spawn detached worker
  → worker: codegraph init → .codegraph/codegraph.db 建立
  → 寫入 ~/.omo/codegraph/session-start.jsonl
```

**不需要手動 `codegraph init`**。驗證方式：

```bash
# 模擬 OpenCode hook 行為
echo '{"cwd": "/path/to/project"}' | \
  node cli.js hook session-start
# 回傳: {"hookSpecificOutput":{"hookEventName":"SessionStart",...}}

# ~1 秒後 .codegraph/ 自動建立
```

注意：hook 透過 **stdin** 接收 cwd，非 env var。
`/tmp` 目錄被 OMO 自動排除，不會觸發 init。

### 5. 版本不需對齊

- OMO binary resolution 走 PATH 時不做版本檢查
- `CODEGRAPH_VERSION = "1.0.1"` 是 minimum，僅在 OMO 自己 provision 時比對 manifest
- Global v1.5.0 + OMO pin v1.4.1 並存無影響

## Why It Works

- **`bun install -g @colbymchenry/codegraph` 必須保留**——OMO 沒有 auto-provision，這是唯一 binary 來源
- **entrypoint MCP block 必須保留**——這是唯一 `enabled: true` 的註冊
- **OMO hook 提供附加價值**——auto-init、auto-sync、post-tool-use guidance
- **不需要手動 init**——OMO SessionStart hook 自動處理

## Side Effects / Tradeoffs

### 效能: 直接 binary 優於 OMO wrapper

| 階段 | 直接 binary | OMO serve.js wrapper |
|---|---|---|
| 冷啟動 (serve+init) | 113ms | — |
| Worker pre-warm | N/A | 332ms |
| Serve 純啟動 | — | 142ms (+29ms overhead) |
| 首次查詢 | 78ms | 128ms |
| **首次有效回應總計** | **191ms** | **602ms** |

OMO serve.js wrapper 每次啟動多 ~29ms（Node.js 層 + env setup）。
但 wrapper 目前未被使用（entrypoint 的直接 binary 優先）。

### 維運面

- OMO worker 寫入 `~/.omo/codegraph/session-start.jsonl` 供診斷
- OMO 自動排除 `/tmp`、`.omo` 路徑
- Worker 60s timeout per command (`init` / `sync`)
- OMO serve wrapper 設定 `CODEGRAPH_NO_DAEMON=1`, `CODEGRAPH_NO_DOWNLOAD=1`, `CODEGRAPH_TELEMETRY=0`

## Evidence

- `docker exec ai-engkit-dev` 實測完整流程
- `~/.omo/codegraph/session-start.jsonl` 記錄每次 worker 執行結果
- `codegraph init` 耗時 ~847ms（直接）/ ~344ms（透過 OMO worker）
- `.codegraph/codegraph.db` ~152KB（本專案）
- OpenCode log: `server unavailable: key=codegraph type=local status=failed`（啟動時），後續 on-demand 恢復

## Related Files

- `Dockerfile:132-133` — `bun install -g @colbymchenry/codegraph`
- `entrypoint.d/02-init-config.sh:~135` — codegraph MCP block
- `entrypoint.d/02-init-config.sh:~167-175` — lean-ctx setup
- OMO plugin: `packages/omo-codex/plugin/.mcp.json`
- OMO plugin: `packages/omo-codex/plugin/components/codegraph/dist/serve.js`
- OMO plugin: `packages/omo-codex/plugin/components/codegraph/dist/cli.js`
- OMO plugin: `hooks/session-start-checking-codegraph-bootstrap.json`

## Tags

- codegraph
- omo
- mcp
- opencode
- entrypoint
- auto-init
- performance
