## MODIFIED Requirements

### Requirement: List agent model configuration
The system SHALL expose a read endpoint returning, for every live OMO subagent, its configured primary model from top-level `agents.<name>.model`, its currently resolved model from the managed OpenCode server `/agent` endpoint, and whether those values agree. The response SHALL expose fresh inference verification separately from configured and runtime-loaded state, including verification status and age when available. A schema-invalid agent configuration SHALL be reported as invalid and SHALL NOT be presented as an effective configured model. Historical successful-request metadata SHALL NOT by itself mark a model as currently usable or effective.

#### Scenario: List a freshly verified configured model
- **WHEN** a configured model is loaded by the managed server and a fresh temporary-session inference returns matching provider and model metadata
- **THEN** the response reports the model as configured, runtime-loaded, and verified usable with the verification timestamp

#### Scenario: List all agents with configured and resolved models
- **WHEN** an authenticated admin requests the agent model list and an agent has a configured primary while the managed server reports a live provider and model
- **THEN** the response contains both the configured and resolved values, their agreement state, and the independent fresh verification state

#### Scenario: Historical request does not prove current usability
- **WHEN** historical request metadata matches the configured model but the latest explicit verification is absent, expired, timed out, or failed
- **THEN** the response reports the historical match separately and does not mark the model as currently verified usable or effective

#### Scenario: Persisted and live models disagree
- **WHEN** the configured primary differs from the managed server's resolved model
- **THEN** the response reports both values, marks the runtime state as mismatched, and does not claim fresh usability

#### Scenario: Agent without configuration reports resolved plugin model
- **WHEN** a live OMO subagent has no top-level model configuration
- **THEN** its response has no configured primary, reports the live `/agent` provider and model, and identifies the source as plugin resolution without claiming inference usability

#### Scenario: Invalid agent config is surfaced, not silently ignored
- **WHEN** an agent entry fails the pinned OMO schema
- **THEN** the response reports the validation failure and does not claim that agent's configured model is effective or usable

### Requirement: Apply confirmation and runtime reporting after restart
Both `PUT /api/agent-models` and `PUT /api/agent-models/:agent` SHALL accept an optional body field `verification` whose value is `"readiness"` or `"inference"`; omitted `verification` SHALL mean `"readiness"`, and any other value SHALL be rejected with HTTP 400. Single-agent inference Apply SHALL verify only its target; batch inference Apply SHALL verify each targeted agent and return a result for each target. The system SHALL expose an authenticated `POST /api/agent-models/verify` operation that SHALL not write configuration or restart managed OpenCode. Its optional `agents` array SHALL select individual configured agents; when omitted, it SHALL verify every configured primary model. A selected agent without a configured primary SHALL return `unconfigured` without issuing inference. The verification operation SHALL deduplicate inference by provider/model/credential fingerprint while preserving per-agent results. After an atomic write, the system SHALL restart only managed OpenCode and SHALL leave the `ai-dev` container running. It SHALL confirm that the replacement managed server is reachable and that the configured primary is loaded by the live `/agent` and provider state. The default Apply operation SHALL NOT call any billable model request. Real model usability verification SHALL be available only through an explicit user-triggered inference action that clearly warns it may consume provider quota. Each inference request SHALL have a hard 90-second deadline and the complete inference operation SHALL have a hard 300-second deadline. A transient HTTP 429 MAY be retried once after honoring `Retry-After` up to 60 seconds; gateway timeout, timeout, quota, cancellation, and aborted results SHALL NOT be retried automatically. An inference verification SHALL cancel and clean up the temporary session after timeout and return a terminal result rather than leaving the parent operation or UI indefinitely pending. A model SHALL be reported as verified/effective only when the fresh assistant response is non-empty and its provider/model metadata matches the requested values. The system SHALL restore the previous configuration and attempt to restore the previous managed runtime when the managed restart fails or an explicitly requested post-restart probe conclusively reports `unavailable` or `retired`. A runtime model mismatch SHALL be reported without rollback. A quota-exhausted result SHALL be represented by `ProbeStatus: quota_exceeded` during probing and by an `ApplyResult` with `ok: true`, status `"applied_with_quota_warning"`, and a non-secret warning after a successful write/restart. Timeout, transient, unreachable, or aborted results SHALL preserve the applied configuration, report an actionable unverified status, and SHALL NOT trigger rollback.

