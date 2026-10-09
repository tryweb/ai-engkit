#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

fail() {
  printf 'compose isolation: FAIL %s\n' "$1" >&2
  exit 1
}

# Preflight: the guard itself depends on these tools.
command -v docker >/dev/null 2>&1 || fail "docker CLI is unavailable"
docker compose version >/dev/null 2>&1 || fail "docker compose plugin is unavailable"
command -v jq >/dev/null 2>&1 || fail "jq is unavailable"
command -v rg >/dev/null 2>&1 || fail "rg is unavailable"

# The dev Compose file must resolve to project 'dev' (read-only config render).
project_name="$(docker compose -p dev -f docker-compose.dev.yml config --format json | jq -r '.name')"
[ "$project_name" = "dev" ] || fail "docker-compose.dev.yml resolves to project '$project_name', expected 'dev'"

# Dev ai-admin must expose the same overlay contract mounts as production.
admin_volumes="$(docker compose -p dev -f docker-compose.dev.yml config --format json | jq -c '[.services["ai-admin"].volumes[]?]')"
printf '%s' "$admin_volumes" | jq -e 'any(.[]; .target == "/opt/ai-engkit/extensions" and .read_only == true and (.source | endswith("/extensions")))' >/dev/null \
  || fail "dev ai-admin is missing the read-only ./extensions:/opt/ai-engkit/extensions mount"
printf '%s' "$admin_volumes" | jq -e 'any(.[]; .target == "/opt/ai-engkit/compose-upgrade-base.yml" and (.read_only != true) and (.source | endswith("/admin-data/upgrade-base.yml")))' >/dev/null \
  || fail "dev ai-admin is missing the read-write ./admin-data/upgrade-base.yml mount"
[ -f admin-data/upgrade-base.yml ] || fail "./admin-data/upgrade-base.yml must exist as a regular file before Compose starts"

if rg -n 'chown -R devuser:devuser /opt/ai-engkit' docker-compose.dev.yml; then
  fail "dev ai-admin recursively chowns the read-only extensions mount"
fi
rg -n 'find /opt/ai-engkit -path /opt/ai-engkit/extensions -prune -o -exec chown devuser:devuser' docker-compose.dev.yml >/dev/null \
  || fail "dev ai-admin does not prune the read-only extensions mount during ownership setup"

