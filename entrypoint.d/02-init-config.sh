#!/usr/bin/env bash
set -euo pipefail

OPCODE_CONFIG_DIR="$HOME/.config/opencode"
OPENCHAMBER_DATA_DIR="${OPENCHAMBER_DATA_DIR:-$HOME/.config/openchamber}"
WORKSPACE_DIR="${WORKSPACE_DIR:-$HOME/workspace}"
PROJECT_OPENCODE_DIR="$WORKSPACE_DIR/.opencode"
PROJECT_LSP_CONFIG_FILE="$PROJECT_OPENCODE_DIR/lsp.json"
DEFAULT_LSP_CONFIG_FILE="/etc/opencode/lsp.json.default"

init_file() {
  local file="$1"
  local content="$2"
  if [ ! -f "$file" ]; then
    echo "Creating default: $file"
    echo "$content" > "$file"
  fi
}

merge_project_lsp_config() {
  if [ ! -f "$DEFAULT_LSP_CONFIG_FILE" ]; then
    return 0
  fi

  mkdir -p "$PROJECT_OPENCODE_DIR"

  if [ ! -f "$PROJECT_LSP_CONFIG_FILE" ]; then
    cp "$DEFAULT_LSP_CONFIG_FILE" "$PROJECT_LSP_CONFIG_FILE"
    echo "Creating default: $PROJECT_LSP_CONFIG_FILE"
    return 0
  fi

  local merged_file
  merged_file="$(mktemp)"

  if jq -s '.[0] * .[1]' "$DEFAULT_LSP_CONFIG_FILE" "$PROJECT_LSP_CONFIG_FILE" > "$merged_file"; then
    mv "$merged_file" "$PROJECT_LSP_CONFIG_FILE"
    echo "Merged default Markdown LSP config into: $PROJECT_LSP_CONFIG_FILE"
  else
    rm -f "$merged_file"
    echo "Warning: Failed to merge $PROJECT_LSP_CONFIG_FILE with defaults" >&2
    return 1
  fi
}

plugin_dependency_name() {
  local plugin="$1"
  if [[ "$plugin" == @* ]]; then
    local scoped="${plugin#@}"
    local scope="${scoped%%/*}"
    local package="${scoped#*/}"
    package="${package%%@*}"
    printf '@%s/%s\n' "$scope" "$package"
  else
    printf '%s\n' "${plugin%%@*}"
  fi
}

expected_plugin_names() {
  local plugins="$1"
  local plugin
  echo "$plugins" | tr ',' '\n' | while IFS= read -r plugin; do
    plugin="${plugin//[[:space:]]/}"
    if [ -n "$plugin" ]; then
      plugin_dependency_name "$plugin"
    fi
  done | sort | tr '\n' ','
}

link_superpowers_skills() {
  local cache_dir="$1"
  local skills_root="$2"

  if [ ! -d "$cache_dir" ]; then
    return 1
  fi

  local skills_dir=""
  skills_dir=$(find "$cache_dir" -path "*/node_modules/superpowers/skills" -type d 2>/dev/null | head -1 || true)
  if [ -z "$skills_dir" ] || [ ! -d "$skills_dir" ]; then
    return 1
  fi

  mkdir -p "$skills_root"
  local linked=0
  local skill_dir
  while IFS= read -r skill_dir; do
    local skill_name="${skill_dir##*/}"
    local target="$skills_root/$skill_name"

    if [ -L "$target" ]; then
      if [ "$(readlink "$target")" = "$skill_dir" ] && [ -f "$target/SKILL.md" ]; then
        linked=$((linked + 1))
        continue
      fi
      rm -f "$target"
    elif [ -e "$target" ]; then
      echo "Skipping Superpowers skill '$skill_name'; $target already exists"
      continue
    fi

    ln -s "$skill_dir" "$target"
    echo "Superpowers skill symlinked: $target -> $skill_dir"
    linked=$((linked + 1))
  done < <(find "$skills_dir" -mindepth 1 -maxdepth 1 -type d -exec test -f '{}/SKILL.md' ';' -print | sort)

  [ "$linked" -gt 0 ]
}

