#!/usr/bin/env bash

# Ensure the OpenChamber settings file carries our defaults: a defaultModel so
# new sessions use the intended model (opencode/big-pickle), an optional
# defaultAgent so new sessions use the intended agent (exact /agent name),
# and update notifications off (showOpenCodeUpdateNotifications: false) so
# OpenChamber does not surface OpenCode update banners out of the box.
#
# - Missing file (first boot): seed a fresh settings.json with the keys.
# - Existing file WITHOUT a key (e.g. settings predating the seed logic in
#   02-init-config.sh): backfill just the missing key(s), preserving
#   everything else in the file.
# - Existing file WITH the keys: untouched — a user-chosen value must win.
# - Symlinked file: skipped, never replaced.
# - Empty default_agent argument: agent seed/backfill skipped entirely, so
#   callers that have no opinion (e.g. the OMO line) change nothing.
#
# Always fails soft: a settings issue must not block container startup.
ensure_openchamber_default_settings() {
  local settings_file="$1"
  local default_model="$2"
  local default_agent="${3:-}"
  local temporary_file

  if [ ! -f "$settings_file" ]; then
    mkdir -p "$(dirname "$settings_file")"
    if [ -n "$default_agent" ]; then
      jq -n --arg model "$default_model" --arg agent "$default_agent" '{
        defaultAgent: $agent,
        defaultModel: $model,
        showOpenCodeUpdateNotifications: false
      }' > "$settings_file"
    else
      jq -n --arg model "$default_model" '{
        defaultModel: $model,
        showOpenCodeUpdateNotifications: false
      }' > "$settings_file"
    fi
    echo "Created default OpenChamber settings: $settings_file"
    return 0
  fi

  if [ -L "$settings_file" ]; then
    echo "Warning: OpenChamber settings backfill skipped; refusing to replace symlinked file" >&2
    return 0
  fi

  if [ -n "$default_agent" ]; then
    if jq -e 'has("defaultAgent") and has("defaultModel") and has("showOpenCodeUpdateNotifications")' "$settings_file" >/dev/null 2>&1; then
      return 0
    fi
  elif jq -e 'has("defaultModel") and has("showOpenCodeUpdateNotifications")' "$settings_file" >/dev/null 2>&1; then
    return 0
  fi

  temporary_file="$(mktemp "${settings_file}.tmp.XXXXXX")"
  if [ -n "$default_agent" ]; then
    if jq --arg model "$default_model" --arg agent "$default_agent" \
        '(.defaultAgent //= $agent) | (.defaultModel //= $model) | (.showOpenCodeUpdateNotifications //= false)' \
        "$settings_file" > "$temporary_file" 2>/dev/null; then
      mv "$temporary_file" "$settings_file"
      echo "Backfilled OpenChamber default settings (defaultAgent=$default_agent, defaultModel=$default_model, showOpenCodeUpdateNotifications=false): $settings_file"
    else
      rm -f "$temporary_file"
      echo "Warning: OpenChamber settings backfill skipped; $settings_file is not valid JSON" >&2
    fi
  elif jq --arg model "$default_model" \
      '(.defaultModel //= $model) | (.showOpenCodeUpdateNotifications //= false)' \
      "$settings_file" > "$temporary_file" 2>/dev/null; then
    mv "$temporary_file" "$settings_file"
    echo "Backfilled OpenChamber default settings (defaultModel=$default_model, showOpenCodeUpdateNotifications=false): $settings_file"
  else
    rm -f "$temporary_file"
    echo "Warning: OpenChamber settings backfill skipped; $settings_file is not valid JSON" >&2
  fi
}