# Dev Compose invocations must pin the project explicitly; an unscoped
# '-f docker-compose.dev.yml' resolves the project from the directory name
# and can attach to (or clobber) the production stack.
if rg -n 'docker compose -f docker-compose\.dev\.yml|docker compose -f "\$compose_file"' \
  test/*.sh .opencode/skills/check-updates/SKILL.md; then
  fail "a dev Compose command omits '-p dev' (use 'docker compose -p dev -f docker-compose.dev.yml')"
fi

# Legacy hyphenated compose entry points are unscoped by construction.
if rg -n 'docker-compose (build|down|up|restart)' test/*.sh; then
  fail "an unscoped legacy 'docker-compose' command remains (use 'docker compose -p dev -f docker-compose.dev.yml ...')"
fi

# Label discovery without the project label can resolve a production
# container when dev is stopped; every service-label fallback must also
# filter on 'label=com.docker.compose.project=dev'.
if rg -n 'label=com\.docker\.compose\.service=' \
  test/run-tests.sh test/test-admin.sh test/test-admin-ui.sh test/test-full.sh \
  test/test-memory-e2e.sh test/test-agent-model-e2e.sh test/leanctx-reliability-gate.sh \
  | rg -v 'label=com\.docker\.compose\.project=dev'; then
  fail "a service-label fallback omits 'label=com.docker.compose.project=dev'"
fi

# 'docker port' against a hardcoded admin container name bypasses label
# resolution and breaks when container_name is overridden.
if rg -n -F 'docker port "ai-engkit-admin-dev"' test/test-admin.sh test/test-admin-ui.sh; then
  fail "a hardcoded admin container 'docker port' call remains (resolve via project=dev + service=ai-admin labels)"
fi

# '|| echo' after a 'docker port ... | head ... | sed' pipeline only fires
# when the pipeline exits non-zero; empty output still builds a malformed
# 'http://<gateway>:' URL. Require an explicit empty-port fallback instead.
if rg -n -F "sed 's/.*://' || echo" test/test-admin.sh test/test-admin-ui.sh; then
  fail "a malformed published-port fallback remains (use 'PUBLISHED_PORT=\"\${PUBLISHED_PORT:-\$ADMIN_PORT}\"')"
fi

# Production identifiers must never appear in dev test scripts.
if rg -n 'ai-engkit_default' test/test-admin.sh test/test-admin-ui.sh; then
  fail "an admin test hardcodes the production network name"
fi

# --- V2 line isolation (prod: docker-compose.v2.yml, dev: docker-compose.v2.dev.yml) ---
# DECISIONS D2: the v2 line must share no mutable state with the v1 lines or
# with its own dev stack. Each V2 compose uses a distinct '<suffix>' named
# volume set, resolves to its own project, keeps OMO runtime residue out, and
# does not collide with prod/dev (or the sibling V2) volumes/ports.
[ -f .env ] || fail "compose isolation guard needs .env (run: cp .env.example .env)"

check_v2_compose() { # $1 = file, $2 = expected project, $3 = volume suffix, $4 = forbidden-port regex
  local file="$1" project="$2" suffix="$3" ports_re="$4" json vols
  json="$(docker compose -f "$file" config --format json)"
  [ "$(printf '%s' "$json" | jq -r '.name')" = "$project" ] \
    || fail "$file resolves to project '$(printf '%s' "$json" | jq -r '.name')', expected '$project'"

  vols="$(printf '%s' "$json" | jq -r '[.services[].volumes[]? | select(.type == "volume") | .source] | unique[]')"
  while IFS= read -r vol; do
    [ -n "$vol" ] || continue
    case "$vol" in
      *-"$suffix") ;;
      *) fail "$file volume '$vol' is not '-$suffix' suffixed" ;;
    esac
  done <<< "$vols"

  if rg -n 'omo-config|ohmyopencode-cache|OH_MY_OPENAGENT_VERSION' "$file" | rg -v '^[0-9]+:[[:space:]]*#'; then
    fail "$file still references OMO runtime residue"
  fi

  while IFS= read -r port; do
    [ -n "$port" ] || continue
    if printf '%s' "$port" | grep -Eq "$ports_re"; then
      fail "$file published port $port collides with a prod/dev/V2 port"
    fi
  done <<< "$(printf '%s' "$json" | jq -r '[.services[] | .ports[]?.published] | unique[]')"
}

# Every V2 named volume (both stacks) must not collide with a v1 prod/dev volume.
all_v2_vols="$(
  for f in docker-compose.v2.yml docker-compose.v2.dev.yml; do
    docker compose -f "$f" config --format json \
      | jq -r '[.services[].volumes[]? | select(.type == "volume") | .source] | unique[]'
  done | sort -u
)"
for other in docker-compose.yml docker-compose.dev.yml; do
  other_volumes="$(docker compose -f "$other" config --format json | jq -r '[.volumes // {} | keys[]] | unique[]')"
  while IFS= read -r vol; do
    [ -n "$vol" ] || continue
    if printf '%s\n' "$other_volumes" | grep -qxF "$vol"; then
      fail "V2 volume '$vol' collides with a $other volume"
    fi
  done <<< "$all_v2_vols"
done

# V2 prod (8002/8082) must avoid prod/dev (8000/8080/8001/8081) and V2 dev (8003/8083).
check_v2_compose docker-compose.v2.yml     v2     v2     '^(8000|8080|8001|8081|8003|8083)$'
# V2 dev (8003/8083) must avoid prod/dev and V2 prod (8002/8082).
check_v2_compose docker-compose.v2.dev.yml v2dev  v2dev  '^(8000|8080|8001|8081|8002|8082)$'

printf 'compose isolation: PASS\n'
