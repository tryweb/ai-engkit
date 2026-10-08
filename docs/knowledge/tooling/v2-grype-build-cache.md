# Remove Build-Only Bun Cache Artifacts from V2 Images

## Context

The V2 Dockerfile bundles self-contained OpenCode plugins and performs a root-owned Bun install during the image build. Grype scans the final image filesystem, including package-cache files that are not runtime dependencies.

## Problem

- CI run `37773598370` found 16 new Critical/High findings, including `stdlib@go1.26.4` and `golang.org/x/text@v0.38.0`.
- SARIF alert `GO-2026-6629` identified `golang.org/x/text` v0.38.0 at `/root/.bun/install/cache/@typescript/typescript-linux-x64@7.0.2@@@1/lib/tsc`.
- Updating the V2 Buildx and GLab pins did not clear the same findings; the root Bun cache was still in the final image.

## Solution

After the Admin install, prune only the cached TypeScript native compiler in V2 builds:

```dockerfile
RUN if [ "$OPENCODE_CLI_PACKAGE" = "@opencode/cli" ]; then rm -rf /root/.bun/install/cache/@typescript; fi
```

Keep the cleanup gated on `OPENCODE_CLI_PACKAGE=@opencode/cli` so V1 builds are unchanged.

## Why It Works

The V2 plugins are emitted as self-contained bundles before the cache is removed. The cache entry is not required by the Admin runtime; the post-cleanup image build, Admin tests/typecheck, and V2 integration job verify that runtime files remain usable.

## Side Effects / Tradeoffs

- The V2 image no longer contains the cached `@typescript` native compiler; if a future runtime path needs it, install it outside the disposable package cache.
- Keep the cleanup narrow. Removing the entire Bun cache could affect unrelated packages installed into the Admin image.

## Evidence

- CI run `37773598370`: the Grype release gate reported 16 new Critical/High findings, including Go stdlib 1.26.4 and x/text 0.38.0.
- SARIF `GO-2026-6629`: the scanned x/text v0.38.0 package was located under the root Bun cache path above.
- CI run `37784678050`: V2 Vulnerability Scan passed with “No new Critical/High findings relative to the published image.”
- The same run passed V2 image build, Admin tests/typecheck, integration checks, and GHCR publication.

## Gate Scope vs Security Tab (verified with gh, 2026-10-09)

The release gate and the Security tab report different things, so a green scan
can coexist with a Security tab that is not clean:

- The gate (`.github/scripts/grype-release-check.sh`) compares the candidate
  against the baseline image and blocks only **new** Critical/High findings.
- The SARIF upload (`category: sca-grype-v2`, `severity-cutoff: critical`)
  populates the Security tab with the image's findings regardless of baseline.

Verified state after run `37784678050` (commit `2717d8e`):

- The latest `sca-grype-v2` analysis reported `828` results.
- `gh api "repos/tryweb/ai-engkit/code-scanning/alerts?ref=refs/heads/trial/opencode-v2&tool_name=Grype&state=open"`
  returned 100 open alerts on page 1 (7 high / 63 medium / 26 low / 4 note)
  while the gate stayed green.
- The x/text alert `GO-2026-6629` is now state `fixed`; its
  `most_recent_instance.location.path` is exactly
  `ai-engkit-ai-v2//root/.bun/install/cache/@typescript/typescript-linux-x64@7.0.2@@@1/lib/tsc`.

Implication: a green V2 scan does **not** mean a clean Security tab. Code
scanning alerts are ref-scoped — query the trial ref explicitly
(`?ref=refs/heads/trial/opencode-v2`), otherwise the API returns only the
default branch's alerts and the V2 findings look absent.

## Related Files

- `Dockerfile` — V2-only cache cleanup after Admin package installation.
- `.github/scripts/grype-release-check.sh` — blocks new Critical/High findings relative to the baseline.
- `.github/workflows/ci.yml` — V2 scan and publish pipeline.

## Tags

`v2` `grype` `bun-cache` `typescript-native` `go-vulnerability` `dockerfile`
