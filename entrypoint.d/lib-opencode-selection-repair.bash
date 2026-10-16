#!/usr/bin/env bash
# lib-opencode-selection-repair.bash — narrow, atomic repair of a stale
# image-managed OpenChamber `opencodeBinary` selection (design D8).
#
# OpenChamber persists an optional absolute CLI path in
# ~/.config/openchamber/settings.json as `opencodeBinary`. A selection that
# survived a container recreate can point at a CLI the image no longer installs
# at that location. This library repairs ONLY the known image-managed or legacy
# paths to the current managed launcher:
#
#   * legacy standalone path  $HOME/.opencode/bin/opencode  (missing)
#   * compatibility wrapper   $HOME/.bun/bin/opencode       (missing)
#   * current managed launcher itself                       (missing)
#
# It writes atomically in the settings directory with a protected first-wins
# backup, preserves the file mode, every unrelated JSON value, and any valid
# custom selection. It refuses — without rewriting anything — a malformed JSON
# file, a symlinked settings file, an unknown missing custom path, and a custom
# executable that reports a non-v1 version.
#
# The managed launcher default is the image's stable PATH wrapper. Callers pass
# an explicit launcher as the second argument in tests to avoid touching /opt.

AI_ENGKIT_MANAGED_OPENCODE_BINARY_DEFAULT="/opt/ai-engkit/core/bin/opencode"
AI_ENGKIT_LEGACY_OPENCODE_BINARY_REL="/.opencode/bin/opencode"
AI_ENGKIT_COMPAT_OPENCODE_BINARY_REL="/.bun/bin/opencode"
AI_ENGKIT_SELECTION_BACKUP_SUFFIX=".ai-engkit-backup"

# Expand a leading `~` or `~/` against $HOME; leave everything else verbatim.
_opencode_selection_expand_tilde() {
  case "$1" in
    "~") printf '%s' "${HOME:-}" ;;
    "~/"*) printf '%s/%s' "${HOME:-}" "${1#~/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# Echo the major version an executable reports via `--version`, or nothing when
# it cannot be determined. This never opens session or database state.
_opencode_selection_detect_major() {
  local binary="$1" out version
  out="$(timeout 10 "$binary" --version 2>/dev/null | head -n 1 | tr -d '\r')" || true
  version="$(printf '%s\n' "$out" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1)"
  printf '%s' "${version%%.*}"
}

# Rewrite `opencodeBinary` to the managed launcher with a protected backup and a
# same-directory atomic replace, preserving the settings file's mode and every
# other key.
_opencode_selection_repair() {
  local settings_file="$1" managed_binary="$2"
  local backup_file="${settings_file}${AI_ENGKIT_SELECTION_BACKUP_SUFFIX}"
  local original_mode temporary_file

  if [[ ! -x "$managed_binary" ]]; then
    echo "[opencode-selection] ERROR: managed launcher missing or not executable: $managed_binary" >&2
    return 1
  fi

  if [[ -L "$backup_file" || ( -e "$backup_file" && ! -f "$backup_file" ) ]]; then
    echo "[opencode-selection] ERROR: refusing non-regular backup file: $backup_file" >&2
    return 1
  fi

  # Protected, first-wins backup: capture the original bytes before any write and
  # never overwrite an existing backup, so repeated boots do not stack backups.
  if [[ ! -e "$backup_file" ]]; then
    cp -p -- "$settings_file" "$backup_file"
  fi
  chmod 600 -- "$backup_file"

  original_mode="$(stat -c '%a' -- "$settings_file")"
  temporary_file="$(mktemp "${settings_file}.tmp-XXXXXX")"
  if ! jq --arg binary "$managed_binary" '.opencodeBinary = $binary' "$settings_file" > "$temporary_file"; then
    rm -f -- "$temporary_file"
    echo "[opencode-selection] ERROR: failed to rewrite settings JSON: $settings_file" >&2
    return 1
  fi
  chmod "$original_mode" -- "$temporary_file"
  chown --reference="$settings_file" -- "$temporary_file" 2>/dev/null || true
  mv -f -- "$temporary_file" "$settings_file"
  echo "[opencode-selection] repaired managed selection -> $managed_binary (backup: $backup_file)"
  return 0
}