#### Scenario: Apply confirms configuration without inference
- **WHEN** the atomic write and managed restart succeed and the replacement server reports the configured model through readiness and live configuration endpoints
- **THEN** the system reports the apply as successful without sending a temporary-session inference request, and the `ai-dev` container remains running

#### Scenario: Explicit usability verification succeeds
- **WHEN** an admin explicitly requests usability verification and a bounded temporary-session inference returns a non-empty assistant response with matching provider and model metadata
- **THEN** the system reports the model as verified usable and records the verification time and quota warning

#### Scenario: Verify one configured agent without changing configuration
- **WHEN** an admin requests `POST /api/agent-models/verify` with one configured agent
- **THEN** the system verifies only that agent, returns its result, and leaves `~/.omo/omo.jsonc` and the managed server unchanged

#### Scenario: Verify all configured agents
- **WHEN** an admin requests `POST /api/agent-models/verify` without an `agents` list
- **THEN** the system returns one result for every configured primary model, deduplicates identical provider/model/credential probes, and leaves configuration unchanged

#### Scenario: Verify selected agents
- **WHEN** an admin requests `POST /api/agent-models/verify` with several agent names
- **THEN** the system returns one result per selected agent and does not verify unselected agents

#### Scenario: Verify an unconfigured agent
- **WHEN** an admin requests verification for an agent without a configured primary model
- **THEN** the system returns `unconfigured` for that agent without issuing an inference request

#### Scenario: Apply is effective after restart
- **WHEN** the atomic write and managed restart succeed and readiness/configuration metadata confirms the configured provider and model
- **THEN** the system reports the apply as successful and the `ai-dev` container remains running, without implying fresh inference usability

#### Scenario: Apply persists but runtime differs
- **WHEN** the top-level model remains present after restart but live model metadata reports another model
- **THEN** the system reports both models as `runtime_mismatch` and does not roll back the persisted value

#### Scenario: Restart failure restores snapshot
- **WHEN** the atomic write succeeds but the managed restart fails
- **THEN** the system restores the previous `~/.omo/omo.jsonc`, attempts to restart managed OpenCode with that configuration, and reports `restart_failed`

#### Scenario: Conclusive unavailable probe restores snapshot
- **WHEN** an explicitly requested post-restart probe reports `unavailable` or `retired`
- **THEN** the system restores the previous `~/.omo/omo.jsonc`, restarts managed OpenCode with that configuration, and reports `probe_failed`

#### Scenario: Inconclusive probe keeps applied configuration
- **WHEN** an explicitly requested probe reports `retryable` or `unreachable`
- **THEN** the system keeps the applied configuration and reports `unverified` without rollback

#### Scenario: Explicit usability verification times out
- **WHEN** the provider does not complete inference before the configured deadline
- **THEN** the system cancels and cleans up the temporary session, returns a terminal timeout/unverified result, and does not leave the parent operation or UI indefinitely applying

#### Scenario: Historical success is stale
- **WHEN** a previous request succeeded for the configured model but the latest verification timed out or was aborted
- **THEN** the system reports the model as configured/runtime-loaded but not currently verified usable

#### Scenario: Provider quota is exhausted
- **WHEN** the provider reports free-usage exhaustion, insufficient quota, or an equivalent terminal billing limit during an explicit verification
- **THEN** the system keeps the applied configuration, stops further automatic verification for that provider/model, and reports `applied_with_quota_warning` without rollback

#### Scenario: Verification request reaches its bound
- **WHEN** one inference request exceeds 90 seconds, or the complete inference verification exceeds 300 seconds, or readiness Apply exceeds 180 seconds
- **THEN** the backend stops waiting, the frontend uses a matching bounded deadline, reports an actionable timeout state, and SHALL NOT leave the UI in an indefinite applying state

#### Scenario: Rollback recovery failure is surfaced
- **WHEN** the system cannot restore the snapshot or cannot recover managed OpenCode after a rollback-triggering failure
- **THEN** the system reports `rollback_failed` and does not claim the new configuration is effective
