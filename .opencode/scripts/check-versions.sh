#!/usr/bin/env bash
# check-versions.sh — Compare Dockerfile pinned ARGs against latest upstream releases.
#
# Usage:
#   check-versions.sh [check|outdated|json] [--latest] [--apt] [--snapshot] [DOCKERFILE]
#
# Subcommands:
#   check     (default) full table with status per pin
#   outdated  only show pins with newer upstream (exit 1 if any)
#   json      machine-readable JSON output
#
# Flags (only affect check output):
#   --latest    include latest-tracked npm packages (oh-my-openagent, codegraph, openspec)
#   --apt       check ubuntu:24.04 base image APT updates (requires docker)
#   --snapshot  diff against version-snapshot.json (saved with --snapshot-save)
#   --all       enable --latest + --apt + --snapshot
#   --snapshot-save  write version-snapshot.json after check
#
# Sources (kept in sync with .github/workflows/dependency-update.yml):
#   DOCKER_VERSION         → github:docker/docker             (strip "docker-" prefix)
#   COMPOSE_VERSION        → github:docker/compose
#   BUILDX_VERSION         → github:docker/buildx
#   GH_VERSION             → github:cli/cli
#   MARKSMAN_VERSION       → github:artempyanykh/marksman
#   LEANCTX_VERSION        → github:yvgude/lean-ctx
#   OPENCODE_VERSION       → npm:opencode-ai
#   OPENCHAMBER_VERSION    → npm:@openchamber/web
#   PLAYWRIGHT_VERSION     → npm:playwright
#   PLAYWRIGHT_MCP_VERSION → npm:@playwright/mcp
#   GLAB_VERSION           → gitlab:gitlab-org/cli
#
# Note: set -u only (no -e). Individual lookup failures must not abort the run;
# each missing value is reported as "check_failed" and the script continues.
set -uo pipefail

DOCKERFILE="${DOCKERFILE:-Dockerfile}"
TIMEOUT="${CHECK_VERSIONS_TIMEOUT:-15}"

# --- Flags ---
DO_LATEST=false
DO_APT=false
DO_SNAPSHOT=false
DO_SNAPSHOT_SAVE=false
SNAPSHOT_FILE="${CHECK_VERSIONS_SNAPSHOT:-version-snapshot.json}"

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
        LEANCTX_VERSION)        get_github_latest "yvgude/lean-ctx" ;;
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
        LEANCTX_VERSION)        echo "github:yvgude/lean-ctx" ;;
        *)                      echo "?" ;;
    esac
}

# Emit TSV rows: <NAME>\t<PINNED>\t<LATEST>\t<SOURCE>\t<STATUS>
# STATUS ∈ { current, outdated, check_failed }
collect_rows() {
    while IFS=$'\t' read -r name pinned; do
        case "$name" in
            DOCKER_VERSION|COMPOSE_VERSION|BUILDX_VERSION|GH_VERSION|MARKSMAN_VERSION|OPENCODE_VERSION|OPENCHAMBER_VERSION|PLAYWRIGHT_VERSION|PLAYWRIGHT_MCP_VERSION|GLAB_VERSION|LEANCTX_VERSION) ;;
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

# ── Latest-tracked packages (not in Dockerfile ARGs) ──

read_snapshot() {
    if [[ ! -f "$SNAPSHOT_FILE" ]]; then echo "{}"; return; fi
    cat "$SNAPSHOT_FILE" 2>/dev/null || echo "{}"
}

