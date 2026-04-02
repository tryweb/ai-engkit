#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://raw.githubusercontent.com/tryweb/codeforge/main"

check_system() {
    echo "========================================"
    echo "1. 檢查系統硬體規格"
    echo "========================================"

    CPU_CORES=$(nproc 2>/dev/null || echo 0)
    RAM_KB=$(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print $2}')
    RAM_GB=$((RAM_KB / 1024 / 1024))
    DISK_KB=$(df -Pk / 2>/dev/null | tail -1 | awk '{print $4}')
    DISK_GB=$((DISK_KB / 1024 / 1024))

    echo "  CPU cores: $CPU_CORES"
    echo "  RAM: ${RAM_GB} GB"
    echo "  Disk available: ${DISK_GB} GB"

    if [ "$CPU_CORES" -lt 2 ]; then
        echo "  ❌ CPU 核心數不足 (需要至少 2 core)"
        exit 1
    elif [ "$CPU_CORES" -lt 4 ]; then
        echo "  ⚠️  警告: CPU 低於建議規格 (4 core 為佳)"
    else
        echo "  ✅ CPU 符合建議規格"
    fi

    if [ "$RAM_GB" -lt 4 ]; then
        echo "  ❌ RAM 不足 (需要至少 4 GB)"
        exit 1
    elif [ "$RAM_GB" -lt 8 ]; then
        echo "  ⚠️  警告: RAM 低於建議規格 (8 GB 為佳)"
    else
        echo "  ✅ RAM 符合建議規格"
    fi

    if [ "$DISK_GB" -lt 30 ]; then
        echo "  ❌ 磁碟空間不足 (需要至少 30 GB)"
        exit 1
    elif [ "$DISK_GB" -lt 100 ]; then
        echo "  ⚠️  警告: 磁碟空間低於建議規格 (100 GB 為佳)"
    else
        echo "  ✅ 磁碟空間符合建議規格"
    fi
}

check_docker() {
    echo
    echo "========================================"
    echo "2. 檢查 Docker 環境"
    echo "========================================"

    if ! command -v docker &> /dev/null; then
        echo "  ❌ Docker 未安裝"
        echo "    請參考: https://docs.docker.com/get-docker/"
        exit 1
    fi
    echo "  ✅ Docker 已安裝: $(docker --version | head -1)"

    if command -v docker compose &> /dev/null; then
        echo "  ✅ Docker Compose V2 已安裝"
    elif command -v docker-compose &> /dev/null; then
        echo "  ⚠️  偵測到 docker-compose (V1)"
    else
        echo "  ❌ Docker Compose 未安裝"
        exit 1
    fi

    SOCK="/var/run/docker.sock"
    if [ ! -S "$SOCK" ]; then
        echo "  ❌ Docker socket 不存在"
        exit 1
    fi
    echo "  ✅ Docker socket 存在: $(ls -la "$SOCK" | awk '{print $1}')"

    if ! docker info &> /dev/null; then
        echo "  ❌ 無法連接 Docker daemon"
        exit 1
    fi
    echo "  ✅ Docker daemon 運作正常"

    if ! command -v curl &> /dev/null && ! command -v wget &> /dev/null; then
        echo "  ❌ 缺少 curl 或 wget"
        exit 1
    fi
    echo "  ✅ 網路工具已安裝"
}

check_and_prepare_volumes() {
    echo
    echo "========================================"
    echo "3. 檢查並準備 Volumes 檔案"
    echo "========================================"

    DOWNLOAD_TOOL="curl -fsSL"
    if ! command -v curl &> /dev/null; then
        DOWNLOAD_TOOL="wget -qO-"
    fi

    echo "  正在解析 docker-compose.yml..."

    FILES_TO_CHECK=(
        "${HOME}/.gitconfig"
        "${HOME}/.git-credentials"
        "${HOME}/.ssh"
        "${HOME}/.ssh/known_hosts"
        "${HOME}/.config/gh"
    )

    for PATH_ITEM in "${FILES_TO_CHECK[@]}"; do
        if [[ "$PATH_ITEM" == *"/.ssh" ]] && [ ! -d "$PATH_ITEM" ]; then
            echo "  📁 建立目錄: $PATH_ITEM"
            mkdir -p "$PATH_ITEM"
            chmod 700 "$PATH_ITEM"
        elif [ ! -e "$PATH_ITEM" ]; then
            if [[ "$PATH_ITEM" == *"/.ssh/known_hosts" ]]; then
                echo "  📁 建立檔案: $PATH_ITEM"
                touch "$PATH_ITEM"
                chmod 600 "$PATH_ITEM"
            else
                echo "  📁 建立檔案: $PATH_ITEM"
                touch "$PATH_ITEM"
                chmod 644 "$PATH_ITEM"
            fi
        else
            echo "  ✅ 已存在: $PATH_ITEM"
        fi
    done
}