# --- lean-ctx XDG migration (v3.8.5+) ---
# Detect legacy single-dir layout (~/.config/lean-ctx with data files)
# and migrate to XDG split (config→XDG_CONFIG_HOME, data→XDG_DATA_HOME, …).
# The migration is crash-safe (atomic rename, idempotent, no clobber).
if command -v lean-ctx &>/dev/null; then
  if [ -d "$HOME/.config/lean-ctx/sessions" ] || [ -d "$HOME/.config/lean-ctx/vectors" ]; then
    echo "Detected legacy lean-ctx single-dir layout; migrating to XDG Base Directory..."
    lean-ctx doctor --fix 2>/dev/null || true
  fi
fi

# --- OpenCode config ---
mkdir -p "$OPCODE_CONFIG_DIR"
OPCODE_CONFIG_FILE="$OPCODE_CONFIG_DIR/opencode.json"

# Always regenerate opencode.json from OPENCODE_PLUGINS to ensure consistency
PLUGINS="${OPENCODE_PLUGINS:-oh-my-openagent}"
PLUGIN_JSON=$(echo "$PLUGINS" | tr ',' '\n' | jq -R . | jq -s .)
OPCODE_CONFIG=$(jq -n \
  --argjson plugins "$PLUGIN_JSON" \
  --arg playwright_version "${PLAYWRIGHT_VERSION}" \
  --arg playwright_mcp_version "${PLAYWRIGHT_MCP_VERSION}" \
  '{
    "$schema": "https://opencode.ai/config.json",
    autoupdate: false,
    plugin: $plugins,
    server: {
      port: 4095,
      hostname: "0.0.0.0"
    },
    lsp: {
      marksman: {
        command: ["marksman", "server"],
        extensions: [".md", ".markdown"]
      }
    },
    mcp: {
      codegraph: {
        type: "local",
        command: ["codegraph", "serve", "--mcp"],
        enabled: true
      },
      playwright: {
        type: "local",
        command: ["pw-mcp"],
        enabled: true
      },
      "lean-ctx": {
        type: "local",
        command: ["lean-ctx"],
        enabled: true
      }
    }
  }')
echo "Updating opencode.json with plugins: $PLUGINS"
echo "$OPCODE_CONFIG" > "$OPCODE_CONFIG_FILE"

if command -v lean-ctx &>/dev/null; then
  if ! grep -qF 'lean-ctx shell hook' "$HOME/.bashrc" 2>/dev/null; then
    lean-ctx setup --non-interactive --yes >/dev/null 2>&1 || true
  fi

  if [ ! -f "$OPCODE_CONFIG_DIR/skills/lean-ctx/SKILL.md" ]; then
    lean-ctx init --agent opencode >/dev/null 2>&1 || true
  fi
fi

merge_project_lsp_config

OPENCODE_CACHE_PKG="$HOME/.cache/opencode/packages"
if [ -f "$OPENCODE_CACHE_PKG/package.json" ]; then
  CACHED_PKGS=$(jq -r '.dependencies | keys | join(",")' "$OPENCODE_CACHE_PKG/package.json" 2>/dev/null || echo "")
  EXPECTED_PKGS=$(expected_plugin_names "$PLUGINS")
  CACHED_SORTED=$(expected_plugin_names "$CACHED_PKGS")
  if [ "$CACHED_SORTED" != "$EXPECTED_PKGS" ]; then
    echo "Stale plugin cache detected ($CACHED_PKGS), removing..."
    rm -rf "$OPENCODE_CACHE_PKG/node_modules" "$OPENCODE_CACHE_PKG/package.json" "$OPENCODE_CACHE_PKG/bun.lock"
  fi
fi

# Workaround for opencode#20940: plugin config() hook mutations are invisible to skill discovery.
# Symlinks ensure superpowers skills are found via global scan path in all projects.
SKILLS_ROOT="$OPCODE_CONFIG_DIR/skills"
BAKED_SUPERPOWERS="/opt/opencode/baked-plugins/superpowers"

link_superpowers_skills() {
  local cache_dir="$1"
  local skills_root="$2"

  if [ ! -d "$cache_dir" ]; then
    return 1
  fi

  local skills_dir=""
  skills_dir=$(find "$cache_dir" -path "*/node_modules/superpowers/skills" -type d 2>/dev/null | head -1 || true)
  if [ -z "$skills_dir" ] || [ ! -d "$skills_dir" ]; then
    return 1
  fi

  mkdir -p "$skills_root"
  local linked=0
  local skill_dir
  while IFS= read -r skill_dir; do
    local skill_name="${skill_dir##*/}"
    local target="$skills_root/$skill_name"

    if [ -L "$target" ]; then
      if [ "$(readlink "$target")" = "$skill_dir" ] && [ -f "$target/SKILL.md" ]; then
        linked=$((linked + 1))
        continue
      fi
      rm -f "$target"
    elif [ -e "$target" ]; then
      echo "Skipping Superpowers skill '$skill_name'; $target already exists"
      continue
    fi

    ln -s "$skill_dir" "$target"
    echo "Superpowers skill symlinked: $target -> $skill_dir"
    linked=$((linked + 1))
  done < <(find "$skills_dir" -mindepth 1 -maxdepth 1 -type d -exec test -f '{}/SKILL.md' ';' -print | sort)

  [ "$linked" -gt 0 ]
}

