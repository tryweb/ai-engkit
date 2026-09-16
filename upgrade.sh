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
# Portable download helper (curl preferred, wget fallback)
# NOTE: wget -O is the output file, -o is the log file
# ──────────────────────────────────────────────────────────
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

# ──────────────────────────────────────────────────────────
# Domain overlay state (set by detect_overlay_configuration)
# ──────────────────────────────────────────────────────────
OVERLAY_ACTIVE=0
OVERLAY_REF=""
OVERLAY_HOST=""
OVERLAY_STAGING_BASE=""
OVERLAY_VALIDATION_ERROR=""
# Empty for base-only installs so `dc` stays `docker compose`; set to
# `--project-directory <install> -f <staged base> -f <overlay>` for overlay runs.
COMPOSE_ARGS=()

# Single-overlay allowlist policy, mirrored from the Admin resolver. Named
# volumes are allowed; every bind mount is rejected, with the Docker socket
# keeping its own explicit message. Emits "ok" on success or a sanitized reason
# (never overlay values) on rejection.
OVERLAY_ALLOWLIST_JQ='
  if (type != "object") then "overlay config is not an object"
  else
    (["name","services","networks","volumes"]) as $top
    | (keys_unsorted - $top) as $bad
    | if ($bad | length) > 0 then "unsupported top-level key: \($bad[0])"
      elif ([.networks, .volumes] | map(select(. != null and (type != "object"))) | length) > 0 then "overlay network/volume declarations must be mappings"
      elif ((.services | type) != "object") then "overlay must declare a services mapping"
      else
        (.services | keys_unsorted) as $names
        | ($names - ["ai-dev"]) as $foreign
        | if ($foreign | length) > 0 then "overlay must not define service: \($foreign[0])"
          elif (($names | index("ai-dev")) == null) then "overlay must define the ai-dev service"
          elif ((.services["ai-dev"] | type) != "object") then "overlay ai-dev service must be a mapping"
          else
            ([.services["ai-dev"] | to_entries[] | . as $e
              | if (["environment","networks","volumes","labels","healthcheck"] | index($e.key)) then empty
                elif (($e.key == "command" or $e.key == "entrypoint") and ($e.value == null)) then empty
                else "unsupported ai-dev field: \($e.key)"
                end] | .[0] // "") as $svc
            | if $svc != "" then $svc
              elif ([.services["ai-dev"].volumes[]? | select((type == "object") and (.type == "bind") and ((.source | type) == "string") and (.source | endswith("/docker.sock")))] | length) > 0
                then "overlay must not mount the Docker socket"
              elif ([.services["ai-dev"].volumes[]? | select((type == "object") and (.type == "bind"))] | length) > 0
                then "overlay must not bind-mount host paths"
              else "ok"
              end
          end
      end
  end
'

# Run `docker compose` with the effective (base-only or base+overlay) arguments.
dc() {
    if [ "${#COMPOSE_ARGS[@]}" -gt 0 ]; then
        docker compose "${COMPOSE_ARGS[@]}" "$@"
    else
        docker compose "$@"
    fi
}

# ──────────────────────────────────────────────────────────
# System requirement checks (shared with install.sh)
# ──────────────────────────────────────────────────────────
check_system() {
    header "1. Checking System Hardware Specifications"

    if [ "${SKIP_SYSTEM_CHECK:-0}" = "1" ]; then
        warn "SKIP_SYSTEM_CHECK=1 set, skipping hardware checks"
        return 0
    fi

    local RAM_KB cg_limit warnings=0
    CPU_CORES=$(nproc 2>/dev/null || echo 0)

    # Containers report host memory via /proc/meminfo — prefer cgroup limit when set
    RAM_KB=""
    if [ -r /sys/fs/cgroup/memory.max ]; then
        cg_limit=$(cat /sys/fs/cgroup/memory.max 2>/dev/null || true)
        if [ -n "$cg_limit" ] && [ "$cg_limit" != "max" ] && \
           [[ "$cg_limit" =~ ^[0-9]+$ ]] && [ "$cg_limit" -lt $((1 << 40)) ]; then
            RAM_KB=$((cg_limit / 1024))   # cgroup v2 limit is in bytes
        fi
    elif [ -r /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then
        cg_limit=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null || true)
        if [ -n "$cg_limit" ] && [[ "$cg_limit" =~ ^[0-9]+$ ]] && [ "$cg_limit" -lt $((1 << 40)) ]; then
            RAM_KB=$((cg_limit / 1024))   # cgroup v1 limit is in bytes
        fi
    fi
    if [ -z "$RAM_KB" ] || [ "$RAM_KB" -le 0 ] 2>/dev/null; then
        RAM_KB=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || true)
    fi
    if [ -z "$RAM_KB" ] || [ "$RAM_KB" -le 0 ] 2>/dev/null; then
        RAM_KB=$(free -k 2>/dev/null | awk '/^Mem:/ {print $2}' || true)
    fi
    RAM_KB="${RAM_KB:-0}"

    DISK_KB=$(df -Pk / 2>/dev/null | tail -1 | awk '{print $4}')
    DISK_GB=$((DISK_KB / 1024 / 1024))

    # One decimal place so e.g. 3.9 GB is not truncated into a failing 3 GB
    RAM_GB=$(awk -v kb="$RAM_KB" 'BEGIN{printf "%.1f", kb/1048576}')
    RAM_GB_INT=$((RAM_KB / 1024 / 1024))

    echo "  CPU cores: $CPU_CORES  |  RAM: ${RAM_GB} GB  |  Disk: ${DISK_GB} GB"

    if [ "$CPU_CORES" -lt 2 ]; then
        fail "Insufficient CPU cores (requires at least 2 cores)"
    fi
    # Warn and continue below the recommended 4 GB; hard-fail only far below it
    if [ "$RAM_GB_INT" -lt 2 ]; then
        fail "Insufficient RAM (requires at least 2 GB; 4 GB recommended)"
    elif [ "$RAM_GB_INT" -lt 4 ]; then
        warn "RAM below recommended 4 GB — continuing, but performance may be limited"
        warnings=1
    fi
    if [ "$DISK_GB" -lt 5 ]; then
        fail "Insufficient disk space (requires at least 5 GB for upgrade)"
    fi

    CPU_FLAGS=$(grep -m1 '^flags' /proc/cpuinfo 2>/dev/null || echo "")
    HAS_AVX=false; HAS_AVX2=false
    echo "$CPU_FLAGS" | grep -qw 'avx'  && HAS_AVX=true
    echo "$CPU_FLAGS" | grep -qw 'avx2' && HAS_AVX2=true

    if [ "$HAS_AVX" = "false" ] || [ "$HAS_AVX2" = "false" ]; then
        echo "  ❌ CPU lacks required SIMD instruction sets:"
        [ "$HAS_AVX"  = "false" ] && echo "     - AVX not supported"
        [ "$HAS_AVX2" = "false" ] && echo "     - AVX2 not supported"
        fail "Unsupported CPU, please refer to install.sh for full details"
    fi

    if [ "$warnings" -eq 1 ]; then
        warn "System meets minimum requirements, but some specs are below recommendation"
    else
        ok "System specifications meet requirements"
    fi
}

