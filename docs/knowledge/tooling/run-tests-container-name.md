# test/run-tests.sh 預設 container name 與 docker-compose.dev.yml 不一致

## Context

執行整合測試時，使用 `./test/run-tests.sh` (不帶參數) 會因為預設 container name 不符而失敗。

## Problem

`test/run-tests.sh` 第 10 行預設 `CONTAINER="${1:-ai-dev}"`，但 `docker-compose.dev.yml` 中 `container_name: codeforge-dev`。因此直接執行 `bash test/run-tests.sh` 會報錯：

```
OCI runtime exec failed: exec failed: unable to start container process: exec: "./test/run-tests.sh": stat ./test/run-tests.sh: no such file or directory
```

## Solution

執行時必須明確傳入 container name：

```bash
bash test/run-tests.sh codeforge-dev
```

## Why It Works

`docker-compose.dev.yml` 定義 `container_name: codeforge-dev`，而測試腳本使用 `docker exec "$CONTAINER"` 操作。若預設值 `ai-dev` 與實際名稱不符，docker 找不到 container 導致測試失敗。

## Side Effects / Tradeoffs

- 若使用 `docker-compose.yml`（正式部署），container name 可能不同，需要對應調整。

## Evidence

- 第一次執行 `bash test/run-tests.sh` → 失敗
- 第二次執行 `bash test/run-tests.sh codeforge-dev` → 48 PASS / 0 FAIL / 6 SKIP

## Related Files

- `test/run-tests.sh` (line 10: `CONTAINER="${1:-ai-dev}"`)
- `docker-compose.dev.yml` (line 9: `container_name: codeforge-dev`)

## Tags

- testing
- docker-compose
- dev-environment
