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

    CPU_FLAGS=$(grep -m1 '^flags' /proc/cpuinfo 2>/dev/null || echo "")
    HAS_AVX=false
    HAS_AVX2=false
    if echo "$CPU_FLAGS" | grep -qw 'avx'; then
        HAS_AVX=true
    fi
    if echo "$CPU_FLAGS" | grep -qw 'avx2'; then
        HAS_AVX2=true
    fi

    if [ "$HAS_AVX" = "true" ] && [ "$HAS_AVX2" = "true" ]; then
        echo "  ✅ CPU 指令集: AVX + AVX2 支援"
    else
        echo ""
        echo "  ❌ CPU 缺少必要的 SIMD 指令集:"
        if [ "$HAS_AVX" = "false" ]; then
            echo "     - AVX  未支援 (opencode 標準版需要)"
        fi
        if [ "$HAS_AVX2" = "false" ]; then
            echo "     - AVX2 未支援 (lancedb prebuilt binary 需要)"
        fi
        echo ""
        echo "  這些指令集為 opencode + lancedb-opencode-pro 的必要條件。"
        echo "  常見不支援的環境: 舊型 CPU、部分雲端 VM (t2.micro 等)、QEMU 預設模式"
        echo "  建議: 使用支援 AVX2 的機器 (Intel Haswell 2013+ / AMD Excavator 2015+)"
        exit 1
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
    echo "3. 檢查並準備 Volumes (選用)"
    echo "========================================"

    # v0.5.0+ 使用 named volumes，entrypoint 會自動建立預設檔案
    # 這裡只檢查是否有可選的 host 端設定需要同步

    DOWNLOAD_TOOL="curl -fsSL"
    if ! command -v curl &> /dev/null; then
        DOWNLOAD_TOOL="wget -qO-"
    fi

    echo "  使用 named volumes (由容器自動管理)"
    echo ""

    check_gh_cli
    check_glab_cli
}

check_gh_cli() {
    echo
    if command -v gh &> /dev/null; then
        echo "  ✅ GitHub CLI (gh) 已安裝: $(gh --version | head -1)"
        if ! gh auth status &> /dev/null; then
            echo "  ⚠️  gh 尚未登入，容器內的 git 操作可能無法使用 GitHub"
            echo "     請執行: gh auth login"
        fi
        return
    fi

    echo "  ⚠️  未偵測到 GitHub CLI (gh)"
    echo "     gh 可讓容器內直接操作 GitHub PR / Issue / Repo"
    echo
    read -p "  是否立即安裝 gh？(y/N): " INSTALL_GH
    case "$INSTALL_GH" in
        y|Y)
            echo "  正在安裝 GitHub CLI..."
            if command -v apt-get &> /dev/null; then
                curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
                    | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null
                sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
                echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
                    | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
                sudo apt-get update -qq && sudo apt-get install -y gh
                echo "  ✅ gh 安裝完成，請執行 gh auth login 登入"
            elif command -v brew &> /dev/null; then
                brew install gh
                echo "  ✅ gh 安裝完成，請執行 gh auth login 登入"
            else
                echo "  ❌ 無法自動安裝，請手動安裝: https://cli.github.com/"
            fi
            ;;
        *)
            echo "  跳過 gh 安裝。若日後需要，請參考: https://cli.github.com/"
            ;;
    esac
}

check_glab_cli() {
    if command -v glab &> /dev/null; then
        echo "  ✅ GitLab CLI (glab) 已安裝: $(glab --version | head -1)"
        if ! glab auth status &> /dev/null; then
            echo "  ⚠️  glab 尚未登入，容器內的 git 操作可能無法使用 GitLab"
            echo "     請執行: glab auth login"
        fi
        return
    fi

    echo "  ℹ️  未偵測到 GitLab CLI (glab)"
    echo "     glab 可讓容器內直接操作 GitLab MR / Issue / Repo"
    echo "     如有需要，可在容器內執行: sudo apt-get install -y glab"
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
    echo "    1) Named Volume (預設，完全 Docker 管理)"
    echo "    2) Bind Mount ./workspace (可直接用本地 IDE 編輯)"
    echo "    3) 自訂路徑"
    read -p "  選擇 [1/2/3]: " WS_CHOICE

    case "$WS_CHOICE" in
        2)
            if [ ! -d "./workspace" ]; then
                echo "  📁 建立目錄: ./workspace"
                mkdir -p "./workspace"
            fi
            sed -i "s|^WORKSPACE_PATH=.*|WORKSPACE_PATH=./workspace|" .env 2>/dev/null || true
            echo "  ✅ 使用 bind mount: ./workspace"
            ;;
        3)
            echo "  請輸入主機上的 workspace 路徑:"
            read -p "  WORKSPACE_PATH: " WS_PATH
            WS_PATH="${WS_PATH:-./workspace}"
            if [ ! -d "$WS_PATH" ]; then
                echo "  📁 建立目錄: $WS_PATH"
                mkdir -p "$WS_PATH"
            fi
            sed -i "s|^WORKSPACE_PATH=.*|WORKSPACE_PATH=$WS_PATH|" .env 2>/dev/null || true
            echo "  ✅ WORKSPACE_PATH 已設定為: $WS_PATH"
            ;;
        *)
            sed -i "s|^WORKSPACE_PATH=.*|# WORKSPACE_PATH=|" .env 2>/dev/null || true
            echo "  ✅ 使用 named volume (預設)"
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

    [ -t 0 ] || exec < /dev/tty

    check_system
    check_docker
    check_and_prepare_volumes
    download_files
    setup_env
    start_services
    show_info
}

main "$@"