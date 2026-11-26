## Context

See `proposal.md` for motivation. The current Agent Models view combines configured assignments, managed-server resolution, and recent successful-request metadata; the validation experiment showed that this can label a model effective after a later child request has timed out. The existing reconciliation already has provider-scoped probe caching and bounded candidate probing, while the normal Apply path intentionally avoids billable inference.

## Goals / Non-Goals

**Goals:**

- Make current usability a fresh, observable proof distinct from configuration and runtime readiness.
- Bound inference verification latency and clean up temporary sessions after timeout, cancellation, or provider failure.
- Preserve a zero-inference readiness Apply and make explicit inference verification cost-aware.
- Prevent timeout, quota, mismatch, and historical-only evidence from authorizing automatic model selection.
- Reuse provider-credential fingerprints, existing probe cache, and per-agent result reporting.

**Non-Goals:**

- Guaranteeing provider availability outside a bounded verification window.
- Probing every catalog model on every Apply or continuously monitoring all providers.
- Treating `/agent`, catalog presence, or historical request metadata as inference proof.
- Changing upstream provider retry behavior or provider quotas.
- Adding persisted fallback chains or a new asynchronous job registry in this change.
- Discovering or selecting OpenRouter free-tier models from the upstream catalog; this change validates configured model references only.

## Decisions

### D1: Separate readiness from usability

Keep `verification=readiness` as the default Apply mode. It proves configuration persistence, managed-server restart, provider connectivity, and runtime loading without a billable message request. Add or retain an explicit `verification=inference` path for current usability proof, with a visible quota/cost warning.

The single-agent PUT inference scope is its target, the batch PUT inference scope is its submitted targets, and `POST /api/agent-models/verify` is a read-only verification operation. That operation accepts an optional agent list; omission means all configured primary models, while an unconfigured selected agent returns `unconfigured` without inference.

**Alternative rejected:** Make every Apply perform inference. The experiment demonstrated that a provider gateway timeout can hold a synchronous parent task for many minutes and can spend quota unnecessarily.

### D2: Use fresh proof as the effective-state authority

Represent configured, runtime-loaded, historical-request, and fresh-verification fields independently. Only a fresh non-empty assistant response whose provider/model metadata exactly matches the requested values can produce `verified`/`effective` usability. Historical successful-request metadata remains useful evidence but cannot override a newer timeout or aborted verification.

**Alternative rejected:** Continue deriving `effective` from configured/assigned equality plus the last successful request, because that hides current provider failure.

### D3: Add a bounded timeout terminal state

Apply an outer 90-second per-inference deadline and a total 300-second verification deadline around the temporary-session operation. On timeout, cancel/delete the temporary session, record `timeout`/`unverified`, complete the parent operation, and prevent another equivalent retry in the same decision. Treat HTTP 429 and provider quota markers as terminal `quota_exceeded` results for the current probe; do not add another retry on top of OpenCode's retry policy. Preserve configuration for timeout and other inconclusive outcomes.

**Alternative rejected:** Rely on the provider SDK's retry policy. The Metis evidence showed repeated five-minute gateway timeouts with the parent task still running and no terminal child result.

### D4: Keep model health and agent routing as separate measurements

Record model-level health by provider/model/credential fingerprint and agent-level routing by the completed child execution metadata. A child can route to the expected agent while its model is retired or timed out; that is routing success but usability failure. Deduplicate health probes by provider/model/fingerprint, while retaining agent probes when the requirement is to verify OMO routing itself.

**Alternative rejected:** Use one aggregate `effective` boolean, which cannot distinguish routing correctness from provider usability.

### D5: Preserve fail-open reconciliation

Automatic reconciliation may replace only conclusively unavailable or retired assignments when a replacement is freshly healthy. Timeout, quota, transient, unreachable, mismatch, and exhausted-budget outcomes preserve the current configuration and surface the result. A model is never auto-selected solely because it is visible or assigned.

### D6: Use bounded cost and cache policy

Probe at most once per distinct provider/model/credential fingerprint in a decision, with concurrency no greater than 3 and the existing maximum of 12 distinct probes per run. Cache confirmed health for 24 hours, transient/unreachable/timeout outcomes for 5 minutes, and quota outcomes for 15 minutes; invalidate the affected provider on credential mutation. The explicit verification action should report the expected number of inference probes before execution when it can be calculated. Model-level deduplication reduces cost, but the response remains per-agent so routing results are not lost.

### D7: Treat known harness limitations separately

The `build` agent and direct `Sisyphus-Junior` subagent-type calls remain excluded from model usability statistics because they are unsupported invocation paths in the current harness. Category routes through `Sisyphus-Junior` remain valid routing tests. This prevents harness capability failures from being misreported as provider/model failures.

## Risks / Trade-offs

- **[Risk] A healthy proof can become stale after provider-side changes** → Show verification age, scope cache by credential fingerprint, and provide explicit re-verification.
- **[Risk] Unknown provider timeout markers may be classified as transient** → Preserve an unverified state, bound all retries, and add fixtures for observed 504 responses without treating unknown errors as healthy.
- **[Risk] Explicit verification consumes quota** → Keep it opt-in, use a minimal prompt, deduplicate model probes, cache results, and warn before execution.
- **[Risk] A timeout may leave provider-side work running** → Cancel and delete the temporary session locally; do not wait indefinitely for provider acknowledgement.
- **[Risk] Different agents may share one model** → Reuse model-level health proof for cost control, but run separate routing verification where agent-specific OMO resolution is part of acceptance.

## Migration Plan

1. Extend result/state types and API/UI rendering without changing persisted configuration format.
2. Add deterministic tests for fresh-proof precedence, timeout/cancellation cleanup, stale history, and each terminal classification.
3. Wire the explicit inference verification path to the bounded probe and provider-scoped cache.
4. Keep readiness Apply as the default and verify it issues no billable inference request.
5. Run a credential-gated end-to-end verification for selected agent routes, recording model-level and agent-level evidence separately.
6. Roll back by disabling explicit verification UI/route changes; persisted primary model format remains compatible.
