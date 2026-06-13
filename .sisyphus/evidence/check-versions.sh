#!/usr/bin/env bash
set -euo pipefail

IFS=$'\n\t'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DOCKERFILE_PATH="${DOCKERFILE_PATH:-$REPO_ROOT/Dockerfile}"
OUTPUT_FILE="${GITHUB_OUTPUT:-/tmp/check-versions.outputs}"
SNAPSHOT_FILE="${SNAPSHOT_FILE:-$SCRIPT_DIR/version-snapshot.json}"
PREVIOUS_SNAPSHOT_PATH="${1:-}"

json_quote() {
  python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"
}

warn() {
  printf '::warning::%s\n' "$*" >&2
}

build_pinned_json() {
  python3 -c 'import json,sys
items=[]
for line in sys.stdin:
    line=line.rstrip("\n")
    if not line:
        continue
    name,current,latest,source,status=line.split("\t")
    items.append({"name":name,"current":current,"latest":latest,"source":source,"status":status})
print(json.dumps(items,separators=(",",":")))'
}

build_latest_json() {
  python3 -c 'import json,sys
items=[]
for line in sys.stdin:
    line=line.rstrip("\n")
    if not line:
        continue
    name,current,previous,source,status=line.split("\t")
    item={"name":name,"current":current,"source":source,"status":status}
    if previous:
        item["previous"]=previous
    items.append(item)
print(json.dumps(items,separators=(",",":")))'
}

get_github_tag() {
  local repo="$1"
  local raw=""
  if command -v gh >/dev/null 2>&1; then
    raw="$(gh release view --repo "$repo" --json tagName --jq .tagName 2>/dev/null || true)"
  fi
  raw="$(printf '%s' "$raw" | tr -d '\r' | awk 'NF{print; exit}' || true)"
  if [[ -z "$raw" ]]; then
    printf 'unknown\n'
    return 0
  fi
  raw="${raw#v}"
  if [[ "$raw" =~ ^[0-9]+([.][0-9]+)*([-.][0-9A-Za-z]+)*$ ]]; then
    printf '%s\n' "$raw"
  else
    printf 'unknown\n'
  fi
}

get_github_tag_raw() {
  local repo="$1"
  local raw=""
  if command -v gh >/dev/null 2>&1; then
    raw="$(gh release view --repo "$repo" --json tagName --jq .tagName 2>/dev/null || true)"
  fi
  raw="$(printf '%s' "$raw" | tr -d '\r' | awk 'NF{print; exit}' || true)"
  if [[ -z "$raw" ]]; then
    printf 'unknown\n'
    return 0
  fi
  if [[ "$raw" =~ ^v?[0-9]+([.][0-9]+)*([-.][0-9A-Za-z]+)*$ ]]; then
    printf '%s\n' "$raw"
  else
    printf 'unknown\n'
  fi
}

get_npm_version() {
  local pkg="$1"
  local version=""
  if command -v npm >/dev/null 2>&1; then
    version="$(npm view "$pkg" version 2>/dev/null || true)"
  fi
  version="$(printf '%s' "$version" | tr -d '\r' | awk 'NF{print; exit}' || true)"
  if [[ -z "$version" ]]; then
    printf 'unknown\n'
    return 0
  fi
  if [[ "$version" =~ ^[0-9A-Za-z]+([.-][0-9A-Za-z]+)*$ ]]; then
    printf '%s\n' "$version"
  else
    printf 'unknown\n'
  fi
}

version_gt() {
  local current="$1"
  local latest="$2"
  [[ -n "$current" && -n "$latest" && "$current" != 'unknown' && "$latest" != 'unknown' ]] || return 1
  local max
  max="$(printf '%s\n%s\n' "$current" "$latest" | sort -V | tail -n1)"
  [[ "$max" == "$latest" && "$current" != "$latest" ]]
}

strip_v() {
  printf '%s\n' "${1#v}"
}

