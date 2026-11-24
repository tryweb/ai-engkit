# Admin test environment isolation

## Context

Admin contains both V1 compatibility tests and native V2 tests. The dev container
exports `OMO_ENABLED=0`; CI and a developer shell can therefore select different
code paths without any source change.

## Problem

- Legacy model, upgrade, and restart fixtures expected V1 behavior but inherited
  V2 mode: wrong agent/config shapes, `.env.v2`, V2 compose assets and image tags.
- Importing `server.ts` scheduled Agent and maintenance/auth scheduler startup,
  connecting to a real Center during unit tests.
- Running Playwright specs with `bun test` produced module-load errors rather
  than browser results. Shared module mocks could also conceal failures.
- Parallel workers also shared `$HOME/.cache/openchamber/agent-model-reconcile.lock`.
  Module isolation does not isolate files: a competing worker caused `EEXIST`
  and a no-op reconciliation, reproducing 14 failures. Several fixtures also
  deleted this shared lock, potentially removing another writer's lock.

## Solution

- Pin V1 fixture mode with save/restore hooks; keep explicit V2 test cases and
  add V2 restart/upgrade path assertions. Never force all CI tests into V1 mode.
- Gate background startup with `import.meta.main`; leave the declarative Bun
  server export unchanged. Test that importing the app starts no Agent or
  maintenance scheduler.
- Run unit tests with `bun test --isolate` or the Admin package `test` script.
  Root `bunfig.toml` excludes `e2e/**`; run those with Playwright separately.
- Use a disposable `HOME` when checking independence from user configuration;
  run mutating browser specs only against disposable containers.
- Inject `AgentModelsDeps.reconcileLockPath` into every reconciler test fixture.
  `createTestReconcileLock()` allocates a private temporary directory and removes
  it after the test. Never delete the real HOME lock in test setup.
- Keep lock contention coverage: another owner's held lock must block work
  without being removed; work resumes after release, independent fixture paths
  do not interfere, and exceptions release locks. Keep the concurrent-run test.

## Why It Works

Fixtures select the contract they exercise, not the shell's deployment mode.
File isolation prevents module mocks from leaking across suites; import-safe
startup prevents unit tests from launching production background services.
Temporary lock namespaces isolate filesystem state between workers while the
production default lock path and locking behavior remain unchanged.

## Side Effects / Tradeoffs

- Importing the application no longer starts background services; executing
  `bun run server.ts` remains the production startup path.
- Eight pre-existing legacy LeanCTX prove-report tests remain skipped because
  that command was removed in 3.12.
- The opt-in external-network Docker runtime suite remains disabled by default;
  its test and hook account for two additional skips.

## Evidence

Initial validation on 2026-11-24 with Bun 1.4.4 (did not establish
filesystem isolation; the later Bun 1.4.5 dev-container gate exposed the race):

- Root `bun test`, `bun test --isolate`, and `bun test --parallel=4`:
  **1610 pass, 10 skip, 0 fail** across 121 files.
- Isolated runs with inherited `OMO_ENABLED=0` (temporary `HOME`) and
  `OMO_ENABLED=1`: **1610 pass, 10 skip, 0 fail**.
- No `Agent: connected` or reconnect messages in the isolated/parallel logs
  after the startup guard.
- `bun run --cwd src/admin typecheck` passes.
- All **18 Playwright tests pass** against disposable V2 containers; the LSP
  browser tests assert disabled controls and HTTP 409 on V2 mutations rather
  than trying to install language servers.
- Executing `server.ts` in the disposable stack still starts the background
  callback: DB and host maintenance endpoints report `isStarted: true`.

Filesystem-isolation follow-up, 2026-11-24:

- Checkout parallel suite with a pre-existing default lock in a temporary HOME:
  **1613 pass, 10 skip, 0 fail**; the lock owner's marker remains unchanged.
- Rebuilt image and actual dev Admin container (Bun 1.4.5), no forced V1 mode:
  `bun --cwd /opt/admin test --parallel=4` gives
  **1525 pass, 10 skip, 0 fail**. The dev run passes twice.
- Five reconciler files repeated five times with four workers:
  **215 pass, 0 fail**, including lock contention and exception cleanup.
- Checkout and dev-container typechecks and `git diff --check` pass.
- Extra full-suite `--rerun-each=3` exposes four `provider-meta.test.ts`
  failures. These also reproduce in the pre-fix image
  `46a209cf7051` with that file alone repeated three times (26 pass, 4 fail);
  they are a separate existing test re-entry issue, not evidence of lock
  isolation failure. Do not describe that stress run as passing.

## Related Files

- `src/admin/server.ts`
- `src/admin/server.test.ts`
- `src/admin/lib/agent-models.test.ts`
- `src/admin/lib/agent-model-reconciler.test.ts`
- `src/admin/lib/agent-model-reconciler-test-support.ts`
- `src/admin/lib/agent-model-types.ts`
- `src/admin/lib/upgrade.test.ts`
- `src/admin/agent/commands-restart.test.ts`
- `bunfig.toml`
- `.github/workflows/ci.yml`
- `CONTRIBUTING.md`

## Tags

`testing` `bun` `v2` `environment-isolation` `agent-models`
