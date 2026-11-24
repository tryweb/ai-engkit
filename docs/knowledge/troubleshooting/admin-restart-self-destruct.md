# Admin Container Self-Destruct on Compose Recreate

## Pinned-image helper download timeout (2026-11-24)

On `192.168.11.196`, two restart attempts started downloading the hardcoded
`:latest` helper image and exited with 143 exactly 120 seconds later. Admin's
start time stayed unchanged: this was the command timeout during image pull,
not proof that Compose had stopped Admin. The requested `v1.25.0` image was
already present locally.

The Dashboard restart path now uses the configured image, disables implicit
helper pulls, and starts the helper detached. If the configured image is not
local, prepare it through the upgrade flow or explicitly pull it before retrying.
The API response means scheduled, not successfully recreated.

Helpers are retained with an `ai-engkit.operation=admin-restart` label, a project
label, and a unique name returned as `helper` in the API response. This preserves
Compose logs and exit status even when Admin is replaced. Inspect on the host:

```bash
docker ps -a --filter label=ai-engkit.operation=admin-restart
docker logs <helper-name>
docker inspect --format '{{.State.Status}} {{.State.ExitCode}} {{.State.Error}}' <helper-name>
```

Before starting a new helper, cleanup retains the newest exited helper for that
project and removes older exited helpers without force; running helpers are not
selected. A new attempt can therefore retain the previous result plus its own.
Cleanup is best-effort and failures are logged without blocking restart.
Dashboard timeout feedback includes the new helper name. After diagnosis, a
specific stopped container can also be removed with `docker rm <helper-name>`.
Logs are capped to one 1 MB file per helper.
These changes apply to the Dashboard path, not the Center-agent restart
path. The historical findings below describe earlier implementations.

## Context

The AI-EngKit admin container (`ai-engkit-admin`) has a "↻ Restart" button that recreates the container with the latest image from `ghcr.io/tryweb/ai-engkit:latest`. The challenge is that the admin server (Bun process) needs to execute a `docker compose up -d --force-recreate` command that ultimately kills its own process — a self-destruct problem.

## Problem

Four bugs were discovered in the admin restart / update check mechanism:

### Bug 1: inFlightCheck never resets (update check cache stuck)

`src/admin/routes/versions.ts` had a Promise dedup variable `inFlightCheck` that was set once and never reset to `null`. After the first update check completed, subsequent cache-expired requests would return the first check's stale result instead of re-fetching digests from ghcr.io.

```typescript
// Before: inFlightCheck was never reset
inFlightCheck = (async () => {
  // ... fetch and compare ...
  cachedCheck = { result, expiresAt: now + 300_000 };
  return result;
  // inFlightCheck is still the Promise object (truthy!)
})();

// After: reset inFlightCheck in finally
inFlightCheck = (async () => {
  try {
    // ... fetch and compare ...
    cachedCheck = { result, expiresAt: now + 300_000 };
    return result;
  } finally {
    inFlightCheck = null;  // ← allows fresh check on next cache miss
  }
})();
```

### Bug 2: Compose self-destruct kills the operation mid-way

When the admin container runs `docker compose up -d --force-recreate ai-admin`, Docker compose:
1. Creates the new container ✅
2. Starts the new container ✅  
3. Stops the old container → **kills the Bun process** → compose command aborted ❌

The new container was left in "Created" (never started) because compose was killed after creating but before starting. The old container continued running unchanged.

**Fix:** Run compose in a **separate temporary container** via `docker run --rm` that survives the admin being killed:

```typescript
await dockerCommand(
  `run --rm ` +
  `-v /opt/ai-engkit/.env:/opt/ai-engkit/.env ` +
  `-v /opt/ai-engkit/docker-compose.yml:/opt/ai-engkit/compose.yml ` +
  `-v /var/run/docker.sock:/var/run/docker.sock ` +
  `ghcr.io/tryweb/ai-engkit:latest ` +
  `sh -c "docker compose -p ${project} --env-file /opt/ai-engkit/.env -f /opt/ai-engkit/compose.yml up -d --force-recreate ai-admin"`,
  120_000,
);
```

### Bug 3: Compose file path mismatch in temporary container

The admin container mounts the host's `docker-compose.yml` as `/opt/ai-engkit/compose.yml`. When running `docker run` in a temporary container, the volume mount must map the specific file correctly:

```yaml
# Admin container mount:
./docker-compose.yml:/opt/ai-engkit/compose.yml:rw

# docker run must mount:
-v /opt/ai-engkit/docker-compose.yml:/opt/ai-engkit/compose.yml
#                         ^^^^^^^^^^^^^^              ^^^^^^^^^^^
#                         host filename               container path
```

Using `-v /opt/ai-engkit:/opt/ai-engkit` (whole directory) fails because the host's directory has `docker-compose.yml`, not `compose.yml`.

### Bug 4: Nested shell quoting in Bun `dockerCommand` causes silent failure on non-default host paths

`src/admin/routes/admin.ts` sends the restart command through three levels of shell nesting:

```
Bun.sh -c → "docker run --rm ... sh -c 'docker compose ...'"
```

