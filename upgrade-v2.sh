#!/usr/bin/env bash
# upgrade-v2.sh — upgrade an existing V2-line installation.
#
# The V2 line is a separate release line from V1 (main): it runs
# docker-compose.v2.yml (production, pull) with .env.v2 and disjoint `-v2`
# volumes, and shares NO mutable state with V1 (trial/DECISIONS.md D2).
#
# This script upgrades ONLY a V2 installation. For a V1 installation (main,
# docker-compose.yml + .env) run upgrade.sh from the main branch.
#
# Design (mirrors upgrade.sh's safety properties):
#   * non-interactive  * backup-first  * merge-only env  * explicit pull
#   * idempotent       * rollback instructions printed
set -euo pipefail

REPO_URL="https://raw.githubusercontent.com/tryweb/ai-engkit/v2"
COMPOSE_FILE="docker-compose.v2.yml"
ENV_FILE=".env.v2"
ENV_EXAMPLE=".env.v2.example"
PROJECT="v2"
ADMIN_DATA_DIR="admin-data-v2"
BACKUP_PREFIX="backup_v2_"
SELF_NAME="upgrade-v2.sh"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

if [ -t 1 ]; then
    RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
    CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
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

# V2 Compose invocations always pin the compose file and env file explicitly:
# `docker compose` defaults to docker-compose.yml/.env, neither of which the V2
# line uses.
dc() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

check_system() {
    header "1. Checking System Hardware Specifications"
    [ "${SKIP_SYSTEM_CHECK:-0}" = "1" ] && { warn "SKIP_SYSTEM_CHECK=1, skipping"; return 0; }

    local RAM_KB="" cg_limit warnings=0
    CPU_CORES=$(nproc 2>/dev/null || echo 0)
    if [ -r /sys/fs/cgroup/memory.max ]; then
        cg_limit=$(cat /sys/fs/cgroup/memory.max 2>/dev/null || true)
        [[ "$cg_limit" =~ ^[0-9]+$ ]] && [ "$cg_limit" -lt $((1 << 40)) ] && RAM_KB=$((cg_limit / 1024))
    elif [ -r /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then
        cg_limit=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null || true)
        [[ "$cg_limit" =~ ^[0-9]+$ ]] && [ "$cg_limit" -lt $((1 << 40)) ] && RAM_KB=$((cg_limit / 1024))
    fi
    { [ -z "$RAM_KB" ] || [ "$RAM_KB" -le 0 ]; } 2>/dev/null && RAM_KB=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || true)
    RAM_KB="${RAM_KB:-0}"
    DISK_KB=$(df -Pk / 2>/dev/null | tail -1 | awk '{print $4}')
    DISK_GB=$((DISK_KB / 1024 / 1024))
    RAM_GB_INT=$((RAM_KB / 1024 / 1024))
    echo "  CPU cores: $CPU_CORES  |  RAM: ${RAM_GB_INT} GB  |  Disk: ${DISK_GB} GB"

    [ "$CPU_CORES" -lt 2 ] && fail "Insufficient CPU cores (requires at least 2 cores)"
    [ "$RAM_GB_INT" -lt 2 ] && fail "Insufficient RAM (requires at least 2 GB; 4 GB recommended)"
    [ "$RAM_GB_INT" -lt 4 ] && { warn "RAM below recommended 4 GB — continuing"; warnings=1; }
    [ "$DISK_GB" -lt 5 ] && fail "Insufficient disk space (requires at least 5 GB)"

    CPU_FLAGS=$(grep -m1 '^flags' /proc/cpuinfo 2>/dev/null || echo "")
    if ! echo "$CPU_FLAGS" | grep -qw 'avx' || ! echo "$CPU_FLAGS" | grep -qw 'avx2'; then
        fail "Unsupported CPU: AVX and AVX2 are required by the OpenCode runtime"
    fi
    [ "$warnings" -eq 1 ] && warn "System meets minimum requirements" || ok "System specifications meet requirements"
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

# DECISIONS D2: refuse to run a V2 upgrade in a V1 directory, and warn if V1
# volumes exist on the host (V2 must never read or clobber V1 state).
guard_line() {
    header "3. Verifying a V2 installation"
    if [ ! -f "$COMPOSE_FILE" ]; then
        if [ -f "docker-compose.yml" ]; then
            fail "This looks like a V1 install (docker-compose.yml, no $COMPOSE_FILE). Run the V1 upgrade from the main branch instead."
        fi
        fail "No $COMPOSE_FILE in $(pwd). Run this from a V2 install directory, or use install-v2.sh for a fresh install."
    fi
    local v1_vols
    v1_vols=$(docker volume ls --format '{{.Name}}' 2>/dev/null \
        | grep -E '(^|_)(workspace|opencode-data|opencode-config|openchamber-data)$' || true)
    if [ -n "$v1_vols" ]; then
        warn "V1 volumes detected on this host; the V2 line uses disjoint -v2 volumes and never shares state with V1."
    fi
    ok "V2 installation detected ($COMPOSE_FILE)"
}

