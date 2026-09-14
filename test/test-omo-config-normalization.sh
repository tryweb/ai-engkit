#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/entrypoint.d/lib-omo-model-defaults.bash"

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

config="$TEMP_DIR/oh-my-opencode-slim.json"
defaults="$ROOT_DIR/.opencode/oh-my-opencode-slim.json.default"

assert_eq "shipped defaults have no permission keys" "0" "$(jq '[.agents, .presets | .. | objects | select(has("permission"))] | length' "$defaults")"
assert_eq "shipped defaults have no tools blocks" "0" "$(jq '[.agents, .presets | .. | objects | select(has("tools"))] | length' "$defaults")"
assert_eq "shipped defaults have no stale migration agent layer" "false" "$(jq '.["[opencode]"] | type == "object" and has("agents")' "$defaults")"
assert_eq "shipped defaults pin the opencode-go preset" "opencode-go" "$(jq -r '.preset // empty' "$defaults")"

cat > "$config" <<'EOF'
{
  "$schema": "schema-v1",
  "custom": { "preserved": true },
  "agents": {
    "librarian": {
      "model": "opencode/nemotron-3.5-lightning-free",
      "description": "keep me",
      "permission": {
        "bash": "deny",
        "read": "allow",
        "webfetch": "allow"
      }
    },
    "sisyphus": {
      "permission": { "*": "allow" }
    },
    "atlas": {
      "permission": {
        "read": "allow",
        "bash": "allow",
        "edit": "allow",
        "write": "allow"
      }
    },
    "hephaestus": {
      "tools": {
        "read": true,
        "bash": true,
        "edit": true,
        "write": true
      }
    }
  },
  "[opencode]": {
    "agents": {
      "librarian": { "model": "opencode/deepseek-v4-flash" }
    },
    "categories": { "visual-engineering": { "model": "openai/gpt-5.6" } }
  }
}
EOF

normalize_omo_config "$config"
assert_eq "top-level model preserved" "opencode/nemotron-3.5-lightning-free" "$(jq -r '.agents.librarian.model' "$config")"
assert_eq "known deny permission converted" "false" "$(jq -r '.agents.librarian.tools.bash' "$config")"
assert_eq "known allow permission converted" "true" "$(jq -r '.agents.librarian.tools.read' "$config")"
assert_eq "additional tool permission converted" "true" "$(jq -r '.agents.librarian.tools.webfetch' "$config")"
assert_eq "permission removed after conversion" "false" "$(jq '.agents.librarian | has("permission")' "$config")"
assert_eq "redundant allow-all permission removed" "false" "$(jq '.agents.sisyphus | has("permission")' "$config")"
assert_eq "direct allow-all permission does not create tools" "false" "$(jq '.agents.atlas | has("tools")' "$config")"
assert_eq "pre-existing allow-all tools are removed" "false" "$(jq '.agents.hephaestus | has("tools")' "$config")"
assert_eq "stale migration agent layer removed" "false" "$(jq '.["[opencode]"] | has("agents")' "$config")"
assert_eq "unrelated migration settings preserved" "openai/gpt-5.6" "$(jq -r '.["[opencode]"].categories["visual-engineering"].model' "$config")"
assert_eq "unrelated top-level settings preserved" "true" "$(jq -r '.custom.preserved' "$config")"
assert_eq "schema preserved" "schema-v1" "$(jq -r '.["$schema"]' "$config")"

before_second_run="$(sha256sum "$config")"
normalize_omo_config "$config"
assert_eq "normalization is byte-idempotent" "$before_second_run" "$(sha256sum "$config")"

cat > "$config" <<'EOF'
{
  "agents": {
    "oracle": {
      "model": "openai/gpt-5.6-sol",
      "permission": {
        "external_directory": { "*": "allow" }
      }
    }
  }
}
EOF

unsupported_before="$(sha256sum "$config")"
if error_output="$(normalize_omo_config "$config" 2>&1)"; then
  fail "unsupported permission shape must fail normalization"
fi
assert_eq "unsupported permission leaves file byte-identical" "$unsupported_before" "$(sha256sum "$config")"
case "$error_output" in
  *'.agents.oracle.permission.external_directory'*) echo "PASS: incompatible path reported" ;;
  *) fail "incompatible path missing from error: $error_output" ;;
esac

cat > "$config" <<'EOF'
{"agents":{"oracle":{"permission":{"*":"deny","read":"allow"}}}}
EOF
deny_all_before="$(sha256sum "$config")"
if normalize_omo_config "$config" >/dev/null 2>&1; then
  fail "deny-all wildcard must not be weakened"
fi
assert_eq "deny-all wildcard remains byte-identical" "$deny_all_before" "$(sha256sum "$config")"

echo "PASS: OMO config normalization is safe and idempotent"