check_docker() {
    header "2. Checking Docker Environment"

    command -v docker &>/dev/null || fail "Docker not installed"
    ok "Docker: $(docker --version | head -1)"

    if command -v docker compose &>/dev/null; then
        ok "Docker Compose V2 installed"
    else
        fail "Docker Compose V2 not installed"
    fi

    [ -S /var/run/docker.sock ] || fail "Docker socket does not exist"
    docker info &>/dev/null || fail "Cannot connect to Docker daemon"
    ok "Docker daemon running normally"

    command -v curl &>/dev/null || command -v wget &>/dev/null || fail "Missing curl or wget"
    ok "Network tools installed"
}

# ──────────────────────────────────────────────────────────
# Backup existing files
# ──────────────────────────────────────────────────────────
backup_files() {
    header "3. Backing Up Existing Configuration Files"

    local backup_dir="backup_${TIMESTAMP}"
    mkdir -p "$backup_dir"
    chmod 700 "$backup_dir"

    for f in docker-compose.yml .env; do
        if [ -f "$f" ]; then
            cp "$f" "${backup_dir}/${f}"
            chmod 600 "${backup_dir}/${f}"
            ok "${f} → ${backup_dir}/${f}"
        else
            info "${f} does not exist, skipping backup"
        fi
    done

    if [ "$OVERLAY_ACTIVE" = "1" ]; then
        if [ -s "./admin-data/upgrade-base.yml" ]; then
            cp "./admin-data/upgrade-base.yml" "${backup_dir}/compose-upgrade-base.yml"
            chmod 600 "${backup_dir}/compose-upgrade-base.yml"
            ok "admin-data/upgrade-base.yml → ${backup_dir}/compose-upgrade-base.yml"
        fi
        if [ -n "$OVERLAY_HOST" ] && [ -f "$OVERLAY_HOST" ]; then
            local overlay_dir="${backup_dir}/overlay" overlay_name
            overlay_name="$(basename "$OVERLAY_HOST")"
            mkdir -p "$overlay_dir"
            chmod 700 "$overlay_dir"
            cp "$OVERLAY_HOST" "${overlay_dir}/${overlay_name}"
            chmod 600 "${overlay_dir}/${overlay_name}"
            printf '%s\n%s\n' "$OVERLAY_REF" "$OVERLAY_HOST" > "${backup_dir}/overlay-reference.txt"
            chmod 600 "${backup_dir}/overlay-reference.txt"
            ok "overlay ${OVERLAY_REF} → ${backup_dir}/overlay/"
        fi
    fi

    # ── Snapshot OpenChamber registration list (pre-upgrade state) ──
    local dev_ref
    dev_ref=$(docker compose ps -q ai-dev 2>/dev/null | head -1 || true)
    dev_ref="${dev_ref:-ai-engkit}"
    if docker cp "${dev_ref}:/home/devuser/.config/openchamber/settings.json" "${backup_dir}/openchamber-settings.json" 2>/dev/null; then
        ok "OpenChamber settings → ${backup_dir}/openchamber-settings.json"
    else
        info "OpenChamber settings not found, skipping snapshot"
    fi

    # ── Prune old backups per retention setting ──
    local retention
    retention=$(grep -E "^BACKUP_RETENTION=" .env 2>/dev/null | head -1 | cut -d= -f2 || true)
    retention="${retention:-5}"

    if ! [[ "$retention" =~ ^[0-9]+$ ]] || [ "$retention" -lt 1 ]; then
        retention=5
    fi

    local backups=()
    while IFS= read -r d; do
        [ -n "$d" ] && backups+=("$d")
    done < <(find . -maxdepth 1 -type d -name 'backup_*' 2>/dev/null | sort)

    if [ "${#backups[@]}" -gt "$retention" ]; then
        local to_remove=$(( ${#backups[@]} - retention ))
        info "Keeping the most recent ${retention} backups, will delete ${to_remove} old backups"
        for ((i=0; i<to_remove; i++)); do
            rm -rf "${backups[$i]}"
            ok "Old backup deleted: ${backups[$i]}"
        done
    fi
}

# ──────────────────────────────────────────────────────────
# Update docker-compose.yml from upstream
# ──────────────────────────────────────────────────────────
update_compose() {
    header "4. Updating docker-compose.yml"

    echo "  Downloading latest docker-compose.yml..."
    if download "$REPO_URL/docker-compose.yml" docker-compose.yml.new && [ -s docker-compose.yml.new ]; then
        mv docker-compose.yml.new docker-compose.yml
        ok "docker-compose.yml updated"
    else
        rm -f docker-compose.yml.new
        fail "Failed to download docker-compose.yml, please check network connection"
    fi
}

# ──────────────────────────────────────────────────────────
# Merge new env vars into .env
# ──────────────────────────────────────────────────────────
merge_env() {
    header "5. Merging .env Settings"

    if [ ! -f ".env" ]; then
        warn ".env does not exist, downloading from upstream"
        if ! download "$REPO_URL/.env.example" .env; then
            rm -f .env
            fail "Failed to download .env.example, please check network connection"
        fi
        ok ".env created (using default values)"
        info "Please edit .env to set passwords and other custom values"
        return
    fi

    local tmp_example
    tmp_example=$(mktemp)
    if ! download "$REPO_URL/.env.example" "$tmp_example"; then
        rm -f "$tmp_example"
        warn "Failed to download .env.example, skipping env merge"
        return
    fi

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
            echo -e "  ${GREEN}➕${NC} ${key} added to .env"
        fi
    done < "$tmp_example"

    rm -f "$tmp_example"

    if [ "$added" -gt 0 ]; then
        ok "Merged ${added} new settings into .env"
    else
        ok ".env already contains all latest settings, no changes needed"
    fi
}

# ──────────────────────────────────────────────────────────
# Pull latest container image
# ──────────────────────────────────────────────────────────
pull_image() {
    header "6. Pulling Latest Docker Image"

    local old_id
    old_id=$(docker images "$IMAGE_REF" -q 2>/dev/null || true)
    if [ -n "$old_id" ]; then
        echo "  Current image ID: ${old_id:0:12}"
    else
        info "No AI-EngKit image found locally"
    fi

    echo "  Pulling ${IMAGE_REF}..."
    if docker compose pull 2>&1; then
        ok "Image updated to latest version"
    else
        ok "Image check completed"
    fi

    local new_id
    new_id=$(docker images "$IMAGE_REF" -q 2>/dev/null || true)
    if [ -n "$new_id" ] && [ "$new_id" != "$old_id" ] && [ -n "$old_id" ]; then
        echo "  New image ID: ${new_id:0:12}"
    fi
}

# ──────────────────────────────────────────────────────────
ensure_provider_state() {
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
        ok "Migrated provider-keys.json from ${legacy_dir}/ into ${state_dir}/"
    elif [ -e "$legacy_file" ]; then
        mv "$legacy_file" "${legacy_file}.legacy.${TIMESTAMP}"
        warn "Preserved legacy provider-keys.json as ${legacy_file}.legacy.${TIMESTAMP}"
    fi
    if [ -e provider-keys.json ]; then
        if [ -f provider-keys.json ] && [ ! -e "$state_file" ]; then
            mv provider-keys.json "$state_file"
            ok "Migrated legacy provider-keys.json into ${state_dir}/"
        else
            mv provider-keys.json "provider-keys.json.legacy.${TIMESTAMP}"
            warn "Preserved legacy provider-keys.json as provider-keys.json.legacy.${TIMESTAMP}"
        fi
    fi
    if [ ! -f "$state_file" ]; then
        printf '{"providers":{}}\n' > "$state_file"
        ok "Provider registry initialized"
    fi
    chown 1000:1000 "$state_dir" "$state_file" 2>/dev/null || true
    chmod 700 "$state_dir"
    chmod 600 "$state_file"
}

# ──────────────────────────────────────────────────────────
# Prepare host paths for the overlay-aware upgrade contract
# ──────────────────────────────────────────────────────────
prepare_overlay_paths() {
    mkdir -p ./extensions
    chmod 755 ./extensions
    ok "./extensions ready"

    mkdir -p ./admin-data
    if [ ! -f ./admin-data/upgrade-base.yml ]; then
        : > ./admin-data/upgrade-base.yml
    fi
    chmod 600 ./admin-data/upgrade-base.yml
    chown 1000:1000 ./admin-data/upgrade-base.yml 2>/dev/null || true
    ok "./admin-data/upgrade-base.yml ready"
}

# ──────────────────────────────────────────────────────────
# Detect and validate a configured domain Compose overlay
# ──────────────────────────────────────────────────────────
detect_overlay_configuration() {
    OVERLAY_ACTIVE=0
    OVERLAY_REF=""
    [ -f ".env" ] || return 0
    local line value
    while IFS= read -r line || [ -n "$line" ]; do
        line="${line#"${line%%[![:space:]]*}"}"
        case "$line" in
            AI_ENGKIT_COMPOSE_OVERLAY=*) value="${line#AI_ENGKIT_COMPOSE_OVERLAY=}" ;;
            "export "*AI_ENGKIT_COMPOSE_OVERLAY=*)
                value="${line#export }"
                value="${value#AI_ENGKIT_COMPOSE_OVERLAY=}"
                ;;
            *) continue ;;
        esac
        case "$value" in
            \"*\") value="${value#\"}"; value="${value%\"}" ;;
            \'*\') value="${value#\'}"; value="${value%\'}" ;;
        esac
        value="${value#"${value%%[![:space:]]*}"}"
        value="${value%"${value##*[![:space:]]}"}"
        if [ -n "$value" ]; then
            OVERLAY_ACTIVE=1
            OVERLAY_REF="$value"
        fi
    done < .env
}

require_jq_for_overlay() {
    [ "$OVERLAY_ACTIVE" = "1" ] || return 0
    if ! command -v jq >/dev/null 2>&1; then
        fail "jq is required to validate the domain Compose overlay declared by AI_ENGKIT_COMPOSE_OVERLAY.
   Install jq on the host (for example: apt-get install jq) and re-run upgrade.sh.
   No files were changed."
    fi
}

canonicalize_path() {
    local path="$1"
    if command -v realpath >/dev/null 2>&1; then
        realpath "$path" 2>/dev/null && return 0
    fi
    if readlink -f "$path" >/dev/null 2>&1; then
        readlink -f "$path" && return 0
    fi
    local dir base dir_real
    dir="$(dirname "$path")"
    base="$(basename "$path")"
    dir_real="$(cd "$dir" 2>/dev/null && pwd -P)" || return 1
    printf '%s/%s\n' "$dir_real" "$base"
}

overlay_resolve_host_path() {
    local ref="$OVERLAY_REF" candidate
    case "$ref" in
        /opt/ai-engkit/extensions/*) candidate="./extensions/${ref#/opt/ai-engkit/extensions/}" ;;
        /*) fail "AI_ENGKIT_COMPOSE_OVERLAY must resolve beneath ./extensions (got ${ref})" ;;
        *) candidate="./extensions/${ref}" ;;
    esac

    [ -d "./extensions" ] || fail "./extensions is missing; create it and place the overlay before upgrading"

    local canonical extensions_real
    canonical="$(canonicalize_path "$candidate")" \
        || fail "AI_ENGKIT_COMPOSE_OVERLAY could not be resolved (got ${ref})"
    extensions_real="$(canonicalize_path "./extensions")" \
        || fail "./extensions could not be resolved"

    case "$canonical" in
        "${extensions_real}"/*) : ;;
        *) fail "AI_ENGKIT_COMPOSE_OVERLAY must resolve beneath ./extensions (got ${ref})" ;;
    esac

    [ -f "$canonical" ] || fail "AI_ENGKIT_COMPOSE_OVERLAY is not a regular file: ${ref}"
    [ -r "$canonical" ] || fail "AI_ENGKIT_COMPOSE_OVERLAY is not readable: ${ref}"
    OVERLAY_HOST="$canonical"
}

overlay_assert_allowlist() {
    local json="$1" result
    result="$(printf '%s' "$json" | jq -r "$OVERLAY_ALLOWLIST_JQ" 2>/dev/null)" || result=""
    if [ "$result" != "ok" ]; then
        OVERLAY_VALIDATION_ERROR="${result:-overlay config could not be parsed}"
        return 1
    fi
    return 0
}

overlay_staging_fail() {
    [ -n "$OVERLAY_STAGING_BASE" ] && rm -f "$OVERLAY_STAGING_BASE"
    fail "$1"
}

overlay_download_staging() {
    header "4. Staging Overlay-Aware Upgrade"

    mkdir -p ./admin-data
    OVERLAY_STAGING_BASE="./admin-data/upgrade-base.yml.staging"
    echo "  Downloading upstream base to ${OVERLAY_STAGING_BASE}..."
    if ! download "$REPO_URL/docker-compose.yml" "$OVERLAY_STAGING_BASE" || [ ! -s "$OVERLAY_STAGING_BASE" ]; then
        overlay_staging_fail "Failed to download docker-compose.yml, please check network connection"
    fi

    local project_dir
    project_dir="$(pwd)"

    echo "  Validating overlay-only configuration..."
    local overlay_json
    if ! overlay_json="$(docker compose --project-directory "$project_dir" -f "$OVERLAY_HOST" config --no-consistency --format json 2>/dev/null)"; then
        overlay_staging_fail "Overlay validation failed: docker compose could not render ${OVERLAY_REF}"
    fi
    if ! overlay_assert_allowlist "$overlay_json"; then
        overlay_staging_fail "Overlay validation failed: ${OVERLAY_VALIDATION_ERROR}"
    fi

    echo "  Validating effective base+overlay configuration..."
    local merged_json
    if ! merged_json="$(docker compose --project-directory "$project_dir" -f "$OVERLAY_STAGING_BASE" -f "$OVERLAY_HOST" config --format json 2>/dev/null)"; then
        overlay_staging_fail "Effective base+overlay validation failed: docker compose could not render the merged configuration"
    fi
    printf '%s' "$merged_json" | jq -e '.services["ai-dev"] != null' >/dev/null 2>&1 \
        || overlay_staging_fail "Effective base+overlay configuration has no ai-dev service"

    # The new base must carry the Admin mounts that make the overlay visible to
    # a future Admin-managed upgrade; otherwise this bootstrap would not stick.
    printf '%s' "$merged_json" | jq -e '[.services["ai-admin"].volumes[]?.target] | index("/opt/ai-engkit/extensions") != null' >/dev/null 2>&1 \
        || overlay_staging_fail "Target base is missing the ai-admin ./extensions mount required for overlay-aware upgrades"
    printf '%s' "$merged_json" | jq -e '[.services["ai-admin"].volumes[]?.target] | index("/opt/ai-engkit/compose-upgrade-base.yml") != null' >/dev/null 2>&1 \
        || overlay_staging_fail "Target base is missing the ai-admin ./admin-data/upgrade-base.yml mount required for overlay-aware upgrades"

    ok "Overlay ${OVERLAY_REF} validated and target base mounts verified"
}

overlay_switch_base() {
    mv "$OVERLAY_STAGING_BASE" ./admin-data/upgrade-base.yml
    chmod 600 ./admin-data/upgrade-base.yml
    chown 1000:1000 ./admin-data/upgrade-base.yml 2>/dev/null || true
    COMPOSE_ARGS=(--project-directory "$(pwd)" -f ./admin-data/upgrade-base.yml -f "$OVERLAY_HOST")
    ok "Effective base switched to ./admin-data/upgrade-base.yml + ${OVERLAY_REF}"
}

# ──────────────────────────────────────────────────────────
# Prepare host volumes for admin container
# ──────────────────────────────────────────────────────────
prepare_volumes() {
    header "7. Preparing Volume Directories"

    mkdir -p ./backups
    chmod 700 ./backups
    chown 1000:1000 ./backups 2>/dev/null || true
    ok "./backups ready"

    ensure_provider_state
    prepare_overlay_paths

    local ws_path
    ws_path=$(grep -E "^WORKSPACE_PATH=" .env 2>/dev/null | cut -d= -f2- || true)
    if [ -n "$ws_path" ]; then
        ws_path=$(expand_workspace_path "$ws_path")
        if [ ! -d "$ws_path" ]; then
            mkdir -p "$ws_path"
            ok "workspace directory created: ${ws_path}"
        fi
    fi
}

# ──────────────────────────────────────────────────────────
# Recreate containers
# ──────────────────────────────────────────────────────────
recreate_containers() {
    header "8. Recreating Containers"

    if [ -f ".env" ]; then
        local ws_path
        ws_path=$(grep -E "^WORKSPACE_PATH=" .env 2>/dev/null | head -1 | cut -d= -f2- || true)
        if [ -n "$ws_path" ]; then
            ws_path=$(expand_workspace_path "$ws_path")
            if [ ! -d "$ws_path" ]; then
                warn "WORKSPACE_PATH=${ws_path} directory does not exist, will create automatically"
                mkdir -p "$ws_path"
            fi
        fi
    fi

    echo "  Executing docker compose up -d --force-recreate..."
    dc up -d --force-recreate 2>&1 || {
        fail "Container startup failed, please check docker compose ps"
    }

    echo -n "  Waiting for service startup"
    for _ in {1..15}; do
        if dc ps --format json 2>/dev/null | grep -q '"Status":"running"' 2>/dev/null || \
           dc ps 2>/dev/null | grep -q "Up"; then
            break
        fi
        echo -n "."
        sleep 2
    done
    echo

    dc ps
    ok "Containers restarted"
}

# ──────────────────────────────────────────────────────────
# Recreate ai-admin and ai-dev with base + overlay
# ──────────────────────────────────────────────────────────
recreate_containers_overlay() {
    header "8. Recreating Containers (base + overlay)"

    if [ -f ".env" ]; then
        local ws_path
        ws_path=$(grep -E "^WORKSPACE_PATH=" .env 2>/dev/null | head -1 | cut -d= -f2- || true)
        if [ -n "$ws_path" ]; then
            ws_path=$(expand_workspace_path "$ws_path")
            if [ ! -d "$ws_path" ]; then
                warn "WORKSPACE_PATH=${ws_path} directory does not exist, will create automatically"
                mkdir -p "$ws_path"
            fi
        fi
    fi

    echo "  Executing docker compose (base + ${OVERLAY_REF}) up -d --force-recreate ai-admin ai-dev..."
    dc up -d --force-recreate ai-admin ai-dev 2>&1 || {
        fail "Container startup failed, please check docker compose ps"
    }

    echo -n "  Waiting for service startup"
    for _ in {1..15}; do
        if dc ps --format json 2>/dev/null | grep -q '"Status":"running"' 2>/dev/null || \
           dc ps 2>/dev/null | grep -q "Up"; then
            break
        fi
        echo -n "."
        sleep 2
    done
    echo

    dc ps
    ok "Containers restarted with base + overlay"
}

# ──────────────────────────────────────────────────────────
# Reconcile OpenChamber project registrations after recreate
# ──────────────────────────────────────────────────────────
reconcile_openchamber_projects() {
    header "9. Reconciling OpenChamber Project Registrations"

    local dev_ref out added
    dev_ref=$(dc ps -q ai-dev 2>/dev/null | head -1 || true)
    dev_ref="${dev_ref:-ai-engkit}"

    if ! out=$(docker exec "$dev_ref" /opt/ai-engkit/scripts/reconcile-openchamber-projects.sh 2>/dev/null); then
        warn "Reconcile unavailable (script missing in image or container not ready) — use Admin → Projects → Sync for manual recovery"
        return 0
    fi

    added=$(printf '%s' "$out" | sed -n 's/.*"added"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' | head -1)
    if [ -n "$added" ] && [ "$added" -gt 0 ] 2>/dev/null; then
        ok "Restored ${added} OpenChamber project registration(s)"
    elif [ -n "$added" ]; then
        ok "OpenChamber registration list is consistent, nothing to restore"
    else
        warn "Reconcile returned unexpected output — use Admin → Projects → Sync for manual recovery"
    fi
}

# ──────────────────────────────────────────────────────────
# Clean up dangling images
# ──────────────────────────────────────────────────────────
cleanup_images() {
    header "10. Cleaning Up Old Images"

    local pruned
    pruned=$(docker image prune -f 2>&1 | grep -oE 'Total reclaimed space: .*' | sed 's/^Total reclaimed space: //' || true)
    if [ -n "$pruned" ]; then
        ok "Disk space freed: ${pruned}"
    else
        info "No cleanup needed"
    fi

    # Pinned installs keep every release tag forever — remove all but the active one
    local repo
    local keep
    local old_tags
    local tag
    repo="${IMAGE_REF%%:*}"
    keep="${IMAGE_REF##*:}"
    old_tags=$(docker images "$repo" --format '{{.Tag}}' 2>/dev/null || true)
    while IFS= read -r tag; do
        [ -z "$tag" ] && continue
        if [ "$tag" != "$keep" ]; then
            if docker rmi "${repo}:${tag}" 2>/dev/null; then
                ok "Old image removed: ${repo}:${tag}"
            else
                info "Skipping ${repo}:${tag} (in use by another stack?)"
            fi
        fi
    done <<< "$old_tags"
}

# ──────────────────────────────────────────────────────────
# Show upgrade summary
# ──────────────────────────────────────────────────────────
show_info() {
    local host_ip=""
    if command -v ip &>/dev/null; then
        host_ip=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}')
    elif command -v hostname &>/dev/null; then
        host_ip=$(hostname -I 2>/dev/null | awk '{print $1}' | grep -v '^fe80\|^::' | head -1)
    fi

    local chamber_port
    chamber_port=$(grep -E "^CHAMBER_PORT=" .env 2>/dev/null | cut -d= -f2 || true)
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
    echo
    echo -e "  ${YELLOW}ℹ${NC}  Backup directory: backup_${TIMESTAMP}/"
    if [ "$OVERLAY_ACTIVE" = "1" ]; then
        echo "     (contains pre-upgrade compose upgrade base, overlay, and .env)"
        echo
        echo -e "  ${YELLOW}ℹ${NC}  To rollback:"
        echo "     docker compose down"
        echo "     cp backup_${TIMESTAMP}/compose-upgrade-base.yml admin-data/upgrade-base.yml"
        echo "     cp backup_${TIMESTAMP}/.env .env"
        echo "     docker compose --project-directory \"\$(pwd)\" -f admin-data/upgrade-base.yml -f ${OVERLAY_HOST} up -d"
    else
        echo "     (contains pre-upgrade docker-compose.yml and .env)"
        echo
        echo -e "  ${YELLOW}ℹ${NC}  To rollback:"
        echo "     docker compose down"
        echo "     cp backup_${TIMESTAMP}/docker-compose.yml docker-compose.yml"
        echo "     cp backup_${TIMESTAMP}/.env .env"
        echo "     docker compose up -d"
    fi
    echo
    echo -e "${BOLD}========================================${NC}"
}

# ──────────────────────────────────────────────────────────
# Self-update
# ──────────────────────────────────────────────────────────
self_update() {
    [ -n "${UPGRADE_SELF_UPDATED:-}" ] && return 0

    # Only self-update when running from a regular file on disk
    [ ! -f "$0" ] && return 0

    local tmp_file
    tmp_file=$(mktemp)

    if download "$REPO_URL/upgrade.sh" "$tmp_file" 2>/dev/null && [ -s "$tmp_file" ]; then
        if bash -n "$tmp_file" 2>/dev/null; then
            if ! cmp -s "$0" "$tmp_file"; then
                info "New version of upgrade.sh found, updating..."
                chmod +x "$tmp_file"
                mv "$tmp_file" "$0"
                ok "upgrade.sh updated to latest version"
                export UPGRADE_SELF_UPDATED=1
                exec bash "$0" "$@"
            fi
        fi
    fi
    rm -f "$tmp_file"
}

# ──────────────────────────────────────────────────────────
# Resolve version pin (AI_ENGKIT_VERSION in .env)
# ──────────────────────────────────────────────────────────
resolve_pins() {
    # Pinned installs fetch runtime assets (compose, .env.example) and
    # images matching their running version; unset tracks the stable
    # channel (:latest, moved only on explicit promotion).
    local pinned
    pinned="$(grep -E '^AI_ENGKIT_VERSION=' .env 2>/dev/null | tail -n1 | cut -d= -f2 | tr -d '"' || true)"
    if [ -n "$pinned" ]; then
        REPO_URL="https://raw.githubusercontent.com/tryweb/ai-engkit/${pinned}"
        IMAGE_REF="ghcr.io/tryweb/ai-engkit:${pinned}"
        info "Version pin detected: ${pinned}"
    else
        IMAGE_REF="ghcr.io/tryweb/ai-engkit:latest"
    fi
}

# ──────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────
verify_installed_environment() {
    if [ -f "docker-compose.yml" ] && [ -f ".env" ]; then
        return 0
    fi

    fail "AI-EngKit installation environment not found (missing docker-compose.yml or .env).

upgrade.sh is for existing installations only. For first-time installation, run install.sh instead:

  curl -fsSL https://raw.githubusercontent.com/tryweb/ai-engkit/main/install.sh | bash

If you have already installed via install.sh, please make sure you are running this script in the correct installation directory."
}

main() {
    cd "$(dirname "$0")"

    verify_installed_environment
    detect_overlay_configuration
    require_jq_for_overlay

    # Self-update before any operations (skipped when piped to shell)
    self_update "$@"
    resolve_pins

    echo
    echo -e "${BOLD}╔══════════════════════════════════════╗${NC}"
    echo -e "${BOLD}║   AI-EngKit Upgrade Script           ║${NC}"
    echo -e "${BOLD}╚══════════════════════════════════════╝${NC}"

    check_system
    check_docker

    if [ "$OVERLAY_ACTIVE" = "1" ]; then
        overlay_resolve_host_path
        backup_files
        overlay_download_staging
        merge_env
        pull_image
        prepare_volumes
        overlay_switch_base
        recreate_containers_overlay
    else
        backup_files
        update_compose
        merge_env
        pull_image
        prepare_volumes
        recreate_containers
    fi

    reconcile_openchamber_projects
    cleanup_images
    show_info
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
