#!/usr/bin/env bash
# install-v2.sh — first-time install of the V2 line.
#
# Installs the V2 production stack (docker-compose.v2.yml, .env.v2), which is a
# separate release line from V1 (main): disjoint `-v2` volumes, no shared
# mutable state (trial/DECISIONS.md D2). Coexists on one host with V1:
#   V1 prod 8000/8080 · V1 dev 8001/8081 · V2 prod 8002/8082 · V2 dev 8003/8083.
set -euo pipefail

REPO_URL="https://raw.githubusercontent.com/tryweb/ai-engkit/v2"
COMPOSE_FILE="docker-compose.v2.yml"
ENV_FILE=".env.v2"
ENV_EXAMPLE=".env.v2.example"
ADMIN_DATA_DIR="admin-data-v2"
BACKUP_DIR="backups-v2"

if [ -t 1 ]; then
    RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
    CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
else
    RED=''; GREEN=''; YELLOW=''; CYAN=''; BOLD=''; NC=''
fi
info() { echo -e "  ${CYAN}ℹ${NC}  $1"; }
ok()   { echo -e "  ${GREEN}✅${NC} $1"; }
warn() { echo -e "  ${YELLOW}⚠️${NC}  $1"; }
fail() { echo -e "  ${RED}❌${NC} $1"; exit 1; }
header() { echo; echo -e "${BOLD}==============================${NC}"; echo -e "${BOLD} $1${NC}"; echo -e "${BOLD}==============================${NC}"; }

download() {
    local url="$1" dest="$2"
    if command -v curl &>/dev/null; then curl -fsSL "$url" -o "$dest"
    elif command -v wget &>/dev/null; then wget -qO "$dest" "$url"
    else return 1; fi
}

set_env_value() { # $1 key, $2 value — replace or append in $ENV_FILE
    local key="$1" val="$2" tmp
    if grep -qE "^${key}=" "$ENV_FILE" 2>/dev/null; then
        tmp=$(mktemp)
        awk -v k="$key" -v v="$val" 'BEGIN{FS=OFS="="} $1==k{print k"="v; next} {print}' "$ENV_FILE" > "$tmp" && mv "$tmp" "$ENV_FILE"
    else
        printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
    fi
}

# --- DooD contract -----------------------------------------------------------
# The V2 production stack keeps file-level host bind mounts that the Admin UI
# upgrade path requires (see the docker-compose.v2.yml header). Those binds only
# resolve correctly when `docker compose` runs on the Docker host: a container
# cannot resolve this install directory's host sources, so the host daemon would
# auto-create empty directories and break ai-admin (EISDIR / HTTP 500). Refuse to
# run from inside a container unless explicitly overridden for testing.
inside_container() {
    [ -f /.dockerenv ] && return 0
    [ -f /run/.containerenv ] && return 0
    grep -qaE '(^|[^a-z])(docker|containerd|kubepods|lxc)([^a-z]|$)' /proc/1/cgroup 2>/dev/null && return 0
    return 1
}

require_host() {
    header "0. Verifying Execution Environment"
    if inside_container; then
        if [ "${AI_ENGKIT_SKIP_HOST_CHECK:-0}" = "1" ]; then
            warn "Inside a container with AI_ENGKIT_SKIP_HOST_CHECK=1 — file bind sources may resolve incorrectly under DooD; test use only"
            return 0
        fi
        fail "Running inside a container. Docker-out-of-Docker cannot resolve this install directory's host file bind mounts; Docker would auto-create empty directories and break ai-admin. Run this on the Docker HOST from the install directory: cd <host-install-dir> && ./$(basename "$0")"
    fi
    ok "Running on the Docker host"
}

# File-level bind sources must be regular files on the Docker host. Docker
# auto-creates a missing source as an empty directory, which makes ai-admin read
# a directory at /opt/ai-engkit/.env and fail with EISDIR. Directory-level mounts
# (admin-data-v2/, backups-v2/, extensions/) are intentionally not checked: an
# empty auto-created directory there is harmless.
verify_bind_sources() { # $1 = 1 to also require each file to already exist
    local require_exist="${1:-0}" f
    for f in "$ENV_FILE" "$COMPOSE_FILE" "$ADMIN_DATA_DIR/upgrade-base.yml"; do
        if [ -d "$f" ]; then
            fail "$f is a DIRECTORY, not a file (a previous run let Docker auto-create it from a missing bind source). Remove it and re-run: rm -rf '$f'"
        fi
        if [ "$require_exist" = "1" ]; then
            [ -e "$f" ] || fail "$f is missing; Docker would auto-create a directory there and break ai-admin (EISDIR). Run install-v2.sh or restore the file first."
            [ -f "$f" ] || fail "$f is not a regular file"
        fi
    done
}

