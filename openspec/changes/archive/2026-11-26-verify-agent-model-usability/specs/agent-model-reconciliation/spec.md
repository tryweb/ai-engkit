## MODIFIED Requirements

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
