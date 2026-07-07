#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://raw.githubusercontent.com/tryweb/ai-engkit/main"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# ──────────────────────────────────────────────────────────
# Color helpers (disabled if not terminal)
# ──────────────────────────────────────────────────────────
if [ -t 1 ]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    CYAN='\033[0;36m'
    BOLD='\033[1m'
    NC='\033[0m'
else
    RED=''; GREEN=''; YELLOW=''; CYAN=''; BOLD=''; NC=''
fi

info()  { echo -e "  ${CYAN}ℹ${NC}  $1"; }
ok()    { echo -e "  ${GREEN}✅${NC} $1"; }
warn()  { echo -e "  ${YELLOW}⚠️${NC}  $1"; }
fail()  { echo -e "  ${RED}❌${NC} $1"; exit 1; }
header() {
    echo
    echo -e "${BOLD}========================================${NC}"
    echo -e "${BOLD} $1${NC}"
    echo -e "${BOLD}========================================${NC}"
}

# ──────────────────────────────────────────────────────────
# System requirement checks (shared with install.sh)
# ──────────────────────────────────────────────────────────
check_system() {
    header "1. 檢查系統硬體規格"

    CPU_CORES=$(nproc 2>/dev/null || echo 0)
    RAM_KB=$(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print $2}')
    RAM_GB=$((RAM_KB / 1024 / 1024))
    DISK_KB=$(df -Pk / 2>/dev/null | tail -1 | awk '{print $4}')
    DISK_GB=$((DISK_KB / 1024 / 1024))

    echo "  CPU cores: $CPU_CORES  |  RAM: ${RAM_GB} GB  |  Disk: ${DISK_GB} GB"

    if [ "$CPU_CORES" -lt 2 ]; then
        fail "CPU 核心數不足 (需要至少 2 core)"
    fi
    if [ "$RAM_GB" -lt 4 ]; then
        fail "RAM 不足 (需要至少 4 GB)"
    fi
    if [ "$DISK_GB" -lt 5 ]; then
        fail "磁碟空間不足 (至少需要 5 GB 以進行升級)"
    fi

    CPU_FLAGS=$(grep -m1 '^flags' /proc/cpuinfo 2>/dev/null || echo "")
    HAS_AVX=false; HAS_AVX2=false
    echo "$CPU_FLAGS" | grep -qw 'avx'  && HAS_AVX=true
    echo "$CPU_FLAGS" | grep -qw 'avx2' && HAS_AVX2=true

    if [ "$HAS_AVX" = "false" ] || [ "$HAS_AVX2" = "false" ]; then
        echo "  ❌ CPU 缺少必要的 SIMD 指令集:"
        [ "$HAS_AVX"  = "false" ] && echo "     - AVX  未支援"
        [ "$HAS_AVX2" = "false" ] && echo "     - AVX2 未支援"
        fail "不支援的 CPU，請參閱 install.sh 的完整說明"
    fi

    ok "系統規格符合要求"
}

check_docker() {
    header "2. 檢查 Docker 環境"

    command -v docker &>/dev/null || fail "Docker 未安裝"
    ok "Docker: $(docker --version | head -1)"

    if command -v docker compose &>/dev/null; then
        ok "Docker Compose V2 已安裝"
    else
        fail "Docker Compose V2 未安裝"
    fi

    [ -S /var/run/docker.sock ] || fail "Docker socket 不存在"
    docker info &>/dev/null || fail "無法連接 Docker daemon"
    ok "Docker daemon 運作正常"

    command -v curl &>/dev/null || command -v wget &>/dev/null || fail "缺少 curl 或 wget"
    ok "網路工具已安裝"
}

