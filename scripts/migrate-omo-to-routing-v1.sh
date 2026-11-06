#!/usr/bin/env bash
set -euo pipefail

OMO_FILE="${HOME}/.omo/omo.jsonc"
CONFIG_DIR="${HOME}/.config/opencode"
ROUTING_FILE="${CONFIG_DIR}/routing.json"
OPENCODE_FILE="${CONFIG_DIR}/opencode.json"

mkdir -p "$CONFIG_DIR"
TMP_ROUTING="$(mktemp "${ROUTING_FILE}.tmp.XXXXXX")"
TMP_OPENCODE="$(mktemp "${OPENCODE_FILE}.tmp.XXXXXX")"
cleanup() { rm -f "$TMP_ROUTING" "$TMP_OPENCODE"; }
trap cleanup EXIT

if [[ ! -f "$OMO_FILE" ]]; then
  printf '[migrate-omo-v1] OMO config missing; skipping routing build (heads still sync below if routing exists)\n' >&2
fi

ROUTING_READY=0
if [[ -f "$ROUTING_FILE" ]] && jq -e '.chains | type == "object" and length > 0' "$ROUTING_FILE" >/dev/null 2>&1; then
  printf '[migrate-omo-v1] routing chains already exist; keeping them\n' >&2
  ROUTING_READY=1
elif ! jq -e 'type == "object"' "$OMO_FILE" >/dev/null 2>&1; then
  printf '[migrate-omo-v1] OMO config is invalid JSON and no routing exists; skipping\n' >&2
  exit 0
fi

if jq -e '.agents | type == "object" and any(.[]; type == "object" and (has("models") or has("fallback_models")))' "$OMO_FILE" >/dev/null 2>&1; then
  printf '[migrate-omo-v1] warning: ignoring OMO models/fallback_models; only model/variant are migrated\n' >&2
fi

# Phase 1: build routing.json from OMO only when no chains exist yet.
# (ROUTING_READY==1 means chains exist; skip straight to head sync.)
if [[ "$ROUTING_READY" -eq 0 ]]; then
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

  chmod 600 "$TMP_ROUTING"
  mv "$TMP_ROUTING" "$ROUTING_FILE"
  printf '[migrate-omo-v1] migrated routing chains\n' >&2
fi

# Phase 2: always sync native agent heads from the effective routing chains.
# opencode.json is regenerated from scratch on every boot, so heads must be
# re-seeded here even when routing already existed; otherwise agents lose
# their /agent model after any container recreate.
if [[ -f "$OPENCODE_FILE" ]] && jq -e 'type == "object"' "$OPENCODE_FILE" >/dev/null 2>&1; then
  cp "$OPENCODE_FILE" "$TMP_OPENCODE"
else
  printf '{}\n' >"$TMP_OPENCODE"
fi

if ! jq --slurpfile routing "$ROUTING_FILE" '
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

chmod 600 "$TMP_OPENCODE"
mv "$TMP_OPENCODE" "$OPENCODE_FILE"
trap - EXIT
printf '[migrate-omo-v1] seeded native agent heads\n' >&2
