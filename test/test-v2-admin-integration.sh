#!/usr/bin/env bash
set -euo pipefail

CHAMBER_URL="${CHAMBER_V2_URL:-http://localhost:8003}"
ADMIN_URL="${ADMIN_V2_URL:-http://localhost:8083}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-testadmin123}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

curl -fsS --max-time 10 "$CHAMBER_URL/" -o "$TMP_DIR/openchamber.html"
echo "PASS: V2 OpenChamber UI responds"

curl -fsS --max-time 10 "$ADMIN_URL/healthz" -o "$TMP_DIR/admin-health.json"
jq -e '.status == "ok"' "$TMP_DIR/admin-health.json" >/dev/null
echo "PASS: V2 Admin health endpoint responds"

curl -fsS --max-time 10 "$ADMIN_URL/login" -o "$TMP_DIR/admin-login.html"
grep -qi "AI-EngKit Admin" "$TMP_DIR/admin-login.html"
echo "PASS: V2 Admin login page renders"

LOGIN_STATUS="$(curl -sS --max-time 10 -o "$TMP_DIR/login.json" -c "$TMP_DIR/cookies" \
  -H 'Content-Type: application/json' \
  -d "{\"password\":\"${ADMIN_PASSWORD}\"}" \
  -w '%{http_code}' "$ADMIN_URL/api/login")"
test "$LOGIN_STATUS" = "200"
jq -e '.ok == true' "$TMP_DIR/login.json" >/dev/null
echo "PASS: V2 Admin login authenticates"

curl -fsS --max-time 20 -b "$TMP_DIR/cookies" "$ADMIN_URL/api/status" -o "$TMP_DIR/status.json"
jq -e '.containers["ai-dev"].status == "running" and .containers["ai-admin"].status == "running"' \
  "$TMP_DIR/status.json" >/dev/null
echo "PASS: V2 Admin status sees both running containers"

curl -fsS --max-time 30 -b "$TMP_DIR/cookies" "$ADMIN_URL/api/providers" -o "$TMP_DIR/providers.json"
jq -e 'type == "object" and (.providers | type == "array")' "$TMP_DIR/providers.json" >/dev/null
echo "PASS: V2 Admin providers endpoint returns metadata"
