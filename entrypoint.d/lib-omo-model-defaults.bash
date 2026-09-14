#!/usr/bin/env bash

normalize_omo_config() {
  local config_file="$1"
  [ -f "$config_file" ] || return 0

  local incompatible_path
  incompatible_path="$(jq -r '
    (.agents // {})
    | to_entries[]
    | .key as $agent
    | (.value.permission? // null) as $permission
    | if $permission == null then
        empty
      elif ($permission | type) != "object" then
        ".agents.\($agent).permission"
      else
        $permission
        | to_entries[]
        | select(
            (.key == "*" and .value != "allow")
            or (.key != "*" and (.value != "allow" and .value != "deny"))
          )
        | ".agents.\($agent).permission.\(.key)"
      end
  ' "$config_file" 2>/dev/null | head -n 1)"

  if [ -n "$incompatible_path" ]; then
    echo "Error: Cannot safely normalize unsupported OMO setting: $incompatible_path" >&2
    return 1
  fi

  local snapshot_file normalized_file
  snapshot_file="$(mktemp "${config_file}.normalize-backup.XXXXXX")"
  normalized_file="$(mktemp "${config_file}.normalize.XXXXXX")"
  cp -p "$config_file" "$snapshot_file"

  if ! jq '
    (.agents // {}) |= with_entries(
      .value |= (
        if has("permission") then
          (.permission | with_entries(select(.key != "*") | .value = (.value == "allow"))) as $converted
          | if ($converted | length) == 0 or ($converted | all(.[]; . == true)) then
              del(.permission)
            else
              .tools = ((.tools // {}) * $converted)
              | del(.permission)
            end
        else
          .
        end
        | if has("tools") and (.tools | type) == "object" and (.tools | all(.[]; . == true)) then
            del(.tools)
          else
            .
          end
      )
    )
    | if (.["[opencode]"]? | type) == "object" then
        .["[opencode]"] |= del(.agents)
        | if .["[opencode]"] == {} then del(.["[opencode]"]) else . end
      else
        .
      end
  ' "$snapshot_file" > "$normalized_file"; then
    rm -f "$snapshot_file" "$normalized_file"
    echo "Error: Failed to normalize OMO config: $config_file" >&2
    return 1
  fi

  chmod --reference="$config_file" "$normalized_file"
  if cmp -s "$config_file" "$normalized_file"; then
    rm -f "$snapshot_file" "$normalized_file"
    return 0
  fi

  if ! mv "$normalized_file" "$config_file"; then
    cp -p "$snapshot_file" "$config_file"
    rm -f "$snapshot_file" "$normalized_file"
    echo "Error: Failed to replace normalized OMO config: $config_file" >&2
    return 1
  fi

  rm -f "$snapshot_file"
  echo "Normalized OMO agent configuration: $config_file"
}

initialize_omo_permissions() {
  local config_file="$1"
  local defaults_file="$2"

  [ -f "$defaults_file" ] || return 0

  if [ -f "$config_file" ]; then
    if ! grep -q '"agents"' "$config_file"; then
      echo "Merging default OMO agent permissions into oh-my-opencode-slim.json"
      jq -s '.[0] * .[1]' "$defaults_file" "$config_file" > "${config_file}.tmp" \
        && mv "${config_file}.tmp" "$config_file"
    fi
  else
    echo "Creating oh-my-opencode-slim.json with default agent permissions"
    cp "$defaults_file" "$config_file"
  fi
}
