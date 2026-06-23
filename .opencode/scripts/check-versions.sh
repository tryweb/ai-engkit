#!/usr/bin/env bash
# check-versions.sh — Compare Dockerfile pinned ARGs against latest upstream releases.
#
# Usage:
#   check-versions.sh [check|outdated|json] [DOCKERFILE]
#
# Subcommands:
#   check     (default) full table with status per pin
#   outdated  only show pins with newer upstream
#   json      machine-readable JSON output
#
# Sources (kept in sync with .github/workflows/dependency-update.yml):
#   DOCKER_VERSION         → github:docker/docker             (strip "docker-" prefix)
#   COMPOSE_VERSION        → github:docker/compose
#   BUILDX_VERSION         → github:docker/buildx
#   GH_VERSION             → github:cli/cli
#   MARKSMAN_VERSION       → github:artempyanykh/marksman
#   OPENCODE_VERSION       → npm:opencode-ai
#   OPENCHAMBER_VERSION    → npm:@openchamber/web
#   PLAYWRIGHT_VERSION     → npm:playwright
#   PLAYWRIGHT_MCP_VERSION → npm:@playwright/mcp
#   GLAB_VERSION           → gitlab:gitlab-org/cli
#
# Note: set -u only (no -e). Individual lookup failures must not abort the run;
# each missing value is reported as "check_failed" and the script continues.
set -uo pipefail

DOCKERFILE="${2:-${DOCKERFILE:-Dockerfile}}"
TIMEOUT="${CHECK_VERSIONS_TIMEOUT:-15}"

die()  { echo "ERROR: $*" >&2; exit 1; }
info() { echo " * $*"; }
ok()   { echo " + $*"; }
warn() { echo " ! $*"; }

strip_tag() {
    # Strip prefix twice: docker/docker tags look like "docker-v29.6.0" and need
    # both the "docker-" and the "v" stripped.
    printf '%s' "$1" | sed -E 's/^(docker-|v|client\/|api\/)//; s/^v//'
}

get_github_latest() {
    local repo="$1"
    if ! command -v gh >/dev/null 2>&1 || ! gh auth status >/dev/null 2>&1; then
        echo "unknown"; return 0
    fi
    local tag
    tag=$(gh release view --repo "$repo" --json tagName --jq '.tagName' 2>/dev/null | head -1) || true
    [[ -z "$tag" ]] && { echo "unknown"; return 0; }
    strip_tag "$tag"
}

get_npm_latest() {
    local pkg="$1"
    local ver
    ver=$(curl -fsSL --max-time "$TIMEOUT" "https://registry.npmjs.org/${pkg}/latest" 2>/dev/null \
        | python3 -c 'import json,sys; print(json.load(sys.stdin).get("version",""))' 2>/dev/null) || true
    [[ -z "$ver" ]] && { echo "unknown"; return 0; }
    echo "$ver"
}

get_gitlab_latest() {
    local project_path="$1"
    local encoded
    encoded=$(printf '%s' "$project_path" \
        | python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.stdin.read().rstrip(),safe=""))' 2>/dev/null) || { echo "unknown"; return 0; }
    local tag
    tag=$(curl -fsSL --max-time "$TIMEOUT" "https://gitlab.com/api/v4/projects/${encoded}/releases/permalink/latest" 2>/dev/null \
        | python3 -c 'import json,sys; print(json.load(sys.stdin).get("tag_name",""))' 2>/dev/null) || true
    [[ -z "$tag" ]] && { echo "unknown"; return 0; }
    strip_tag "$tag"
}

# version_gt "current" "latest" → returns 0 if latest > current (i.e., outdated)
version_gt() {
    local current="$1" latest="$2"
    [[ -n "$current" && -n "$latest" && "$current" != "unknown" && "$latest" != "unknown" ]] || return 1
    [[ "$current" == "$latest" ]] && return 1
    local max
    max=$(printf '%s\n%s\n' "$current" "$latest" | sort -V | tail -n1)
    [[ "$max" == "$latest" ]]
}

lookup() {
    case "$1" in
        DOCKER_VERSION)         get_github_latest "docker/docker" ;;
        COMPOSE_VERSION)        get_github_latest "docker/compose" ;;
        BUILDX_VERSION)         get_github_latest "docker/buildx" ;;
        GH_VERSION)             get_github_latest "cli/cli" ;;
        MARKSMAN_VERSION)       get_github_latest "artempyanykh/marksman" ;;
        OPENCODE_VERSION)       get_npm_latest "opencode-ai" ;;
        OPENCHAMBER_VERSION)    get_npm_latest "@openchamber/web" ;;
        PLAYWRIGHT_VERSION)     get_npm_latest "playwright" ;;
        PLAYWRIGHT_MCP_VERSION) get_npm_latest "@playwright/mcp" ;;
        GLAB_VERSION)           get_gitlab_latest "gitlab-org/cli" ;;
        *)                      echo "unknown" ;;
    esac
}

