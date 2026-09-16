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

printf 'compose isolation: PASS\n'