previous_latest_value() {
  local key="$1"
  if [[ -z "$PREVIOUS_SNAPSHOT_PATH" || ! -f "$PREVIOUS_SNAPSHOT_PATH" ]]; then
    printf '\n'
    return 0
  fi
  python3 - "$PREVIOUS_SNAPSHOT_PATH" "$key" <<'PY'
import json
import sys

path, key = sys.argv[1], sys.argv[2]
try:
    with open(path, 'r', encoding='utf-8') as fh:
        data = json.load(fh)
except Exception:
    print('')
    raise SystemExit(0)

value = data.get('latest', {}).get(key, '')
if not isinstance(value, str):
    value = ''
print(value)
PY
}

resolve_apt_updates() {
  if ! command -v apt-get >/dev/null 2>&1; then
    printf '%s\n' 'apt-get unavailable'
    return 0
  fi

  local updates count names
  apt-get update -qq >/dev/null 2>&1 || true
  updates="$(apt-get upgrade -s 2>/dev/null | grep '^Inst ' || true)"
  count="$(printf '%s\n' "$updates" | grep -c '^Inst ' || true)"

  if [[ "${count:-0}" -gt 0 ]]; then
    names="$(printf '%s\n' "$updates" | awk '{print $2}' | awk 'NF{printf "%s%s", sep, $0; sep=", "}' )"
    printf '%s\n' "$count packages have updates available: $names"
  else
    printf '%s\n' 'All packages are up to date'
  fi
}

output_kv() {
  printf '%s=%s\n' "$1" "$2" >> "$OUTPUT_FILE"
}

mapfile -t all_arg_names < <(grep -oP '^ARG \K\w+(?==[0-9.]+$)' "$DOCKERFILE_PATH")
mapfile -t all_arg_versions < <(grep -oP '^ARG \w+=\K[0-9.]+' "$DOCKERFILE_PATH")

pinned_names=()
pinned_versions=()
for i in "${!all_arg_names[@]}"; do
  case "${all_arg_names[$i]}" in
    DOCKER_VERSION|COMPOSE_VERSION|BUILDX_VERSION|OPENCODE_VERSION|OPENCHAMBER_VERSION|PLAYWRIGHT_VERSION|PLAYWRIGHT_MCP_VERSION)
      pinned_names+=("${all_arg_names[$i]}")
      pinned_versions+=("${all_arg_versions[$i]}")
      ;;
  esac
done

if [[ "${#pinned_names[@]}" -ne 7 || "${#pinned_versions[@]}" -ne 7 ]]; then
  printf 'Expected 7 pinned ARG versions in %s, found %s names and %s versions\n' "$DOCKERFILE_PATH" "${#pinned_names[@]}" "${#pinned_versions[@]}" >&2
  exit 1
fi

pinned_updates_lines=()
latest_updates_lines=()
dockerfile_changes_needed=false
latest_changes_detected=false
apt_updates_needed=false

for i in "${!pinned_names[@]}"; do
  name="${pinned_names[$i]}"
  current="${pinned_versions[$i]}"
  case "$name" in
    DOCKER_VERSION)
      source='moby/moby'
      latest="$(get_github_tag "$source")"
      ;;
    COMPOSE_VERSION)
      source='docker/compose'
      latest="$(get_github_tag "$source")"
      ;;
    BUILDX_VERSION)
      source='docker/buildx'
      latest="$(get_github_tag "$source")"
      ;;
    OPENCODE_VERSION)
      source='opencode-ai'
      latest="$(get_npm_version "$source")"
      ;;
    OPENCHAMBER_VERSION)
      source='@openchamber/web'
      latest="$(get_npm_version "$source")"
      ;;
    PLAYWRIGHT_VERSION)
      source='playwright'
      latest="$(get_npm_version "$source")"
      ;;
    PLAYWRIGHT_MCP_VERSION)
      source='@playwright/mcp'
      latest="$(get_npm_version "$source")"
      ;;
    *)
      source='unknown'
      latest='unknown'
      ;;
  esac

  if version_gt "$current" "$latest"; then
    dockerfile_changes_needed=true
    pinned_updates_lines+=("$(printf '%s\t%s\t%s\t%s\t%s' "$name" "$current" "$latest" "$source" 'changed')")
  elif [[ "$latest" == 'unknown' ]]; then
    warn "Could not resolve latest version for $name from $source"
  fi
done

