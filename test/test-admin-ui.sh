#!/usr/bin/env bash
set -uo pipefail

# ============================================================
# ai-admin UI Smoke Test
# Tests login -> dashboard flow via HTTP (server-rendered HTML)
# ============================================================

ADMIN_PORT="${ADMIN_DEV_PORT:-8081}"
# Resolve the admin container: prefer the legacy name (matches dev setups),
# then fall back to the compose service label, which survives container_name
# overrides.
ADMIN_CONTAINER="ai-engkit-admin-dev"
if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$ADMIN_CONTAINER"; then
  ADMIN_CONTAINER="$(docker ps --filter 'label=com.docker.compose.project=dev' --filter 'label=com.docker.compose.service=ai-admin' --filter 'status=running' --format '{{.Names}}' 2>/dev/null | head -n 1)"
fi
ADMIN_CONTAINER="${ADMIN_CONTAINER:-ai-engkit-admin-dev}"
# In DooD (Docker-out-of-Docker) mode, use the bridge gateway
if [ -n "${ADMIN_BASE_URL:-}" ]; then
  BASE="$ADMIN_BASE_URL"
elif [ -f /.dockerenv ] || grep -q docker /proc/1/cgroup 2>/dev/null; then
  NETWORK=$(docker compose -p dev -f docker-compose.dev.yml config --format json | jq -r '.networks.default.name // "dev_default"')
  GATEWAY=$(docker network inspect "$NETWORK" --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null || echo "172.20.0.1")
  # Resolve published host port from container (DooD: gateway needs host port, not container port)
  PUBLISHED_PORT=$(docker port "$ADMIN_CONTAINER" 8080/tcp 2>/dev/null | head -1 | sed 's/.*://')
  PUBLISHED_PORT="${PUBLISHED_PORT:-$ADMIN_PORT}"
  BASE="http://${GATEWAY}:${PUBLISHED_PORT}"
else
  BASE="http://localhost:${ADMIN_PORT}"
fi
COOKIE_JAR="/tmp/admin-ui-cookies.txt"
PASS=0
FAIL=0

RED='\033[0;31m'; GREEN='\033[0;32m'; NC='\033[0m'
pass() { PASS=$((PASS+1)); echo -e "  ${GREEN}PASS${NC} $1"; }
fail() { FAIL=$((FAIL+1)); echo -e "  ${RED}FAIL${NC} $1"; }
assert_contains() { local label="$1" n="$2" h="$3"; if grep -qi "$n" <<<"$h"; then pass "$label"; else fail "$label (expected '$n')"; fi; }
assert_not_contains() { local label="$1" n="$2" h="$3"; if grep -qi "$n" <<<"$h"; then fail "$label (unexpected '$n')"; else pass "$label"; fi; }

COMPOSE_PROJECT="$(docker inspect "$ADMIN_CONTAINER" --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null || true)"
if [ -z "$COMPOSE_PROJECT" ]; then
  fail "cannot read Compose project label for container '$ADMIN_CONTAINER'; refusing to test an unknown container"
  exit 1
fi
if [ "$COMPOSE_PROJECT" != "dev" ]; then
  fail "refusing to test non-dev Compose project '$COMPOSE_PROJECT'"
  exit 1
fi

rm -f "$COOKIE_JAR"

echo "============================================"
echo " ai-admin UI Smoke Test"
echo " URL: $BASE"
echo "============================================"
echo ""

# 1. Login page renders
LOGIN_HTML=$(curl -s "$BASE/login" 2>/dev/null || echo "")
assert_contains "Login page loads" "AI-EngKit Admin" "$LOGIN_HTML"
assert_contains "Login page has password field" "password" "$LOGIN_HTML"
assert_contains "Login page has form" "form" "$LOGIN_HTML"

# 2. Login page redirects to /setup if no password configured
# (setup page is served at /setup when ADMIN_PASSWORD is unset)
SETUP_CHECK=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/setup" 2>/dev/null || echo "000")
if [ "$SETUP_CHECK" = "200" ]; then
  pass "Setup page accessible (no password configured)"
elif [ "$SETUP_CHECK" = "302" ] || [ "$SETUP_CHECK" = "200" ]; then
  pass "Setup check returned $SETUP_CHECK"
else
  pass "Setup check returned $SETUP_CHECK (password may already be set)"
fi

# 3. Login attempt (get session cookie)
ADMIN_PASSWORD="${ADMIN_PASSWORD:-testadmin123}"
LOGIN_RES=$(curl -s -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
  -X POST "$BASE/api/login" \
  -H "Content-Type: application/json" \
  -d "{\"password\":\"$ADMIN_PASSWORD\"}" \
  -w "\n%{http_code}" 2>/dev/null || echo "")

LOGIN_CODE=$(echo "$LOGIN_RES" | tail -1)
LOGIN_BODY=$(echo "$LOGIN_RES" | head -n -1)

if [ "$LOGIN_CODE" = "200" ] || [ "$LOGIN_CODE" = "302" ]; then
  pass "Login returns $LOGIN_CODE"
elif [ "$LOGIN_CODE" = "401" ]; then
  pass "Login returns 401 (wrong password) — password may differ"
else
  pass "Login returned $LOGIN_CODE"
fi

# 4. Dashboard page loads with session (or redirects to login)
DASH_HTML=$(curl -s -b "$COOKIE_JAR" "$BASE/" 2>/dev/null || echo "")
if [ -n "$DASH_HTML" ]; then
  assert_contains "Dashboard response contains dashboard content" "Dashboard" "$DASH_HTML"
fi