The `dockerCommand` helper (`src/admin/lib/docker.ts`) runs all subcommands via `sh -c`:

```typescript
const args = ["sh", "-c", `docker ${subcommand}`];
```

When `getSelfBindSource()` correctly resolves host paths (e.g. `/root/.env` → `/root/.env`), the `shellQuote()` wrapping and the triple-nested `sh -c` processing can still cause the temporary container to exit with code 1. The error surfaces in admin logs as:

```
/opt/ai-engkit/.env is a directory
```

This is misleading — the host path is correct and the file exists. The quoting chain (`'"'"'` escape sequences passing through two `sh -c` layers) desynchronizes the shell parser, causing the temporary container's inner `docker compose` command to use fallback paths that resolve to host directories instead of files.

**Fix**: Avoid triple-nested `sh -c` by one of:
- Use `Bun.spawn` with direct args array instead of `dockerCommand` for the restart call, eliminating the outer `sh -c` layer
- Write the compose command to a temp file and execute it inside the container via `--entrypoint` with a script
- Use `docker run` with `--entrypoint docker` and pass compose args as positional arguments after the image name

```typescript
// Alternative: bypass dockerCommand's sh -c by calling runCommand directly
const args = [
  "docker", "run", "--rm", "--user", "0", "--entrypoint", "docker",
  "-v", `${envSource}:${envSource}:ro`,
  "-v", `${composeSource}:${composeSource}:ro`,
  "-v", "/var/run/docker.sock:/var/run/docker.sock",
  "ghcr.io/tryweb/ai-engkit:latest",
  "compose", "-p", project,
  "--env-file", envSource,
  "-f", composeSource,
  "up", "-d", "--force-recreate", "ai-admin",
];
// Use runCommand directly to avoid shell quoting
const { runCommand } = await import("../lib/docker");
runCommand(args, 120_000).catch(() => {});
```

**Detection**: Docker events show a `container die` with `exitCode=1` on an auto-named temporary container (e.g. `inspiring_ellis`). The same `docker run` command succeeds when pasted directly into a host shell or SSH session.

**Status in v1.7.0**: ❌ **Not fixed.** Commit `1d609c6 fix(admin): make sidecar recreate DooD-aware` added `getSelfBindSource()` and `shellQuote()` but still uses `dockerCommand()` with the triple-nested `sh -c` pattern. The `dockerCommand()` function in `src/admin/lib/docker.ts` was not changed in v1.7.0.

**Confirmed on 3 machines**:
| Machine | Host Paths | Compose Project | Temp Container | exitCode |
|---------|-----------|----------------|----------------|----------|
| 192.168.11.195 | `/root/.env` | `root` | `inspiring_ellis` | 1 |
| 192.168.11.194 | `/home/jonathan/.env` | `jonathan` | `intelligent_cannon` | 1 |
| (knowledge base original) | `/opt/ai-engkit/.env` | `ai-engkit` | N/A | N/A (Bug 3, different cause) |

All three share the same error signature: admin log shows `/opt/ai-engkit/.env is a directory` after restart attempt, but the host file exists and the identical `docker run` command succeeds via direct SSH execution.

## Solution

