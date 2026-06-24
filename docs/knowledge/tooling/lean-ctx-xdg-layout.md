# lean-ctx XDG Directory Layout and v3.8.9 Layout Pin

## Context

ai-engkit runs lean-ctx inside a Docker container. lean-ctx uses the [XDG Base Directory](https://specifications.freedesktop.org/basedir-spec/basedir-spec-latest.html) layout, with these four directories:

| XDG Base | Container path | Purpose | Persisted? | Mechanism |
|----------|---------------|---------|-----------|-----------|
| `XDG_DATA_HOME` | `~/.local/share/lean-ctx` | Sessions, vectors, graphs, knowledge | ✅ | `lean-ctx-data` named volume |
| `XDG_STATE_HOME` | `~/.local/state/lean-ctx` | Event logs, journals, agent runtime env | ✅ | `lean-ctx-state` named volume |
| `XDG_CACHE_HOME` | `~/.cache/lean-ctx` | Semantic cache, models, learned patterns | ❌ (ephemeral) | in-image only — recreated on container recreate (cache is rebuildable) |
| `XDG_CONFIG_HOME` | `~/.config/lean-ctx` | `config.toml`, `layout.toml` (pin), `env.sh` | ❌ (ephemeral) | in-image only — created by `lean-ctx` install at build time, regenerated on first lean-ctx invocation |

Only `lean-ctx-data` and `lean-ctx-state` are **named volumes** declared in `docker-compose.yml`. The `~/.cache/lean-ctx` directory is pre-created in the image (Dockerfile L235) but **not** mounted from a volume, so it does not survive `docker compose down && docker compose up`. The `~/.config/lean-ctx` directory is created by the `lean-ctx` install at build time (Dockerfile L134) and is **not** in the `opencode-config` volume — that volume mounts `~/.config/opencode/`, a sibling directory, not `~/.config/`.

lean-ctx v3.8.5 introduced [proper XDG Base Directory compliance](https://github.com/yvgude/lean-ctx/releases/tag/v3.8.5) (#408), splitting data/state/cache/config into separate directories. Before v3.8.9, this split was enforced by a **heuristic**: if no legacy `~/.lean-ctx` marker was found, the XDG layout was used. However, a stray marker (an old backup restored, a concurrent older binary writing `~/.lean-ctx`, or even an empty `sessions/` directory) could silently **collapse** all four directories back into one, causing config to look empty, dashboard graphs to disappear, and data to appear lost.

## Problem

A container rebuild or volume restore could re-introduce a `~/.lean-ctx` marker (e.g., from `LEAN_CTX_CONFIG_HOME` being set to a path that also writes to the old location, or from a restored snapshot). When the heuristic detected this marker, it reverted to single-directory mode, making:

- `config.toml` unfindable (data had moved to `$XDG_DATA_HOME/lean-ctx`),
- dashboard graph and search index disappear,
- cross-session knowledge appear lost.

The heuristic was fragile — it could flip back at any point, without warning.

## Solution

lean-ctx v3.8.9 ([#623](https://github.com/yvgude/lean-ctx/issues/623)) introduces a **layout pin**: a file at

```
$XDG_CONFIG_HOME/lean-ctx/layout.toml   →  mode = "xdg"
```

that records the commitment to the XDG layout. The pin is checked **before** the legacy heuristic and takes priority. Once written, the XDG layout is permanent.

The pin is auto-written by every independent long-running path:
- `lean-ctx setup`
- MCP server start
- daemon `init_foreground_daemon` (launchd/systemd autostart)
- `lean-ctx doctor --fix` (after migration + reclaim)

A residual `~/.lean-ctx` is auto-drained (emptied) when the pin is written, preventing stale data from accumulating in the old location.

## Why It Works

The pin turns a heuristic (guess, can flip) into a commitment (recorded fact, cannot flip). The resolver reads `layout.toml` first — if it says `mode = "xdg"`, no amount of stray markers in `~/.lean-ctx` can revert the layout. This is the same pattern as an init-system lock file: once the migration is committed, it stays.

The pin is crash-safe (written atomically) and idempotent (re-writing the same pin is a no-op).

## Side Effects / Tradeoffs

- **No rollback**: Once pinned, there is no automatic way to revert to a legacy single-directory layout. Manual removal of the pin file + migration would be required. In practice this is desirable for ai-engkit (we want XDG permanence).
- **Legacy installs are unaffected**: Installs that never migrated to XDG continue working in single-directory mode. The pin is only written when the XDG layout is active.
- **Container compatibility**: The pin's persistence depends on which event happens:
  - `docker compose down && up` (recreate): `~/.config/lean-ctx/` survives because the directory is in the image (created at build time by `lean-ctx` install), not because of any volume. The two `lean-ctx-*` named volumes are unaffected.
  - `docker compose down -v && up` (drop volumes): drops `lean-ctx-data` and `lean-ctx-state` only. `~/.config/lean-ctx/` still survives from the image.
  - Image rebuild (`docker compose build --no-cache`): produces a new image with fresh `~/.config/lean-ctx/`, so the pin is **lost**. lean-ctx auto-recreates it on the first `setup` / MCP start / `doctor --fix` run after rebuild.
  - `docker compose down -v --rmi all` (nuclear): loses both volumes and the image, so all four directories are reset.

## Evidence

- [Release v3.8.9 — XDG layout pin (#623)](https://github.com/yvgude/lean-ctx/releases/tag/v3.8.9)
- [XDG Base Directory compliance v3.8.5 (#408)](https://github.com/yvgude/lean-ctx/releases/tag/v3.8.5)
- ai-engkit `README.md` — volume configuration table
- ai-engkit `docs/ARCHITECTURE.md` — lean-ctx integration overview
- ai-engkit `docker-compose.yml` — `lean-ctx-data`, `lean-ctx-state` volume declarations (only the persistent ones; `lean-ctx-cache` is in-image only)
- ai-engkit `Dockerfile` L134 (`lean-ctx` install creates `~/.config/lean-ctx/` at build time) and L235 (pre-creates `~/.cache/lean-ctx/` in image)
- ai-engkit `Dockerfile` L256-267 (`VOLUME` array declares `~/.local/share/lean-ctx` and `~/.local/state/lean-ctx` only)

## Related Files

- `README.md` — volume configuration section
- `docs/ARCHITECTURE.md` — lean-ctx architecture section
- `docker-compose.yml` — volume definitions

## Tags

- lean-ctx
- XDG
- layout-pin
- volume-persistence
- tooling
