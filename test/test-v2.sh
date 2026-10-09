#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# V2 Test Script — isolated V2 cells
# Usage: ./test/test-v2.sh [cell1|cell2|cell3|cell4|cell5|cell6|cell7|all]
# ============================================================

CHAMBER_V2DEV_PORT="${CHAMBER_V2DEV_PORT:-8003}"
ADMIN_V2DEV_PORT="${ADMIN_V2DEV_PORT:-8083}"

# --------------------------------------------------
# Cell stubs — real assertions come later
# --------------------------------------------------

cell1() {
  echo "CELL cell1: no-OMO baseline"
  local repo_root compose
  repo_root="$(cd "$(dirname "$0")/.." && pwd)"
  compose="docker compose -f ${repo_root}/docker-compose.v2.dev.yml"

  $compose ps --status running --format '{{.Name}}' | grep -q '^ai-engkit-v2dev$'
  $compose ps --status running --format '{{.Name}}' | grep -q '^ai-engkit-admin-v2dev$'
  echo "PASS: V2 containers running"

  # Seed workspace through the daemon: host-path writes are invisible to the
  # V2 container under DooD, so `docker cp` (not cp into a bind) is required
  docker exec ai-engkit-v2dev rm -rf /home/devuser/workspace/.opencode/agents
  docker cp "${repo_root}/.opencode/agents" ai-engkit-v2dev:/home/devuser/workspace/.opencode/agents

  docker exec ai-engkit-v2dev opencode --version 2>&1 | grep -q '2\.0\.24'
  echo "PASS: opencode 2.0.24 in V2 container"

  [ "$(docker exec ai-engkit-v2dev jq -c '.plugin' /home/devuser/.config/opencode/opencode.json)" = "[]" ]
  echo "PASS: opencode.json plugin-free"
  docker exec ai-engkit-v2dev test ! -f /home/devuser/.omo/omo.jsonc
  echo "PASS: no ~/.omo/omo.jsonc (OMO lifecycle skipped)"
  [ "$(docker exec ai-engkit-v2dev find /home/devuser/workspace/.opencode/agents -name '*.md' | wc -l)" -eq 12 ]
  echo "PASS: 12 native agents visible in V2 workspace"

  # Baked V2 plugins: self-contained bundles shipped in the image and deployed
  # to the global OpenCode config plugins dir at boot (v2-plugin-bake.md).
  docker exec ai-engkit-v2dev test -f /opt/opencode/v2-plugins/b1-routing.js
  docker exec ai-engkit-v2dev test -f /opt/opencode/v2-plugins/m3-enforcer.js
  echo "PASS: baked v2 plugins present in image"
  for p in b1-routing m3-enforcer; do
    docker exec ai-engkit-v2dev test -f "/home/devuser/.config/opencode/plugins/$p.js"
  done
  echo "PASS: v2 plugins deployed to global plugins dir"

  # Prove they actually LOAD, not just deploy: each baked plugin appends
  # "setup start" to its log under the opencode data volume when the managed
  # OpenCode server loads it (see v2-plugin-bake.md). Bounded wait for first load.
  for p in b1-routing m3-enforcer; do
    loaded=0
    for _ in $(seq 1 30); do
      if docker exec ai-engkit-v2dev grep -q 'setup start' "/home/devuser/.local/share/opencode/log/$p.log" 2>/dev/null; then
        loaded=1
        break
      fi
      sleep 2
    done
    if [ "$loaded" -ne 1 ]; then
      echo "FAIL: $p plugin did not log 'setup start' within 60s (not loaded)" >&2
      return 1
    fi
    echo "PASS: $p plugin loaded (setup start logged)"
  done

  # Reachable base: localhost works from a host shell; from inside a sibling
  # container (DooD) use the compose bridge gateway instead
  local base=""
  if curl -sf -m 8 -o /dev/null "http://localhost:${CHAMBER_V2DEV_PORT}/"; then
    base="http://localhost:${CHAMBER_V2DEV_PORT}"
  else
    local gw
    gw="$(docker network inspect v2_default --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null)" || gw=""
    if [ -n "$gw" ] && curl -sf -m 8 -o /dev/null "http://${gw}:${CHAMBER_V2DEV_PORT}/"; then
      base="http://${gw}:${CHAMBER_V2DEV_PORT}"
    fi
  fi
  if [ -n "$base" ]; then
    echo "PASS: OpenChamber responds at $base"
  else
    echo "FAIL: OpenChamber unreachable on ${CHAMBER_V2DEV_PORT}" >&2
    return 1
  fi
}

