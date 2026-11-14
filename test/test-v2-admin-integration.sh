#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# V2 Admin live integration checks
#
# Stability rules (2026-11-14, false-failure triage):
#   1. DooD: compose publishes ports on the HOST daemon, so localhost is
#      unreachable from this container. Probe localhost first, then fall
#      back to the compose bridge gateway (same derivation as cell1 of
#      test/test-v2.sh). Explicit CHAMBER_V2_URL / ADMIN_V2_URL still win.
#   2. Servers start late (the ai-admin entrypoint chowns the whole
#      admin-data volume before `bun run server.ts`), so a one-shot curl
#      right after `compose up` races the boot. Readiness-gate instead.
#   3. The login password must mirror the SERVER's resolution order
#      (src/admin/lib/auth.ts getPassword): persisted env file first
#      (V2: /opt/ai-engkit/.env.v2, V1: .env — OMO_ENABLED=0 picks V2),
#      then the container env. An ambient ADMIN_PASSWORD here is the
#      container-env value and can MISMATCH the persisted file, which
#      produced 401 false failures; it is therefore ignored unless passed
#      explicitly as ADMIN_PASSWORD_TEST.
# ============================================================

CHAMBER_PORT="${CHAMBER_V2DEV_PORT:-8003}"
ADMIN_PORT="${ADMIN_V2DEV_PORT:-8083}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

# --- 1. Resolve base URLs: explicit env > localhost > bridge gateway -------
resolve_url() { # $1 explicit URL, $2 port, $3 probe path
  if [ -n "$1" ]; then
    printf '%s' "$1"
    return 0
  fi
  if curl -sf -m 2 -o /dev/null "http://localhost:$2$3" 2>/dev/null; then
    printf 'http://localhost:%s' "$2"
    return 0
  fi
  local gw=""
  gw="$(docker inspect ai-engkit-v2dev \
    --format '{{range $k, $v := .NetworkSettings.Networks}}{{$v.Gateway}}{{end}}' 2>/dev/null | head -1)" || gw=""
  if [ -z "$gw" ]; then
    for net in v2dev_default v2_default; do
      gw="$(docker network inspect "$net" \
        --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null)" || gw=""
      [ -n "$gw" ] && break
    done
  fi
  if [ -n "$gw" ] && curl -sf -m 2 -o /dev/null "http://$gw:$2$3" 2>/dev/null; then
    printf 'http://%s:%s' "$gw" "$2"
    return 0
  fi
  return 1
}

CHAMBER_URL="$(resolve_url "${CHAMBER_V2_URL:-}" "$CHAMBER_PORT" "/")" \
  || fail "OpenChamber unreachable on port ${CHAMBER_PORT} (tried localhost and bridge gateway)"
ADMIN_URL="$(resolve_url "${ADMIN_V2_URL:-}" "$ADMIN_PORT" "/healthz")" \
  || fail "Admin unreachable on port ${ADMIN_PORT} (tried localhost and bridge gateway)"
echo "PASS: endpoints resolved (chamber=${CHAMBER_URL} admin=${ADMIN_URL})"