check_latest_packages() {
    local snapshot prev status
    snapshot=$(read_snapshot)
    for entry in OH_MY_OPENAGENT_VERSION CODEGRAPH_VERSION OPENSPEC_VERSION; do
        local pkg source_label
        case "$entry" in
            OH_MY_OPENAGENT_VERSION) pkg="oh-my-openagent"; source_label="npm" ;;
            CODEGRAPH_VERSION)       pkg="@colbymchenry/codegraph"; source_label="npm" ;;
            OPENSPEC_VERSION)        pkg="@fission-ai/openspec"; source_label="npm" ;;
        esac
        local current
        current=$(get_npm_latest "$pkg")
        if [[ "$current" == "unknown" ]]; then
            printf '%s\tunknown\t\t%s\tcheck_failed\n' "$entry" "$source_label"
            continue
        fi
        prev=$(echo "$snapshot" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    v=d.get('latest',{}).get('$entry','')
    print(v if isinstance(v,str) else '')
except:
    print('')
" 2>/dev/null)
        if [[ -n "$prev" && "$prev" != "-" && "$current" != "$prev" ]]; then
            status="changed"
        else
            status="current"
        fi
        printf '%s\t%s\t%s\t%s\t%s\n' "$entry" "$current" "${prev:--}" "$source_label" "$status"
    done
}

cmd_latest() {
    echo ""
    echo "--- Latest-tracked packages ---"
    printf '%-28s %-12s %-12s %-24s %s\n' "PACKAGE" "CURRENT" "PREVIOUS" "SOURCE" "STATUS"
    printf '%-28s %-12s %-12s %-24s %s\n' "-------" "-------" "--------" "------" "------"
    while IFS=$'\t' read -r name current prev source status; do
        [[ -z "$name" ]] && continue
        case "$status" in
            current)      marker="OK current" ;;
            changed)      marker="CHANGED" ;;
            check_failed) marker="? failed" ;;
            *)            marker="? unknown" ;;
        esac
        if [[ "$prev" == "-" || -z "$prev" ]]; then prev_display="--"; else prev_display="$prev"; fi
        printf '%-28s %-12s %-12s %-24s %s\n' "$name" "$current" "$prev_display" "$source" "$marker"
    done < <(check_latest_packages)
}

# ── APT updates (ubuntu:24.04 base image) ──

check_apt_updates() {
    if ! command -v docker >/dev/null 2>&1; then
        printf 'skipped\t0\tdocker not available\n'
        return
    fi
    docker pull ubuntu:24.04 --quiet >/dev/null 2>&1 || true
    local updates
    updates=$(docker run --rm ubuntu:24.04 bash -c 'apt-get update -qq 2>/dev/null && apt-get upgrade --just-print 2>/dev/null' 2>/dev/null | grep '^Inst ' || true)
    local count
    count=$(printf '%s\n' "$updates" | grep -c '^Inst ' 2>/dev/null || true)
    if [[ "${count:-0}" -eq 0 ]]; then
        printf 'up-to-date\t0\tAll packages are up to date\n'
        return
    fi
    local names
    names=$(printf '%s\n' "$updates" | awk '{print $2}' | head -20 | tr '\n' ', ' | sed 's/, $//')
    printf 'updates-available\t%s\t%s\n' "$count" "$names"
}

cmd_apt() {
    echo ""
    echo "--- APT updates (ubuntu:24.04 base image) ---"
    if ! command -v docker >/dev/null 2>&1; then
        warn "docker not available; skipping APT check"
        return
    fi
    printf '%-20s %-6s %s\n' "STATUS" "COUNT" "DETAILS"
    printf '%-20s %-6s %s\n' "------" "-----" "-------"
    while IFS=$'\t' read -r status count details; do
        [[ -z "$status" ]] && continue
        printf '%-20s %-6s %s\n' "$status" "$count" "$details"
    done < <(check_apt_updates)
}

# ── Snapshot diff & save ──

