#!/usr/bin/env bash
set -euo pipefail
OMO_FILE="$HOME/.omo/omo.jsonc"
ROUTING_FILE="$HOME/.config/opencode/routing.json"
OPENCODE_FILE="$HOME/.config/opencode/opencode.json"
if [ ! -f "$OMO_FILE" ]; then
  echo "[migrate-omo] no OMO config to migrate ($OMO_FILE missing), skipping" >&2
  exit 0
fi
if [ -f "$ROUTING_FILE" ] && jq -e '.chains | length > 0' "$ROUTING_FILE" >/dev/null 2>&1; then
  echo "[migrate-omo] routing already present ($ROUTING_FILE has chains), skipping migration" >&2
  exit 0
fi
if ! jq -e '.' "$OMO_FILE" >/dev/null 2>&1; then
  echo "[migrate-omo] invalid OMO JSON ($OMO_FILE), skipping migration" >&2
  exit 0
fi
mkdir -p "$(dirname "$ROUTING_FILE")" "$(dirname "$OPENCODE_FILE")"
TMP_ROUTING="$(mktemp "${ROUTING_FILE}.tmp.XXXXXX")"
TMP_OPENCODE="$(mktemp "${OPENCODE_FILE}.tmp.XXXXXX")"
cleanup() { rm -f "$TMP_ROUTING" "$TMP_OPENCODE"; }
trap cleanup EXIT
if ! jq -s '
  .[0] as $omo |
  {
    version: 1,
    defaults: { cooldownSeconds: 60, maxFallbackAttempts: 3, notifyOnFallback: false },
    chains: (
      reduce ($omo.agents // {} | to_entries[]) as $e ({};
        if ($e.value.model | type) == "string" and ($e.value.model | test("^[^/[:space:]]+/[^[:space:]]+$"))
        then .[$e.key] = { chain: [ { model: $e.value.model } + (if ($e.value.variant | type) == "string" and ($e.value.variant | length) > 0 then { variant: $e.value.variant } else {} end) ] }
        else .
        end
      )
    )
  }
' "$OMO_FILE" > "$TMP_ROUTING" 2>/dev/null; then
  echo "[migrate-omo] jq routing build failed, aborting migration" >&2
  exit 0
fi
if [ ! -s "$TMP_ROUTING" ]; then
  echo "[migrate-omo] empty routing output, aborting" >&2
  exit 0
fi
chmod 600 "$TMP_ROUTING"
if ! mv "$TMP_ROUTING" "$ROUTING_FILE"; then
  echo "[migrate-omo] failed to move routing file" >&2
  exit 0
fi
trap - EXIT
echo "[migrate-omo] routing migrated to $ROUTING_FILE" >&2
if [ -f "$OPENCODE_FILE" ]; then
  cp "$OPENCODE_FILE" "$TMP_OPENCODE" 2>/dev/null || echo '{}' > "$TMP_OPENCODE"
else
  echo '{}' > "$TMP_OPENCODE"
fi
MIGRATED=0
for agent in $(jq -r '.chains | keys[]' "$ROUTING_FILE" 2>/dev/null); do
  model=$(jq -r --arg a "$agent" '.chains[$a].chain[0].model // empty' "$ROUTING_FILE" 2>/dev/null)
  variant=$(jq -r --arg a "$agent" '.chains[$a].chain[0].variant // empty' "$ROUTING_FILE" 2>/dev/null)
  if [ -z "$model" ]; then continue; fi
  TMP2="$(mktemp "${OPENCODE_FILE}.head.XXXXXX")"
  if [ -n "$variant" ]; then
    if jq --arg agent "$agent" --arg model "$model" --arg variant "$variant" '.agent[$agent].model = $model | .agent[$agent].variant = $variant' "$TMP_OPENCODE" > "$TMP2" 2>/dev/null; then
      chmod 600 "$TMP2" && mv "$TMP2" "$TMP_OPENCODE" && MIGRATED=$((MIGRATED+1))
    else
      rm -f "$TMP2"
      echo "[migrate-omo] warning: failed to seed head for $agent" >&2
    fi
  else
    if jq --arg agent "$agent" --arg model "$model" '.agent[$agent].model = $model | del(.agent[$agent].variant)' "$TMP_OPENCODE" > "$TMP2" 2>/dev/null; then
      chmod 600 "$TMP2" && mv "$TMP2" "$TMP_OPENCODE" && MIGRATED=$((MIGRATED+1))
    else
      rm -f "$TMP2"
      echo "[migrate-omo] warning: failed to seed head for $agent" >&2
    fi
  fi
done
if [ "$MIGRATED" -gt 0 ]; then
  chmod 600 "$TMP_OPENCODE"
  mv "$TMP_OPENCODE" "$OPENCODE_FILE"
  echo "[migrate-omo] seeded $MIGRATED opencode.json heads from routing" >&2
else
  rm -f "$TMP_OPENCODE"
  echo "[migrate-omo] no heads to seed" >&2
fi
if jq -e '.agents | to_entries[] | select(.value | has("models") or has("fallback_models"))' "$OMO_FILE" >/dev/null 2>&1; then
  echo "[migrate-omo] ignored OMO chain keys (models/fallback_models) for some agents — chain config was not effective on V1 per knowledge pattern" >&2
fi
echo "[migrate-omo] OMO volume retained for rollback; prune with: docker volume rm omo-config-v2 (after verifying routing)" >&2
exit 0
