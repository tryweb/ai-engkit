# Reachability first-pass — 15 bundled-Node findings (2026-11-27)

## Runtime surface (codegraph 1.6.4, Linux bundle — same version as `CODEGRAPH_VERSION`)

Evidence from the installed package (`@colbymchenry/codegraph-linux-x64`, `bin/codegraph` launches
`$DIR/node` with `--liftoff-only --disable-warning --max-semi-space-size`, no `--permission`):

- Inbound: MCP daemon on a **Unix socket** (`lib/dist/mcp/daemon.js:191`, `net.createServer`,
  no TLS); UI server is **cleartext `node:http` on loopback** (`lib/dist/ui-server/index.js:41,99,294`).
- No `http2` / `tls` server usage anywhere in server code.
- Only outbound `https` is the update check (`lib/dist/upgrade/index.js`, `https.get` to
  github.com with the default agent — no custom `ca`, no per-host policies).
- No `.params(` zlib calls, no proxy handling code in app JS (viewer assets excluded).
- Container env carries only `no_proxy`/`NO_PROXY`; no credentialed proxy URL.

## Per-finding mapping (all verdicts are candidates, not VEX)

| Alerts | CVE needs | Why not reachable here |
|---|---|---|
| #10191, #10200, #10258 | TLS server with SNI/OCSP/client-cert policies | No TLS server exists in the bundle |
| #10192, #10194, #10195, #10196, #10197, #10210, #10213 | HTTP/2 server (some + `respondWithFile`/`altsvc` app calls) | No HTTP/2 usage at all; `altsvc`/`respondWithFile` never called |
| #10206 | HTTPS server with flush-then-end handler shape | Only server is cleartext `node:http`, which the advisory states is not affected |
| #10233 | Two requests with differing `ca` policies sharing an Agent cache | Sole outbound TLS uses default policy; no second policy exists |
| #10250 | Credentialed proxy URL from env reaching error sink | No credentialed proxy env; app has no proxy code |
| #10259 | App calling `deflate.params()` while streaming | No such calls in the bundle |
| #10262 | macOS/Windows + `--permission` + another actor creating files | Linux container, launched without `--permission` — platform precondition fails |

## Strongest-first confirmation order

1. #10262 (platform mismatch) and the no-server groups — confirm by asserting the negative on each
   `CODEGRAPH_VERSION` bump (re-grep the bundle; fail the check if a server API appears).
2. #10250 — assert no credentialed `*_PROXY` env in image/entrypoint at scan time.
3. #10233 — assert the update check remains the only outbound TLS and keeps default policy.
4. Rest — same per-bump re-grep plus image rescan showing `fixed`.

## Not claimed

- No runtime probing was performed; a future codegraph release could add servers/features and
  invalidate this note — hence the per-bump re-grep requirement.
- This does not authorize `.grype.yaml` suppression; each suppression still needs advisory +
  package + version scope, reviewer, and expiry.
