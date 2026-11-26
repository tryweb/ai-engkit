## Purpose

Keep Agent Model assignments usable at startup, after provider credential changes, and after an Admin model save by combining deterministic selection with real inference proof and provider-scoped health caching.

## Requirements

### Requirement: Reconciliation triggers
The system SHALL trigger Agent Model reconciliation only when managed OpenCode becomes ready during startup, after a successful provider credential mutation, or when an Admin saves an Agent Model. Provider credential mutations SHALL include API-key add, activate, and delete, plus OAuth apply and disconnect. Provider-definition edits and runtime request errors SHALL NOT trigger reconciliation under this capability.

#### Scenario: Startup readiness triggers reconciliation
- **WHEN** managed OpenCode first becomes ready during container startup
- **THEN** the system runs Agent Model reconciliation once for all configurable Agents

#### Scenario: API-key mutation triggers reconciliation
- **WHEN** an Admin successfully adds, activates, or deletes a provider API key
- **THEN** the system invalidates health results for that provider and runs reconciliation after managed OpenCode is ready with the changed credential

#### Scenario: OAuth mutation triggers reconciliation
- **WHEN** an Admin successfully applies or disconnects a provider OAuth credential
- **THEN** the system invalidates health results for that provider and runs reconciliation after managed OpenCode is ready with the changed credential

#### Scenario: Agent Model save triggers reconciliation
- **WHEN** an Admin submits a valid `PUT /api/agent-models/:agent` request
- **THEN** the system applies and verifies that Agent's requested primary through the reconciliation policy

### Requirement: Serialized reconciliation
The system SHALL permit only one reconciliation writer at a time across all trigger sources. If one or more triggers arrive while reconciliation is running, the system SHALL retain pending work and run reconciliation again after the active run completes. It MAY coalesce redundant pending triggers that affect the same scope.

#### Scenario: Trigger arrives during active reconciliation
- **WHEN** a provider credential mutation occurs while startup reconciliation holds the write lock
- **THEN** the active run completes before a subsequent run evaluates the changed provider credential

#### Scenario: Redundant pending triggers are coalesced
- **WHEN** multiple Agent Model saves for the same Agent arrive while one run is active
- **THEN** the system MAY process them in one subsequent run using the latest accepted configuration request

### Requirement: Real usability proof
The system SHALL distinguish catalog visibility, provider connectivity, runtime assignment, and real model usability. A model SHALL be eligible for automatic assignment only when it exists in the connected-provider catalog and a bounded temporary-session inference request succeeds with a non-empty response whose metadata matches the requested provider and model. Catalog visibility, connectivity, `/agent` resolution, or historical request metadata alone SHALL NOT mark a model healthy. Provider quota exhaustion, gateway timeout, request timeout, cancellation, or aborted child execution SHALL be treated as inability to prove usability and SHALL NOT authorize automatic replacement or selection.

#### Scenario: Visible model fails inference
- **WHEN** a model appears in the connected catalog but its temporary-session inference reports unavailable or retired
- **THEN** the system does not select that model automatically

#### Scenario: Inference resolves another model
- **WHEN** temporary-session inference succeeds but response metadata identifies a different provider or model
- **THEN** the system classifies the result as mismatch and does not treat the requested model as healthy

#### Scenario: Inference confirms requested model
- **WHEN** bounded temporary-session inference returns a non-empty assistant response with metadata matching the requested provider and model
- **THEN** the system classifies that model as healthy for the current provider credential

#### Scenario: Provider quota prevents proof
- **WHEN** temporary-session inference reports free-usage exhaustion, insufficient quota, or an equivalent terminal billing limit
- **THEN** the system does not classify the model as healthy, does not automatically replace the current configuration, and reports a quota-limited result

#### Scenario: Gateway timeout prevents proof
- **WHEN** temporary-session inference reaches its hard deadline or the provider returns a gateway timeout
- **THEN** the system classifies the result as timeout/unverified, does not classify the model as healthy, and does not leave the reconciliation task running indefinitely

### Requirement: Provider-scoped probe cache
The system SHALL scope each cached probe result to the provider ID, the model reference, and a fingerprint derived only from that provider's canonical auth-store entry. A credential change SHALL cause cache misses for the affected provider without invalidating unrelated providers. The system SHALL eagerly remove affected-provider entries after a successful API-key or OAuth mutation and SHALL also reject a cached result when the current provider fingerprint differs. Credentials and fingerprints SHALL NOT be exposed through logs or APIs.

#### Scenario: Key rotation invalidates one provider
- **WHEN** provider A's active API key changes while provider B is unchanged
- **THEN** provider A's models require new probes and provider B's unexpired cached results remain reusable

#### Scenario: OAuth credential change invalidates cached proof
- **WHEN** an OAuth apply or disconnect changes a provider's canonical auth-store entry
- **THEN** the next reconciliation does not reuse probe results created with the previous fingerprint

#### Scenario: Unchanged provider reuses valid proof
- **WHEN** the provider credential fingerprint and model reference are unchanged and the cached result has not expired
- **THEN** reconciliation MAY reuse that cached result without another inference request

### Requirement: Deterministic single-primary fallback selection
The system SHALL persist at most one primary model per Agent. It SHALL keep a configured primary when its provider is connected and real inference proves it healthy. For an Agent without a configured primary, the system SHALL first verify the runtime-resolved default and SHALL leave the Agent unset when that default is healthy. When candidate selection is required, the system SHALL rank connected-catalog models by the existing capability policy for the Agent's category and SHALL use the complete model reference as an ascending stable tie-breaker. It SHALL probe candidates in that order and persist only the first model proven healthy.

