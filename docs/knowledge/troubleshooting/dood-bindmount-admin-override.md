# DooD 模式下的 bind mount 不生效：docker-compose.dev.yml 中的 `./src/admin:/opt/admin` 被 host 端空目錄覆蓋

## Context

ai-engkit 採用 DooD（Docker-out-of-Docker）模式，`docker compose` 命令經由 `/var/run/docker.sock` 轉發給 **host** 的 Docker daemon 執行。這代表所有 bind mount 的來源路徑都從 **host 的檔案系統**解析，而非 ai-engkit 容器內的檔案系統。

`docker-compose.dev.yml` 中 ai-admin 服務有以下 bind mount：

```yaml
volumes:
  - ./src/admin:/opt/admin          # 開發中即時更新
  - ./.env:/opt/ai-engkit/.env:rw   # 環境變數持久化
  - ./docker-compose.yml:/opt/ai-engkit/compose.yml:rw  # docker compose exec 用
```

當開發者在 ai-engkit 容器內修改 `src/admin/` 檔案時，這些變更**只存在於容器內**。Docker daemon 在 host 端找不到 `/home/devuser/workspace/ai-engkit/src/admin/`（因為 host 檔案系統沒有該路徑或該路徑內容不同），bind mount 會 fallback 到 overlay，最終容器看到的是**空目錄或舊的 image 內容**。

## 問題

執行 `docker compose -p dev -f docker-compose.dev.yml up -d ai-admin` 後，容器持續 restart：

```
ai-engkit-admin-dev  | error: Module not found "/opt/admin/server.ts"
```

即使 Dockerfile 中的 `COPY src/admin/ /opt/admin/` 已正確包含檔案，bind mount 仍會**覆蓋** `/opt/admin/`：

```bash
# 驗證：host 端 mount source 不存在或指向錯誤的目錄
$ docker run --rm -v /home/devuser/workspace/ai-engkit/src/admin:/check alpine ls -la /check/server.ts
# → server.ts 被視為**目錄**（不是檔案），表示 mount source 在 host 端是空的或不正確
```

同時，`.env` 和 `docker-compose.yml` 的 mount 也會失效，導致：
- auth 無法初始化（`/opt/ai-engkit/.env` 不存在）
- `docker compose exec ai-dev` 失敗（`/opt/ai-engkit/compose.yml` 不存在）
- devuser 無法存取 Docker socket（entrypoint 的 GID fix 沒執行）

## 解決方案

有兩種 workaround，依情境選擇：

### 方案 A：手動容器 + docker cp（開發期間測試用）

```bash
# 1. 用 sleep 啟動容器（繞過 bundle mount + entrypoint）
docker run -d --name ai-engkit-admin-dev \
  -p 8081:8080 \
  --network ai-engkit_default \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  ai-engkit-ai-admin \
  /usr/bin/tini -- sleep 9999

# 2. 注入修改後的檔案
docker cp src/admin/. ai-engkit-admin-dev:/opt/admin/

# 3. 建立 auth 設定檔
docker exec ai-engkit-admin-dev sh -c \
  'sudo mkdir -p /opt/ai-engkit && echo "ADMIN_PASSWORD=admin" | sudo tee /opt/ai-engkit/.env > /dev/null'

# 4. 複製 compose 檔案（供 docker compose exec 使用）
docker cp docker-compose.dev.yml ai-engkit-admin-dev:/opt/ai-engkit/compose.yml

# 5. 啟動 server
docker exec -d -w /opt/admin ai-engkit-admin-dev bun /opt/admin/server.ts
```

### 方案 B：重建 image + 移除 bind mount（CI / 正式環境用）

修改 `docker-compose.dev.yml`，暫時移除無法正確解析的 bind mount，讓容器使用 image 內建的檔案：

```yaml
services:
  ai-admin:
    build:
      context: .
      dockerfile: Dockerfile
    # 移除 volumes: 中的 ./src/admin, ./.env, ./docker-compose.yml
    # 這些檔案需在 Dockerfile 中 COPY 進 image
```

然後 `docker compose build --no-cache ai-admin` 確保 image 包含最新程式碼。

## 為何有效

方案 A 的原理：
- `sleep 9999` 讓容器保持運行，**不觸發 entrypoint 初始化**（也就不會嘗試 fix docker GID）
- `docker cp` 直接寫入容器的 writable layer，不受 bind mount overlay 影響
- 手動建立 `/opt/ai-engkit/.env` 讓 auth 模組能讀到 `ADMIN_PASSWORD`
- Docker socket 透過 `ro` mount 保留，entrypoint 雖沒跑但 socket 本身可用（需 root 身分執行 `docker`）

