#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/entrypoint.d/lib-native-routing-heads.bash"

TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

opencode_config="$TEMP_DIR/opencode.json"
routing_config="$TEMP_DIR/routing.json"
omo_config="$TEMP_DIR/omo.jsonc"

cat > "$opencode_config" <<'JSON'
{"agent":{"general":{"model":"old/general"},"reviewer":{"model":"custom/reviewer"}},"mcp":{"enabled":true}}
JSON
cat > "$routing_config" <<'JSON'
{"version":1,"chains":{"general":{"chain":[{"model":"native/general","variant":"high"}]},"plan":{"chain":[{"model":"native/planner"}]},"explore":{"chain":[{"model":"native/explorer"}]}}}
JSON
cat > "$omo_config" <<'JSON'
{"agents":{"general":{"model":"legacy/omo"},"plan":{"model":"legacy/plan"}}}
JSON

sync_native_routing_heads "$opencode_config" "$routing_config"

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" != "$actual" ]; then
    echo "FAIL: $label (expected='$expected', actual='$actual')" >&2
    exit 1
  fi
  echo "PASS: $label"
}

assert_eq "routing is authoritative over legacy OMO" "native/general" "$(jq -r '.agent.general.model' "$opencode_config")"
assert_eq "routing variant is copied" "high" "$(jq -r '.agent.general.variant' "$opencode_config")"
assert_eq "all native chain heads are seeded" "native/explorer" "$(jq -r '.agent.explore.model' "$opencode_config")"
assert_eq "custom OpenCode agent is preserved" "custom/reviewer" "$(jq -r '.agent.reviewer.model' "$opencode_config")"
assert_eq "unrelated config is preserved" "true" "$(jq -r '.mcp.enabled' "$opencode_config")"
assert_eq "legacy OMO value is not applied" "native/general" "$(jq -r '.agent.general.model' "$opencode_config")"

cat > "$routing_config" <<'JSON'
{"version":1,"chains":{"general":{"chain":[{"model":"native/general-next"}]}}}
JSON
cat > "$opencode_config" <<'JSON'
{"agent":{},"mcp":{"enabled":true}}
JSON
sync_native_routing_heads "$opencode_config" "$routing_config"
assert_eq "removed routing chain does not retain stale model" "false" "$(jq '.agent | has("plan")' "$opencode_config")"

echo "PASS: native routing heads sync safely"