# --- 2. Readiness gate: bounded wait before asserting ----------------------
wait_ready() { # $1 base url, $2 probe path, $3 seconds
  local deadline=$(( $(date +%s) + $3 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -sf -m 3 -o /dev/null "$1$2" 2>/dev/null; then return 0; fi
    sleep 2
  done
  return 1
}

wait_ready "$CHAMBER_URL" "/" 90 \
  || fail "OpenChamber not ready at ${CHAMBER_URL} within 90s"
echo "PASS: OpenChamber ready at ${CHAMBER_URL}"

wait_ready "$ADMIN_URL" "/healthz" 90 \
  || fail "Admin not ready at ${ADMIN_URL}/healthz within 90s"
echo "PASS: Admin ready at ${ADMIN_URL}"

# --- 3. Resolve the effective password (server precedence, no hijack) ------
resolve_admin_password() {
  if [ -n "${ADMIN_PASSWORD_TEST:-}" ]; then
    printf '%s' "$ADMIN_PASSWORD_TEST"
    return 0
  fi
  docker exec ai-engkit-admin-v2dev sh -c '
    if [ "$OMO_ENABLED" = "0" ]; then files="/opt/ai-engkit/.env.v2"; else files="/opt/ai-engkit/.env"; fi
    for f in $files; do
      if [ -f "$f" ]; then
        v="$(sed -n "s/^ADMIN_PASSWORD=//p" "$f" | tail -1)"
        [ -n "$v" ] && { printf "%s" "$v"; exit 0; }
      fi
    done
    printf "%s" "$ADMIN_PASSWORD"
  '
}

ADMIN_PASSWORD="$(resolve_admin_password)" \
  || fail "could not read the effective admin password (set ADMIN_PASSWORD_TEST to override explicitly)"
[ -n "$ADMIN_PASSWORD" ] \
  || fail "effective admin password resolved empty (set ADMIN_PASSWORD_TEST to override explicitly)"

# --- 4. Assertions, each with status + body diagnostics on failure ---------
curl -fsS --max-time 10 "$CHAMBER_URL/" -o "$TMP_DIR/openchamber.html" \
  || fail "OpenChamber UI fetch failed at ${CHAMBER_URL}/ (body: $(head -c 300 "$TMP_DIR/openchamber.html" 2>/dev/null))"
echo "PASS: V2 OpenChamber UI responds"

curl -fsS --max-time 10 "$ADMIN_URL/healthz" -o "$TMP_DIR/admin-health.json" \
  || fail "Admin /healthz fetch failed (body: $(cat "$TMP_DIR/admin-health.json" 2>/dev/null))"
jq -e '.status == "ok"' "$TMP_DIR/admin-health.json" >/dev/null \
  || fail "Admin /healthz payload unexpected: $(cat "$TMP_DIR/admin-health.json")"
echo "PASS: V2 Admin health endpoint responds"

curl -fsS --max-time 10 "$ADMIN_URL/login" -o "$TMP_DIR/admin-login.html" \
  || fail "Admin /login fetch failed"
grep -qi "AI-EngKit Admin" "$TMP_DIR/admin-login.html" \
  || fail "Admin login page does not render AI-EngKit Admin"
echo "PASS: V2 Admin login page renders"

jq -nc --arg pw "$ADMIN_PASSWORD" '{password:$pw}' > "$TMP_DIR/login-body.json"
LOGIN_STATUS="$(curl -sS --max-time 10 -o "$TMP_DIR/login.json" -c "$TMP_DIR/cookies" \
  -H 'Content-Type: application/json' --data-binary @"$TMP_DIR/login-body.json" \
  -w '%{http_code}' "$ADMIN_URL/api/login")" || LOGIN_STATUS="000"
[ "$LOGIN_STATUS" = "200" ] \
  || fail "login rejected (status=${LOGIN_STATUS}, body: $(cat "$TMP_DIR/login.json" 2>/dev/null))"
jq -e '.ok == true' "$TMP_DIR/login.json" >/dev/null \
  || fail "login returned 200 with unexpected body: $(cat "$TMP_DIR/login.json")"
echo "PASS: V2 Admin login authenticates"

curl -fsS --max-time 20 -b "$TMP_DIR/cookies" "$ADMIN_URL/api/status" -o "$TMP_DIR/status.json" \
  || fail "GET /api/status failed (body: $(cat "$TMP_DIR/status.json" 2>/dev/null))"
jq -e '.containers["ai-dev"].status == "running" and .containers["ai-admin"].status == "running"' \
  "$TMP_DIR/status.json" >/dev/null \
  || fail "/api/status containers not both running: $(cat "$TMP_DIR/status.json")"
echo "PASS: V2 Admin status sees both running containers"

curl -fsS --max-time 30 -b "$TMP_DIR/cookies" "$ADMIN_URL/api/providers" -o "$TMP_DIR/providers.json" \
  || fail "GET /api/providers failed (body: $(cat "$TMP_DIR/providers.json" 2>/dev/null))"
jq -e 'type == "object" and (.providers | type == "array")' "$TMP_DIR/providers.json" >/dev/null \
  || fail "/api/providers payload unexpected: $(cat "$TMP_DIR/providers.json")"
echo "PASS: V2 Admin providers endpoint returns metadata"