方案 B 的原理：
- 移除 bind mount 後，容器使用 image 內建的 `/opt/admin/`，不受 host 端檔案系統影響
- `--no-cache` 確保 build 時重新 COPY 最新檔案進 image

### 方案 C：移除檔案層級 bind mount + 改用 docker exec/ps（推薦）

最完整的解法：徹底擺脫對 file-level bind mount 的依賴，改用 `docker exec` + `docker ps` 操作容器，密碼透過 env var 傳遞。

修改 `docker-compose.dev.yml`：

```yaml
services:
  ai-admin:
    build:
      context: .
      dockerfile: Dockerfile
      args:
        - AI_ENGKIT_VERSION=dev
    container_name: ai-engkit-admin-dev
    # 不移除 entrypoint（使用 image 預設，讓 entrypoint.d 腳本能初始化 Docker GID）
    command: ["bun", "run", "/opt/admin/server.ts"]
    ports:
      - "${ADMIN_DEV_PORT:-8081}:8080"
    volumes:
      # 只保留目錄層級的 mount（backups）和 Docker socket
      - ./backups:/opt/ai-engkit/backups:rw
      - /var/run/docker.sock:/var/run/docker.sock:ro
    environment:
      - ADMIN_PORT=8080
      # ADMIN_PASSWORD 直接 env var，不需要 .env mount
      - ADMIN_PASSWORD=${ADMIN_PASSWORD:-testadmin123}
```

對應的程式碼調整（`src/admin/lib/docker.ts`）：

```typescript
// 不再使用 docker compose exec（需 compose.yml）
export async function getAiDevContainerRef(): Promise<string> {
  for (const name of ["ai-engkit-dev", "ai-engkit"]) {
    const result = await runCommand(
      ["docker", "ps", "--filter", `name=${name}`, "--format", "{{.ID}}"],
      10_000,
    );
    if (result.exitCode === 0 && result.stdout.trim()) {
      return result.stdout.trim().split("\n")[0];
    }
  }
  return "ai-engkit";
}

export async function execInAiDev(command: string, timeoutMs = 30_000) {
  const ref = await getAiDevContainerRef();
  return runCommand(["docker", "exec", ref, "sh", "-c", command], timeoutMs);
}
```

認證模組 `auth.ts` 加入 `process.env` fallback：

```typescript
function getPassword(): string | null {
  const pw = readEnvFile().ADMIN_PASSWORD;
  if (pw && pw.length > 0) return pw;
  const envPw = process.env.ADMIN_PASSWORD;  // fallback for dev compose
  return envPw && envPw.length > 0 ? envPw : null;
}
```

### 方案 D：named volume + seed（2026-08 實作，持久化資料的可靠替代）

方案 C 移除 file-level bind mount 後，dev 的 registry（`/opt/ai-engkit/provider-keys.json`）與 `.env` 變成 container-local——**每次 recreate admin 容器即清空**（image 未包含這些檔案）。需要持久化時，不能用 host file bind mount（host 端路徑不存在，見下方實驗），改用 **named volume + command seed**：

```yaml
# docker-compose.dev.yml
ai-admin:
  command:
    - sh
    - -c
    - |
      set -e
      sudo chown -R devuser:devuser /opt/ai-engkit   # volume 首次掛載為 root:root → 先 chown 才能寫
      mkdir -p /opt/ai-engkit/backups
      [ -f /opt/ai-engkit/VERSION ] || echo dev > /opt/ai-engkit/VERSION
      [ -f /opt/ai-engkit/.env ] || env | grep -v -E '^(HOME|PATH|BUN_|NODE_|npm_|HOSTNAME|PWD|SHLVL|TERM|TZ|LS_COLORS|LESS[ _]|PAGER|EDITOR|LC_|LANG|SHELL|USER|SUDO_|TMPDIR|OLDPWD|_|LOGNAME|PLAYWRIGHT_|DEBIAN_|CLAUDE_)' > /opt/ai-engkit/.env
      [ -f /opt/ai-engkit/provider-keys.json ] || printf '%s\n' '{"providers":{}}' > /opt/ai-engkit/provider-keys.json
      bun run /opt/admin/server.ts
  volumes:
    - admin-data-dev:/opt/ai-engkit
    - /var/run/docker.sock:/var/run/docker.sock:ro
# 頂層 volumes 區加入 admin-data-dev:
```