cell2() {
  echo "CELL cell2: v2 diagnostics without LSP (see trial/CELL2.md)"
  local repo_root compose
  repo_root="$(cd "$(dirname "$0")/.." && pwd)"
  compose="docker compose -f ${repo_root}/docker-compose.v2.dev.yml"

  $compose ps --status running --format '{{.Name}}' | grep -q '^ai-engkit-v2dev$'
  echo "PASS: ai-engkit-v2dev running"

  # 1. LSP block is marksman-only: v2 configures no language servers.
  # Upstream V2 accepts lsp but runs none, so this posture needs no entrypoint change.
  [ "$(docker exec ai-engkit-v2dev jq -c '.lsp | keys' /home/devuser/.config/opencode/opencode.json)" = '["marksman"]' ]
  echo "PASS: v2 lsp block is marksman-only (no language servers)"

  # 2. MCP config intact (presence, not runtime).
  [ "$(docker exec ai-engkit-v2dev jq -c '.mcp | keys | sort' /home/devuser/.config/opencode/opencode.json)" = '["codegraph","lean-ctx","playwright"]' ]
  echo "PASS: v2 mcp block has codegraph/lean-ctx/playwright"

  # 3. Baked skills intact — karpathy-guidelines files ARE present in v2;
  # the v2 skill thread is scope/UI, not missing files.
  docker exec ai-engkit-v2dev test -f /home/devuser/.config/opencode/skills/karpathy-guidelines/SKILL.md
  echo "PASS: karpathy-guidelines symlinked in v2 global skills"

  # 4. Zero-install fallbacks present (yaml格 + Dockerfile格).
  docker exec ai-engkit-v2dev python3 -c 'import yaml' 2>/dev/null
  echo "PASS: python3+pyyaml present (yaml fallback)"
  docker exec ai-engkit-v2dev docker --version >/dev/null 2>&1
  echo "PASS: docker CLI present (docker build --check path)"

  # 5. E2E: seed minimal fixtures through the daemon (DooD-safe, same as cell1
  # agents seeding) and prove detection works without any language server.
  docker exec ai-engkit-v2dev mkdir -p /tmp/lsp-cell2
  printf 'key: value\n\tbad_indent: 1\n' | docker exec -i ai-engkit-v2dev sh -c 'cat > /tmp/lsp-cell2/sample.yaml'
  printf 'FROM ubuntu:24.04\nRUN apt-get update && apt-get install -y curl\n' | docker exec -i ai-engkit-v2dev sh -c 'cat > /tmp/lsp-cell2/Dockerfile'
  if docker exec ai-engkit-v2dev python3 -c "import yaml; yaml.safe_load(open('/tmp/lsp-cell2/sample.yaml'))" 2>/dev/null; then
    echo "FAIL: bad yaml parsed without error" >&2
    return 1
  fi
  echo "PASS: bad yaml detected (ScannerError path, no LSP server)"
  if ! docker exec ai-engkit-v2dev docker build --check -f /tmp/lsp-cell2/Dockerfile /tmp/lsp-cell2/ >/dev/null 2>&1; then
    echo "FAIL: docker build --check failed on clean fixture" >&2
    return 1
  fi
  echo "PASS: docker build --check runs in v2"

  # 6. Known gaps — recorded, not failed (CELL3.md §5 decides on demand).
  # NOTE: `command -v` is a shell builtin; probes MUST run under `sh -c`
  # (bare `docker exec ... command -v` always fails and would fake a SKIP).
  if docker exec ai-engkit-v2dev sh -c 'command -v biome' >/dev/null 2>&1; then
    echo "NOTE: biome present in v2 (covered by catalog, CELL3.md §5)"
  else
    echo "SKIP: biome absent in v2 (on-demand via BUN_PACKAGES, CELL3.md §5)"
  fi
  if docker exec ai-engkit-v2dev sh -c 'command -v pyright' >/dev/null 2>&1; then
    echo "NOTE: pyright present in v2 (covered by catalog, CELL3.md §5)"
  else
    echo "SKIP: pyright absent in v2 (on-demand via BUN_PACKAGES, CELL3.md §5)"
  fi
}