check_system() {
    header "1. Checking System Specifications"
    [ "${SKIP_SYSTEM_CHECK:-0}" = "1" ] && { warn "SKIP_SYSTEM_CHECK=1, skipping"; return 0; }
    local RAM_KB="" cg_limit
    CPU_CORES=$(nproc 2>/dev/null || echo 0)
    if [ -r /sys/fs/cgroup/memory.max ]; then
        cg_limit=$(cat /sys/fs/cgroup/memory.max 2>/dev/null || true)
        [[ "$cg_limit" =~ ^[0-9]+$ ]] && [ "$cg_limit" -lt $((1 << 40)) ] && RAM_KB=$((cg_limit / 1024))
    fi
    { [ -z "$RAM_KB" ] || [ "$RAM_KB" -le 0 ]; } 2>/dev/null && RAM_KB=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || true)
    RAM_KB="${RAM_KB:-0}"
    DISK_GB=$(( $(df -Pk / 2>/dev/null | tail -1 | awk '{print $4}') / 1024 / 1024 ))
    RAM_GB_INT=$((RAM_KB / 1024 / 1024))
    echo "  CPU cores: $CPU_CORES  |  RAM: ${RAM_GB_INT} GB  |  Disk: ${DISK_GB} GB"
    [ "$CPU_CORES" -lt 2 ] && fail "Requires at least 2 CPU cores"
    [ "$RAM_GB_INT" -lt 2 ] && fail "Requires at least 2 GB RAM (4 GB recommended)"
    [ "$DISK_GB" -lt 30 ] && warn "Less than 30 GB disk free (recommended)"
    local flags; flags=$(grep -m1 '^flags' /proc/cpuinfo 2>/dev/null || echo "")
    if ! echo "$flags" | grep -qw 'avx' || ! echo "$flags" | grep -qw 'avx2'; then
        fail "Unsupported CPU: AVX and AVX2 are required by the OpenCode runtime"
    fi
    ok "System specifications meet requirements"
}

check_docker() {
    header "2. Checking Docker Environment"
    command -v docker &>/dev/null || fail "Docker not installed"
    docker compose version &>/dev/null || fail "Docker Compose V2 not installed"
    [ -S /var/run/docker.sock ] || fail "Docker socket does not exist"
    docker info &>/dev/null || fail "Cannot connect to Docker daemon"
    command -v curl &>/dev/null || command -v wget &>/dev/null || fail "Missing curl or wget"
    ok "Docker + Compose + daemon ready"
}

fetch_assets() {
    header "3. Fetching Configuration"
    verify_bind_sources 0
    if [ ! -f "$COMPOSE_FILE" ]; then
        download "$REPO_URL/$COMPOSE_FILE" "$COMPOSE_FILE" || fail "Failed to download $COMPOSE_FILE"
        ok "$COMPOSE_FILE downloaded"
    else
        ok "$COMPOSE_FILE already exists"
    fi
    if [ ! -f "$ENV_FILE" ]; then
        download "$REPO_URL/$ENV_EXAMPLE" "$ENV_FILE" || fail "Failed to download $ENV_EXAMPLE"
        chmod 600 "$ENV_FILE"
        ok "$ENV_FILE created"
    else
        ok "$ENV_FILE already exists"
    fi
}

prompt_passwords() {
    header "4. Passwords"
    if [ -z "${OPENCHAMBER_UI_PASSWORD:-}" ]; then
        read -s -p "  OpenChamber UI password: " OPENCHAMBER_UI_PASSWORD < /dev/tty || true
        echo
        [ -z "$OPENCHAMBER_UI_PASSWORD" ] && fail "UI password cannot be empty"
        set_env_value "OPENCHAMBER_UI_PASSWORD" "$OPENCHAMBER_UI_PASSWORD"
        ok "UI password set"
    else
        ok "UI password already set in environment"
    fi
    if [ -z "${ADMIN_PASSWORD:-}" ]; then
        read -s -p "  Admin Dashboard password (required): " ADMIN_PASSWORD < /dev/tty || true
        echo
        [ -z "$ADMIN_PASSWORD" ] && fail "Admin password cannot be empty"
        set_env_value "ADMIN_PASSWORD" "$ADMIN_PASSWORD"
        ok "Admin password set"
    else
        ok "Admin password already set in environment"
    fi
}

