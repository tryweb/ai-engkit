# Bundled-tooling + Ubuntu triage — 2026-11-27 (OpenChamber out of scope)

## Direction

Per owner decision, OpenChamber cannot move via upstream upgrade. Its 5 findings stay on the
escalation pack (`openchamber-escalation-2026-11-27.md`) as track-or-accept items. This pack covers
everything else still open after CI `45970585021` (commit `57183ac`): CodeGraph, Compose, Buildx,
and Ubuntu/APT.

## Upstream state: no fixed parent available today (verified 2026-11-27)

| Owner | Open | Pinned | Upstream latest | Verdict |
|---|---:|---|---|---|
| codegraph-bundled-node | 15 | `CODEGRAPH_VERSION=1.6.4` | npm `latest` = 1.6.4; platform pkg `latest` = 1.6.4 | No bump available |
| docker-compose-go | 7 | `COMPOSE_VERSION=5.8.0` | GitHub latest = v5.8.0 (2026-11-17) | No bump available |
| docker-buildx-go | 2 | `BUILDX_VERSION=0.39.1` | GitHub latest = v0.39.1 (2026-11-19) | No bump available |
| ubuntu-24.04-apt | ~865 | `ubuntu:24.04`, `UPGRADE_PACKAGES=true` | Scan reports no fix version on any row | Consume-if-published; rest is track |

### Evidence

- Compose: tag `v5.8.0` go.mod contains exactly the scanned versions
  (`otel v1.46.0`, `compress v1.20.0`, `x/crypto v0.57.0`, `x/net v0.60.0`) — the scan reflects
  release contents, not DB noise. Compose `main` still pins the same otel/crypto/net
  (compress moved to v1.20.5, past its 1.20.2 fix — partial only).
- Buildx: `master` go.mod still has `go-archive v0.2.0` (fix 0.3.0) and `x/crypto v0.58.0`.
- CodeGraph: no newer wrapper or platform package exists to select.
- Ubuntu: every open row's scan help lists an empty fix version. Empty means "no vendor fix
  reported at scan time", not proof none exists today — but nothing here is actionable by version
  selection. Live Ubuntu-tracker spot checks were unreachable from this environment (timeouts);
  treat per-package status as unverified until checked from a connected host.

## Disposition per owner

### CodeGraph bundled Node (15)

- Do not touch the embedded `codegraph-linux-x64/node` binary and do not expect system
  Node/Bun changes to affect it.
- Trigger: on every `CODEGRAPH_VERSION` bump, rescan the image and confirm the 15 alert numbers
  report `fixed`. Suggested `check-versions.sh` follow-up: record the platform package's bundled
  Node version alongside the wrapper version so staleness is visible.

### Compose / Buildx embedded Go modules (9)

- APT/npm/Go-toolchain upgrades cannot patch compiled plugin binaries. Only a rebuilt upstream
  binary helps.
- Trigger: on every `COMPOSE_VERSION` / `BUILDX_VERSION` bump, compare the release's go.mod (or
  rescan the image) before assuming the fix rode along. `moby/go-archive` in Buildx is not
  automatically daemon-only — check the advisory's reachable path before any VEX suppression.

### Ubuntu/APT (~865)

- Keep `UPGRADE_PACKAGES=true`; refresh the base intentionally (a cached layer reruns nothing).
- Priority order for tracker review: openssl/libssl, git, krb5, glibc, python3.12, rsync,
  binutils — highest binary-group counts first.
- Do not merge binary groups into source packages without `artifact.upstreams` from Grype
  JSON/SBOM or dpkg Source metadata.
- Removing optional packages (e.g. X11/CUPS stacks) is a separate image-design decision for a
  dev-tool image, not a drive-by cleanup.

## What this project can do without upstream releases

1. **Reachability review (bounded):** for the 9 Go-module + 15 Node findings, determine whether
   the vulnerable code is reachable in this container's usage. A `not-affected` claim needs
   per-finding evidence and an expiry/recheck trigger — never a category-wide ignore.
2. **Upstream issues:** file or subscribe to Compose/Buildx/CodeGraph dependency-bump requests
   referencing the advisory IDs; link them here with dates.
3. **Exception governance:** any VEX/ignore entry stays scoped to advisory + package + version,
   with reviewer and recheck trigger. The existing `.grype.yaml` Chromium entry should be
   re-reviewed under the same bar (headless is not untrusted-content-safe).

## Acceptance

- Each `*_VERSION` bump is followed by an image rescan; targeted alerts show `fixed`, not dismissed.
- Unfixed rows each have an owner, a recheck trigger (upstream release or date), and no
  package-category-wide suppression.
- `docs/security/code-scanning-triage-2026-11-27.*` remains the snapshot; this pack and the
  OpenChamber pack are the living follow-ups.
