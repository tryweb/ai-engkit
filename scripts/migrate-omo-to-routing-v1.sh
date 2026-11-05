#!/usr/bin/env bash
set -euo pipefail

OMO_FILE="${HOME}/.omo/omo.jsonc"
CONFIG_DIR="${HOME}/.config/opencode"
ROUTING_FILE="${CONFIG_DIR}/routing.json"
OPENCODE_FILE="${CONFIG_DIR}/opencode.json"

if [[ ! -f "$OMO_FILE" ]]; then
  printf '[migrate-omo-v1] OMO config missing; skipping\n' >&2
  exit 0
fi

if [[ -f "$ROUTING_FILE" ]] && jq -e '.chains | type == "object" and length > 0' "$ROUTING_FILE" >/dev/null 2>&1; then
  printf '[migrate-omo-v1] routing chains already exist; skipping\n' >&2
  exit 0
fi

if ! jq -e 'type == "object"' "$OMO_FILE" >/dev/null 2>&1; then
  printf '[migrate-omo-v1] OMO config is invalid JSON; skipping\n' >&2
  exit 0
fi

if jq -e '.agents | type == "object" and any(.[]; type == "object" and (has("models") or has("fallback_models")))' "$OMO_FILE" >/dev/null 2>&1; then
  printf '[migrate-omo-v1] warning: ignoring OMO models/fallback_models; only model/variant are migrated\n' >&2
fi

mkdir -p "$CONFIG_DIR"
TMP_ROUTING="$(mktemp "${ROUTING_FILE}.tmp.XXXXXX")"
TMP_OPENCODE="$(mktemp "${OPENCODE_FILE}.tmp.XXXXXX")"
cleanup() { rm -f "$TMP_ROUTING" "$TMP_OPENCODE"; }
trap cleanup EXIT

if ! jq '
  . as $omo |
  {
    version: 1,
    defaults: {cooldownSeconds: 60, maxFallbackAttempts: 3, notifyOnFallback: false},
    chains: (
      reduce (($omo.agents // {}) | to_entries[]) as $entry ({};
        if (($entry.value.model | type) == "string"
            and ($entry.value.model | test("^[^/[:space:]]+/[^[:space:]]+$")))
        then .[$entry.key] = {chain: ([{model: $entry.value.model} +
          (if ($entry.value.variant | type) == "string" and ($entry.value.variant | length) > 0
           then {variant: $entry.value.variant} else {} end)])}
        else . end
      )
    )
  }
' "$OMO_FILE" >"$TMP_ROUTING" 2>/dev/null; then
  printf '[migrate-omo-v1] could not build routing config; skipping\n' >&2
  exit 0
fi

if [[ ! -s "$TMP_ROUTING" ]] || ! jq -e '.chains | type == "object"' "$TMP_ROUTING" >/dev/null 2>&1; then
  printf '[migrate-omo-v1] routing output invalid; skipping\n' >&2
  exit 0
fi

if [[ -f "$OPENCODE_FILE" ]] && jq -e 'type == "object"' "$OPENCODE_FILE" >/dev/null 2>&1; then
  cp "$OPENCODE_FILE" "$TMP_OPENCODE"
else
  printf '{}\n' >"$TMP_OPENCODE"
fi

if ! jq --slurpfile routing "$TMP_ROUTING" '
  . as $config |
  reduce ($routing[0].chains | to_entries[]) as $entry ($config;
    .agent[$entry.key].model = $entry.value.chain[0].model |
    if ($entry.value.chain[0] | has("variant"))
    then .agent[$entry.key].variant = $entry.value.chain[0].variant
    else del(.agent[$entry.key].variant) end
  )
' "$TMP_OPENCODE" >"${TMP_OPENCODE}.next" 2>/dev/null; then
  printf '[migrate-omo-v1] could not seed native agent heads; skipping\n' >&2
  exit 0
fi
mv "${TMP_OPENCODE}.next" "$TMP_OPENCODE"

chmod 600 "$TMP_ROUTING" "$TMP_OPENCODE"
mv "$TMP_ROUTING" "$ROUTING_FILE"
mv "$TMP_OPENCODE" "$OPENCODE_FILE"
trap - EXIT
printf '[migrate-omo-v1] migrated routing chains and native agent heads\n' >&2