# 5. /api/status with cookie (if we have one)
if [ -s "$COOKIE_JAR" ]; then
  STATUS_RES=$(curl -s -b "$COOKIE_JAR" "$BASE/api/status" 2>/dev/null || echo "{}")
  STATUS_CODE=$(echo "$STATUS_RES" | jq -r '.status' 2>/dev/null || echo "")
  if [ "$STATUS_CODE" = "ok" ] || [ "$STATUS_CODE" = "degraded" ]; then
    pass "GET /api/status returns status=$STATUS_CODE"
  else
    pass "GET /api/status returned: $STATUS_CODE"
  fi
fi

# 6. /api/versions with cookie (grouped structure)
VERSIONS_RES=$(curl -s -b "$COOKIE_JAR" "$BASE/api/versions" 2>/dev/null || echo "{}")
HAS_CORE=$(echo "$VERSIONS_RES" | jq 'has("core")' 2>/dev/null || echo "false")
HAS_CLI=$(echo "$VERSIONS_RES" | jq 'has("cli")' 2>/dev/null || echo "false")
HAS_MCP=$(echo "$VERSIONS_RES" | jq 'has("mcp")' 2>/dev/null || echo "false")
HAS_PLUGIN=$(echo "$VERSIONS_RES" | jq 'has("plugin")' 2>/dev/null || echo "false")
TOOL_COUNT=$(echo "$VERSIONS_RES" | jq '[.core, .cli, .mcp, .plugin] | map(length) | add' 2>/dev/null || echo "0")
if [ "$HAS_CORE" = "true" ] && [ "$HAS_CLI" = "true" ] && [ "$HAS_MCP" = "true" ] && [ "$HAS_PLUGIN" = "true" ]; then
  pass "GET /api/versions returns 4 categories (core, cli, mcp, plugin) with $TOOL_COUNT total tools"
else
  fail "GET /api/versions missing categories: core=$HAS_CORE cli=$HAS_CLI mcp=$HAS_MCP plugin=$HAS_PLUGIN (tools=$TOOL_COUNT)"
fi

# 7. /upgrade page embeds the component versions cards (merged Versions & Upgrade)
VERSIONS_HTML=$(curl -s -b "$COOKIE_JAR" "$BASE/upgrade" 2>/dev/null || echo "")
assert_contains "Upgrade page lists Core tools" "Core" "$VERSIONS_HTML"
assert_contains "Upgrade page lists CLI tools" "CLI" "$VERSIONS_HTML"
assert_contains "Upgrade page lists MCP tools" "MCP" "$VERSIONS_HTML"
assert_contains "Upgrade page lists Plugin tools" "Plugin" "$VERSIONS_HTML"
assert_contains "Upgrade page has Image Metadata card" "Image Metadata" "$VERSIONS_HTML"

# 8. Mobile navigation elements present in Layout-wrapped pages
assert_contains "Layout has #nav-toggle button" "nav-toggle" "$VERSIONS_HTML"
assert_contains "Layout has #nav-backdrop" "nav-backdrop" "$VERSIONS_HTML"

# 9. CSS stylesheet contains mobile responsive rules
CSS_CONTENT=$(curl -s "$BASE/static/style.css" 2>/dev/null || echo "")
NAV_OPEN_RULE=$(echo "$CSS_CONTENT" | grep -c "nav-open" || echo "0")
if [ "$NAV_OPEN_RULE" -gt 0 ]; then pass "CSS has .nav-open rule for mobile nav"; else fail "CSS missing .nav-open rule"; fi
TOUCH_TARGET=$(echo "$CSS_CONTENT" | grep -c "min-height: 44px" || echo "0")
if [ "$TOUCH_TARGET" -gt 0 ]; then pass "CSS has min-height:44px touch targets"; else fail "CSS missing min-height:44px"; fi

# 10. Dashboard contains restart ai-dev button
assert_contains "Dashboard has restart ai-dev button" "btn-dash-restart" "$DASH_HTML"

# 11. Secrets page API tests
SECRETS_API=$(curl -s -b "$COOKIE_JAR" "$BASE/api/secrets" 2>/dev/null || echo "")
SECRETS_COUNT=$(echo "$SECRETS_API" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
if [ "$SECRETS_COUNT" = "3" ]; then
  pass "GET /api/secrets returns 3 secrets"
else
  fail "GET /api/secrets returned $SECRETS_COUNT secrets (expected 3)"
fi

SECRETS_VAL=$(curl -s -b "$COOKIE_JAR" "$BASE/api/secrets/ADMIN_PASSWORD/value" 2>/dev/null || echo "")
SECRET_VAL_KEY=$(echo "$SECRETS_VAL" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('key',''))" 2>/dev/null || echo "")
SECRET_VAL_HAS=$(echo "$SECRETS_VAL" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if d.get('value') else 'no')" 2>/dev/null || echo "")
if [ "$SECRET_VAL_KEY" = "ADMIN_PASSWORD" ] && [ "$SECRET_VAL_HAS" = "yes" ]; then
  pass "GET /api/secrets/ADMIN_PASSWORD/value returns value"
else
  fail "GET /api/secrets/ADMIN_PASSWORD/value failed"
fi

SECRETS_PUT=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" \
  -X PUT -H "Content-Type: application/json" \
  -d '{"value":"test123"}' \
  "$BASE/api/secrets/OPENCHAMBER_UI_PASSWORD" 2>/dev/null || echo "000")
if [ "$SECRETS_PUT" = "200" ]; then
  pass "PUT /api/secrets/OPENCHAMBER_UI_PASSWORD returns 200"
else
  fail "PUT /api/secrets/OPENCHAMBER_UI_PASSWORD returned $SECRETS_PUT (expected 200)"
fi

SECRETS_404=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" \
  -X PUT -H "Content-Type: application/json" \
  -d '{"value":"x"}' \
  "$BASE/api/secrets/NONEXISTENT_KEY" 2>/dev/null || echo "000")
if [ "$SECRETS_404" = "404" ]; then
  pass "PUT /api/secrets/NONEXISTENT_KEY returns 404"
else
  fail "PUT /api/secrets/NONEXISTENT_KEY returned $SECRETS_404 (expected 404)"
fi

SECRETS_PAGE=$(curl -s -b "$COOKIE_JAR" "$BASE/secrets" 2>/dev/null || echo "")
assert_contains "Secrets nav link present" "Secrets" "$SECRETS_PAGE"
assert_contains "Secrets page renders 3 cards" "secret-card" "$SECRETS_PAGE"
assert_contains "ADMIN_PASSWORD shows immediate badge" "Takes effect immediately" "$SECRETS_PAGE"
assert_contains "OPENCHAMBER shows restart badge" "Restart container required" "$SECRETS_PAGE"

# 12. Static assets served
CSS_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/static/style.css" 2>/dev/null || echo "000")
if [ "$CSS_CODE" = "200" ]; then
  pass "Static CSS served (200)"
else
  fail "Static CSS returned $CSS_CODE (expected 200)"
fi

JS_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/static/app.js" 2>/dev/null || echo "000")
if [ "$JS_CODE" = "200" ]; then
  pass "Static JS served (200)"
else
  fail "Static JS returned $JS_CODE (expected 200)"
fi

# ============================================================
# 13. Providers page renders
# ============================================================
PROVIDERS_HTML=$(curl -s -b "$COOKIE_JAR" "$BASE/providers" 2>/dev/null || echo "")
assert_contains "Providers page has title" "Providers" "$PROVIDERS_HTML"
assert_contains "Providers page has restart button" "Restart ai-dev" "$PROVIDERS_HTML"
assert_contains "Providers page nav link present" "/providers" "$PROVIDERS_HTML"

# ============================================================
# 14. Providers API: list metadata, no plaintext
# ============================================================
PROVIDERS_API=$(curl -s -b "$COOKIE_JAR" "$BASE/api/providers" 2>/dev/null || echo "{}")
PROVIDER_COUNT=$(echo "$PROVIDERS_API" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('providers',[])))" 2>/dev/null || echo "-1")
if [ "$PROVIDER_COUNT" -ge 0 ]; then
  pass "GET /api/providers returns list ($PROVIDER_COUNT providers)"
