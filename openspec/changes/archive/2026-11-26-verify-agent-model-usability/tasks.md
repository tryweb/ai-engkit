## 1. State and result contract

- [x] 1.1 Extend Agent Models result types with separate configured, runtime-loaded, historical-request, and fresh-verification fields; verify type/unit tests distinguish these states.
- [x] 1.2 Add explicit statuses for healthy, retired, unavailable, quota-exceeded, mismatch, timeout, unreachable, and aborted verification; verify classifier fixtures cover each status without exposing credentials.

## 2. Bounded usability verification

- [x] 2.1 Implement explicit inference verification using the existing temporary-session probe path; verify only a non-empty assistant response with matching provider/model metadata becomes healthy.
- [x] 2.2 Enforce a 90-second per-request and 300-second total verification deadline; treat quota/rate-limit results as terminal for the current probe, verify a simulated Gateway Timeout returns a terminal unverified result, and never leave a pending task loop.
- [x] 2.3 Cancel and clean up temporary sessions on timeout, cancellation, quota failure, and provider error; verify cleanup runs on every exit path.
- [x] 2.4 Reuse provider/model/credential-fingerprint cache entries with healthy, transient, timeout, and quota TTLs; verify credential mutation invalidates only the affected provider.

## 3. Apply and reconciliation behavior

- [x] 3.1 Preserve readiness-only Apply as the default and prove it issues no billable inference request; verify existing readiness Apply tests remain green.
- [x] 3.2 Add read-only `POST /api/agent-models/verify` with single-agent, selected-agent, and all-configured-agent scopes; verify it does not write configuration or restart managed OpenCode and returns `unconfigured` without inference for agents lacking a primary.
- [x] 3.3 Wire explicit inference Apply and verification-only actions as cost-labeled user actions with bounded frontend/backend deadlines; verify timeout produces an actionable terminal UI state.
- [x] 3.4 Prevent historical successful-request metadata, `/agent` equality, catalog visibility, and provider connectivity from marking a model usable; verify stale-history regression tests report unverified.
- [x] 3.5 Update automatic reconciliation to select only fresh healthy candidates and preserve configuration for timeout, quota, mismatch, unreachable, and exhausted-budget outcomes; verify EOL replacement and timeout fail-open tests.

## 4. Admin presentation and observability

- [x] 4.1 Render configured, runtime-loaded, last-request, and current-usability statuses separately with verification age and non-secret failure reason; verify the Metis timeout scenario is not shown as effective.
- [x] 4.2 Show explicit quota/cost and timeout messaging for inference verification while keeping readiness Apply zero-inference; verify duplicate submission is disabled until the bounded operation terminates.
- [x] 4.3 Keep unsupported harness routes (`build` and direct `Sisyphus-Junior`) outside model health metrics; verify route statistics distinguish harness-invalid from provider/model failure.

## 5. End-to-end verification and rollout

- [x] 5.1 Add credential-gated end-to-end coverage for one healthy route, one retired/unavailable route, one timeout route, and one agent-routing mismatch; verify each status is persisted and reported correctly.
- [x] 5.2 Add a read-only verification sweep that records model-level health separately from agent-level routing and proves `~/.omo/omo.jsonc` is byte-identical before and after; verify no configuration mutation occurs.
- [x] 5.3 Run the Admin test suite, focused model-probe/reconciliation tests, and OpenSpec strict validation; verify all pass and document any unrelated pre-existing type-check failures.
- [x] 5.4 Perform a production-like smoke test with a bounded inference deadline and inspect the rendered Admin Agent Models state; verify no child session or UI operation remains indefinitely pending.
