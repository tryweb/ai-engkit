# Isolate Admin Test Module State

## Context

The Admin test suite runs under Bun and includes tests that mock modules and mutate process-wide environment variables. V2 image tests run in the build image; V2 integration tests run in the Compose admin container. The V2 branch is native-only and no longer uses `OMO_ENABLED` as a mode selector.

## Problem

- A module-scope `mock.module("node:fs", ...)` polluted other tests and interfered with filesystem-dependent behavior.
- `src/admin/server.test.ts` set `process.env.ADMIN_PASSWORD` at module scope without restoring the caller's environment.
- A partial `mock.module("../lib/agent-model-reconciler", ...)` replaced exports for later test files; CI then reported `TypeError: reconciler.suggestExplicit is not a function`.
- LSP route tests probed the live V2 `ai-dev` container instead of injecting the OpenCode capability result.
- Fake Docker/environment state can leak when the full suite runs in one process.

## Solution

- Inject filesystem checks such as `composeFileExists` into `createRealCommandDeps()` instead of mocking `node:fs` globally.
- In tests that set `ADMIN_PASSWORD`, save the original value and restore it in `afterAll`; delete it when it was originally unset.
- Inject `isOpenCodeV2` into `createLspRoutes()` so route tests can supply V1/V2 outcomes without probing the live container.
- Run V2 Admin tests without setting `OMO_ENABLED`; V2 no longer supports a legacy mode.
- Use local test seams rather than a partial `mock.module()` replacement, and run the V2 Admin suite with `bun test --parallel=4` for worker/per-file module isolation.
- V2 fixtures must return wrapped `/api/agent`, `/api/provider` and `/api/model` responses and use `routing.json` chains; V1 arrays, `.omo` config and OMO provider caches are not V2 fixtures.
- Readiness returns `configured` without inference; inference verifies the actual SubAgent request against any configured chain entry, not against the Markdown assignment or a separate V1 model probe.
- `AgentModelStateSource.readRoutingConfig` is required; do not restore the removed `readAgentModelsConfig` fallback to accommodate old mocks.

## Why It Works

Dependency injection limits test doubles to the code path that needs them. Parallel Bun workers isolate module/global state between files. `process.env` is still mutable process-wide state and must be restored explicitly.

## Side Effects / Tradeoffs

- `createRealCommandDeps()` has one additional dependency parameter with a production default.
- `LspRoutesDeps` has a production-defaulted version detector for deterministic route tests.
- Tests must maintain cleanup logic whenever they mutate process-wide state.
- Four Bun workers use more memory than a serial test run; tests sharing external resources still need unique paths, ports, or project names.
- `--parallel` does not replace explicit setup/cleanup for process environment variables or external resources.

## Evidence

- Native-only review fixes: both `bun test --parallel=4` and CI's `bun test --isolate` passed with `1482 pass`, `10 skip`, `0 fail` across 108 files; `bun run typecheck` passed. Existing skips were not increased.

- `bun test` in `/opt/admin`: `Ran 435 tests across 40 files. [8.35s]`, exit code `0`.
- Focused server test: `3 pass`, `0 fail`.
- Docker image rebuild and `ai-admin` recreation completed successfully.
- `git diff --check` passed after the implementation.
- CI run `37784678050`: Admin suite reported `1294 pass`, `0 fail`, `2 skip` across 96 files; V2 integration and typecheck passed.
- Historical note: the same four route test files passed `68/68` under the
  former `OMO_ENABLED=1` legacy mode; that is not V2 release evidence.
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

`bun` `testing` `dependency-injection` `mock-isolation` `environment-cleanup` `v2-ci` `admin`