for name in OH_MY_OPENAGENT_VERSION CODEGRAPH_VERSION LEANCTX_VERSION; do
  case "$name" in
    OH_MY_OPENAGENT_VERSION)
      source='npm'
      package='oh-my-openagent'
      current="$(get_npm_version "$package")"
      previous="$(previous_latest_value "$name")"
      ;;
    CODEGRAPH_VERSION)
      source='npm'
      package='@colbymchenry/codegraph'
      current="$(get_npm_version "$package")"
      previous="$(previous_latest_value "$name")"
      ;;
    LEANCTX_VERSION)
      source='github'
      package='yvgude/lean-ctx'
      current="$(get_github_tag_raw "$package")"
      previous="$(previous_latest_value "$name")"
      ;;
  esac

  if [[ -z "$PREVIOUS_SNAPSHOT_PATH" || ! -f "$PREVIOUS_SNAPSHOT_PATH" ]]; then
    latest_changes_detected=true
    latest_updates_lines+=("$(printf '%s\t%s\t%s\t%s\t%s' "$name" "$current" 'missing' "$source" 'changed')")
    continue
  fi

  if [[ "$current" == 'unknown' ]]; then
    warn "Could not resolve latest version for $name"
    continue
  fi

  if [[ "$name" == 'LEANCTX_VERSION' ]]; then
    if [[ "$(strip_v "$current")" != "$(strip_v "$previous")" ]]; then
      latest_changes_detected=true
      latest_updates_lines+=("$(printf '%s\t%s\t%s\t%s\t%s' "$name" "$current" "$previous" "$source" 'changed')")
    fi
  else
    if [[ "$current" != "$previous" ]]; then
      latest_changes_detected=true
      latest_updates_lines+=("$(printf '%s\t%s\t%s\t%s\t%s' "$name" "$current" "$previous" "$source" 'changed')")
    fi
  fi
done

apt_summary="$(resolve_apt_updates)"
if [[ "$apt_summary" != 'All packages are up to date' && "$apt_summary" != 'apt-get unavailable' ]]; then
  apt_updates_needed=true
fi

timestamp_value="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

pinned_updates_json="$(printf '%s\n' "${pinned_updates_lines[@]:-}" | build_pinned_json)"
latest_updates_json="$(printf '%s\n' "${latest_updates_lines[@]:-}" | build_latest_json)"

updates_needed=false
if [[ "$dockerfile_changes_needed" == true || "$latest_changes_detected" == true || "$apt_updates_needed" == true ]]; then
  updates_needed=true
fi

cat > "$SNAPSHOT_FILE" <<EOF
{
  "timestamp": $(json_quote "$timestamp_value"),
  "pinned": {
    "DOCKER_VERSION": $(json_quote "${pinned_versions[0]}") ,
    "COMPOSE_VERSION": $(json_quote "${pinned_versions[1]}") ,
    "BUILDX_VERSION": $(json_quote "${pinned_versions[2]}") ,
    "OPENCODE_VERSION": $(json_quote "${pinned_versions[3]}") ,
    "OPENCHAMBER_VERSION": $(json_quote "${pinned_versions[4]}") ,
    "PLAYWRIGHT_VERSION": $(json_quote "${pinned_versions[5]}") ,
    "PLAYWRIGHT_MCP_VERSION": $(json_quote "${pinned_versions[6]}")
  },
  "latest": {
    "OH_MY_OPENAGENT_VERSION": $(json_quote "$(get_npm_version 'oh-my-openagent')") ,
    "CODEGRAPH_VERSION": $(json_quote "$(get_npm_version '@colbymchenry/codegraph')") ,
    "LEANCTX_VERSION": $(json_quote "$(get_github_tag_raw 'yvgude/lean-ctx')")
  },
  "apt_snapshot": $(json_quote "$timestamp_value")
}
EOF

output_kv 'updates-needed' "$updates_needed"
output_kv 'dockerfile-changes-needed' "$dockerfile_changes_needed"
output_kv 'latest-changes-detected' "$latest_changes_detected"
output_kv 'pinned-updates' "$pinned_updates_json"
output_kv 'latest-updates' "$latest_updates_json"
output_kv 'apt-updates' "$apt_summary"

printf 'version snapshot written to %s\n' "$SNAPSHOT_FILE"
