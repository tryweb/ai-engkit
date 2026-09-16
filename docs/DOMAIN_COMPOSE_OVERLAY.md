# Domain Compose Overlay

AI-EngKit owns the upstream base Compose file. A domain deployment can own
**exactly one** local overlay that extends the `ai-dev` service so domain
integrations survive AI-EngKit upgrades, restarts, and database maintenance
recreates.

## Ownership boundary

| Owner | Artifact |
|---|---|
| AI-EngKit | Upstream base Compose file, staged at `/opt/ai-engkit/compose-upgrade-base.yml` |
| Domain project | One overlay under `/opt/ai-engkit/extensions/` |
| Domain project | External networks, domain worker services, and their lifecycle |

AI-EngKit never creates, starts, stops, or backs up domain worker services. It
only keeps `ai-dev` attached to the overlay's declared networks/volumes.

## Configuration

Set one value in the installation `.env`:

```dotenv
# Relative to /opt/ai-engkit/extensions/, or an absolute path beneath it.
AI_ENGKIT_COMPOSE_OVERLAY=ep-design.yml
```

The path is resolved from the persisted local environment, canonicalized, and
required to be a readable regular file beneath `/opt/ai-engkit/extensions/`.
Symlinks that escape the directory, parent-directory traversal, missing files,
and non-canonical paths fail closed. There is no public API to select a path or
URL: the value is operator-controlled only.

### Fixed path contract (Docker-out-of-Docker)

| Host path | Admin container path | Mode |
|---|---|---|
| `./extensions/` | `/opt/ai-engkit/extensions/` | read-only |
| `./admin-data/upgrade-base.yml` | `/opt/ai-engkit/compose-upgrade-base.yml` | read-write |
| `./docker-compose.yml` | `/opt/ai-engkit/compose.yml` | read-write (base-only installs) |

`install.sh` and `upgrade.sh` create both host paths before Compose starts; a
missing bind-mount source for a file is otherwise auto-created as a directory by
Docker. Every overlay-aware Compose invocation also passes
`--project-directory /opt/ai-engkit` so relative host paths keep the
installation-root semantics.

## Allowed and protected surface

The overlay may extend only the `ai-dev` service, and only with:

- `environment`
- `networks`
- named `volumes` only
- `labels`
- `healthcheck`

Top-level `networks` and `volumes` declarations are allowed. Everything else is
rejected before any container is recreated:

- `image`, `container_name`, `command`, `entrypoint`, published `ports`
- `privileged`, `cap_add`, `cap_drop`, `security_opt`, `devices`, `pid`, `ipc`,
  `userns_mode`, `sysctls`, `network_mode`, and other privilege/security fields
- any host bind mount, including Docker socket mounts (for example `/var/run/docker.sock`)
- the `ai-admin` service or any other AI-EngKit-owned service
- any domain worker service

Validation runs against the overlay alone first (normalized Compose JSON), then
against the ordered base-plus-overlay configuration, and both must succeed
before any recreate. A failure leaves the running deployment unchanged.

## ep-design external-network example

The confirmed OpenCode runtime configuration names are `OPENCHAMBER_OPENCODE_PORT`
(or `OPENCODE_PORT`) for the managed OpenCode port and `OPENCHAMBER_OPENCODE_HOSTNAME`
for its bind hostname (default `127.0.0.1`). The OpenCode API listens on `4095`
by default. `OPENCODE_HOST` is **not** a listen address — it points the runtime at
an external OpenCode URL and must not be used to expose the local API.

`/opt/ai-engkit/extensions/ep-design.yml`:

```yaml
services:
  ai-dev:
    environment:
      # Bind the managed OpenCode API so the domain worker can reach it.
      OPENCHAMBER_OPENCODE_HOSTNAME: 0.0.0.0
      OPENCHAMBER_OPENCODE_PORT: "4095"
    networks:
      - ep-design_interop
    labels:
      com.example.owner: ep-design
networks:
  ep-design_interop:
    external: true
```

The domain project creates and owns the shared network and the worker:

```bash
docker network create ep-design_interop   # once, owned by the domain project
```

Domain worker (separate Compose project):

```yaml
services:
  ep-design-worker:
    environment:
      AI_ENGKIT_OPENCODE_URL: http://ai-dev:4095
    networks:
      - ep-design_interop
networks:
  ep-design_interop:
    external: true
```

After an AI-EngKit upgrade, restart, or database maintenance recreate, `ai-dev`
returns on `ep-design_interop` and the worker resolves the stable service name
`ai-dev` (for example `http://ai-dev:4095`).

## Lifecycle application

The same effective base-plus-overlay configuration is used by:

- Admin upgrade (`Admin → Upgrade`)
- `restart-ai-dev`
- database maintenance startup
- agent-triggered `ai-dev` recreates

With no overlay configured, these paths keep the historical single-file
behavior.

## Backups and rollback

Each Admin upgrade backup (`backups/pre-<timestamp>/`) is mode `0700`; sensitive
files (`.env`, provider keys, OpenChamber settings, overlay content, staged base)
are mode `0600`. The backup records the prior staged base and an
`overlay/` copy plus `overlay-reference.txt` so the effective configuration can
be reconstructed. No `.env` value or overlay content is written to upgrade logs.

If recreate or health verification fails, AI-EngKit restores the prior `.env`,
active base, and staged base, then re-runs the previous base-plus-overlay
configuration. An incomplete rollback is reported inline in the upgrade result.

## Host upgrade

The host `upgrade.sh` path is overlay-aware so an existing overlay installation
can bootstrap the overlay-capable `ai-admin` image without a manual migration.
When `AI_ENGKIT_COMPOSE_OVERLAY` is set it:

- requires `jq` on the host;
- resolves the overlay beneath `./extensions` under the same single-overlay policy;
- downloads the target upstream base to `./admin-data/upgrade-base.yml.staging`;
- validates the overlay-only normalized JSON and the merged base-plus-overlay
  configuration, and requires `ai-dev`;
- verifies the target base exposes the `./extensions` and
  `./admin-data/upgrade-base.yml` Admin mounts;
- backs up the current staged base, overlay content, `.env`, and settings;
- atomically replaces the staged base and recreates `ai-admin` and `ai-dev`
  with `--project-directory <install root> -f <staged base> -f <overlay>`.

Any failed prerequisite (missing `jq`, unreadable or invalid overlay, missing
required mounts) exits before the active base is replaced. There is no silent
base-only fallback. Installations without an overlay keep the existing
single-file flow unchanged.

## V1 limits

- One overlay only; no ordering or conflict resolution across multiple overlays.
- No overlay editor, no automatic conflict resolution, no migration of
  hand-edited Compose files.
- `ai-dev` integration only; the domain worker lifecycle remains domain-owned.
- The overlay may not change the AI-EngKit image, container identity, entrypoint,
  Admin service, or Docker socket policy.