prepare_volumes() {
    header "5. Preparing Host Directories"
    mkdir -p "./$BACKUP_DIR"; chmod 700 "./$BACKUP_DIR"; chown 1000:1000 "./$BACKUP_DIR" 2>/dev/null || true
    ok "./$BACKUP_DIR ready"
    mkdir -p "./$ADMIN_DATA_DIR"
    [ -f "./$ADMIN_DATA_DIR/upgrade-base.yml" ] || : > "./$ADMIN_DATA_DIR/upgrade-base.yml"
    [ -f "./$ADMIN_DATA_DIR/provider-keys.json" ] || printf '{"providers":{}}\n' > "./$ADMIN_DATA_DIR/provider-keys.json"
    chown 1000:1000 "./$ADMIN_DATA_DIR" "./$ADMIN_DATA_DIR/upgrade-base.yml" "./$ADMIN_DATA_DIR/provider-keys.json" 2>/dev/null || true
    chmod 700 "./$ADMIN_DATA_DIR"; chmod 600 "./$ADMIN_DATA_DIR/upgrade-base.yml" "./$ADMIN_DATA_DIR/provider-keys.json"
    ok "./$ADMIN_DATA_DIR ready"
    mkdir -p ./extensions; chmod 755 ./extensions
    ok "./extensions ready"

    # Optional host bind for the ai-dev workspace (mirrors V1's WORKSPACE_PATH).
    # Unset keeps the `workspace-v2` named volume. Under Docker-out-of-Docker the
    # value MUST be an absolute host path: a relative path resolves against the
    # admin container's Compose directory and can bind the wrong host directory
    # (see the README "DooD note").
    local ws="${WORKSPACE_PATH:-}"
    if [ -z "$ws" ]; then
        ws=$(grep -E '^WORKSPACE_PATH=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)
    fi
    if [ -z "$ws" ]; then
        ok "workspace: named volume workspace-v2 (set WORKSPACE_PATH to bind a host path)"
    else
        case "$ws" in
            /*) ;;
            *) fail "WORKSPACE_PATH must be an absolute host path (got: '$ws'). Relative paths are unsafe under DooD." ;;
        esac
        [ -d "$ws" ] || warn "WORKSPACE_PATH='$ws' does not exist yet; Docker will create it as an empty directory"
        [ -n "${WORKSPACE_PATH:-}" ] && set_env_value "WORKSPACE_PATH" "$WORKSPACE_PATH"
        ok "workspace bind: $ws"
    fi
}

start_services() {
    header "6. Starting Services"
    echo "  docker compose --env-file $ENV_FILE -f $COMPOSE_FILE up -d"
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d || fail "docker compose up failed"
    for _ in $(seq 1 30); do
        [ "$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps --status running --format '{{.Name}}' 2>/dev/null | wc -l)" -ge 2 ] && break
        sleep 2
    done
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps || true
}

show_info() {
    local chamber_port admin_port host_ip
    chamber_port=$(grep -E "^CHAMBER_V2_PORT=" "$ENV_FILE" 2>/dev/null | cut -d= -f2 || true)
    admin_port=$(grep -E "^ADMIN_V2_PORT=" "$ENV_FILE" 2>/dev/null | cut -d= -f2 || true)
    host_ip=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
    header "Installation complete"
    echo "  OpenChamber: http://${host_ip:-localhost}:${chamber_port:-8002}"
    echo "  Admin:       http://${host_ip:-localhost}:${admin_port:-8082}"
    echo
    echo "  Upgrade later:  curl -fsSL ${REPO_URL}/upgrade-v2.sh | bash"
    echo "  Env file:       ${ENV_FILE} (compose is run with --env-file ${ENV_FILE})"
    echo "  The V2 line shares no state with V1; do not reuse V1 volumes."
}

main() {
    echo -e "${BOLD}AI-EngKit — V2 line installer${NC}"
    require_host
    if [ -f "docker-compose.yml" ] && [ ! -f "$COMPOSE_FILE" ]; then
        fail "A V1 install (docker-compose.yml) is present here. Use install.sh for V1, or run this in a separate directory."
    fi
    check_system
    check_docker
    fetch_assets
    prompt_passwords
    prepare_volumes
    verify_bind_sources 1
    start_services
    show_info
}

main "$@"