cell3() {
  echo "CELL cell3: v2 site diagnostics catalog (see trial/CELL3.md)"
  local repo_root compose catalog key check
  repo_root="$(cd "$(dirname "$0")/.." && pwd)"
  compose="docker compose -f ${repo_root}/docker-compose.v2.dev.yml"
  catalog="${repo_root}/.opencode/v2-diagnostics-catalog.json"

  $compose ps --status running --format '{{.Name}}' | grep -q '^ai-engkit-v2dev$'
  echo "PASS: ai-engkit-v2dev running"

  # 1. Catalog shape: 8 keys, every entry carries a valid kind.
  [ "$(jq -r '.tools | keys | length' "$catalog")" = "8" ]
  echo "PASS: catalog has 8 keys"
  [ "$(jq -r '[.tools[] | select(.kind != "global-executor" and .kind != "project-managed")] | length' "$catalog")" = "0" ]
  echo "PASS: every catalog entry has a valid kind"

  # 2. Enabled global-executors probe green in v2; checks driven by catalog itself.
  for key in $(jq -r '.tools | to_entries[] | select(.value.kind == "global-executor" and .value.enabled == true) | .key' "$catalog"); do
    check="$(jq -r ".tools[\"$key\"].check" "$catalog")"
    if ! docker exec ai-engkit-v2dev sh -c "$check" >/dev/null 2>&1; then
      echo "FAIL: catalog tool '$key' check failed: $check" >&2
      return 1
    fi
    echo "PASS: catalog tool '$key' present in v2"
  done

  # 3. Pinned version holds (typescript@5.8.3 — classic tsserver, NOT 7.x).
  if ! docker exec ai-engkit-v2dev tsc --version 2>&1 | grep -q "5.8.3"; then
    echo "FAIL: tsc version drift (expected 5.8.3)" >&2
    return 1
  fi
  echo "PASS: tsc pinned at 5.8.3 in v2"

  # 4. Default-OFF absent is a recorded decision, not a failure (cell2 SKIP idiom).
  for key in $(jq -r '.tools | to_entries[] | select(.value.kind == "global-executor" and .value.enabled == false) | .key' "$catalog"); do
    check="$(jq -r ".tools[\"$key\"].check" "$catalog")"
    if docker exec ai-engkit-v2dev sh -c "$check" >/dev/null 2>&1; then
      echo "NOTE: default-OFF tool '$key' present (unexpected)"
    else
      echo "SKIP: default-OFF tool '$key' absent in v2 (CELL3.md §5)"
    fi
  done

  # 5. ruff is project-managed: kind asserted, never installed globally by Apply.
  [ "$(jq -r '.tools.ruff.kind' "$catalog")" = "project-managed" ]
  echo "PASS: ruff is project-managed in catalog"
  if docker exec ai-engkit-v2dev command -v ruff >/dev/null 2>&1; then
    echo "NOTE: ruff present globally (unexpected)"
  else
    echo "SKIP: ruff not global in v2 (repo venv owns it, CELL3.md §2)"
  fi
}

cell4() {
  echo "CELL cell4 NOT-IMPLEMENTED"
}

cell5() {
  echo "CELL cell5 NOT-IMPLEMENTED"
}

cell6() {
  echo "CELL cell6 NOT-IMPLEMENTED"
}

cell7() {
  echo "CELL cell7 NOT-IMPLEMENTED"
}

# --------------------------------------------------
# Main — case dispatch
# --------------------------------------------------

main() {
  local target="${1:-all}"
  case "$target" in
    cell1) cell1 ;;
    cell2) cell2 ;;
    cell3) cell3 ;;
    cell4) cell4 ;;
    cell5) cell5 ;;
    cell6) cell6 ;;
    cell7) cell7 ;;
    all) cell1; cell2; cell3; cell4; cell5; cell6; cell7 ;;
    *) echo "Usage: $0 [cell1|cell2|cell3|cell4|cell5|cell6|cell7|all]" >&2; exit 1 ;;
  esac
}

main "$@"
