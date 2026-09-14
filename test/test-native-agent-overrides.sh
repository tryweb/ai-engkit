#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/entrypoint.d/lib-native-agent-overrides.bash"

TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "PASS: $label"
  else
    fail "$label (expected='$expected', actual='$actual')"
  fi
}

base_config() {
  cat <<'EOF'
{"plugin":["oh-my-opencode-slim"],"mcp":{"codegraph":{"enabled":true}},"agent":{"reviewer":{"model":"opencode/reviewer"},"general":{"model":"ollama/old","variant":"low"}}}
EOF
}

opencode_config="$TEMP_DIR/opencode.json"
omo_config="$TEMP_DIR/oh-my-opencode-slim.json"

base_config > "$opencode_config"
cat > "$omo_config" <<'EOF'
{"agents":{"general":{"model":"opencode/big-pickle","variant":"high","permission":{"bash":"allow"}},"plan":{"model":"opencode/plan-model"},"build":{"model":"opencode/should-not-merge"},"explore":{"model":"opencode/also-not-native"}}}
EOF
merge_native_agent_overrides "$opencode_config" "$omo_config"
assert_eq "general model merged" "opencode/big-pickle" "$(jq -r '.agent.general.model' "$opencode_config")"
assert_eq "general variant merged" "high" "$(jq -r '.agent.general.variant' "$opencode_config")"
assert_eq "plan model merged" "opencode/plan-model" "$(jq -r '.agent.plan.model' "$opencode_config")"
assert_eq "unrelated OpenCode agent preserved" "opencode/reviewer" "$(jq -r '.agent.reviewer.model' "$opencode_config")"
assert_eq "non-allowlisted native agent ignored" "false" "$(jq 'has("agent") and (.agent | has("build"))' "$opencode_config")"
assert_eq "unrelated top-level config preserved" "true" "$(jq '.mcp.codegraph.enabled' "$opencode_config")"

base_config > "$opencode_config"
printf '{"agents":{"general":{"model":"opencode/big-pickle"}}}\n' > "$omo_config"
merge_native_agent_overrides "$opencode_config" "$omo_config"
assert_eq "missing variant removes stale variant" "false" "$(jq '.agent.general | has("variant")' "$opencode_config")"

base_config > "$opencode_config"
printf '{"agents":{"general":{}}}\n' > "$omo_config"
merge_native_agent_overrides "$opencode_config" "$omo_config"
assert_eq "cleared model removes native override" "false" "$(jq '.agent | has("general")' "$opencode_config")"

base_config > "$opencode_config"
printf '{"agents":{"general":{"model":"big-pickle"}}}\n' > "$omo_config"
merge_native_agent_overrides "$opencode_config" "$omo_config"
assert_eq "provider-less model is rejected" "false" "$(jq '.agent | has("general")' "$opencode_config")"

base_config > "$opencode_config"
printf '{"agents":{"general":{"model":"openrouter/dots-studio/dots-3-note-preview:free"}}}\n' > "$omo_config"
merge_native_agent_overrides "$opencode_config" "$omo_config"
assert_eq "org-scoped multi-slash model merged" "openrouter/dots-studio/dots-3-note-preview:free" "$(jq -r '.agent.general.model' "$opencode_config")"

base_config > "$opencode_config"
printf '{ invalid json\n' > "$omo_config"
before="$(sha256sum "$opencode_config")"
merge_native_agent_overrides "$opencode_config" "$omo_config"
assert_eq "invalid OMO config leaves OpenCode config unchanged" "$before" "$(sha256sum "$opencode_config")"

echo "PASS: native agent overrides are merged safely"