if echo "$PLUGINS" | tr ',' '\n' | grep -q '^superpowers@\|^superpowers$'; then
  if ! link_superpowers_skills "$OPENCODE_CACHE_PKG" "$SKILLS_ROOT"; then
    if [ -d "$BAKED_SUPERPOWERS/skills" ]; then
      echo "Superpowers skills not in cache; linking from baked image..."
      mkdir -p "$SKILLS_ROOT"
      linked=0
      while IFS= read -r skill_dir; do
        skill_name="${skill_dir##*/}"
        target="$SKILLS_ROOT/$skill_name"

        if [ -L "$target" ]; then
          if [ "$(readlink "$target")" = "$skill_dir" ] && [ -f "$target/SKILL.md" ]; then
            linked=$((linked + 1))
            continue
          fi
          rm -f "$target"
        elif [ -e "$target" ]; then
          echo "Skipping Superpowers skill '$skill_name'; $target already exists"
          continue
        fi

        ln -s "$skill_dir" "$target"
        echo "Superpowers skill symlinked (baked): $target -> $skill_dir"
        linked=$((linked + 1))
      done < <(find "$BAKED_SUPERPOWERS/skills" -mindepth 1 -maxdepth 1 -type d -exec test -f '{}/SKILL.md' ';' -print | sort)

      if [ "$linked" -eq 0 ]; then
        echo "Warning: No Superpowers skills found in baked image"
      fi
    else
      echo "Superpowers skills not found in cache yet; warming OpenCode plugin cache..."
      timeout 180 opencode >/dev/null 2>&1 || true
      if ! link_superpowers_skills "$OPENCODE_CACHE_PKG" "$SKILLS_ROOT"; then
        echo "Warning: Superpowers skills directory not found after OpenCode cache warmup"
      fi
    fi
  fi
fi

# --- Baked skills (enable-project-knowledge) ---
BAKED_SKILLS_DIR="/opt/opencode/baked-skills"
if [ -d "$BAKED_SKILLS_DIR" ]; then
  mkdir -p "$SKILLS_ROOT"
  while IFS= read -r skill_dir; do
    [ -n "$skill_dir" ] || continue
    skill_name="$(basename "$skill_dir")"
    target="$SKILLS_ROOT/$skill_name"
    if [ ! -e "$target" ]; then
      ln -s "$skill_dir" "$target"
      echo "Baked skill symlinked: $target -> $skill_dir"
    fi
  done < <(find "$BAKED_SKILLS_DIR" -mindepth 1 -maxdepth 1 -type d -exec test -f '{}/SKILL.md' ';' -print | sort)
fi

# --- ai-engkit environment knowledge (AGENTS.md) ---
# Append ai-engkit-specific sections to user's AGENTS.md if not already present.
# Uses HTML-comment sentinel markers for idempotent dedup: each section identified
# by <!-- @ai-engkit --> is appended exactly once, surviving container restarts.
AI_ENGKIT_AGENTS_DEFAULT="/etc/opencode/AGENTS.md.default"
USER_AGENTS_MD="$OPCODE_CONFIG_DIR/AGENTS.md"

if [ -f "$AI_ENGKIT_AGENTS_DEFAULT" ]; then
  if [ -f "$USER_AGENTS_MD" ]; then
    if ! grep -q '<!-- @ai-engkit -->' "$USER_AGENTS_MD" 2>/dev/null; then
      echo "" >> "$USER_AGENTS_MD"
      cat "$AI_ENGKIT_AGENTS_DEFAULT" >> "$USER_AGENTS_MD"
      echo "Appended ai-engkit environment knowledge to AGENTS.md"
    fi
  else
    cp "$AI_ENGKIT_AGENTS_DEFAULT" "$USER_AGENTS_MD"
    echo "Created AGENTS.md with ai-engkit environment knowledge"
  fi
fi

echo "Default configs initialized"