backup_files() {
    header "4. Backing Up Configuration"
    local backup_dir="${BACKUP_PREFIX}${TIMESTAMP}"
    mkdir -p "$backup_dir"; chmod 700 "$backup_dir"
    for f in "$COMPOSE_FILE" "$ENV_FILE"; do
        if [ -f "$f" ]; then
            cp "$f" "${backup_dir}/${f}"; chmod 600 "${backup_dir}/${f}"
            ok "${f} → ${backup_dir}/${f}"
        else
            info "${f} does not exist, skipping"
        fi
    done
    if [ -s "./${ADMIN_DATA_DIR}/upgrade-base.yml" ]; then
        cp "./${ADMIN_DATA_DIR}/upgrade-base.yml" "${backup_dir}/compose-upgrade-base.yml"; chmod 600 "${backup_dir}/compose-upgrade-base.yml"
        ok "compose-upgrade-base.yml backed up"
    fi
    local dev_ref
    dev_ref=$(dc ps -q ai-dev 2>/dev/null | head -1 || true)
    if [ -n "$dev_ref" ] && docker cp "${dev_ref}:/home/devuser/.config/openchamber/settings.json" "${backup_dir}/openchamber-settings.json" 2>/dev/null; then
        ok "OpenChamber settings backed up"
    fi
    echo "$backup_dir"
}

update_compose() {
    header "5. Updating $COMPOSE_FILE"
    echo "  Downloading latest $COMPOSE_FILE..."
    if download "$REPO_URL/$COMPOSE_FILE" "${COMPOSE_FILE}.new" && [ -s "${COMPOSE_FILE}.new" ]; then
        mv "${COMPOSE_FILE}.new" "$COMPOSE_FILE"
        ok "$COMPOSE_FILE updated"
    else
        rm -f "${COMPOSE_FILE}.new"
        fail "Failed to download $COMPOSE_FILE, please check network connection"
    fi
}

merge_env() {
    header "6. Merging $ENV_FILE Settings"
    if [ ! -f "$ENV_FILE" ]; then
        warn "$ENV_FILE does not exist, downloading from upstream"
        download "$REPO_URL/$ENV_EXAMPLE" "$ENV_FILE" || { rm -f "$ENV_FILE"; fail "Failed to download $ENV_EXAMPLE"; }
        ok "$ENV_FILE created from $ENV_EXAMPLE — edit it to set passwords"
        chmod 600 "$ENV_FILE"
        return 0
    fi
    local tmp_example added=0 line key
    tmp_example=$(mktemp)
    if ! download "$REPO_URL/$ENV_EXAMPLE" "$tmp_example"; then
        rm -f "$tmp_example"; warn "Failed to download $ENV_EXAMPLE, skipping env merge"; return 0
    fi
    while IFS= read -r line; do
        case "$line" in ''|\#*) continue ;; esac
        key="${line%%=*}"
        [ -z "$key" ] && continue
        if ! grep -qE "^(export[[:space:]]+)?${key}=" "$ENV_FILE" 2>/dev/null; then
            echo "$line" >> "$ENV_FILE"
            ok "➕ ${key} added to $ENV_FILE"
            added=$((added + 1))
        fi
    done < "$tmp_example"
    rm -f "$tmp_example"
    [ "$added" -gt 0 ] && ok "Merged $added new settings" || ok "$ENV_FILE already has all settings"
}

apply() {
    header "7. Pulling and Recreating"
    echo "  docker compose --env-file $ENV_FILE -f $COMPOSE_FILE pull"
    dc pull || fail "docker compose pull failed"
    echo "  docker compose ... up -d --force-recreate"
    dc up -d --force-recreate || fail "Container startup failed; check 'docker compose ps'"

    local i
    for i in $(seq 1 30); do
        if [ "$(dc ps --status running --format '{{.Name}}' 2>/dev/null | wc -l)" -ge 2 ]; then
            ok "V2 services running"; break
        fi
        [ "$i" -eq 30 ] && warn "Services did not report running within 60s; check 'docker compose ps'"
        sleep 2
    done
}

retention() {
    local backup_dir="$1" retention
    retention=$(grep -E "^BACKUP_RETENTION=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2 || true)
    retention="${retention:-5}"
    mapfile -t backups < <(find . -maxdepth 1 -type d -name "${BACKUP_PREFIX}*" 2>/dev/null | sort)
    local count=${#backups[@]}
    if [ "$count" -gt "$retention" ]; then
        local remove=$((count - retention)) i
        for ((i = 0; i < remove; i++)); do
            rm -rf "${backups[$i]}"
            info "Removed old backup ${backups[$i]}"
        done
    fi
}

self_update() {
    [ -n "${UPGRADE_SELF_UPDATED:-}" ] && return 0
    [ -f "$0" ] || return 0
    local tmp_file
    tmp_file=$(mktemp)
    if download "$REPO_URL/$SELF_NAME" "$tmp_file" 2>/dev/null && [ -s "$tmp_file" ]; then
        if ! cmp -s "$tmp_file" "$0"; then
            cp "$tmp_file" "$0"; chmod +x "$0"
            export UPGRADE_SELF_UPDATED=1
            ok "Self-updated $SELF_NAME; re-executing"
            exec "$0" "$@"
        fi
    fi
    rm -f "$tmp_file"
}

main() {
    echo -e "${BOLD}AI-EngKit — V2 line upgrade${NC}"
    self_update "$@"
    check_system
    check_docker
    guard_line
    local backup_dir
    backup_dir=$(backup_files | tail -1)
    update_compose
    merge_env
    apply
    retention "$backup_dir"

    header "Upgrade complete"
    echo -e "  Backup directory: ${BOLD}${backup_dir}${NC}"
    echo
    echo -e "  ${BOLD}Rollback:${NC}"
    echo "     cp ${backup_dir}/${COMPOSE_FILE} ${COMPOSE_FILE}"
    echo "     cp ${backup_dir}/${ENV_FILE} ${ENV_FILE}"
    echo "     docker compose --env-file ${ENV_FILE} -f ${COMPOSE_FILE} up -d --force-recreate"
    echo
    info "The V2 line shares no state with V1; a V1↔V2 switch needs fresh volumes."
}

main "$@"
