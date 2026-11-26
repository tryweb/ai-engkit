## Why

The Agent Models validation showed that a configured and historically successful model is not necessarily usable now: four configured NVIDIA models returned `410 Gone`, while the Metis model repeatedly returned `504 Gateway Timeout` and left its parent task running until aborted. The current UI and runtime state can therefore overstate model health, while the existing readiness-only Apply path intentionally avoids billable inference and cannot satisfy the original usability requirement by itself.

## What Changes

- Define fresh inference usability as a separate, explicit verification result; catalog visibility, provider connectivity, `/agent` resolution, and historical request metadata remain non-proof states.
- Define verification scope explicitly: single-agent Apply verifies its target, batch Apply verifies its targets, and a read-only verification action can verify selected agents or all configured primary models without rewriting or restarting configuration.
- Add bounded model/agent verification with a hard deadline, finite retry policy, temporary-session cleanup, and terminal handling for timeout, retired, unavailable, quota, and mismatch outcomes.
- Prevent models without fresh matching provider/model response metadata from being reported as `effective` or selected automatically.
- Preserve readiness-only Apply as the zero-inference-cost default, while exposing an explicit cost-labeled usability verification path.
- Show verification age and current verification status separately from configured and runtime-loaded state.
- Cache proof by provider, model, and provider-credential fingerprint to limit repeated inference cost and invalidate it after credential changes.

## Capabilities

### New Capabilities

<!-- None: this change tightens existing Agent Models and reconciliation contracts. -->

### Modified Capabilities

- `admin-agent-model-config`: distinguish configured/runtime-ready state from fresh inference usability and expose bounded explicit verification results.
- `agent-model-reconciliation`: require fresh matching inference proof for automatic usability claims and bound timeout/retry behavior.

## Impact

- Admin Agent Models API and UI status/result types.
- Agent model live-state aggregation and historical request handling.
- Temporary-session model probing, retry/deadline handling, cleanup, and provider-scoped health cache.
- Automatic reconciliation and candidate selection.
- Tests and documentation for model-level health versus agent-level routing.
