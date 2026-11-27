# Bundled-Dependency Reachability Triage

## Context

Some image vulnerabilities live in dependencies this repo does not select: a Node binary inside
the CodeGraph platform package, Go modules compiled into Docker Compose/Buildx plugins, npm
packages inside the OpenChamber managed core. Bumping our pins cannot fix them until an upstream
parent ships the fix. Blindly ignoring them is as wrong as counting each as an app vulnerability.

## Problem

How to produce an evidence-backed disposition (track upstream vs. candidate not-affected) for
findings in prebuilt binaries without executing target code or trusting version numbers alone.

## Solution

1. Split by handling system first: direct deps (we bump), bundled runtimes/plugins (upstream
   rebuilds), distro packages (vendor fixes). Only bundled items enter this flow.
2. Confirm the scan reflects release contents: fetch the upstream tag's `go.mod`
   (`gh api repos/<org>/<repo>/contents/go.mod?ref=<tag>`) and compare module versions to the
   scan. If they match, it is not DB noise.
3. Check whether a fixed parent exists: npm `latest` / GitHub latest release versus our pin.
   If equal, record "no actionable bump" with date instead of leaving it open-ended.
4. For reachability, grep the upstream source **at the exact release tag**, not default branch:
   `git clone --filter=blob:none --depth 1 <url>`, `git fetch --depth 1 origin tag <v>`,
   `git grep <pattern> <v> -- '*.go'`. Look for imports of the vulnerable package/module,
   configuration of the vulnerable feature, and server constructors (`createServer`,
   `createSecureServer`, `respondWithFile`, `altsvc`).
5. For bundled runtimes, inspect the local install of the same pinned version: entrypoint flags,
   server constructors (Unix socket vs TLS vs cleartext loopback), outbound clients, env
   preconditions. Example: a cleartext-only `node:http` server is explicitly out of scope of an
   advisory that states "Cleartext node:http is not affected".
6. Record verdicts as candidates with a named confirmation step (`go mod why <module>` at tag,
   env assertion, independent reviewer) and a recheck trigger (next parent release). Never turn
   them into VEX/ignore rules at this stage.

## Why It Works

Tag-pinned grep tests the exact code shipped in the scanned binary, avoiding main-branch drift.
Absence of an import or feature flag in the shipped tag is positive evidence of unreachability,
while presence (e.g. vendored buildkit unpacking contexts via go-archive) marks a genuine track
item. The per-bump re-grep trigger keeps the conclusion from rotting when upstreams change.

## Side Effects / Tradeoffs

- Blobless clones still cost disk (buildx ~118 MB); delete `.tmp/upstream/*` after capture.
  Check `df` first — this workflow once ran at 97–99% disk.
- `git grep` on a blobless clone fetches blobs on demand; output is correct but slower.
- Static absence is strong but not proof: transitive linkage needs `go mod why` with a Go
  toolchain, which this environment did not run. Say so in the note.

## Evidence

- 2026-11-27: compose v5.8.0 tag `go.mod` matched all 7 scanned module versions; compose code
  had no direct imports of `x/net/html`, `openpgp`, or `compress`; `AttributeValueLengthLimit`
  never configured; buildx v0.39.1 uses go-archive via vendored buildkit (genuine) while
  `x/crypto/openpgp` appeared only in a vendored comment.
- CodeGraph 1.6.4 bundle: Unix-socket MCP daemon + cleartext loopback HTTP only; all 15 Node
  CVE preconditions (TLS/HTTP/2 servers, proxy env, `--permission`, zlib `params`) absent.
  Notes: `docs/security/reachability-go-modules-2026-11-27.md`,
  `docs/security/reachability-node-2026-11-27.md`.

## Related Files

- `docs/security/bundled-tooling-2026-11-27.md`
- `Dockerfile` (`CODEGRAPH_VERSION`, `COMPOSE_VERSION`, `BUILDX_VERSION`)
- `.grype.yaml`

## Tags

grype, reachability, vendored-dependencies, triage, evidence