# Repair a stale image-managed `opencodeBinary` selection in place. Returns 0 on
# success or when no repair is required, and 1 when startup must be refused.
ensure_managed_opencode_selection() {
  local settings_file="$1"
  local managed_binary="${2:-$AI_ENGKIT_MANAGED_OPENCODE_BINARY_DEFAULT}"
  local legacy_binary compat_binary stored configured major

  if [[ -n "${HOME:-}" ]]; then
    legacy_binary="$HOME$AI_ENGKIT_LEGACY_OPENCODE_BINARY_REL"
    compat_binary="$HOME$AI_ENGKIT_COMPAT_OPENCODE_BINARY_REL"
  else
    legacy_binary="$AI_ENGKIT_LEGACY_OPENCODE_BINARY_REL"
    compat_binary="$AI_ENGKIT_COMPAT_OPENCODE_BINARY_REL"
  fi

  # A missing settings file is a fresh install: OpenChamber uses managed PATH.
  if [[ ! -e "$settings_file" && ! -L "$settings_file" ]]; then
    echo "[opencode-selection] no settings file at $settings_file; using managed PATH lookup"
    return 0
  fi

  # Never replace a symlinked settings file or its target.
  if [[ -L "$settings_file" ]]; then
    echo "[opencode-selection] ERROR: refusing symlinked settings file: $settings_file" >&2
    return 1
  fi
  if [[ ! -f "$settings_file" ]]; then
    echo "[opencode-selection] ERROR: settings path is not a regular file: $settings_file" >&2
    return 1
  fi

  # Malformed JSON is preserved, never replaced.
  if ! jq -e 'type == "object"' "$settings_file" >/dev/null 2>&1; then
    echo "[opencode-selection] ERROR: refusing malformed settings JSON: $settings_file" >&2
    return 1
  fi

  # Unset, non-string, or empty selection uses managed PATH lookup.
  if ! jq -e 'has("opencodeBinary")' "$settings_file" >/dev/null 2>&1; then
    echo "[opencode-selection] selection unset; using managed PATH lookup"
    return 0
  fi
  if ! jq -e '.opencodeBinary | type == "string"' "$settings_file" >/dev/null 2>&1; then
    echo "[opencode-selection] selection is not a string; using managed PATH lookup"
    return 0
  fi

  stored="$(jq -r '.opencodeBinary' "$settings_file")"
  configured="$(_opencode_selection_expand_tilde "$stored" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  if [[ -z "$configured" ]]; then
    echo "[opencode-selection] selection empty; using managed PATH lookup"
    return 0
  fi

  # Known image-managed or legacy selections: leave when present, repair when
  # the path no longer exists.
  if [[ "$configured" == "$managed_binary" || "$configured" == "$compat_binary" || "$configured" == "$legacy_binary" ]]; then
    if [[ -x "$configured" ]]; then
      echo "[opencode-selection] managed selection present: $configured"
      return 0
    fi
    _opencode_selection_repair "$settings_file" "$managed_binary"
    return $?
  fi

  # Custom selection: never rewrite it. Refuse a missing path, a non-file, a
  # non-executable, or an executable that reports a non-v1 version.
  if [[ ! -e "$configured" ]]; then
    echo "[opencode-selection] ERROR: configured custom OpenCode CLI is missing and unrecognized: $stored" >&2
    echo "[opencode-selection] refusing to overwrite the selection; install the CLI or clear settings.opencodeBinary" >&2
    return 1
  fi
  if [[ ! -f "$configured" ]]; then
    echo "[opencode-selection] ERROR: configured OpenCode CLI is not a regular file: $stored" >&2
    return 1
  fi
  if [[ ! -x "$configured" ]]; then
    echo "[opencode-selection] ERROR: configured OpenCode CLI is not executable: $stored" >&2
    return 1
  fi
  major="$(_opencode_selection_detect_major "$configured")"
  if [[ -n "$major" && "$major" != "1" ]]; then
    echo "[opencode-selection] ERROR: configured custom OpenCode CLI reports a non-v1 version (${major}.x): $stored" >&2
    echo "[opencode-selection] the image-managed runtime requires the v1 CLI; refusing startup and preserving the selection" >&2
    return 1
  fi
  echo "[opencode-selection] valid custom selection preserved: $configured"
  return 0
}
