#!/usr/bin/env bash
# V1 only — on OMO_ENABLED=0 this file is not sourced (see 02-init-config.sh gating).

merge_native_agent_overrides() {
  local opencode_config="$1"
  local omo_config="$2"
  local temporary_file="${opencode_config}.native-agent-overrides.tmp"

  [ -f "$opencode_config" ] || return 0
  [ -f "$omo_config" ] || return 0

  if ! jq -s '
    .[0] as $opencode
    | .[1] as $omo
     | reduce ["general", "plan"][] as $name ($opencode;
        ($omo.agents[$name] // {}) as $override
        | if (        ($override.model | type) == "string"
              and ($override.model | test("^[^/[:space:]]+/[^[:space:]]+$"))) then
            .agent = (.agent // {})
            | .agent[$name].model = $override.model
            | if (($override.variant | type) == "string" and ($override.variant | length) > 0) then
                .agent[$name].variant = $override.variant
              else
                del(.agent[$name].variant)
              end
          else
            del(.agent[$name])
          end
      )
  ' "$opencode_config" "$omo_config" > "$temporary_file" 2>/dev/null; then
    rm -f "$temporary_file"
    echo "Warning: Native agent overrides skipped; invalid configuration" >&2
    return 0
  fi

  mv "$temporary_file" "$opencode_config"
}