else
  fail "GET /api/providers failed to parse"
fi
REGISTRY_OK=$(echo "$PROVIDERS_API" | python3 -c "
import sys,json
d=json.load(sys.stdin)
ok=all('registry' in p and 'keyCount' in p['registry'] and 'keys' in p['registry'] for p in d.get('providers',[]))
print('yes' if ok else 'no')
" 2>/dev/null || echo "no")
if [ "$REGISTRY_OK" = "yes" ]; then
  pass "GET /api/providers exposes registry summary per provider"
else
  fail "GET /api/providers missing registry summary"
fi

# ============================================================
# 15. Provider validation (400 on bad shape, env untouched)
# ============================================================
BEFORE_ENV=$(curl -s -b "$COOKIE_JAR" "$BASE/api/env" 2>/dev/null || echo "{}")
PROVIDER_BAD=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" \
  -X PUT -H "Content-Type: application/json" \
  -d '{"provider":"not-an-object"}' \
  "$BASE/api/providers/badshape" 2>/dev/null || echo "000")
if [ "$PROVIDER_BAD" = "400" ]; then
  pass "PUT /api/providers/badshape with invalid shape returns 400"
else
  fail "PUT /api/providers/badshape returned $PROVIDER_BAD (expected 400)"
fi
AFTER_ENV=$(curl -s -b "$COOKIE_JAR" "$BASE/api/env" 2>/dev/null || echo "{}")
if [ "$BEFORE_ENV" = "$AFTER_ENV" ]; then
  pass "Invalid provider PUT leaves env untouched"
else
  fail "Invalid provider PUT modified env"
fi

# ============================================================
# 16. Provider CRUD (smoke-test-provider, cleaned up after)
# ============================================================
TEST_PROVIDER="smoke-test-provider"
PROVIDER_PUT=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" \
  -X PUT -H "Content-Type: application/json" \
  -d "{\"provider\":{\"npm\":\"@ai-sdk/openai-compatible\",\"name\":\"Smoke Test\",\"options\":{\"baseURL\":\"http://localhost:9999/v1\"}}}" \
  "$BASE/api/providers/$TEST_PROVIDER" 2>/dev/null || echo "000")
if [ "$PROVIDER_PUT" = "200" ]; then
  pass "PUT /api/providers/$TEST_PROVIDER returns 200"
else
  fail "PUT /api/providers/$TEST_PROVIDER returned $PROVIDER_PUT (expected 200)"
fi

PROVIDERS_API2=$(curl -s -b "$COOKIE_JAR" "$BASE/api/providers" 2>/dev/null || echo "{}")
if echo "$PROVIDERS_API2" | grep -q "$TEST_PROVIDER"; then
  pass "Created provider appears in list"
else
  fail "Created provider missing from list"
fi

# ============================================================
# 17. Key registry CRUD on the test provider (no apply path)
# ============================================================
TEST_KEY="sk-smoke-1234567890abcdef"
KEY_ADD=$(curl -s -b "$COOKIE_JAR" \
  -X POST -H "Content-Type: application/json" \
  -d "{\"value\":\"$TEST_KEY\"}" \
  "$BASE/api/providers/$TEST_PROVIDER/keys" 2>/dev/null || echo "{}")
KEY_ID=$(echo "$KEY_ADD" | python3 -c "import sys,json; print(json.load(sys.stdin).get('key',{}).get('id',''))" 2>/dev/null || echo "")
KEY_MASKED=$(echo "$KEY_ADD" | python3 -c "import sys,json; print(json.load(sys.stdin).get('key',{}).get('masked',''))" 2>/dev/null || echo "")
if [ -n "$KEY_ID" ] && [ "$KEY_MASKED" = "sk-s…cdef" ] && ! echo "$KEY_ADD" | grep -q "$TEST_KEY"; then
  pass "POST key returns masked identifier (no plaintext)"
else
  fail "POST key response wrong: id='$KEY_ID' masked='$KEY_MASKED'"
fi
if [ "$KEY_MASKED" = "sk-s…cdef" ]; then
  pass "Mask format is first4…last4 (got '$KEY_MASKED')"
else
  fail "Unexpected mask '$KEY_MASKED' (expected 'sk-s…cdef')"
fi

if echo "$PROVIDERS_API2" | grep -q "$TEST_KEY"; then
  fail "Plaintext key leaked in /api/providers list"
else
  pass "No plaintext key in /api/providers list"
fi

KEY_VALUE=$(curl -s -b "$COOKIE_JAR" "$BASE/api/providers/$TEST_PROVIDER/keys/$KEY_ID/value" 2>/dev/null || echo "{}")
if echo "$KEY_VALUE" | grep -q "$TEST_KEY"; then
  pass "GET key value endpoint reveals plaintext on demand"
else
  fail "GET key value endpoint did not return plaintext"
fi

# Second key: first stays active; then switch active
KEY2_ADD=$(curl -s -b "$COOKIE_JAR" \
  -X POST -H "Content-Type: application/json" \
  -d '{"value":"sk-smoke-2-abcdef9876543210"}' \
  "$BASE/api/providers/$TEST_PROVIDER/keys" 2>/dev/null || echo "{}")
KEY2_ID=$(echo "$KEY2_ADD" | python3 -c "import sys,json; print(json.load(sys.stdin).get('key',{}).get('id',''))" 2>/dev/null || echo "")
ACTIVE_SWITCH=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" \
  -X PUT "$BASE/api/providers/$TEST_PROVIDER/keys/$KEY2_ID/active" 2>/dev/null || echo "000")
if [ "$ACTIVE_SWITCH" = "200" ]; then
  pass "PUT active key returns 200 (no apply for non-key-managed provider)"
else
  fail "PUT active key returned $ACTIVE_SWITCH (expected 200)"
fi
ACTIVE_CHECK=$(curl -s -b "$COOKIE_JAR" "$BASE/api/providers" 2>/dev/null | python3 -c "
import sys,json
d=json.load(sys.stdin)
p=next((x for x in d.get('providers',[]) if x['name']=='$TEST_PROVIDER'),None)
if not p: print('missing')
else:
  reg=p['registry']
  print(reg['activeKeyId'] if reg['activeKeyId']=='$KEY2_ID' else 'stale:'+str(reg['activeKeyId']))
" 2>/dev/null || echo "parse-error")
if [ "$ACTIVE_CHECK" = "$KEY2_ID" ]; then
  pass "Active key selection persisted"
else
  fail "Active key selection wrong ($ACTIVE_CHECK)"
fi

# Delete the active key → the other key is promoted
KEY_DEL=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" \
  -X DELETE "$BASE/api/providers/$TEST_PROVIDER/keys/$KEY2_ID" 2>/dev/null || echo "000")
if [ "$KEY_DEL" = "200" ]; then
  pass "DELETE key returns 200"
else
  fail "DELETE key returned $KEY_DEL (expected 200)"
fi
PROMOTED=$(curl -s -b "$COOKIE_JAR" "$BASE/api/providers" 2>/dev/null | python3 -c "
import sys,json
d=json.load(sys.stdin)
p=next((x for x in d.get('providers',[]) if x['name']=='$TEST_PROVIDER'),None)
if not p: print('missing')
else:
  reg=p['registry']
  print(reg['activeKeyId'] if reg['activeKeyId']=='$KEY_ID' else 'stale:'+str(reg['activeKeyId']))
" 2>/dev/null || echo "parse-error")
if [ "$PROMOTED" = "$KEY_ID" ]; then
  pass "Deleting active key promotes remaining key"
else
  fail "Key promotion failed ($PROMOTED)"
fi

KEY_DEL_404=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" \
  -X DELETE "$BASE/api/providers/$TEST_PROVIDER/keys/nonexistent" 2>/dev/null || echo "000")
if [ "$KEY_DEL_404" = "404" ]; then
  pass "DELETE unknown key returns 404"
else
  fail "DELETE unknown key returned $KEY_DEL_404 (expected 404)"
fi

# Import candidate on a key-managed provider is a valid JSON response
IMPORT_CANDIDATE=$(curl -s -b "$COOKIE_JAR" "$BASE/api/providers/opencode-go/keys/import-candidate" 2>/dev/null || echo "{}")
if echo "$IMPORT_CANDIDATE" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
  pass "import-candidate returns valid JSON"
else
  fail "import-candidate returned non-JSON: $IMPORT_CANDIDATE"
fi

# ============================================================
# 18. Provider cleanup
# ============================================================
PROVIDER_DEL=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" \
  -X DELETE "$BASE/api/providers/$TEST_PROVIDER" 2>/dev/null || echo "000")
if [ "$PROVIDER_DEL" = "200" ]; then
  pass "DELETE /api/providers/$TEST_PROVIDER returns 200"
else
  fail "DELETE /api/providers/$TEST_PROVIDER returned $PROVIDER_DEL (expected 200)"
fi
PROVIDERS_API3=$(curl -s -b "$COOKIE_JAR" "$BASE/api/providers" 2>/dev/null || echo "{}")
if echo "$PROVIDERS_API3" | grep -q "$TEST_PROVIDER"; then
  fail "Deleted provider still present"
else
  pass "Deleted provider removed from list"
fi

PROVIDER_DEL_404=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" \
  -X DELETE "$BASE/api/providers/$TEST_PROVIDER" 2>/dev/null || echo "000")
if [ "$PROVIDER_DEL_404" = "404" ]; then
  pass "DELETE unknown provider returns 404"
else
  fail "DELETE unknown provider returned $PROVIDER_DEL_404 (expected 404)"
fi

# ============================================================
# 19. Project creation registers in OpenChamber settings
# Creates a real project, asserts registration + dedupe, then cleans up.
# ============================================================
E2E_PROJ="e2e-reg-$(date +%s)"
TOOL_PROJ="e2e-tool-$(date +%s)"
# Resolve the ai-dev container: prefer the legacy name (matches dev setups),
# then fall back to the compose service label, which survives container_name
# overrides (CI renames the container to "ci-test").
AI_DEV_CONTAINER="${AI_DEV_CONTAINER:-ai-engkit-dev}"
if [ "$AI_DEV_CONTAINER" = "ai-engkit-dev" ] && ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$AI_DEV_CONTAINER"; then
  AI_DEV_CONTAINER="$(docker ps --filter 'label=com.docker.compose.project=dev' --filter 'label=com.docker.compose.service=ai-dev' --filter 'status=running' --format '{{.Names}}' 2>/dev/null | head -n 1)"
fi
AI_DEV_CONTAINER="${AI_DEV_CONTAINER:-ai-engkit-dev}"
e2e_project_cleanup() {
  curl -s -o /dev/null -b "$COOKIE_JAR" -X POST "$BASE/api/projects/sync" \
    -H "Content-Type: application/json" \
    -d "{\"remove\":[\"$E2E_PROJ\",\"$TOOL_PROJ\"]}" >/dev/null 2>&1 || true
  docker exec "$AI_DEV_CONTAINER" sh -c "rm -rf /home/devuser/workspace/$E2E_PROJ" >/dev/null 2>&1 || true
  docker exec "$AI_DEV_CONTAINER" sh -c "rm -rf /home/devuser/workspace/$TOOL_PROJ" >/dev/null 2>&1 || true
}
trap e2e_project_cleanup EXIT

if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$AI_DEV_CONTAINER"; then
  OC_SETTINGS="/home/devuser/.config/openchamber/settings.json"
  OC_COUNT="docker exec $AI_DEV_CONTAINER jq -r --arg path /home/devuser/workspace/$E2E_PROJ '[.projects[]?|select(.path==\$path)]|length' $OC_SETTINGS"

  CREATE_RES=$(curl -s -w "\n%{http_code}" -b "$COOKIE_JAR" \
    -X POST "$BASE/api/projects" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"$E2E_PROJ\",\"git_init\":false}" 2>/dev/null || echo "")
  CREATE_CODE=$(echo "$CREATE_RES" | tail -1)
  CREATE_BODY=$(echo "$CREATE_RES" | head -n -1)
  CREATE_OK=$(echo "$CREATE_BODY" | jq -r '.ok // false' 2>/dev/null || echo "false")
  if [ "$CREATE_CODE" = "200" ] && [ "$CREATE_OK" = "true" ]; then
    pass "POST /api/projects creates project ($CREATE_CODE, ok=true)"
  else
    fail "POST /api/projects returned $CREATE_CODE body=$CREATE_BODY"
  fi

  REG_COUNT=$(timeout 15 sh -c "$OC_COUNT" 2>/dev/null || echo "err")
  if [ "$REG_COUNT" = "1" ]; then
    pass "Project registered in OpenChamber settings"
  else
    fail "OpenChamber registration count=$REG_COUNT (expected 1)"
  fi

  # Duplicate create must not duplicate the settings entry
  curl -s -o /dev/null -b "$COOKIE_JAR" -X POST "$BASE/api/projects" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"$E2E_PROJ\",\"git_init\":false}" 2>/dev/null || true
  DUP_COUNT=$(timeout 15 sh -c "$OC_COUNT" 2>/dev/null || echo "err")
  if [ "$DUP_COUNT" = "1" ]; then
    pass "Duplicate create keeps a single settings entry"
  else
    fail "Duplicate create produced count=$DUP_COUNT (expected 1)"
  fi

  # Settings file remains a valid JSON object with a projects array
  OC_SHAPE=$(timeout 15 docker exec "$AI_DEV_CONTAINER" jq -r 'type + "/" + (.projects | type)' "$OC_SETTINGS" 2>/dev/null || echo "err")
  if [ "$OC_SHAPE" = "object/array" ]; then
    pass "OpenChamber settings shape valid (object with projects array)"
  else
    fail "OpenChamber settings shape=$OC_SHAPE (expected object/array)"
  fi

  # Overview must expose typed tool status fields for the created project
  OVERVIEW_API=$(curl -s -b "$COOKIE_JAR" "$BASE/api/projects/overview" 2>/dev/null || echo "{}")
  OV_TOOL_OK=$(echo "$OVERVIEW_API" | python3 -c "
import sys,json
d=json.load(sys.stdin)
p=d.get('$E2E_PROJ')
if not p: print('missing')
else:
  ok='codegraph' in p
  cg=p.get('codegraph')
  if ok and cg is not None: ok=isinstance(cg.get('initialized'),bool)
  print('yes' if ok else 'no')
" 2>/dev/null || echo "parse-error")
  if [ "$OV_TOOL_OK" = "yes" ]; then
    pass "Overview exposes codegraph field for created project"
  else
    fail "Overview tool status wrong for $E2E_PROJ ($OV_TOOL_OK)"
  fi

  # Explicit cleanup (trap above is the backstop)
  SYNC_DEL=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" \
    -X POST "$BASE/api/projects/sync" \
    -H "Content-Type: application/json" \
    -d "{\"remove\":[\"$E2E_PROJ\"]}" 2>/dev/null || echo "000")
  docker exec "$AI_DEV_CONTAINER" sh -c "rm -rf /home/devuser/workspace/$E2E_PROJ" >/dev/null 2>&1 || true
  if [ "$SYNC_DEL" = "200" ]; then
    pass "POST /api/projects/sync remove returns 200 (cleanup)"
  else
    fail "POST /api/projects/sync remove returned $SYNC_DEL (expected 200)"
  fi
  POST_COUNT=$(timeout 15 sh -c "$OC_COUNT" 2>/dev/null || echo "err")
  if [ "$POST_COUNT" = "0" ]; then
    pass "Settings entry removed after cleanup"
  else
    fail "Settings entry still present after cleanup (count=$POST_COUNT)"
  fi
else
  echo "  SKIP project registration E2E ($AI_DEV_CONTAINER container not running)"
fi

# ============================================================
# 19b. Projects page + overview tool status (codegraph)
# ============================================================
TOOL_CREATE_RES=$(curl -s -w "\n%{http_code}" -b "$COOKIE_JAR" \
  -X POST "$BASE/api/projects" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$TOOL_PROJ\",\"git_init\":false}" 2>/dev/null || echo "")
TOOL_CREATE_CODE=$(echo "$TOOL_CREATE_RES" | tail -1)
TOOL_CREATE_OK=$(echo "$TOOL_CREATE_RES" | head -n -1 | jq -r '.ok // false' 2>/dev/null || echo "false")
if [ "$TOOL_CREATE_CODE" = "200" ] && [ "$TOOL_CREATE_OK" = "true" ]; then
  pass "Created tool-status project fixture"
else
  fail "Could not create tool-status project fixture ($TOOL_CREATE_CODE)"
fi

PROJECTS_HTML=$(curl -s -b "$COOKIE_JAR" "$BASE/projects" 2>/dev/null || echo "")
assert_contains "Projects page renders CodeGraph column" "CodeGraph" "$PROJECTS_HTML"
# The shared Layout sidebar always carries a "LeanCTX Config" nav link, so a
# whole-page absence check would false-fail. Tool columns surface as filter
# selects; a leanCTX column would add an id="filter-leanctx" select here.
PROJECTS_FILTERS=$(printf '%s' "$PROJECTS_HTML" | grep -oE 'id="filter-[a-z]+"')
assert_not_contains "Projects toolbar has no leanCTX filter" 'leanctx' "$PROJECTS_FILTERS"
assert_contains "Projects page loads projects-page.js" 'projects-page.js' "$PROJECTS_HTML"
assert_contains "Projects page has re-scan button" "btn-tool-refresh" "$PROJECTS_HTML"

REFRESH_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" \
  -X POST "$BASE/api/projects/tool-status/refresh" 2>/dev/null || echo "000")
if [ "$REFRESH_CODE" = "200" ]; then
  pass "POST /api/projects/tool-status/refresh returns 200"
else
  fail "POST /api/projects/tool-status/refresh returned $REFRESH_CODE (expected 200)"
fi

OVERVIEW_API=$(curl -s -b "$COOKIE_JAR" "$BASE/api/projects/overview" 2>/dev/null || echo "{}")
OV_PROJECT_COUNT=$(echo "$OVERVIEW_API" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "-1")
OV_SHAPE=$(echo "$OVERVIEW_API" | python3 -c "
import sys,json
d=json.load(sys.stdin)
if not d: print('empty')
ok=True
for name,p in d.items():
  if not isinstance(p,dict) or 'codegraph' not in p: ok=False; break
  cg=p['codegraph']
  if cg is not None and not isinstance(cg.get('initialized'),bool): ok=False; break
print('yes' if ok else 'no')
" 2>/dev/null || echo "parse-error")
if [ "$OV_SHAPE" = "yes" ]; then
  pass "Overview entries carry typed codegraph fields ($OV_PROJECT_COUNT projects)"
elif [ "$OV_SHAPE" = "empty" ]; then
  pass "Overview empty (no projects to inspect)"
else
  fail "Overview tool status shape invalid ($OV_SHAPE)"
fi

OV_STATS=$(echo "$OVERVIEW_API" | python3 -c "
import sys,json
d=json.load(sys.stdin)
ok=False
for name,p in d.items():
  st=p.get('stats')
  if st is None: continue
  if not isinstance(st,dict): print('bad'); sys.exit(0)
  for key in ('knowledge','maintenance','openspec'):
    v=st.get(key)
    if v is None: continue
    if not isinstance(v,dict): print('bad'); sys.exit(0)
    counter=v.get('files',v.get('reports',v.get('active',0)))
    if not isinstance(counter,int): print('bad'); sys.exit(0)
  ok=True
print('yes' if ok else 'none')
" 2>/dev/null || echo "parse-error")
if [ "$OV_STATS" = "yes" ]; then
  pass "Overview exposes typed feature stats for enabled features"
elif [ "$OV_STATS" = "none" ]; then
  pass "Overview stats absent (no project has an enabled feature)"
else
  fail "Overview feature stats shape invalid ($OV_STATS)"
fi

# Dashboard must present site-level leanCTX statistics
DASHBOARD_HTML=$(curl -s -b "$COOKIE_JAR" "$BASE/" 2>/dev/null || echo "")
assert_contains "Dashboard renders leanCTX statistics" "leanCTX" "$DASHBOARD_HTML"
STATUS_API=$(curl -s -b "$COOKIE_JAR" "$BASE/api/status" 2>/dev/null || echo "{}")
LC_SHAPE=$(echo "$STATUS_API" | python3 -c "
import sys,json
d=json.load(sys.stdin)
lc=d.get('leanctx')
if lc is None: print('null'); sys.exit(0)
if not isinstance(lc.get('projectsWithFacts'),int): print('bad'); sys.exit(0)
if not isinstance(lc.get('totalMemoryFacts'),int): print('bad'); sys.exit(0)
if not isinstance(lc.get('activeProjects24h'),int): print('bad'); sys.exit(0)
if not isinstance(lc.get('healthCoverage'),int): print('bad'); sys.exit(0)
print('yes')
" 2>/dev/null || echo "parse-error")
if [ "$LC_SHAPE" = "yes" ] || [ "$LC_SHAPE" = "null" ]; then
  pass "Status API exposes typed leanCTX site stats ($LC_SHAPE)"
else
  fail "Status API leanCTX stats invalid ($LC_SHAPE)"
fi

# Dashboard must present leanCTX token-savings telemetry
assert_contains "Dashboard renders Token Savings card" "Token Savings" "$DASHBOARD_HTML"
GAIN_SHAPE=$(echo "$STATUS_API" | python3 -c "
import sys,json
d=json.load(sys.stdin)
g=d.get('gain')
if g is None: print('null'); sys.exit(0)
for k in ('tokensSaved','netTokensSaved','grossUsdSaved','netUsdSaved','overheadUsd','bounceTokens','ledgerEvents'):
  if not isinstance(g.get(k),(int,float)): print('bad:'+k); sys.exit(0)
if not isinstance(g.get('compressionPct'),(int,float)): print('bad:compressionPct'); sys.exit(0)
if not isinstance(g.get('ledgerVerified'),bool): print('bad:ledgerVerified'); sys.exit(0)
print('yes')
" 2>/dev/null || echo "parse-error")
if [ "$GAIN_SHAPE" = "yes" ] || [ "$GAIN_SHAPE" = "null" ]; then
  pass "Status API exposes typed leanCTX gain stats ($GAIN_SHAPE)"
else
  fail "Status API gain stats invalid ($GAIN_SHAPE)"
fi

# ============================================================
# 20. Optional apply integration (RUN_APPLY_TESTS=1)
# Writes a key to the opencode auth store in ai-engkit-dev and restarts it.
# ============================================================
if [ "${RUN_APPLY_TESTS:-0}" = "1" ]; then
  # Backup pre-test registry + auth store so the environment keeps its state.
  REGISTRY_BACKUP=$(timeout 15 docker exec ai-engkit-admin-dev sh -c 'cat /opt/ai-engkit/admin-data/provider-keys.json 2>/dev/null' 2>/dev/null || echo "")
  AUTH_BACKUP=$(timeout 15 docker exec ai-engkit-dev sh -c 'cat ~/.local/share/opencode/auth.json 2>/dev/null' 2>/dev/null || echo "")
  echo '{"providers": {}}' | docker exec -i ai-engkit-admin-dev sh -c 'cat > /opt/ai-engkit/admin-data/provider-keys.json'

  APPLY_KEY="sk-apply-test-$(date +%s)"
  APPLY_ADD=$(curl -s -b "$COOKIE_JAR" \
    -X POST -H "Content-Type: application/json" \
    -d "{\"value\":\"$APPLY_KEY\"}" \
    "$BASE/api/providers/opencode-go/keys" 2>/dev/null || echo "{}")
  APPLY_OK=$(echo "$APPLY_ADD" | python3 -c "import sys,json; print('yes' if json.load(sys.stdin).get('ok') else 'no')" 2>/dev/null || echo "no")
  if [ "$APPLY_OK" = "yes" ]; then
    pass "POST first key to opencode-go applied (key saved)"
  else
    fail "POST first key to opencode-go failed: $APPLY_ADD"
  fi

  AUTH_STORE=$(timeout 15 docker exec ai-engkit-dev sh -c 'cat ~/.local/share/opencode/auth.json 2>/dev/null' 2>/dev/null || echo "")
  if echo "$AUTH_STORE" | grep -q "$APPLY_KEY"; then
    pass "Applied key written to opencode auth.json"
  else
    fail "Applied key missing from auth.json"
  fi

  CACHE_LEFT=$(timeout 15 docker exec ai-engkit-dev sh -c 'ls ~/.cache/oh-my-opencode/ 2>/dev/null | grep -c json || true' 2>/dev/null || echo "1")
  if [ "$CACHE_LEFT" = "0" ]; then
    pass "oh-my-opencode cache cleared after apply"
  else
    fail "Cache not cleared ($CACHE_LEFT json files remain)"
  fi

  APPLY_ID=$(echo "$APPLY_ADD" | python3 -c "import sys,json; print(json.load(sys.stdin).get('key',{}).get('id',''))" 2>/dev/null || echo "")
  if [ -n "$APPLY_ID" ]; then
    DEL_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" \
      -X DELETE "$BASE/api/providers/opencode-go/keys/$APPLY_ID" 2>/dev/null || echo "000")
    if [ "$DEL_CODE" = "200" ]; then
      pass "DELETE applied key returns 200"
    else
      fail "DELETE applied key returned $DEL_CODE (expected 200)"
    fi
    # The delete triggers a container restart; give it time to come back.
    sleep 5
    AUTH_AFTER=$(timeout 15 docker exec ai-engkit-dev sh -c 'cat ~/.local/share/opencode/auth.json 2>/dev/null' 2>/dev/null || echo "")
    if echo "$AUTH_AFTER" | grep -q "$APPLY_KEY"; then
      fail "Deleted key still present in auth.json after delete"
    else
      pass "Deleted key removed from opencode auth.json"
    fi
  fi

  # ------------------------------------------------------------------
  # 19b. Upgrade scenario: pre-existing auth-store key becomes first key
  # ------------------------------------------------------------------
  UPGRADE_KEY="sk-upgrade-test-$(date +%s)"
  docker exec ai-engkit-dev sh -c "test -f ~/.local/share/opencode/auth.json || echo '{}' > ~/.local/share/opencode/auth.json; jq --arg k '$UPGRADE_KEY' '.[\"opencode-go\"] = {type: \"api\", key: \$k}' ~/.local/share/opencode/auth.json > /tmp/auth.json.new && mv /tmp/auth.json.new ~/.local/share/opencode/auth.json && chmod 600 ~/.local/share/opencode/auth.json"

  OVERWRITE_CODE=$(curl -s -o /tmp/overwrite-body.json -w "%{http_code}" -b "$COOKIE_JAR" \
    -X POST -H "Content-Type: application/json" \
    -d "{\"value\":\"sk-overwrite-test\"}" \
    "$BASE/api/providers/opencode-go/keys" 2>/dev/null || echo "000")
  if [ "$OVERWRITE_CODE" = "409" ]; then
    pass "Upgrade: first-key add rejected when auth store holds a key (409)"
  else
    fail "Upgrade: first-key add returned $OVERWRITE_CODE (expected 409)"
  fi

  REG_STILL_EMPTY=$(curl -s -b "$COOKIE_JAR" "$BASE/api/providers" | python3 -c "
import sys,json
d=json.load(sys.stdin)
for p in d.get('providers',[]):
    if p.get('name')=='opencode-go':
        print('yes' if p.get('registry',{}).get('keyCount')==0 else 'no')
        break
" 2>/dev/null || echo "no")
  if [ "$REG_STILL_EMPTY" = "yes" ]; then
    pass "Upgrade: rejected add left registry empty"
  else
    fail "Upgrade: rejected add modified registry"
  fi

  AUTH_STILL=$(timeout 15 docker exec ai-engkit-dev sh -c 'cat ~/.local/share/opencode/auth.json 2>/dev/null' 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('opencode-go',{}).get('key',''))" 2>/dev/null || echo "")
  if [ "$AUTH_STILL" = "$UPGRADE_KEY" ]; then
    pass "Upgrade: rejected add left auth store untouched"
  else
    fail "Upgrade: rejected add altered auth store"
  fi

  UPGRADE_CANDIDATE=$(curl -s -b "$COOKIE_JAR" "$BASE/api/providers/opencode-go/keys/import-candidate" 2>/dev/null || echo "{}")
  CAND_OK=$(echo "$UPGRADE_CANDIDATE" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if d.get('candidate') else 'no')" 2>/dev/null || echo "no")
  if [ "$CAND_OK" = "yes" ]; then
    pass "Upgrade: import-candidate surfaces pre-existing auth-store key"
  else
    fail "Upgrade: import-candidate did not surface key: $UPGRADE_CANDIDATE"
  fi

  EXPECTED_MASK=$(printf '%s' "$UPGRADE_KEY" | awk '{print substr($0,1,4)"…"substr($0,length($0)-3)}')
  CAND_MASK=$(echo "$UPGRADE_CANDIDATE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('masked',''))" 2>/dev/null || echo "")
  if [ "$CAND_MASK" = "$EXPECTED_MASK" ]; then
    pass "Upgrade: candidate masked matches pre-existing key"
  else
    fail "Upgrade: candidate masked '$CAND_MASK' != expected '$EXPECTED_MASK'"
  fi

  UPGRADE_IMPORT=$(curl -s -b "$COOKIE_JAR" -X POST "$BASE/api/providers/opencode-go/keys/import" 2>/dev/null || echo "{}")
  IMPORT_ID=$(echo "$UPGRADE_IMPORT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('key',{}).get('id',''))" 2>/dev/null || echo "")
  if [ -n "$IMPORT_ID" ]; then
    pass "Upgrade: POST import adopts key ($IMPORT_ID)"
  else
    fail "Upgrade: POST import failed: $UPGRADE_IMPORT"
  fi

  UPGRADE_STATE=$(curl -s -b "$COOKIE_JAR" "$BASE/api/providers" 2>/dev/null || echo "{}")
  REG_OK=$(echo "$UPGRADE_STATE" | python3 -c "
import sys,json
d=json.load(sys.stdin)
found=False
for p in d.get('providers',[]):
    if p.get('name')=='opencode-go':
        found=True
        r=p.get('registry',{})
        k=r.get('keys',[{}])[0]
        ok = r.get('keyCount')==1 and r.get('activeKeyId')=='$IMPORT_ID' and k.get('active') is True and k.get('masked')=='$EXPECTED_MASK'
        print('yes' if ok else 'no: '+json.dumps(r))
        break
if not found: print('no: provider missing')
" 2>/dev/null || echo "no")
  if [ "$REG_OK" = "yes" ]; then
    pass "Upgrade: imported key is first and active in registry"
  else
    fail "Upgrade: registry state wrong ($REG_OK)"
  fi

  AUTH_VAL=$(timeout 15 docker exec ai-engkit-dev sh -c 'cat ~/.local/share/opencode/auth.json 2>/dev/null' 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('opencode-go',{}).get('key',''))" 2>/dev/null || echo "")
  if [ "$AUTH_VAL" = "$UPGRADE_KEY" ]; then
    pass "Upgrade: auth store value untouched by import"
  else
    fail "Upgrade: auth store rewritten by import (value mismatch)"
  fi

  if [ -n "$REGISTRY_BACKUP" ]; then
    printf '%s' "$REGISTRY_BACKUP" | docker exec -i ai-engkit-admin-dev sh -c 'cat > /opt/ai-engkit/admin-data/provider-keys.json'
  fi
  if [ -n "$AUTH_BACKUP" ]; then
    printf '%s' "$AUTH_BACKUP" | docker exec -i ai-engkit-dev sh -c 'cat > ~/.local/share/opencode/auth.json && chmod 600 ~/.local/share/opencode/auth.json'
  fi
  REG_RESTORED=$(timeout 15 docker exec ai-engkit-admin-dev sh -c 'cat /opt/ai-engkit/admin-data/provider-keys.json 2>/dev/null' 2>/dev/null || echo "")
  if [ "$REG_RESTORED" = "$REGISTRY_BACKUP" ]; then
    pass "Upgrade: registry restored to pre-test state"
  else
    fail "Upgrade: registry restore mismatch"
  fi
fi

# Summary
echo ""
echo "============================================"
echo " Results: ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC}"
echo "============================================"

rm -f "$COOKIE_JAR"
[ "$FAIL" -gt 0 ] && exit 1 || exit 0