1. **inFlightCheck fix**: `try/finally { inFlightCheck = null; }` in the async update check
2. **Self-destruct fix**: Run compose in a `docker run --rm` temporary container
3. **File mount fix**: Mount specific file paths with the correct container-side name
4. **Version display fix**: Separate `aiEngkitVer` (read from ai-dev via `execInAiDev`) from `adminVer` (read from admin's own filesystem via `readFileSync`) — the versions table shows dev version, the mismatch badge shows admin version
5. **Shell quoting fix** (Bug 4): Use `runCommand` with direct args array instead of `dockerCommand` for the restart call to eliminate triple-nested `sh -c` quoting issues.

## Why It Works

- The temporary container launched by `docker run --rm` is a separate Docker container from the admin. When compose stops and kills the old admin container, this temporary container continues running because it's a distinct container with its own PID namespace.
- Compose completes the full workflow (pull → create → start → stop old) because the client process isn't killed mid-way.
- The client dashboard polls `/healthz` after the admin sends the restart response, and the page reloads when the new admin is healthy.

## Side Effects / Tradeoffs

- The `docker run` command pulls the image again if not cached locally. Since the upgrade pipeline already pulled `:latest`, the image is typically cached and startup is fast.
- The temporary container runs the full entrypoint (baked skills, config init) which adds ~5-10s to the restart time. This is acceptable since restart is infrequent.
- Hotfixes applied to the running admin container are **lost** on restart because the new container starts from the production image. All fixes must be committed to the repo and released.
- When both ai-dev and ai-admin are on the same version, no mismatch badge is shown. The badge only appears when they diverge.

## Evidence

- **Bug 1**: Dashboard showed "✓ Latest" even after remote `ghcr.io` digest changed. SSH verification confirmed `localDigest ≠ remoteDigest` but API returned cached "up-to-date".
- **Bug 2**: `docker ps -a` showed a `Created` container `09bf67e8876b_ai-engkit-admin` after restart attempt. Old admin container still running on old image.
- **Bug 3**: `open /opt/ai-engkit/compose.yml: no such file or directory` error in temporary container logs.
- **Bug 4**: `/opt/ai-engkit/.env is a directory` error in admin logs after restart attempt on 3 separate deployments. `docker events` shows temporary container created and died with `exitCode=1`:
  - `192.168.11.195` (root): `inspiring_ellis` — host paths `/root/.env`, project `root`
  - `192.168.11.194` (jonathan): `intelligent_cannon` — host paths `/home/jonathan/.env`, project `jonathan`
  - Original evidence deployment: `/opt/ai-engkit/.env` (Bug 3 era, same error signature)
  Same `docker run` command succeeds when executed directly via SSH on all machines. v1.7.0 still uses `dockerCommand()` with `sh -c` wrapping (commit `1d609c6` only added `getSelfBindSource()` + `shellQuote()`, did not fix the triple-nested shell quoting).
- **Final fix**: After applying all fixes, `↻ Restart` successfully recreated admin from `15332b7a83b7 (v1.6.0)` to `44b863f386c8 (v1.6.1)`. `⚠` badge disappeared, `✓ Latest` displayed.

## Agent Command Path (v1.14.6)

The same Bug 2 reappeared on the **agent command path**: `src/admin/agent/commands.ts` `restartContainer("ai-admin")` (used when Center Manager dispatches a restart action to the agent) ran `docker compose up -d --force-recreate ai-admin` in-place. Commit `a4f385d` (v1.14.5) introduced this, so a restart dispatched through Center Manager killed the agent mid-recreate exactly like the dashboard path did.

**Fix** (commit `88b8162`, v1.14.6): the `ai-admin` branch now mirrors the dashboard pattern in `routes/admin.ts`:

1. Best-effort `docker pull ghcr.io/tryweb/ai-engkit:latest` (the agent path is ai-admin's only upgrade path; a registry outage must not block the restart).
2. Recreate from a **separate helper container** via `runCommand` with a direct argv array (`docker run --rm --user 0 --entrypoint /usr/local/bin/docker -v <env>:<env>:ro -v <compose>:<compose>:ro -v /var/run/docker.sock:... <image> compose ... up -d --force-recreate ai-admin`) — no shell nesting, bind sources resolved via `getSelfBindSource` (Bug 4-safe).
3. If bind sources cannot be resolved, return a failure result (unlike the dashboard's silent return, the agent must answer its action with an ack).

**Ack semantics**: the agent sends an immediate "restarting ai-admin" ack; when the helper recreate succeeds the old admin is killed, so no final ack is possible. Completion is observed as the agent's reconnection. Never report the helper exit code in an ack — the process is usually already dead.

The `ai-dev` branch keeps the direct in-place compose (safe: the admin container is not the one being recreated).

## Dashboard Fast-Fail and Bounded Recovery (2026-09)

A staging observation on `192.168.11.195` showed `POST /api/admin/restart` returning `200` while the admin image digest stayed unchanged and uptime continued increasing. The Dashboard route resolved bind sources only inside its delayed callback and silently returned when either source was unavailable, so the browser could not distinguish a scheduled restart from a no-op.

The Dashboard path now preserves response-first self-recreate while making its observable boundaries explicit:

1. Resolve the compose project and host-side `.env`/Compose bind sources before returning success. A failed or missing preflight returns HTTP `500` and does not schedule the helper.
2. After successful preflight, return HTTP `200` and retain the two-second delayed helper launch so the response flushes before Compose stops the old admin.
3. Handle helper rejection and non-zero exit at the route boundary with an error log. A successful helper normally kills the process before it can report completion.
4. Capture `/api/admin/status` before restart and poll it sequentially for at most 120 seconds. Reload only after an image-digest change, an uptime reset, or recovery from observed unavailability; the still-running old admin is not mistaken for a completed restart.
5. On timeout or HTTP failure, restore the Restart button and show actionable feedback.

The helper image remains separate from the target service image. `docker compose --env-file ...` resolves both services through `${AI_ENGKIT_VERSION:-latest}`, preserving Official versus Specified channel semantics.

**Evidence:** focused restart tests pass `15/15`; the complete Admin test suite passes `740/740`. The TypeScript no-excuse audit reports no violations in the five changed source/test files. Live post-fix container recreation still requires deployment to the staging host.

## Related Files

- `src/admin/routes/versions.ts` — inFlightCheck bug + getAiEngkitVersion / getLocalDigest fixes
- `src/admin/routes/admin.ts` — restart endpoint with docker run workaround
- `src/admin/lib/docker.ts` — `dockerCommand()` / `runCommand()` helpers with `sh -c` wrapping (Bug 4 root cause)
- `src/admin/server.ts` — version reading split (dev vs admin)
- `src/admin/views/dashboard.tsx` — `vv1.6.0` double-v prefix fix
- `src/admin/lib/upgrade.ts` — upgrade pipeline (only recreates ai-dev, not ai-admin)

## Tags

`#admin` `#docker` `#compose` `#self-destruct` `#restart` `#bug` `#update-check` `#shell-quoting` `#bun`
