#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_HOME="$(mktemp -d)"
trap 'rm -rf "$TMP_HOME"' EXIT

mkdir -p "$TMP_HOME/.omo" "$TMP_HOME/.config/opencode"
cat > "$TMP_HOME/.omo/omo.jsonc" <<'JSON'
{
  "agents": {
    "general": { "model": "openai/gpt-test", "variant": "high" },
    "plan": { "model": "opencode/plan-test" },
    "sisyphus": { "models": [{ "model": "ignored/fallback" }] }
  }
}
JSON
cat > "$TMP_HOME/.config/opencode/opencode.json" <<'JSON'
{"plugin":[],"agent":{"custom":{"model":"keep/provider"}}}
JSON
cp "$TMP_HOME/.omo/omo.jsonc" "$TMP_HOME/omo.before"

HOME="$TMP_HOME" bash "$ROOT/scripts/migrate-omo-to-native.sh" >/dev/null 2>&1

jq -e '.version == 1 and .chains.general.chain == [{"model":"openai/gpt-test","variant":"high"}] and .chains.plan.chain == [{"model":"opencode/plan-test"}] and (.chains | has("sisyphus") | not)' "$TMP_HOME/.config/opencode/routing.json" >/dev/null
jq -e '.agent.general.model == "openai/gpt-test" and .agent.general.variant == "high" and .agent.plan.model == "opencode/plan-test" and .agent.custom.model == "keep/provider"' "$TMP_HOME/.config/opencode/opencode.json" >/dev/null
cmp -s "$TMP_HOME/omo.before" "$TMP_HOME/.omo/omo.jsonc"
cp "$TMP_HOME/.config/opencode/routing.json" "$TMP_HOME/routing.before"

# An existing native chain prevents a later startup from overwriting the import.
HOME="$TMP_HOME" bash "$ROOT/scripts/migrate-omo-to-native.sh" >/dev/null 2>&1
cmp -s "$TMP_HOME/routing.before" "$TMP_HOME/.config/opencode/routing.json"
echo "PASS: one-time OMO data import preserves source and native config"
