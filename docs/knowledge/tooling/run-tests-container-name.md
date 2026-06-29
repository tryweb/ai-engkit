# test/run-tests.sh 支援雙容器 (engine + UI) 測試

## Context

`test/run-tests.sh` 已從單一 container 改為支援 engine + UI 雙容器測試。

## Usage

```bash
# 使用預設名稱 (docker-compose.yml 正式部署)
bash test/run-tests.sh

# 指定 engine 與 UI container (開發環境)
bash test/run-tests.sh ai-engkit-engine-dev ai-engkit-ui-dev

# 指定自訂 port
CHAMBER_PORT=8001 bash test/run-tests.sh ai-engkit-engine-dev ai-engkit-ui-dev
```

## Parameters

- `$1` — Engine container name (default: `ai-engkit-engine`)
- `$2` — UI container name (default: `ai-engkit-ui`)

Engine tests run against `$1` (dev tools, MCP, lean-ctx, CodeGraph).
Web UI / health tests run against `$2` (openchamber, HTTP, health API).

## Related Files

- `test/run-tests.sh`
- `docker-compose.yml` — `ai-engine` / `ai-ui` services
- `docker-compose.dev.yml` — `ai-engkit-engine-dev` / `ai-engkit-ui-dev` containers

## Tags

- testing
- docker-compose
- multi-container
- dev-environment
