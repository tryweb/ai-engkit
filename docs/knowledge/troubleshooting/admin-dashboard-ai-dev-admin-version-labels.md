# Dashboard Must Label ai-dev and ai-admin Versions Separately

## Context

The V2 Admin dashboard reads runtime versions from two containers:

- `ai-dev`: `GET /` executes `cat /opt/ai-engkit/VERSION` through `execInAiDev`.
- `ai-admin`: `GET /` reads its own image's `/opt/ai-engkit/VERSION`.

The Admin UI upgrade flow updates and recreates **only ai-dev**. Admin remains
on its old image until separately recreated.

## Problem

The dashboard previously displayed the ai-dev version under the generic label
`AI-EngKit`, while its admin restart warning appeared separately and only when
image digests differed. During a partial upgrade, users could see
`AI-EngKit v2.0.23` and mistake it for the Admin UI version even though
ai-admin was still running v2.0.22.

The `Pinned` badge describes the configured target (`AI_ENGKIT_VERSION`), not
the version currently running in both containers.

## Solution

Commit `e5342ac` separates both runtime versions in the dashboard's Component
Versions table:

- `AI-EngKit (ai-dev)` — version read from the dev container.
- `AI-EngKit Admin (ai-admin)` — version embedded in the admin image.

The pin badge is labelled `Target pin` to distinguish configuration from
runtime state. The existing digest-based restart control remains unchanged;
its message clarifies that ai-admin is running a different image and that
restarting it applies the configured image.

## Why It Works

The two versions are shown regardless of mismatch, so operators do not need
to infer admin's version from a conditional warning. The digest comparison
continues to control the restart action: different image digests may require
recreation even when the version strings happen to match.

## Side Effects / Tradeoffs

- This is a presentation and regression-test change; it does not alter API
  behavior, version discovery, digest detection, or either upgrade path.
- If a version value is unavailable, the table displays `unknown`. The
  existing digest-mismatch logic remains unchanged and may still be unable to
  offer restart when either digest lookup fails.
- The end-to-end validation used a temporary patched dashboard file inside
  the test admin container; that patch was discarded when the admin container
  was recreated from the release image. The committed fix requires a newly
  built/published image before deployment.

## Evidence

- `bun test src/admin/views/dashboard.test.ts src/admin/lib/status.test.ts src/admin/routes/admin.test.ts src/admin/routes/versions.test.ts src/admin/routes/upgrade.test.ts` — 98 passed.
- `bunx tsc --noEmit -p src/admin/tsconfig.json` — passed.
- Playwright on isolated `192.168.11.199`, `v2.0.23` ai-dev / `v2.0.22`
  ai-admin: table showed both versions, digest mismatch was true, and the
  restart warning/button appeared.
- Clicking the Admin restart control recreated ai-admin from the configured
  image. Afterwards both versions were `v2.0.23`, mismatch was false, and
  the Admin restart button was absent.
- The dashboard tests cover skew, aligned versions, same version strings
  with different image digests, missing version strings, and the target-pin
  label.

## Related Files

- `src/admin/server.ts` — dashboard version collection and props.
- `src/admin/views/dashboard.tsx` — runtime version labels, target pin, and restart message.
- `src/admin/views/dashboard.test.ts` — rendering regression tests.
- `src/admin/lib/status.ts` — container version and digest status collection.
- `docs/knowledge/troubleshooting/v2-admin-version-detection-chain-199.md` — version-stepping evidence on prod-199.

## Tags

admin-dashboard, ai-dev, ai-admin, version-labels, digest-mismatch, upgrade, v2
