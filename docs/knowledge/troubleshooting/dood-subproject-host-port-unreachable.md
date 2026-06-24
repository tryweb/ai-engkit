# DooD 模式下子專案容器 port 從 host 連不到 — 屬於 host Docker daemon 問題，非 ai-engkit bug

## Context

ai-engkit 採用 DooD（Docker-out-of-Docker）模式，透過 `/var/run/docker.sock` socket passthrough 讓容器內的 `docker compose` 命令直接操作 **host** 的 Docker daemon（`docs/TOOLING.md` 第 51 行、`Dockerfile` 第 61 行、Docker 標註「DooD 模式」）。`docker-compose.yml` 同時設定 `extra_hosts: "host.docker.internal:host-gateway"`，讓子專案容器可解析回 host。

在標準 Docker 主機（CI / staging / production）上，這個組合直接 `docker compose up` 就能讓 port mapping 正常運作。但在多 netns、rootless、自訂 iptables 規則被沖掉的本機 dev box 上，會出現「port mapping 明明寫了 0.0.0.0:8020->80/tcp、容器服務健康，但 host 端 curl localhost:8020 失敗」的情境。ai-engkit 對此**無能為力也不應負責**——修復點在 host 而非容器。

## Problem

從 ai-engkit 容器內啟動的子專案，三組症狀同時出現即可確診為 host docker daemon 環境問題：

| 測試位置 | 結果 | 意義 |
|---------|------|------|
| `curl http://<子容器 IP>:8020/` | `Connection refused` | 子容器多在 172.20.0.0/16 bridge，host 路由表沒這段 |
| `curl http://localhost:8020/` | `Connection refused` | host `docker-proxy` 沒起來，host 沒 listen 8020 |
| `curl http://<bridge gateway>:8020/` | **200 OK** | 容器服務本身健康，純粹是 host NAT 問題 |

典型 host 端可見證據：
- `ps -ef \| grep docker-proxy` 為空（userland-proxy 沒被拉起來）
- `daemon.json` 有 `userland-proxy: true` 但仍無 process
- `ip route` 沒有 172.20.0.0/16（或子專案實際使用的 bridge 網段）
- `/proc/net/tcp` 沒有 8020 listening socket（因為 host 上根本沒人 listen）

## Solution

**第一步：判斷歸屬（不動 host，立即見效）**

在 ai-engkit 容器內跑下面三條，可以一次確認問題不在 ai-engkit：

```bash
# 1. 子專案容器在跑且 port mapping 已建立
docker ps --format 'table {{.Names}}\t{{.Ports}}'

# 2. 子專案容器內部服務可達（健康度檢查）
docker exec <子專案容器> curl -s -o /dev/null -w "%{http_code}\n" http://localhost:80

# 3. 找出子專案的 bridge gateway
docker network inspect <子專案網路名> \
  --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}'
```

只要第 2 條回 200、第 3 條拿到 gateway IP，就能用 `curl http://<gateway>:8020/` 在容器內繼續工作，**不必修改 ai-engkit**。

**第二步：告知使用者這是 host 端問題**

向使用者說明：
- ai-engkit 的設計本身正確（socket passthrough + `host.docker.internal:host-gateway` 都在）
- 標準 Docker 主機（CI / staging / production）不會有此問題
- 同類型已知案例：`docs/TROUBLESHOOTING.md` 「glab 作為 git credential helper 的版本化路徑問題」一節，問題同樣在使用者 host 端，容器內不受影響

**第三步：給使用者 host 端修復指引（不代為執行）**

```bash
# 在 HOST（非 ai-engkit 容器內）執行
# 1. docker iptables 鏈還在嗎？
sudo iptables -t nat -L -n | grep -i docker
sudo iptables -L -n      | grep -i docker

# 2. 鏈不見了？重啟 dockerd 會重建
sudo systemctl restart docker

# 3. 仍不行？查 dockerd log
sudo journalctl -u docker --since "10 min ago"

# 4. 確認 daemon.json 沒關掉 userland-proxy
cat /etc/docker/daemon.json   # 應含 "ip-forward": true, "userland-proxy": true
```