# ──────────────────────────────────────────────────────────
# Backup existing files
# ──────────────────────────────────────────────────────────
backup_files() {
    header "3. 備份既有設定檔"

    local backup_dir="backup_${TIMESTAMP}"
    mkdir -p "$backup_dir"

    for f in docker-compose.yml .env; do
        if [ -f "$f" ]; then
            cp "$f" "${backup_dir}/${f}"
            ok "${f} → ${backup_dir}/${f}"
        else
            info "${f} 不存在，跳過備份"
        fi
    done

    # ── Prune old backups per retention setting ──
    local retention
    retention=$(grep -E "^BACKUP_RETENTION=" .env 2>/dev/null | head -1 | cut -d= -f2)
    retention="${retention:-5}"

    if ! [[ "$retention" =~ ^[0-9]+$ ]] || [ "$retention" -lt 1 ]; then
        retention=5
    fi

    local backups=()
    while IFS= read -r -d '' d; do
        backups+=("$d")
    done < <(find . -maxdepth 1 -type d -name 'backup_*' -print0 2>/dev/null | sort -z)

    if [ "${#backups[@]}" -gt "$retention" ]; then
        local to_remove=$(( ${#backups[@]} - retention ))
        info "保留最近 ${retention} 份備份，將刪除 ${to_remove} 份舊備份"
        for ((i=0; i<to_remove; i++)); do
            rm -rf "${backups[$i]}"
            ok "已刪除舊備份: ${backups[$i]}"
        done
    fi
}

# ──────────────────────────────────────────────────────────
# Update docker-compose.yml from upstream
# ──────────────────────────────────────────────────────────
update_compose() {
    header "4. 更新 docker-compose.yml"

    DOWNLOAD_TOOL="curl -fsSL"
    command -v curl &>/dev/null || DOWNLOAD_TOOL="wget -qO-"

    echo "  下載最新 docker-compose.yml..."
    $DOWNLOAD_TOOL "$REPO_URL/docker-compose.yml" -o docker-compose.yml.new

    if [ ! -s docker-compose.yml.new ]; then
        rm -f docker-compose.yml.new
        fail "下載 docker-compose.yml 失敗，請檢查網路連線"
    fi

    mv docker-compose.yml.new docker-compose.yml
    ok "docker-compose.yml 已更新"
}

# ──────────────────────────────────────────────────────────
# Merge new env vars into .env
# ──────────────────────────────────────────────────────────
merge_env() {
    header "5. 合併 .env 設定"

    DOWNLOAD_TOOL="curl -fsSL"
    command -v curl &>/dev/null || DOWNLOAD_TOOL="wget -qO-"

    if [ ! -f ".env" ]; then
        warn ".env 不存在，從 upstream 下載"
        $DOWNLOAD_TOOL "$REPO_URL/.env.example" -o .env
        ok ".env 已建立（使用預設值）"
        info "請編輯 .env 設定密碼等自訂值"
        return
    fi

    local tmp_example
    tmp_example=$(mktemp)
    $DOWNLOAD_TOOL "$REPO_URL/.env.example" -o "$tmp_example" || {
        rm -f "$tmp_example"
        warn "無法下載 .env.example，跳過 env 合併"
        return
    }

    local added=0
    while IFS= read -r line; do
        [[ "$line" =~ ^[[:space:]]*#.*$ || -z "${line// /}" ]] && continue

        key="${line%%=*}"
        key="${key## }"; key="${key%% }"

        if grep -qE "^(export[[:space:]]+)?${key}=" .env 2>/dev/null; then
            :
        else
            echo "$line" >> .env
            added=$((added + 1))
            echo -e "  ${GREEN}➕${NC} ${key} 已新增至 .env"
        fi
    done < "$tmp_example"

    rm -f "$tmp_example"

    if [ "$added" -gt 0 ]; then
        ok "已合併 ${added} 個新設定值到 .env"
    else
        ok ".env 已包含所有最新設定，無需變更"
    fi
}

# ──────────────────────────────────────────────────────────
# Pull latest container image
# ──────────────────────────────────────────────────────────
pull_image() {
    header "6. 拉取最新 Docker 映像"

    local old_id
    old_id=$(docker images ghcr.io/tryweb/ai-engkit:latest -q 2>/dev/null || true)
    if [ -n "$old_id" ]; then
        echo "  當前映像 ID: ${old_id:0:12}"
    else
        info "本地尚無 ai-engkit 映像"
    fi

    echo "  正在拉取 ghcr.io/tryweb/ai-engkit:latest..."
    if docker compose pull 2>&1; then
        ok "映像已更新至最新版"
    else
        ok "映像已檢查完畢"
    fi

    local new_id
    new_id=$(docker images ghcr.io/tryweb/ai-engkit:latest -q 2>/dev/null || true)
    if [ -n "$new_id" ] && [ "$new_id" != "$old_id" ] && [ -n "$old_id" ]; then
        echo "  新映像 ID: ${new_id:0:12}"
    fi
}

# ──────────────────────────────────────────────────────────
# Recreate containers
# ──────────────────────────────────────────────────────────
recreate_containers() {
    header "7. 重建容器"

    if [ -f ".env" ]; then
        local ws_path
        ws_path=$(grep -E "^WORKSPACE_PATH=" .env 2>/dev/null | head -1 | cut -d= -f2-)
        if [ -n "$ws_path" ]; then
            ws_path=$(eval echo "$ws_path")
            if [ ! -d "$ws_path" ]; then
                warn "WORKSPACE_PATH=${ws_path} 目錄不存在，將自動建立"
                mkdir -p "$ws_path"
            fi
        fi
    fi

    echo "  執行 docker compose up -d --force-recreate..."
    docker compose up -d --force-recreate 2>&1 || {
        fail "容器啟動失敗，請檢查 docker compose ps"
    }

    echo -n "  等待服務啟動"
    for _ in {1..15}; do
        if docker compose ps --format json 2>/dev/null | grep -q '"Status":"running"' 2>/dev/null || \
           docker compose ps 2>/dev/null | grep -q "Up"; then
            break
        fi
        echo -n "."
        sleep 2
    done
    echo

    docker compose ps
    ok "容器已重新啟動"
}

# ──────────────────────────────────────────────────────────
# Clean up dangling images
# ──────────────────────────────────────────────────────────
cleanup_images() {
    header "8. 清理舊映像"

    local pruned
    pruned=$(docker image prune -f 2>&1 | grep -oP 'Total reclaimed space: \K.*' || true)
    if [ -n "$pruned" ]; then
        ok "已釋放磁碟空間: ${pruned}"
    else
        info "無需清理"
    fi
}

# ──────────────────────────────────────────────────────────
# Show upgrade summary
# ──────────────────────────────────────────────────────────
show_info() {
    local host_ip=""
    if command -v ip &>/dev/null; then
        host_ip=$(ip route get 1.1.1.1 2>/dev/null | grep -oP 'src \K[^ ]+' | head -1)
    elif command -v hostname &>/dev/null; then
        host_ip=$(hostname -I 2>/dev/null | awk '{print $1}' | grep -v '^fe80\|^::' | head -1)
    fi

    local chamber_port
    chamber_port=$(grep -E "^CHAMBER_PORT=" .env 2>/dev/null | cut -d= -f2)
    chamber_port="${chamber_port:-8000}"

    echo
    echo -e "${BOLD}========================================${NC}"
    echo -e "${BOLD}  Upgrade Complete!${NC}"
    echo -e "${BOLD}========================================${NC}"
    echo
    if [ -n "$host_ip" ] && [[ ! "$host_ip" =~ ^127\. ]]; then
        echo -e "  ${CYAN}🌐${NC} Web UI: http://${host_ip}:${chamber_port}"
    else
        echo -e "  ${CYAN}🌐${NC} Web UI: http://localhost:${chamber_port}"
    fi
    echo "  Ollama API: http://localhost:11434"
    echo
    echo -e "  ${YELLOW}ℹ${NC}  備份目錄: backup_${TIMESTAMP}/"
    echo "     (包含升級前的 docker-compose.yml 與 .env)"
    echo
    echo -e "  ${YELLOW}ℹ${NC}  若需回滾:"
    echo "     docker compose down"
    echo "     cp backup_${TIMESTAMP}/docker-compose.yml docker-compose.yml"
    echo "     cp backup_${TIMESTAMP}/.env .env"
    echo "     docker compose up -d"
    echo
    echo -e "${BOLD}========================================${NC}"
}

# ──────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────
verify_installed_environment() {
    if [ -f "docker-compose.yml" ] && [ -f ".env" ]; then
        return 0
    fi

    fail "找不到 ai-engkit 安裝環境（缺少 docker-compose.yml 或 .env）。

upgrade.sh 僅供已安裝環境使用。首次安裝請改執行 install.sh：

  curl -fsSL https://raw.githubusercontent.com/tryweb/ai-engkit/main/install.sh | bash

若已透過 install.sh 安裝過，請確認你在正確的安裝目錄下執行此腳本。"
}

main() {
    cd "$(dirname "$0")"

    verify_installed_environment

    echo
    echo -e "${BOLD}╔══════════════════════════════════════╗${NC}"
    echo -e "${BOLD}║   ai-engkit 升級腳本                ║${NC}"
    echo -e "${BOLD}╚══════════════════════════════════════╝${NC}"

    check_system
    check_docker
    backup_files
    update_compose
    merge_env
    pull_image
    recreate_containers
    cleanup_images
    show_info
}

main "$@"
