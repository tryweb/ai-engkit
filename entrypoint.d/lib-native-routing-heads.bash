#!/usr/bin/env bash

# Seed OpenCode's native agent model assignments from the authoritative routing
# chains after opencode.json is regenerated during container startup.
sync_native_routing_heads() {
  local opencode_config="$1"
  local routing_config="$2"
  local temporary_file="${opencode_config}.routing-heads.tmp"

  [ -f "$opencode_config" ] || return 0
  [ -f "$routing_config" ] || return 0
  jq -e '.version == 1 and (.chains | type == "object")' "$routing_config" >/dev/null 2>&1 || {
    echo "Warning: Native routing heads skipped; invalid routing configuration" >&2
    return 0
  }

  if ! jq --slurpfile routing "$routing_config" '
    . as $config |
    reduce ($routing[0].chains | to_entries[]) as $entry ($config;
      if (($entry.value.chain | type) == "array" and ($entry.value.chain | length) > 0) then
        .agent[$entry.key].model = $entry.value.chain[0].model |
        if ($entry.value.chain[0].variant | type) == "string" and ($entry.value.chain[0].variant | length) > 0
        then .agent[$entry.key].variant = $entry.value.chain[0].variant
        else del(.agent[$entry.key].variant) end
      else . end
    )
  ' "$opencode_config" > "$temporary_file" 2>/dev/null; then
    rm -f "$temporary_file"
    echo "Warning: Native routing heads skipped; could not update OpenCode config" >&2
    return 0
  fi

  mv "$temporary_file" "$opencode_config"
}
