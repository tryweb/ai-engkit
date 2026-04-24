#!/usr/bin/env bash
set -euo pipefail

for script in /entrypoint.d/*; do
  if [[ -f $script ]]; then
    chmod +x "$script"
    case "$(basename "$script")" in
      03-fix-docker-gid.sh|04-init-git-ssh.sh|05-init-gh-cli.sh)
        sudo /bin/bash -c "$(cat "$script")"
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