關鍵細節：
- **chown 必須在 seed 之前**：首次掛載的 named volume 由 host daemon 建立、owner 為 root；`env | grep ... > .env` 的 shell redirect 以 devuser 執行 → 不先 chown 會 `Permission denied`
- **volume 首次掛載會 copy-up image 內容**：image 的 `/opt/ai-engkit/VERSION`（Dockerfile L281）自動保留，seed 的 `[ -f ] ||` 判斷使其冪等
- **不掛 compose.yml**：dev 的 restart 刻意走 `docker restart`（避免 `build: .` 觸發 2-5 min 重建），見 `dev-verification-limitations.md`——env apply 在 dev 不可驗證是既有決策，不要用掛 compose.yml 的方式「修」

## 副作用 / 取捨

- **方案 D**：admin 的 `.env`/registry 內容存在 named volume（`/var/lib/docker/volumes/admin-data-dev/_data`），host 端看不到，需 `docker exec` 查看
- **方案 D**：image 的 `/opt/ai-engkit` 若未來新增檔案會被 volume shadow，需同步加到 seed
- **驗證陷阱**：admin server 有 rate limit（`RATE_LIMIT=120` req/min、in-memory Map，server.ts:39）——連續跑完整 test（每次上百 curl）會 429 鎖住所有 API，造成大規模假 FAIL；`--force-recreate`（重置 in-memory map）後即恢復
- **方案 A** 的容器不是由 docker compose 管理，`docker compose logs` / `docker compose down` 無法控制它
  - 清理需手動：`docker rm -f ai-engkit-admin-dev`
- **方案 A** 的 bun process 以 root 身分執行（非 devuser），可能與正式環境行為略有差異
  - 若要模擬 devuser：加 `sudo -u devuser` 但需先 fix docker GID
- **方案 B** 會讓 dev 模式的 hot-reload（`--watch`）失效，因為檔案修改後不會同步進容器
  - 解決方式：每次修改後重新 build
- **方案 C** 讓 dev 模式的 hot-reload（`--watch`）失效（同方案 B），但使用 image 預設 entrypoint 確保 Docker GID 正確初始化
- **方案 C** 的 `getAiDevContainerRef()` 依賴 container name pattern，若 container name 變更需要同步更新
- 此問題只在 DooD 模式發生。若 CI 的 Docker daemon 與 build context 在同一 host，bind mount 正常運作

## Evidence

```bash
# 方案 D 驗證（2026-08，DooD dev 環境）：
# 1) host 視角確認 file bind mount 不可行（host 無此檔 → Docker 自動建「目錄」）
$ docker run --rm -v /home/devuser/workspace/ai-engkit/provider-keys.json:/check.json alpine sh -c 'ls -ld /check.json; cat /check.json 2>&1'
drwxr-xr-x    2 root     root    4096 Jul 31 23:18 /check.json
cat: read error: Is a directory

# 2) seed 結果：三檔建立、owner devuser
$ docker exec ai-engkit-admin-dev ls -la /opt/ai-engkit/
-rw-rw-r-- 1 devuser devuser 1101 Aug  1 07:23 .env
-rw-r--r-- 1 devuser devuser    4 Jul 31 23:08 VERSION   # copy-up 保留 image 內容
-rw-rw-r-- 1 devuser devuser   17 Aug  1 07:23 provider-keys.json  # {"providers":{}}

# 3) 核心驗證：import → force-recreate → registry 保留
$ docker compose -p dev -f docker-compose.dev.yml up -d --force-recreate ai-admin
$ docker exec ai-engkit-admin-dev jq -r '.providers["opencode-go"].activeKeyId' /opt/ai-engkit/provider-keys.json
k-ms9kjmmw   # 保留，未清空

# 4) 完整回歸：RUN_APPLY_TESTS=1 ./test/test-admin-ui.sh → 64 passed, 0 failed

# host 端 mount source 不存在或內容錯誤的證明（方案 A/B/C 時期）
$ docker run --rm -v /home/devuser/workspace/ai-engkit/src/admin:/check alpine ls -la /check/server.ts
total 8
drwxr-xr-x    2 root     root          4096 Jul 24 07:39 .
drwxr-xr-x    2 root     root          4096 Jul 24 07:39 ..

# 本機檔案系統內容 vs host 端 mount 內容不同
$ ls -la /home/devuser/workspace/ai-engkit/src/admin/server.ts
-rw-rw-r-- 1 devuser devuser 5807 Jul 24 15:51 server.ts   # 容器內是檔案

# docker inspect 顯示 mount source 為 host 路徑
$ docker inspect ai-engkit-admin-dev --format '{{json .Mounts}}' | jq '.[] | select(.Destination=="/opt/admin") | {Source, Destination}'
{"Source": "/home/devuser/workspace/ai-engkit/src/admin", "Destination": "/opt/admin"}
```

