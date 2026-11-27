# Reachability first-pass — 9 Go-module findings (2026-11-27)

## Method (static only, no runtime probing)

- Advisory substance from code-scanning rule text (2026-11-27 snapshot).
- Import checks with `git grep` at the exact release tags (`compose v5.8.0`, `buildx v0.39.1`),
  not default branch. Blobless clones under `.tmp/upstream/` (removed after).
- Verdicts below are **candidates**, not VEX findings. Nothing here authorizes suppression.

## Compose v5.8.0 (7 findings)

| Alert | Finding | Import evidence at tag | First-pass verdict |
|---|---|---|---|
| #9530, #9531 | x/net `html` parser quadratic + namespace confusion | `golang.org/x/net/html` imported nowhere in compose's own `.go` files | Likely dead code **if** no transitive chain links it — needs `go mod why golang.org/x/net` at tag |
| #9532 | x/crypto `openpgp` unsafe-by-design | No `openpgp` import in compose code | Likely dead code — needs `go mod why` at tag |
| #9519 | compress panic on two-block frames | `klauspost/compress` imported nowhere in compose code | Likely dead code — needs `go mod why` at tag |
| #9968, #9969 | otel `AttributeValueLengthLimit` bypass | Limit string never appears in compose code (never configured) | Bypass of an unconfigured limit is a no-op — candidate not-affected, unless a dependency sets it or `OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT` is set in the container (check env) |
| #10520 | otel W3C baggage parse amplification | Only hit is a comment in `pkg/compose/shellout.go:42` (outgoing propagation to child env, not parsing untrusted input) | Plausibly unreachable from untrusted input; parser input here is operator-controlled env — self-impact at most |

## Buildx v0.39.1 (2 findings)

| Alert | Finding | Import evidence at tag | First-pass verdict |
|---|---|---|---|
| #6259 | go-archive tar-slip (fix 0.3.0) | Imported via vendored buildkit `frontend/dockerui/context.go` — build-context unpacking path | **Genuine, track upstream.** Anyone who can feed buildx a crafted context is in scope (local untrusted checkout, CI building repo code). Do not suppress. |
| #9781 | x/crypto `openpgp` unsafe-by-design | Only a code comment in vendored sigstore/rekor; no real import | Likely dead code — needs `go mod why` at tag |

## Required confirmation before any VEX/not-affected claim

1. `go mod why <module>` at each release tag (needs Go toolchain + module fetch; not run here).
2. For otel: confirm no dependency configures span limits and the container env does not set
   `OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT`.
3. Independent reviewer + recheck trigger (next plugin release) per exception-governance rule.
4. Re-rescan after every `COMPOSE_VERSION` / `BUILDX_VERSION` bump regardless.

## Cleanup note

`.tmp/upstream/{compose,buildx}` removed after evidence capture (129 MB, disk was 97% full).
Reproduce with: `git clone --filter=blob:none --depth 1 <url>`, `git fetch --depth 1 origin tag <v>`,
`git grep <pattern> <v> -- '*.go'`.
