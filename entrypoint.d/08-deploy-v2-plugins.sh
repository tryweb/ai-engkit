#!/usr/bin/env bash
# Deploy the baked V2-line plugins (b1-routing, m3-enforcer) into the global
# OpenCode config plugins directory.
#
# Only the V2 line (OMO_ENABLED=0) gets them: the V1/OMO line keeps
# oh-my-openagent and must never load native-V2 plugins. OpenCode auto-discovers
# direct .js files under the global plugins dir, so no opencode.json entry is
# needed. Overwriting on every boot makes upgrades take effect on recreate.
set -euo pipefail

if [ "${OMO_ENABLED:-1}" != "0" ]; then
  exit 0
fi

SRC="/opt/opencode/v2-plugins"
DEST="$HOME/.config/opencode/plugins"

if [ ! -d "$SRC" ]; then
  echo "V2 plugins: $SRC missing; skipping deployment" >&2
  exit 0
fi

mkdir -p "$DEST"
deployed=""
for src in "$SRC"/*.js; do
  [ -f "$src" ] || continue
  name="$(basename "$src")"
  install -m 0644 "$src" "$DEST/$name"
  deployed="${deployed}${deployed:+ }$name"
done
echo "V2 plugins deployed to $DEST: ${deployed:-none}"
