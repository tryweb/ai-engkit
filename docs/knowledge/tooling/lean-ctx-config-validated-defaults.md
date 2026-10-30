# lean-ctx v3.9.20 Validated Configuration Defaults

## Context

AI-EngKit pinned lean-ctx v3.9.20 at the time of that reconciliation (current pin: v3.12.0, see `Dockerfile`) and exposes selected settings through the Admin editor. GitHub issue #68 requested reconciling AI-EngKit's baseline with the runtime schema after stress testing.

## Problem

`lean-ctx config validate` accepts unknown keys, so a successful validation does not prove that a setting is active. The v3.9.20 schema does not contain `cognitive_mode`, `search.candidate_count`, `loop_detection.enabled`, `loop_detection.max_calls_per_tool`, `loop_detection.max_total_calls`, `boundary_policy.universal_gotchas`, `proxy.enabled`, `proxy.port`, or `secret_detection.redact_in_archive`, although earlier AI-EngKit configuration surfaces exposed them.

The supported security controls are `secret_detection.enabled` and `secret_detection.redact`. Both default to `true`, but relying only on upstream defaults would leave AI-EngKit's security policy implicit.

## Solution

- Treat `lean-ctx config schema` as the authority for supported keys; use `config validate` only for value and TOML validation.
- Pin `secret_detection.enabled = true` and `secret_detection.redact = true` in `docker/lean-ctx/config.default.toml`.
- Remove the schema-proven inert keys from the Admin schema and baked baseline.
- During startup, remove those inert keys from persisted runtime configuration and backfill missing dotted baseline keys.
- Keep `compression_level = "lite"`, `graph_index_max_files = 5000`, routing policy, archive, autonomy, boundary policy, and tool profile unchanged unless a separate workload evaluation supports changing them.

## Why It Works

The Admin editor can no longer serialize controls that v3.9.20 ignores. New containers receive the explicit security baseline, while existing containers converge through the same baseline backfill path without replacing unrelated user settings.

## Side Effects / Tradeoffs

- Existing values for the removed keys are discarded because the runtime cannot honor them.
- Dotted baseline keys now participate in missing-key backfill; existing values remain untouched.
- This does not make `config validate` strict and does not dynamically mirror every upstream schema key.
- Routing remains fail-closed under the existing G0 decision.

## Evidence

- `lean-ctx --version` returned `3.9.20` on the host and in `ai-engkit-dev`.
- `lean-ctx config schema` contained `secret_detection.enabled` and `secret_detection.redact`, but none of the removed keys.
- `printf 'loop_detection.enabled = true\n' | lean-ctx config validate -` exited successfully, confirming lenient unknown-key handling.
- A synthetic `ghp_` token was replaced with `[REDACTED:API key param]` through both `ctx_read` and `ctx_shell`.
- `bun test src/admin/lib/leanctx-schema.test.ts` passed 4/4 after first failing against the old schema.
- `bash entrypoint.d/02-init-config.test.sh` passed after first failing against root-only baseline backfill.
- The focused Admin suite passed 44/44, the rebuilt-container integration suite passed 133/133, and the LeanCTX browser E2E suite passed 5/5.

## Related Files

- `docker/lean-ctx/config.default.toml`
- `src/admin/lib/leanctx-schema.ts`
- `src/admin/lib/leanctx-schema.test.ts`
- `entrypoint.d/02-init-config.sh`
- `entrypoint.d/02-init-config.test.sh`
- `test/run-tests.sh`
- `docs/knowledge/maintenance/lean-ctx-reliability-evaluation.md`

## Tags

`lean-ctx`, `configuration`, `security`, `migration`, `issue-68`
