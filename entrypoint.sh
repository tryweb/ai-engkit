#!/usr/bin/env bash
set -euo pipefail

AI_ENGKIT_BOOT_ROLE=ai-dev
case "${1:-}" in
  bun)
    if [[ "${2:-}" == "run" && "${3:-}" == "/opt/admin/server.ts" ]]; then
      AI_ENGKIT_BOOT_ROLE=ai-admin
    fi
    ;;
  sh|bash)
    if [[ "${2:-}" == "-c" && "${3:-}" == *"bun run /opt/admin/server.ts"* ]]; then
      AI_ENGKIT_BOOT_ROLE=ai-admin
    fi
    ;;
esac
export AI_ENGKIT_BOOT_ROLE

block_startup() {
  echo "[entrypoint] preflight refused startup; container is blocked until operator remediation and an explicit restart" >&2
  blocked_sleep_pid=
  trap 'kill "${blocked_sleep_pid:-}" 2>/dev/null || true; exit 0' INT TERM
  while :; do
    /usr/bin/sleep infinity &
    blocked_sleep_pid=$!
    wait "$blocked_sleep_pid" || true
  done
}

for script in /entrypoint.d/*.sh; do
  if [[ -f $script ]]; then
    chmod +x "$script"
    case "$(basename "$script")" in
      00-core-recovery.sh|00-db-compat-gate.sh|00-opencode-selection-repair.sh)
        if ! "$script"; then
          block_startup
        fi
        ;;
      03-fix-docker-gid.sh)
        sudo /bin/bash -c "$(cat "$script")"
        ;;
      04-init-git-ssh.sh|05-init-gh-cli.sh)
        sudo /bin/bash -c "$(cat "$script")" || \
          echo "[entrypoint] Optional initialization failed: $(basename "$script")"
        ;;
      *)
        "$script"
        ;;
    esac
  fi
done

echo "Running:"
echo "$@"
echo

# Re-exec via sudo to refresh supplementary groups
# (entrypoint.d scripts may have modified /etc/group, e.g. docker GID fix;
#  env PATH=… bypasses sudo secure_path which would strip bun/brew from PATH)
exec sudo -E -u devuser -- env PATH="$PATH" "$@"
