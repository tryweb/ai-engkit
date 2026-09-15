# OMO-slim Evaluation Disposition

## Context

- On 2026-09-15, the user clarified that the `slim` branch evaluates a replacement because original OMO's OpenCode V2 support is uncertain, not merely to reduce plugin size or token cost.
- The [migration watch](../tooling/opencode-v2-migration-watch.md) records the 2026-09-14 upstream assessment: no committed OMO V2 timeline, and waiting for an OMO V2 release is not a reliable migration dependency.
- That assessment does not establish that OMO will never support V2.
- The experiment moved from `oh-my-openagent@4.19.4` to `oh-my-opencode-slim@2.2.20`; the lost LSP MCP integration and its replacement are documented [separately](../patterns/omo-lsp-mcp-vendored-bridge.md).

## Problem

- Replacement validation expanded into LSP integration, Agent Models roster/reconciliation, and unresolved Fixer tool-permission behavior.
- A working plugin replacement in a V1 deployment is not proof that the complete deployment works on OpenCode V2.
- Session compaction lost the original migration motivation and led to an incorrect recommendation framed as abandoning optional lightweight tooling.

## Solution

### Recommendation, not an executed rollback

- Pause active V2/slim validation and prioritize the known-working V1/OMO baseline on `main`.
- Preserve the slim experiment and evidence; do not treat the candidate as either production-ready or conclusively defective.
- Keep a V2 replacement path open without assuming original OMO will provide it.
- The user requested documentation after discussing this recommendation. This capture does not authorize or record a completed branch switch, commit, deployment rollback, or volume restoration.

### Safe return to V1

1. Preserve uncommitted slim work and record exact versions/configuration before switching branches.
2. Prevent experimental changes from carrying into `main` unintentionally.
3. Restore a known-working image/plugin/configuration combination, not just the plugin name. Git checkout does not restore containers or persistent volumes.
4. Verify primary and delegated agents through reading, searching, editing, shell execution, tests, deletion of a disposable test file, and LSP operations.
5. Preserve intended permission denials; do not remove global restrictions merely to make the checks pass.

### Conditions for resuming evaluation

- A reproducible OpenCode/OpenChamber V2 deployment path is available.
- At least one replacement candidate can be evaluated against required OMO capabilities: delegation, model routing/fallback, continuation, tools, and permission enforcement.
- Validate effective permissions and actual tool calls for both primary and child agents, including expected denials.
- Confirm behavior survives service restart and redeployment.
- Change runtime and plugin independently where supported; document unsupported combinations rather than attributing all failures to one component.
- Choose between slim, another candidate, or a thin native integration based on demonstrated behavior and maintenance cost. No alternative was selected in this discussion.

## Why It Works

- Separating stable maintenance from experimental migration limits disruption without making uncertain upstream support a blocker.
- Explicit restart criteria prevent an indefinite sequence of compatibility fixes without a usable replacement.
- Reading the migration rationale before advising prevents repeated loss of context after compaction.

## Side Effects / Tradeoffs

- V2 adoption is delayed, and V1/OMO remains a temporary dependency.
- Preserving the experiment does not resolve its outstanding permission issue.
- Upstream status must be checked again when evaluation resumes; dated findings are not permanent compatibility guarantees.

## Evidence

- User clarification in the 2026-09-15 discussion: the session began because OMO might not support OpenCode V2, and replacement validation was taking place on the slim branch.
- The existing migration-watch entry preserves the prior upstream evidence and migration rationale.
- The LSP bridge entry records a concrete integration difference encountered during the slim migration.
- [Permission investigation](../troubleshooting/omo-slim-global-tool-denies.md): global denies were observed, but their writer and the old/new effective-permission difference remain unproven.
- Earlier session summaries report build/recreation and model-roster validation; this disposition does not independently certify those checks or claim end-to-end V2 success.

## Related Files

- `docs/knowledge/tooling/opencode-v2-migration-watch.md`
- `docs/knowledge/patterns/omo-lsp-mcp-vendored-bridge.md`
- `docs/knowledge/troubleshooting/omo-slim-global-tool-denies.md`
- `Dockerfile`
- `docker-compose.dev.yml`
- `entrypoint.d/02-init-config.sh`

## Tags

- omo-slim
- opencode-v2
- migration-disposition
- v1-maintenance
- context-recovery
