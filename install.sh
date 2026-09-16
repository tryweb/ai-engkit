#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://raw.githubusercontent.com/tryweb/ai-engkit/main"

# Portable download helper (curl preferred, wget fallback)
# NOTE: wget -O is the output file, -o is the log file
download() {
    local url="$1" dest="$2"
    if command -v curl &>/dev/null; then
        curl -fsSL "$url" -o "$dest"
    elif command -v wget &>/dev/null; then
        wget -qO "$dest" "$url"
    else
        return 1
    fi
}

# Resolve a WORKSPACE_PATH value read from .env without invoking a shell.
# Only plain paths and a leading "~/" are expanded, so command substitution and
# other shell syntax in .env are treated as literal text, never executed.
expand_workspace_path() {
    local path="$1"
    case "$path" in
        "~")   printf '%s' "$HOME" ;;
        "~/"*) printf '%s/%s' "$HOME" "${path:2}" ;;
        *)     printf '%s' "$path" ;;
    esac
}

set_env_value() {
    local key="$1"
    local value="$2"

    if grep -qE "^[[:space:]]*#?[[:space:]]*${key}=" .env 2>/dev/null; then
        sed -i "s|^[[:space:]]*#\{0,1\}[[:space:]]*${key}=.*|${key}=${value}|" .env
    else
        echo "${key}=${value}" >> .env
    fi
}

unset_env_value() {
    local key="$1"

    if grep -qE "^[[:space:]]*#?[[:space:]]*${key}=" .env 2>/dev/null; then
        sed -i "s|^[[:space:]]*#\{0,1\}[[:space:]]*${key}=.*|# ${key}=|" .env
    else
        echo "# ${key}=" >> .env
    fi
}

check_system() {
    echo "========================================"
    echo "1. Checking System Hardware Specifications"
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
        echo "  ❌ Insufficient CPU cores (at least 2 required)"
        exit 1
    elif [ "$CPU_CORES" -lt 4 ]; then
        echo "  ⚠️  Warning: CPU below recommended specs (4 cores preferred)"
    else
        echo "  ✅ CPU meets recommended specifications"
    fi

    if [ "$RAM_GB" -lt 4 ]; then
        echo "  ❌ Insufficient RAM (at least 4 GB required)"
        exit 1
    elif [ "$RAM_GB" -lt 8 ]; then
        echo "  ⚠️  Warning: RAM below recommended specs (8 GB preferred)"
    else
        echo "  ✅ RAM meets recommended specifications"
    fi

    if [ "$DISK_GB" -lt 30 ]; then
        echo "  ❌ Insufficient disk space (at least 30 GB required)"
        exit 1
    elif [ "$DISK_GB" -lt 100 ]; then
        echo "  ⚠️  Warning: Disk space below recommended specs (100 GB preferred)"
    else
        echo "  ✅ Disk space meets recommended specifications"
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
        echo "  ✅ CPU instruction set: AVX + AVX2 supported"
    else
        echo ""
        echo "  ❌ CPU missing required SIMD instruction sets:"
        if [ "$HAS_AVX" = "false" ]; then
            echo "     - AVX not supported (required by opencode standard)"
        fi
        if [ "$HAS_AVX2" = "false" ]; then
            echo "     - AVX2 not supported (required by lancedb prebuilt binary)"
        fi
        echo ""
        echo "  These instruction sets are required for opencode."
        echo "  Common unsupported environments: older CPUs, some cloud VMs (t2.micro, etc.), QEMU default mode"
        echo "  Recommendation: Use machines with AVX2 support (Intel Haswell 2013+ / AMD Excavator 2015+)"
        exit 1
    fi
}

