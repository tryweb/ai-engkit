# Tasks

## 1. Define the Compose integration contract

- [x] 1.1 Add optional `LEANCTX_MCP_WRAPPER` to the `ai-dev` service environment only; run `docker compose config --format json` with unset and configured values, parse only the two service environment maps, and assert the variable is set only for `ai-dev` without logging other environment values.
- [x] 1.2 Document the variable in `.env.example` and README: unset preserves `lean-ctx`, configured value is an absolute executable path inside the existing `opencode-config` volume, wrapper installation precedes setting it, and changing it requires recreating `ai-dev`; verify the examples match Compose behavior.

## 2. Validate and generate the LeanCTX MCP command

- [x] 2.1 Add `entrypoint.d/00-leanctx-mcp-wrapper.sh` and register it as a signal-responsive hard preflight in `entrypoint.sh`; test unset/empty and a valid absolute executable path pass, while relative, missing, symlinked, and non-executable paths fail with a clear message before `opencode.json` is written (`entrypoint.d/02-init-config.test.sh` passes).
- [x] 2.2 Update `entrypoint.d/02-init-config.sh` to emit `['lean-ctx']` when unset and `[LEANCTX_MCP_WRAPPER]` when valid, using safe JSON encoding; after all startup config writers, atomically reassert a configured override only when set, preserving the unset path's existing `lean-ctx init` behavior.
- [x] 2.3 Extend `entrypoint.d/02-init-config.test.sh` and dev integration checks to simulate later initialization rewriting the MCP command, verify wrapper reapplication changes no unrelated config, cover persistence after container recreation, fail-closed validation, and the ai-dev-only Compose contract; run shell and relevant Compose tests. Verified shell tests, `test/run-tests.sh ai-engkit-dev` (128 pass), and default/override disposable Compose startup/recreation checks.

## 3. Validate the shipped image contract

- [x] 3.1 Build the AI-EngKit image and run the entrypoint tests inside it; inspect generated `opencode.json` in a disposable dev Compose project for default and wrapper override, and verify a recreated `ai-dev` regenerates the same override without changing other MCP entries. Verified image `ai-engkit-mcp-contract-test:local`, in-image entrypoint tests, default `['/usr/local/bin/lean-ctx']` post-init behavior, configured path with spaces, unrelated MCP config, and override persistence after recreation.
- [x] 3.2 Update AI-EngKit release documentation/changelog with the new optional env contract and confirm a normal installation with the variable unset is behavior-identical. Documented in README and `docs/CHANGELOG.md`; unset disposable startup retained the existing post-init command.

## Workflow follow-up

- Release the AI-EngKit version containing the new contract before the ep-design-ai-srv wrapper wiring can be considered durable on `.197` or `.66`.
- After AI-EngKit rollout, set `LEANCTX_MCP_WRAPPER` in the AI-EngKit host `.env` only after the wrapper has been installed into `ai-engkit_opencode-config`; recreate `ai-dev` in a review-idle window, then run the wrapper canary and verify the actual wrapper process is active.