cmd_snapshot_diff() {
    local snapshot
    snapshot=$(read_snapshot)
    echo ""
    echo "--- Snapshot diff (${SNAPSHOT_FILE}) ---"
    if [[ "$snapshot" == "{}" ]]; then
        info "No previous snapshot found; use --snapshot-save to create one"
        return
    fi
    local ts
    ts=$(echo "$snapshot" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("timestamp","unknown"))' 2>/dev/null)
    info "Previous snapshot: $ts"
    local changed=false
    while IFS=$'\t' read -r name pinned latest source status; do
        [[ "$status" == "outdated" ]] || continue
        echo "  ! $name: $pinned -> $latest ($source)"
        changed=true
    done < <(collect_rows)
    if [[ "$DO_LATEST" == true ]]; then
        while IFS=$'\t' read -r name current prev source status; do
            [[ "$status" == "changed" ]] || continue
            if [[ "$prev" == "-" || -z "$prev" ]]; then prev_display="--"; else prev_display="$prev"; fi
            echo "  ~ $name: $prev_display -> $current (npm)"
            changed=true
        done < <(check_latest_packages)
    fi
    if [[ "$changed" == false ]]; then
        ok "No changes since last snapshot"
    fi
}

build_and_save_snapshot() {
    python3 -c '
import json, subprocess
dockerfile = "'"$DOCKERFILE"'"
pinned = {}
with open(dockerfile) as f:
    for line in f:
        if line.startswith("ARG "):
            line = line[4:].strip()
            if "=" in line:
                name, val = line.split("=", 1)
                pinned[name] = val
import urllib.request
def npm_latest(pkg):
    try:
        url = f"https://registry.npmjs.org/{pkg}/latest"
        resp = urllib.request.urlopen(url, timeout=10)
        data = json.loads(resp.read())
        return data.get("version", "unknown")
    except:
        return "unknown"
latest = {
    "OH_MY_OPENAGENT_VERSION": npm_latest("oh-my-openagent"),
    "CODEGRAPH_VERSION": npm_latest("@colbymchenry/codegraph"),
    "OPENSPEC_VERSION": npm_latest("@fission-ai/openspec"),
}
snapshot = {
    "timestamp": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "pinned": pinned,
    "latest": latest,
}
with open("'"$SNAPSHOT_FILE"'", "w") as f:
    json.dump(snapshot, f, indent=2, ensure_ascii=False)
'
    info "Snapshot saved to $SNAPSHOT_FILE"
}

# ── Combined check output with optional sections ──

cmd_check_all() {
    cmd_check
    if [[ "$DO_LATEST" == true ]]; then cmd_latest; fi
    if [[ "$DO_APT" == true ]]; then cmd_apt; fi
    if [[ "$DO_SNAPSHOT" == true ]]; then cmd_snapshot_diff; fi
    if [[ "$DO_SNAPSHOT_SAVE" == true ]]; then build_and_save_snapshot; fi
}

# ── Main entry point ──

main() {
    local positional=()
    while [[ $# -gt 0 ]]; do
        case "$1" in
            check|outdated|json) cmd="$1"; shift ;;
            --latest) DO_LATEST=true; shift ;;
            --apt) DO_APT=true; shift ;;
            --snapshot) DO_SNAPSHOT=true; shift ;;
            --snapshot-save) DO_SNAPSHOT_SAVE=true; DO_SNAPSHOT=true; shift ;;
            --all) DO_LATEST=true; DO_APT=true; DO_SNAPSHOT=true; shift ;;
            -h|--help|help) sed -n '2,18p' "$0"; exit 0 ;;
            *) positional+=("$1"); shift ;;
        esac
    done
    if [[ ${#positional[@]} -ge 1 ]]; then
        DOCKERFILE="${positional[0]}"
    fi
    if [[ ! -f "$DOCKERFILE" ]]; then
        die "Dockerfile not found: $DOCKERFILE"
    fi
    case "${cmd:-check}" in
        check)    cmd_check_all ;;
        outdated) cmd_outdated ;;
        json)     cmd_json ;;
        *)
            echo "Usage: $(basename "$0") [check|outdated|json] [--latest] [--apt] [--snapshot] [DOCKERFILE]" >&2
            exit 1
            ;;
    esac
}

main "$@"