check_docker() {
    echo
    echo "========================================"
    echo "2. Checking Docker Environment"
    echo "========================================"

    if ! command -v docker &> /dev/null; then
        echo "  ❌ Docker not installed"
        echo "    Please refer to: https://docs.docker.com/get-docker/"
        exit 1
    fi
    echo "  ✅ Docker installed: $(docker --version | head -1)"

    if command -v docker compose &> /dev/null; then
        echo "  ✅ Docker Compose V2 installed"
    elif command -v docker-compose &> /dev/null; then
        echo "  ⚠️  Detected docker-compose (V1)"
    else
        echo "  ❌ Docker Compose not installed"
        exit 1
    fi

    SOCK="/var/run/docker.sock"
    if [ ! -S "$SOCK" ]; then
        echo "  ❌ Docker socket does not exist"
        exit 1
    fi
    echo "  ✅ Docker socket exists: $(ls -la "$SOCK" | awk '{print $1}')"

    if ! docker info &> /dev/null; then
        echo "  ❌ Cannot connect to Docker daemon"
        exit 1
    fi
    echo "  ✅ Docker daemon running normally"

    if ! command -v curl &> /dev/null && ! command -v wget &> /dev/null; then
        echo "  ❌ Missing curl or wget"
        exit 1
    fi
    echo "  ✅ Network tools installed"
}

check_and_prepare_volumes() {
    echo
    echo "========================================"
    echo "3. Checking and Preparing Volumes (Optional)"
    echo "========================================"

    # v0.5.0+ uses named volumes, entrypoint will auto-create default files
    echo "  Using named volumes (managed automatically by containers)"
    echo ""
}

download_files() {
    echo
    echo "========================================"
    echo "4. Downloading Configuration Files"
    echo "========================================"

    if [ ! -f "docker-compose.yml" ]; then
        echo "  Downloading docker-compose.yml..."
        download "$REPO_URL/docker-compose.yml" docker-compose.yml
        echo "  ✅ docker-compose.yml downloaded"
    else
        echo "  ✅ docker-compose.yml already exists"
    fi

    if [ ! -f ".env" ]; then
        if [ -f ".env.example" ]; then
            echo "  Copying .env.example -> .env"
            cp .env.example .env
        else
            echo "  Downloading .env.example..."
            download "$REPO_URL/.env.example" .env
        fi
        echo "  ✅ .env created, please edit settings"
    else
        echo "  ✅ .env already exists"
    fi

    echo "  Downloading latest upgrade.sh..."
    download "$REPO_URL/upgrade.sh" upgrade.sh
    chmod +x upgrade.sh
    echo "  ✅ upgrade.sh ready (run ./upgrade.sh later to upgrade)"
}

setup_env() {
    echo
    echo "========================================"
    echo "5. Environment Setup"
    echo "========================================"

    if [ -f ".env" ]; then
        source .env
    fi

    if [ -z "${OPENCHAMBER_UI_PASSWORD:-}" ]; then
        echo "  Please set the Web UI password (required):"
        read -s -p "  UI_PASSWORD: " UI_PASS < /dev/tty
        echo
        if [ -z "$UI_PASS" ]; then
            echo "  ❌ Password cannot be empty"
            exit 1
        fi
        sed -i "s/^OPENCHAMBER_UI_PASSWORD=.*/OPENCHAMBER_UI_PASSWORD=$UI_PASS/" .env 2>/dev/null || true
        echo "  ✅ UI password set"
    else
        echo "  ✅ UI password already set"
    fi

    if [ -z "${ADMIN_PASSWORD:-}" ]; then
        echo "  Please set the Admin Dashboard password (required):"
        read -s -p "  ADMIN_PASSWORD: " ADMIN_PASS < /dev/tty
        echo
        if [ -z "$ADMIN_PASS" ]; then
            echo "  ❌ Password cannot be empty"
            exit 1
        fi
        set_env_value "ADMIN_PASSWORD" "$ADMIN_PASS"
        echo "  ✅ Admin password set"
    else
        echo "  ✅ Admin password already set"
    fi

    echo "  Please select Workspace type:"
    echo "    1) Named Volume (default, fully Docker managed)"
    echo "    2) Bind Mount ./workspace (can edit directly with local IDE)"
    echo "    3) Custom path"
    read -p "  Select [1/2/3]: " WS_CHOICE < /dev/tty

    case "$WS_CHOICE" in
        2)
            if [ ! -d "./workspace" ]; then
                echo "  📁 Creating directory: ./workspace"
                mkdir -p "./workspace"
            fi
            set_env_value "WORKSPACE_PATH" "./workspace"
            echo "  ✅ Using bind mount: ./workspace"
            ;;
        3)
            echo "  Please enter the workspace path on the host:"
            read -p "  WORKSPACE_PATH: " WS_PATH < /dev/tty
            WS_PATH="${WS_PATH:-./workspace}"
            if [ ! -d "$WS_PATH" ]; then
                echo "  📁 Creating directory: $WS_PATH"
                mkdir -p "$WS_PATH"
            fi
            set_env_value "WORKSPACE_PATH" "$WS_PATH"
            echo "  ✅ WORKSPACE_PATH set to: $WS_PATH"
            ;;
        *)
            unset_env_value "WORKSPACE_PATH"
            echo "  ✅ Using named volume (default)"
            ;;
    esac
}

