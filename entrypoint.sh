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

# sg docker ensures the final command runs with correct group membership.
# The docker group was added by 03-fix-docker-gid.sh, but running processes
# cannot dynamically update their groups. sg starts a new shell that re-reads
# /etc/group, giving the service processes proper docker group access.
if getent group docker > /dev/null 2>&1; then
  exec sg docker -c "$*"
else
  exec "$@"
fi
