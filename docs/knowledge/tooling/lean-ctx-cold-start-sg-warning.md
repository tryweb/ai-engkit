# lean-ctx cold-start: `Usage: sg group [[-c] command]` log warning

## Context

On the very first cold start of the `ai-engkit-engine-dev` container, the
engine log may show:

```
opencode server listening on http://0.0.0.0:4095
Usage: sg group [[-c] command]
```

The warning appears between `opencode server listening` and any MCP server
output. After the first container restart, this line never appears again.

## What's actually happening

This is **not** a call to the `sg` utility by ai-engkit. The real failure
is a `cannot execute binary file` (`execve ENOEXEC`) error from inside
`lean-ctx init`'s bash script, which then falls back to running `sg` as a
shell utility — also without arguments, which prints its usage.

The chain is:

1. `entrypoint.d/02-init-config.sh` runs `lean-ctx init --agent opencode`
2. `lean-ctx init` writes its binary to `/home/devuser/.local/bin/lean-ctx`
3. In the same shell session, lean-ctx's init bash runs `command -v <tool>`
   to verify CLI tools it discovered
4. On the overlay filesystem, the freshly-written binary's inode is on
   disk but the page cache hasn't synced for `execve()` yet
5. `execve` returns `ENOEXEC` — the error is reported by bash
6. lean-ctx's fallback path tries `sg <tool>` to find a matching group,
   which also fails because `sg` requires a group argument
7. `sg` prints `Usage: sg group [[-c] command]`

The `sg` usage line is a **symptom**, not the cause.

## Why we don't fix it

- It only happens **once per fresh image**; any subsequent container
  start (with the existing image's overlay layers cached) doesn't
  reproduce it
- The engine starts, listens on :4095, and serves all API calls
  correctly — the warning is **cosmetic**
- Patching lean-ctx's internal init would be a fork
- Adding fsync / sleep / binary-readiness checks to our entrypoint
  would add complexity for a warning that has no functional impact

The `restart: unless-stopped` policy in `docker-compose.yml` means
production deployments naturally converge on warm starts within one
restart cycle, so users in production never see this line.

## How to verify the engine is actually fine

After seeing the warning, the engine is still healthy if:

```bash
docker exec ai-engkit-engine-dev curl -s -u "opencode:devonly" \
  http://localhost:4095/health
# → HTTP 200, JSON with status, agents, providers

docker exec ai-engkit-engine-dev ls /home/devuser/.local/bin/lean-ctx
# → /home/devuser/.local/bin/lean-ctx (binary present, executable)
```

If both work, the warning is just noise.

## Tags

- lean-ctx
- entrypoint
- cold-start
- known-issue
- cosmetic