ensure_provider_state() {
    local TIMESTAMP
    TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    local state_dir="admin-data"
    local state_file="${state_dir}/provider-keys.json"
    local legacy_dir="provider-state"
    local legacy_file="${legacy_dir}/provider-keys.json"
    mkdir -p "$state_dir"

    # Migrate the legacy provider-state registry (preserve, never delete)
    if [ -d "$legacy_file" ]; then
        mv "$legacy_file" "${legacy_file}.legacy.${TIMESTAMP}"
    fi
    if [ -f "$legacy_file" ] && [ ! -e "$state_file" ]; then
        mv "$legacy_file" "$state_file"
        echo "  ✅ migrated provider-keys.json from ${legacy_dir}/ into ${state_dir}/"
    elif [ -e "$legacy_file" ]; then
        mv "$legacy_file" "${legacy_file}.legacy.${TIMESTAMP}"
        echo "  ⚠️  preserved legacy provider-keys.json as ${legacy_file}.legacy.${TIMESTAMP}"
    fi
    if [ -e provider-keys.json ]; then
        if [ -f provider-keys.json ] && [ ! -e "$state_file" ]; then
            mv provider-keys.json "$state_file"
            echo "  ✅ migrated legacy provider-keys.json into ${state_dir}/"
        else
            mv provider-keys.json "provider-keys.json.legacy.${TIMESTAMP}"
            echo "  ⚠️  preserved legacy provider-keys.json as provider-keys.json.legacy.${TIMESTAMP}"
        fi
    fi
    if [ ! -f "$state_file" ]; then
        printf '{"providers":{}}\n' > "$state_file"
        echo "  ✅ provider registry initialized"
    fi
    chown 1000:1000 "$state_dir" "$state_file" 2>/dev/null || true
    chmod 700 "$state_dir"
    chmod 600 "$state_file"
    echo "  ✅ provider registry ready"
}

prepare_overlay_paths() {
    # The overlay-aware upgrade mounts ./extensions read-only into ai-admin and
    # stages the upstream base at ./admin-data/upgrade-base.yml. Create both host
    # paths before `docker compose up`: a missing bind-mount source for a file
    # would otherwise be auto-created as a directory by Docker.
    mkdir -p ./extensions
    chmod 755 ./extensions
    echo "  ✅ ./extensions ready"

    mkdir -p ./admin-data
    if [ ! -f ./admin-data/upgrade-base.yml ]; then
        : > ./admin-data/upgrade-base.yml
    fi
    chmod 600 ./admin-data/upgrade-base.yml
    chown 1000:1000 ./admin-data/upgrade-base.yml 2>/dev/null || true
    echo "  ✅ ./admin-data/upgrade-base.yml ready"
}

prepare_volumes() {
    echo
    echo "========================================"
    echo "6. Preparing Volume Directories"
    echo "========================================"

    echo "  Creating ./backups (for admin container backups)..."
    mkdir -p ./backups
    chmod 700 ./backups
    chown 1000:1000 ./backups 2>/dev/null || true
    echo "  ✅ ./backups ready"

    ensure_provider_state
    prepare_overlay_paths

    echo "  Creating ./workspace (for code editing)..."
    WS_PATH=$(grep -E "^WORKSPACE_PATH=" .env 2>/dev/null | cut -d= -f2- || echo "")
    if [ -n "$WS_PATH" ]; then
        WS_PATH=$(expand_workspace_path "$WS_PATH")
        if [ ! -d "$WS_PATH" ]; then
            mkdir -p "$WS_PATH"
        fi
    fi
    echo "  ✅ workspace directory confirmed"
}