## Why It Works

ai-engkit 容器內的 `docker compose` 透過 unix socket 把指令轉給 **host** 的 `dockerd` 處理。`dockerd` 接到 `ports: 0.0.0.0:8020:80` 後，理論上要做兩件事才能讓 host 端能 curl：

1. 在 host 核心 netfilter 注入 MASQUERADE / DNAT 規則（依賴 `iptables` + `ip-forward`）
2. 啟動 `docker-proxy` process 監聽 host 的 8020，把流量轉給容器內的 80 port

兩件事**都發生在 host**。容器內的 ai-engkit 沒有 CAP_NET_ADMIN、無法編 host 路由表，也沒辦法 spawn host process。

bridge gateway IP（典型 172.20.0.1）能通，是因為 curl 走的是 host 的 L2 介面（`docker0` 或自訂 bridge 介面），**繞過了 MASQUERADE 規則**——因為來源端是 host 本身而非外部網路。這條路徑也避開了 userland-proxy，純靠 L3 routing + container 的 socket 直連。

## Side Effects / Tradeoffs

- **bridge gateway IP workaround 只在 host 端好用**。從外部機器 / 同事的電腦 curl `172.20.0.1:8020` 會失敗，因為那個 IP 不可路由。
- 若使用者的 host 是 rootless docker、多 netns、WSL2、或曾手動改過 iptables（特別是 `iptables -F` 沖過 docker 鏈），這個問題會反覆出現。
- 若 ai-engkit 改用 Docker-in-Docker（DinD）模式，host 問題會消失但會失去 host volumes / socket 的便利性，tradeoff 完全不同。
- **不要**嘗試在 ai-engkit 容器內安裝 / 設定 iptables 來「修好 host」——這違反容器隔離原則，且通常會被 SELinux / AppArmor 擋下。

## Evidence

- `docker-compose.yml` line 20：`/var/run/docker.sock:/var/run/docker.sock`（socket passthrough）
- `docker-compose.yml` line 27：`extra_hosts: "host.docker.internal:host-gateway"`
- `Dockerfile` line 61：標註「DooD 模式」
- `docs/TOOLING.md` line 51：「ai-engkit is designed for Docker socket passthrough」
- `entrypoint.d/03-fix-docker-gid.sh`：只處理 socket GID 匹配，**未**觸碰 iptables / userland-proxy（刻意）
- 原始回報（2026-06-23）：port mapping 寫 `0.0.0.0:8020->80/tcp`、容器健康、`curl 172.20.0.1:8020` 通、`curl localhost:8020` 與 `curl 172.18.0.3:8020` 都 `Connection refused`
- 對照基準：CI / staging / production 等標準 Docker 主機跑同樣的 `docker-compose.yml` 正常運作
- 同類問題先例：`docs/TROUBLESHOOTING.md` 「glab 作為 git credential helper 的版本化路徑問題」一節（host 端問題、容器內不受影響）

## Related Files

- `docker-compose.yml` — socket passthrough 與 `extra_hosts` 設定
- `docker-compose.dev.yml` — 同上（dev 用）
- `Dockerfile` — DooD 模式標註
- `entrypoint.d/03-fix-docker-gid.sh` — 處理 socket GID（與本問題無關）
- `docs/TROUBLESHOOTING.md` — 新增「容器內啟動的子專案，從 host 連不到」一節，使用者可自助診斷
- `docs/TOOLING.md` — 說明 ai-engkit 的 DooD 設計意圖
- `docs/ARCHITECTURE.md` — 容器架構總覽

## Tags

- docker
- DooD
- socket-passthrough
- userland-proxy
- iptables
- host-networking
- troubleshooting
- documentation
