# Isolate Admin Test Module State

## Context

The Admin test suite runs under Bun and includes tests that mock modules and mutate process-wide environment variables. The V2 CI job runs Admin tests inside the V2 image, where the runtime's `OMO_ENABLED=0` default differs from the legacy tests' V1 assumptions.

## Problem

- A module-scope `mock.module("node:fs", ...)` polluted other tests and interfered with filesystem-dependent behavior.
- `src/admin/server.test.ts` set `process.env.ADMIN_PASSWORD` at module scope without restoring the caller's environment.
- A partial `mock.module("../lib/agent-model-reconciler", ...)` replaced exports for later test files; CI then reported `TypeError: reconciler.suggestExplicit is not a function`.
- LSP route tests probed the live V2 `ai-dev` container and received HTTP 409 instead of exercising V1 behavior.
- Test files require different `OMO_ENABLED` modes, and fake Docker/environment state can leak when the full suite runs in one process.

## Solution

- Inject filesystem checks such as `composeFileExists` into `createRealCommandDeps()` instead of mocking `node:fs` globally.
- In tests that set `ADMIN_PASSWORD`, save the original value and restore it in `afterAll`; delete it when it was originally unset.
- Inject `isOpenCodeV2` into `createLspRoutes()` so route tests can supply V1/V2 outcomes without probing the live container.
- Set the Admin CI test process to `OMO_ENABLED=1`; V2-specific tests opt into `OMO_ENABLED=0` and restore it.
- Use local test seams rather than a partial `mock.module()` replacement, and run the V2 Admin suite with `bun test --parallel=4` for worker/per-file module isolation.

## Why It Works

Dependency injection limits test doubles to the code path that needs them. A mode baseline per test file preserves V1/V2 expectations, and parallel Bun workers isolate module/global state between files. `process.env` is still mutable process-wide state and must be restored explicitly.

## Side Effects / Tradeoffs

- `createRealCommandDeps()` has one additional dependency parameter with a production default.
- `LspRoutesDeps` has a production-defaulted version detector for deterministic route tests.
- Tests must maintain cleanup logic whenever they mutate process-wide state.
- Four Bun workers use more memory than a serial test run; tests sharing external resources still need unique paths, ports, or project names.
- `--parallel` does not replace explicit setup/cleanup for process environment variables or external resources.

## Evidence

- `bun test` in `/opt/admin`: `Ran 435 tests across 40 files. [8.35s]`, exit code `0`.
- Focused server test: `3 pass`, `0 fail`.
- Docker image rebuild and `ai-admin` recreation completed successfully.
- `git diff --check` passed after the implementation.
- CI run `37784678050`: Admin suite reported `1294 pass`, `0 fail`, `2 skip` across 96 files; V2 integration and typecheck passed.
- The same four route test files passed `68/68` locally under `OMO_ENABLED=1`.
- The V2 integration job's runtime/diagnostics cells and Admin HTTP smoke passed.

## Related Files

- `src/admin/agent/commands.ts`
- `src/admin/agent/commands-restart.test.ts`
- `src/admin/server.test.ts`
- `.github/workflows/ci.yml`
- `src/admin/routes/lsp.ts` / `src/admin/routes/lsp.test.ts`
- `src/admin/routes/agent-models.test.ts`
- `src/admin/routes/providers-oauth.ts` / `src/admin/routes/providers-oauth.test.ts`

## Tags

`bun` `testing` `dependency-injection` `mock-isolation` `environment-cleanup` `OMO_ENABLED` `v2-ci` `admin`
