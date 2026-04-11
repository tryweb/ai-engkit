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

exec "$@"