source_label() {
    case "$1" in
        DOCKER_VERSION)         echo "github:docker/docker" ;;
        COMPOSE_VERSION)        echo "github:docker/compose" ;;
        BUILDX_VERSION)         echo "github:docker/buildx" ;;
        GH_VERSION)             echo "github:cli/cli" ;;
        MARKSMAN_VERSION)       echo "github:artempyanykh/marksman" ;;
        OPENCODE_VERSION)       echo "npm:opencode-ai" ;;
        OPENCHAMBER_VERSION)    echo "npm:@openchamber/web" ;;
        PLAYWRIGHT_VERSION)     echo "npm:playwright" ;;
        PLAYWRIGHT_MCP_VERSION) echo "npm:@playwright/mcp" ;;
        GLAB_VERSION)           echo "gitlab:gitlab-org/cli" ;;
        *)                      echo "?" ;;
    esac
}

# Emit TSV rows: <NAME>\t<PINNED>\t<LATEST>\t<SOURCE>\t<STATUS>
# STATUS ∈ { current, outdated, check_failed }
collect_rows() {
    while IFS=$'\t' read -r name pinned; do
        case "$name" in
            DOCKER_VERSION|COMPOSE_VERSION|BUILDX_VERSION|GH_VERSION|MARKSMAN_VERSION|OPENCODE_VERSION|OPENCHAMBER_VERSION|PLAYWRIGHT_VERSION|PLAYWRIGHT_MCP_VERSION|GLAB_VERSION) ;;
            *) continue ;;
        esac
        [[ -z "${pinned:-}" ]] && continue
        local latest source status
        latest=$(lookup "$name")
        source=$(source_label "$name")
        if [[ "$latest" == "unknown" ]]; then
            status="check_failed"
        elif [[ "$pinned" == "$latest" ]]; then
            status="current"
        elif version_gt "$pinned" "$latest"; then
            status="outdated"
        else
            status="current"
        fi
        printf '%s\t%s\t%s\t%s\t%s\n' "$name" "$pinned" "$latest" "$source" "$status"
    done < <(awk '/^ARG [A-Z_]+=/ { sub(/^ARG /, ""); split($0, kv, "="); print kv[1] "\t" kv[2] }' "$DOCKERFILE")
}

cmd_check() {
    info "Dockerfile: ${DOCKERFILE}"
    info "Source: upstream releases (GitHub / npm / GitLab)"
    echo ""
    printf '%-22s %-12s %-12s %-32s %s\n' "PACKAGE" "PINNED" "LATEST" "SOURCE" "STATUS"
    printf '%-22s %-12s %-12s %-32s %s\n' "-------" "------" "------" "------" "------"

    local outdated=0 unknown=0
    while IFS=$'\t' read -r name pinned latest source status; do
        case "$status" in
            current)      marker="OK current" ;;
            outdated)     marker="UPDATE"; outdated=$((outdated + 1)) ;;
            check_failed) marker="? check_failed"; unknown=$((unknown + 1)) ;;
            *)            marker="? unknown" ;;
        esac
        printf '%-22s %-12s %-12s %-32s %s\n' "$name" "$pinned" "$latest" "$source" "$marker"
    done < <(collect_rows)

    echo ""
    info "outdated: ${outdated}    check_failed: ${unknown}"
}

cmd_outdated() {
    local count=0
    while IFS=$'\t' read -r name pinned latest source status; do
        [[ "$status" == "outdated" ]] || continue
        printf '%-22s %s → %s (%s)\n' "$name" "$pinned" "$latest" "$source"
        count=$((count + 1))
    done < <(collect_rows)
    if [[ "$count" -gt 0 ]]; then
        exit 1
    fi
    exit 0
}

cmd_json() {
    python3 -c '
import json, sys
out = {}
for line in sys.stdin:
    line = line.rstrip("\n")
    if not line:
        continue
    parts = line.split("\t")
    if len(parts) != 5:
        continue
    name, pinned, latest, source, status = parts
    out[name] = {
        "pinned": pinned,
        "latest": latest,
        "source": source,
        "status": status,
    }
print(json.dumps(out, indent=2, ensure_ascii=False))
' < <(collect_rows)
}

main() {
    local cmd="${1:-check}"
    if [[ ! -f "$DOCKERFILE" ]]; then
        die "Dockerfile not found: $DOCKERFILE"
    fi
    case "$cmd" in
        check)    cmd_check ;;
        outdated) cmd_outdated ;;
        json)     cmd_json ;;
        -h|--help|help)
            sed -n '2,12p' "$0"
            exit 0
            ;;
        *)
            echo "Usage: $(basename "$0") [check|outdated|json] [DOCKERFILE]" >&2
            exit 1
            ;;
    esac
}

main "$@"