## V2 production: host-run contract for file bind mounts (2026-10)

The V2 **production** stack (`docker-compose.v2.yml`) keeps the file-level host
bind mounts that the V2 **dev** stack removed (方案 D above is dev-only). They
cannot move to a named volume in production because the Admin UI upgrade path
requires host files:

- `src/admin/lib/upgrade.ts` writes `/opt/ai-engkit/.env`, `/opt/ai-engkit/compose.yml`,
  and backups under `/opt/ai-engkit/backups` (`ENV_FILE` / `COMPOSE_FILE` /
  `BACKUP_DIR`, upgrade.ts:45-47) and re-reads the effective Compose it wrote.
- The host-side `upgrade-v2.sh` reads/writes `./.env.v2`,
  `./docker-compose.v2.yml`, and `./admin-data-v2/upgrade-base.yml` directly on
  the host.

A named volume would sever that host-visible surface: host `cat .env.v2`,
`git diff docker-compose.v2.yml`, and `backups-v2` would diverge from the running
admin's state. This is why the dev-stack 方案 D is not applied to production.

The remaining failure mode is DooD path resolution: when `docker compose` runs
from **inside a container**, the host daemon resolves each relative file source
against a different host tree and auto-creates an empty directory, so ai-admin
reads a directory at `/opt/ai-engkit/.env` and returns HTTP 500 (EISDIR).

Fix (2026-10): `install-v2.sh` and `upgrade-v2.sh` now

1. refuse to run inside a container (`require_host`), telling the operator to run
   on the Docker host; and
2. verify each file-level bind source is a regular file on the host before any
   `docker compose up` (`verify_bind_sources`) — a source that is a directory
   (auto-created by a prior bad run) or missing is a hard failure.

Directory-level mounts (`admin-data-v2/`, `backups-v2/`, `extensions/`) are not
checked; an empty auto-created directory there is harmless. `AI_ENGKIT_SKIP_HOST_CHECK=1`
bypasses the container guard for in-container testing only (mirrors
`SKIP_SYSTEM_CHECK`) and does not fix path resolution. The `env.ts` guard
(`envPathIsFile` returns `{}` for a non-file path) and `upgrade.ts:ensureComposeFile`
(removes a directory-shaped compose file) remain as second-line defense.

Evidence:

```bash
# In-container run aborts before any side effect:
$ ./upgrade-v2.sh
  ❌ Running inside a container. Docker-out-of-Docker cannot resolve ...
```

## Related Files

- `docker-compose.v2.yml` — V2 production ai-admin file/dir bind mounts + host-run note
- `install-v2.sh` / `upgrade-v2.sh` — `require_host` + `verify_bind_sources`
- `docker-compose.dev.yml` — ai-admin volumes 定義（方案 D：`admin-data-dev` named volume + seed command）
- `Dockerfile` line 258 — `COPY src/admin/ /opt/admin/`
- `Dockerfile` line 281 — `mkdir -p /opt/ai-engkit && echo "$AI_ENGKIT_VERSION" > /opt/ai-engkit/VERSION`（image 內唯一的 /opt/ai-engkit 內容，volume copy-up 保留）
- `entrypoint.d/03-fix-docker-gid.sh` — Docker socket GID 匹配腳本
- `src/admin/lib/docker.ts` — `getAiDevContainerRef` / `execInAiDev` 改用 `docker exec` + `docker ps`
- `src/admin/lib/auth.ts` — `getPassword` 加入 `process.env` fallback
- `src/admin/lib/env.ts` — `readEnvFile` 讀取 `/opt/ai-engkit/.env`
- `docs/knowledge/troubleshooting/dood-subproject-host-port-unreachable.md` — 相關 DooD 問題

## Tags

- docker
- DooD
- bind-mount
- volume
- admin-dashboard
- troubleshooting
- development-workflow