#### Scenario: Healthy configured primary is unchanged
- **WHEN** an Agent's configured primary is connected and real inference proves it healthy
- **THEN** reconciliation leaves that assignment unchanged

#### Scenario: Healthy resolved default stays inherited
- **WHEN** an Agent has no configured primary and its runtime-resolved default is healthy
- **THEN** reconciliation leaves the Agent unset and does not materialize the resolved default into configuration

#### Scenario: Candidate ranking is deterministic
- **WHEN** two connected candidates have the same capability score for an Agent
- **THEN** reconciliation probes the lexicographically smaller complete model reference first

#### Scenario: First healthy candidate becomes primary
- **WHEN** candidate selection is required and earlier ranked candidates are conclusively unusable before a later candidate proves healthy
- **THEN** reconciliation persists only that first healthy candidate as the Agent's primary

### Requirement: Conclusive replacement and fail-open behavior
The system SHALL replace a configured primary automatically only when its provider is disconnected or real inference conclusively reports `unavailable` or `retired`. It SHALL NOT change the current configuration when the current or resolved-default probe reports `retryable`, `unreachable`, `timeout`, `quota_exceeded`, or `mismatch`, when the probe budget is exhausted, or when no candidate is proven healthy.

#### Scenario: Disconnected configured provider permits replacement
- **WHEN** an Agent's configured primary belongs to a disconnected provider and a ranked candidate proves healthy
- **THEN** reconciliation replaces the primary with that healthy candidate

#### Scenario: Retired configured model permits replacement
- **WHEN** an Agent's configured primary probe reports `retired` and a ranked candidate proves healthy
- **THEN** reconciliation replaces the primary with that healthy candidate

#### Scenario: Timeout preserves configuration
- **WHEN** an Agent's current-model or candidate probe reaches its deadline or reports a gateway timeout
- **THEN** reconciliation preserves the current configuration, records an actionable unverified result, and does not retry indefinitely

#### Scenario: Inconclusive current-model probe preserves configuration
- **WHEN** an Agent's current-model probe reports `retryable`, `unreachable`, `quota_exceeded`, or `mismatch`
- **THEN** reconciliation leaves that Agent's configuration unchanged

#### Scenario: No healthy candidate preserves configuration
- **WHEN** candidate selection finds no proven-healthy model within the run budget
- **THEN** reconciliation makes no change for that Agent

#### Scenario: Invalid configured reference preserves configuration
- **WHEN** an Agent's configured primary is not a valid provider/model reference
- **THEN** reconciliation classifies it as `mismatch`, leaves the configured reference unchanged, and does not replace it with a healthy candidate

### Requirement: Bounded probing
Each reconciliation run SHALL enforce configured limits on concurrent inference probes, distinct provider-credential/model combinations, per-request execution time, and total run time. Each inference request SHALL have a hard 90-second deadline and each reconciliation run SHALL have a hard 300-second deadline. A transient HTTP 429 MAY be retried once after honoring `Retry-After` up to 60 seconds; gateway timeout, timeout, quota, cancellation, and aborted results SHALL NOT be retried automatically. The system SHALL stop probing for an Agent after selecting its first healthy candidate and SHALL NOT scan the complete catalog solely to populate cache health. Confirmed healthy results SHALL remain reusable for 24 hours; retryable, unreachable, and timeout results SHALL remain reusable for 300 seconds; and quota-exhausted results SHALL remain reusable for 900 seconds. The cache SHALL remain scoped to provider/model/credential fingerprint. When a provider/model returns a terminal quota-exhausted result, the system SHALL stop equivalent probes for that provider/model during the run and SHALL defer new probes until the 900-second cooldown expires. A timeout or gateway-timeout result SHALL be recorded once per bounded decision, SHALL not enter an unbounded retry loop, and SHALL clean up the temporary session.

#### Scenario: Run reaches probe limit
- **WHEN** candidate evaluation reaches the configured distinct-probe limit or total run deadline
- **THEN** the system starts no additional probes during that run and leaves unevaluated Agents unchanged

#### Scenario: Healthy candidate stops Agent probing
- **WHEN** a candidate proves healthy for an Agent
- **THEN** the system does not probe lower-ranked candidates for that Agent during the run

#### Scenario: Timeout stops equivalent probing
- **WHEN** a provider/model probe reaches its execution deadline or returns a gateway timeout
- **THEN** the system records one bounded unverified result, starts no equivalent retry loop during that decision, and continues or terminates according to the run budget

#### Scenario: Quota result stops equivalent probing
- **WHEN** a provider/model probe reports a terminal quota limit
- **THEN** the system starts no additional equivalent inference probes during that run and records a provider/model/credential-fingerprint-scoped cooldown result for 900 seconds

### Requirement: Automatic apply discipline
An automatic reconciliation write SHALL modify only the affected Agent's primary model and SHALL add no unsupported Agent configuration keys. It SHALL restart only managed OpenCode and SHALL use the rollback and reporting behavior defined by the modified Admin Agent Model apply requirement. Unrelated Agent configuration SHALL remain unchanged.

#### Scenario: Automatic assignment writes one primary
- **WHEN** reconciliation selects a healthy fallback candidate for an Agent
- **THEN** it writes only that Agent's primary model, removes stale unsupported chain keys for that Agent, and leaves unrelated Agents unchanged

#### Scenario: Automatic apply probe becomes unavailable
- **WHEN** an automatically selected model reports `unavailable` or `retired` during post-restart verification
- **THEN** the system restores the previous configuration and managed runtime according to the apply rollback contract

#### Scenario: Automatic apply reports mismatch without rollback
- **WHEN** an automatically selected model resolves to a different runtime model after restart
- **THEN** the system keeps the applied configuration and reports `runtime_mismatch` according to the apply contract