download_files() {
    echo
    echo "========================================"
    echo "4. 下載設定檔案"
    echo "========================================"

    DOWNLOAD_TOOL="curl -fsSL"
    if ! command -v curl &> /dev/null; then
        DOWNLOAD_TOOL="wget -qO-"
    fi

    if [ ! -f "docker-compose.yml" ]; then
        echo "  下載 docker-compose.yml..."
        $DOWNLOAD_TOOL "$REPO_URL/docker-compose.yml" -o docker-compose.yml
        echo "  ✅ docker-compose.yml 已下載"
    else
        echo "  ✅ docker-compose.yml 已存在"
    fi

    if [ ! -f ".env" ]; then
        if [ -f ".env.example" ]; then
            echo "  複製 .env.example -> .env"
            cp .env.example .env
        else
            echo "  下載 .env.example..."
            $DOWNLOAD_TOOL "$REPO_URL/.env.example" -o .env
        fi
        echo "  ✅ .env 已建立，請編輯設定"
    else
        echo "  ✅ .env 已存在"
    fi
}

setup_env() {
    echo
    echo "========================================"
    echo "5. 環境設定"
    echo "========================================"

    if [ -f ".env" ]; then
        source .env
    fi

    if [ -z "${OPENCHAMBER_UI_PASSWORD:-}" ]; then
        echo "  請設定 Web UI 密碼 (必填):"
        read -s -p "  UI_PASSWORD: " UI_PASS
        echo
        if [ -z "$UI_PASS" ]; then
            echo "  ❌ 密碼不能為空"
            exit 1
        fi
        sed -i "s/^OPENCHAMBER_UI_PASSWORD=.*/OPENCHAMBER_UI_PASSWORD=$UI_PASS/" .env 2>/dev/null || true
        echo "  ✅ UI 密碼已設定"
    else
        echo "  ✅ UI 密碼已設定"
    fi

    echo "  請選擇 Workspace 類型:"
    echo "    1) Named Volume (預設，建議)"
    echo "    2) Bind Mount (自訂路徑)"
    read -p "  選擇 [1/2]: " WS_CHOICE

    case "$WS_CHOICE" in
        2)
            echo "  請輸入主機上的 workspace 路徑:"
            read -p "  WORKSPACE_PATH: " WS_PATH
            if [ -n "$WS_PATH" ]; then
                if [ ! -d "$WS_PATH" ]; then
                    echo "  📁 建立目錄: $WS_PATH"
                    mkdir -p "$WS_PATH"
                fi
                sed -i "s|^WORKSPACE_PATH=.*|WORKSPACE_PATH=$WS_PATH|" .env 2>/dev/null || true
                echo "  ✅ WORKSPACE_PATH 已設定為: $WS_PATH"
            else
                echo "  ⚠️  使用預設 named volume"
                sed -i "s|^WORKSPACE_PATH=.*|# WORKSPACE_PATH=|" .env 2>/dev/null || true
            fi
            ;;
        *)
            echo "  ✅ 使用 named volume"
            sed -i "s|^WORKSPACE_PATH=.*|# WORKSPACE_PATH=|" .env 2>/dev/null || true
            ;;
    esac
}

start_services() {
    echo
    echo "========================================"
    echo "6. 啟動服務"
    echo "========================================"

    echo "  執行 docker compose up -d..."
    docker compose up -d

    echo "  等待服務啟動..."
    echo -n "  "
    for i in {1..30}; do
        if docker compose ps --format json 2>/dev/null | grep -q "running"; then
            break
        fi
        echo -n "."
        sleep 2
    done
    echo

    echo "  檢查服務狀態..."
    docker compose ps
}

show_info() {
    echo
    echo "========================================"
    echo "7. 連線資訊"
    echo "========================================"

    HOST_IP=""
    if command -v ip &> /dev/null; then
        HOST_IP=$(ip route get 1.1.1.1 2>/dev/null | grep -oP 'src \K[^ ]+' | head -1)
    elif command -v hostname &> /dev/null; then
        HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}' | grep -v '^fe80\|^::' | head -1)
    fi

    if [ -n "$HOST_IP" ] && [[ ! "$HOST_IP" =~ ^127\. ]] && [[ ! "$HOST_IP" =~ ^:: ]]; then
        echo "  🌐 請使用以下網址存取 OpenChamber:"
        echo "     http://${HOST_IP}:8000"
        echo
        echo "  登入資訊:"
        echo "    - UI Password: (請查看 .env 中的 OPENCHAMBER_UI_PASSWORD)"
        echo "    - OpenCode Password: devonly"
    else
        echo "  ⚠️  無法自動偵測主機 IP"
        echo
        echo "  請查詢主機 IP 後使用以下網址:"
        echo "    http://{YOUR_IP}:8000"
        echo
        echo "  查詢方式:"
        echo "    - Linux: ip route get 1.1.1.1 | awk '{print \$6}'"
        echo "    - macOS: ipconfig getifaddr en0"
        echo "    - Windows: ipconfig | findstr /i IPv4"
    fi

    echo
    echo "  其他服務:"
    echo "    - Ollama API: http://${HOST_IP:-localhost}:11434"
    echo
    echo "========================================"
    echo "  安裝完成!"
    echo "========================================"
}

main() {
    cd "$(dirname "$0")"

    check_system
    check_docker
    check_and_prepare_volumes
    download_files
    setup_env
    start_services
    show_info
}

main "$@"