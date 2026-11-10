# Admin Unit-Test Harness Pitfalls

## Context

`bun test src/admin` for the Admin UI backend (`src/admin/lib`,
`src/admin/routes`). Stubs fake `exec` per command.

## Problem

Three independent harness quirks each produced misleading red tests that
looked like product bugs:

1. **`OMO_ENABLED` env flips the backend under test.** `createAgentModelsLib`
   picks the routing backend when `deps.readEnv()["OMO_ENABLED"] === "0"` **or**
   `process.env.OMO_ENABLED === "0"`. A shell with `OMO_ENABLED=0` (normal in
   this dev container) silently switches 18 tests to the routing backend and
   they fail. Canonical invocation: `env -u OMO_ENABLED bun test <path>`.
2. **bun 1.4.2 `toMatchObject` mishandles nested asymmetric matchers.**
   `expect(obj).toMatchObject({ error: expect.stringContaining("x") })` fails
   even when the string contains `x` (verified in isolation). Use two-step
   assertions: `toMatchObject` for shape + `toContain` on the extracted
   string field.
3. **Route-test stubs are persistent, not one-shot.** `stubDeps` in
   `src/admin/routes/agent-models-test-support.ts` returns the same stdout
   for every matching exec. Any code under test that re-reads a file (e.g. a
   post-apply read-back) observes stale pre-write state. Feed ordered states
   via a counting wrapper around `deps.exec` (match the config-read command,
   serve `[pre, pre, post]`, last repeats).

## Solution

- Always run the full `src/admin` tree for shared-path changes
  (`applyAndVerifyBatch` is exercised by lib tests, route tests, and
  reconciler tests); subsets hide cross-file breakage — this exact miss
  broke CI (`Admin unit tests` step) after local subsets were green.
- New tests that must run under a specific backend pin `process.env`
  explicitly with save/restore (`delete` when previously unset), so they
  pass regardless of the runner's environment.
- e2e (`e2e/`) needs `launchOptions.executablePath` pointed at
  `/ms-playwright/chromium-*/chrome-linux64/chrome`; the pinned
  `@playwright/test` headless-shell revision is absent. Known unrelated
  failure: `lsp.spec.ts` typescript toggle — the row renders Built-in with
  no toggle in dev, so the check times out (environmental, not a product
  regression).

## Why It Works

Each rule removes one source of false signal: env-pinned backends make
results runner-independent, `toContain` avoids the broken matcher path,
ordered read states let write-then-verify code be tested honestly, and
full-tree runs catch shared-path fallout before CI does.

## Side Effects / Tradeoffs

- `env -u OMO_ENABLED` is tribal knowledge until the harness defaults it;
  changing the harness default is out of scope here.
- The counting wrapper must match the exact number of pre-reads
  (batch PUT: 1 pre-read; single PUT via `applyAgent`: 2); miscounts fail
  loudly, which is preferable to silent staleness.

## Evidence

- 18 failures with `OMO_ENABLED=0` in shell vs 36/36 pass with `env -u`.
- Isolated `toMatchObject` + nested `stringContaining` repro failed on
  bun 1.4.2; `toContain` on the same string passed.
- CI job `Build Image → Admin unit tests` failed on 4 route tests after a
  lib-only green run; fixed by ordered read states; then `src/admin` full
  tree: 1297 pass, 0 fail.
- e2e with workaround config: 17 passed, 1 failed (LSP toggle only).

## Related Files

- `src/admin/lib/agent-models.test.ts`
- `src/admin/routes/agent-models.test.ts`
- `src/admin/routes/agent-models-test-support.ts`
- `e2e/playwright.config.ts`

## Tags

- testing
- bun
- stub
- ci
- e2e