start_services() {
    echo
    echo "========================================"
    echo "7. Starting Services"
    echo "========================================"

    echo "  Running docker compose up -d..."
    docker compose up -d

    echo "  Waiting for services to start..."
    echo -n "  "
    for i in {1..30}; do
        if docker compose ps --format json 2>/dev/null | grep -q "running"; then
            break
        fi
        echo -n "."
        sleep 2
    done
    echo

    echo "  Checking service status..."
    docker compose ps
}

show_info() {
    echo
    echo "========================================"
    echo "8. Connection Information"
    echo "========================================"

    HOST_IP=""
    if command -v ip &> /dev/null; then
        HOST_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}')
    elif command -v hostname &> /dev/null; then
        HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}' | grep -v '^fe80\|^::' | head -1)
    fi

    local chamber_port
    chamber_port=$(grep -E "^CHAMBER_PORT=" .env 2>/dev/null | cut -d= -f2 || true)
    chamber_port="${chamber_port:-8000}"

    if [ -n "$HOST_IP" ] && [[ ! "$HOST_IP" =~ ^127\. ]] && [[ ! "$HOST_IP" =~ ^:: ]]; then
        echo "  🌐 Access OpenChamber using the following URL:"
        echo "     http://${HOST_IP}:${chamber_port}"
        echo
        echo "  Login credentials:"
        echo "    - UI Password: (check OPENCHAMBER_UI_PASSWORD in .env)"
        echo "    - OpenCode Password: devonly"
    else
        echo "  ⚠️  Unable to auto-detect host IP"
        echo
        echo "  Please find your host IP and use the following URL:"
        echo "    http://{YOUR_IP}:${chamber_port}"
        echo
        echo "  How to find your IP:"
        echo "    - Linux: ip route get 1.1.1.1 | awk '{print \$6}'"
        echo "    - macOS: ipconfig getifaddr en0"
        echo "    - Windows: ipconfig | findstr /i IPv4"
    fi

    echo
    echo "  Admin Dashboard: http://${HOST_IP:-localhost}:${ADMIN_PORT:-8080}"
    echo "    (login with ADMIN_PASSWORD set during install)"
    echo
    echo "  Upgrade command: ./upgrade.sh"
    echo "    (pulls new compose/image from upstream, auto-backup and merge .env)"
    echo
    echo "========================================"
    echo "  Installation complete!"
    echo "========================================"
}

delegate_to_upgrade_if_installed() {
    if [ ! -f "docker-compose.yml" ]; then
        return 0
    fi

    echo
    echo "========================================"
    echo "  Detected Existing Installation"
    echo "========================================"
    echo "  - docker-compose.yml exists at $(pwd)"
    echo "  - install.sh is for first-time install only; run ./upgrade.sh instead"
    echo

    echo "  Downloading latest upgrade.sh..."
    if ! download "$REPO_URL/upgrade.sh" upgrade.sh; then
        echo "  ❌ Failed to download upgrade.sh, please check network connection"
        exit 1
    fi
    chmod +x upgrade.sh
    echo "  ✅ upgrade.sh updated to latest version"

    echo "  Delegating to ./upgrade.sh ..."
    echo
    exec ./upgrade.sh "$@"
}

main() {
    cd "$(dirname "$0")"

    delegate_to_upgrade_if_installed "$@"

    # Check /dev/tty availability before any side effects.
    # Without a controlling terminal, interactive reads fail with a cryptic error.
    if ! [ -t 0 ] && ! (: < /dev/tty) 2>/dev/null; then
        echo "  ❌ Interactive prompts require a controlling terminal."
        echo "     Run via: ssh -t root@HOST or use a local terminal."
        echo "     For non-interactive installs, pre-configure .env with:"
        echo "       OPENCHAMBER_UI_PASSWORD=your_password"
        echo "       ADMIN_PASSWORD=your_password"
        exit 1
    fi

    check_system
    check_docker
    check_and_prepare_volumes
    download_files
    setup_env
    prepare_volumes
    start_services
    show_info
}

main "$@"
