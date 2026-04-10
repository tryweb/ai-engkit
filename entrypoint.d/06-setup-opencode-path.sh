#!/usr/bin/env bash
set -euo pipefail

PROFILE_FILE="$HOME/.profile"
MARKER="# OpenCode (opencode.ai) - Added by Codeforge entrypoint"

echo "=== Setting up OpenCode PATH in .profile ==="

touch "$PROFILE_FILE"

if ! grep -qF "$MARKER" "$PROFILE_FILE" 2>/dev/null; then
  cat >> "$PROFILE_FILE" << 'EOF'

# OpenCode (opencode.ai) - Added by Codeforge entrypoint
if [ -d "$HOME/.bun/bin" ]; then
    export PATH="$HOME/.bun/bin:$PATH"
fi
EOF
  echo "Added OpenCode PATH to $PROFILE_FILE"
else
  echo "OpenCode PATH already exists in $PROFILE_FILE"
fi

echo "=== OpenCode PATH setup completed ==="
echo
