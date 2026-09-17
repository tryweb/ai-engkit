# Design

## Context

The existing Admin Projects overview already probes CodeGraph per project and separately probes LeanCTX site statistics. The per-project LeanCTX store is keyed by LeanCTX project identity under the ai-dev data volume, while Admin itself reaches ai-dev through the existing Docker execution boundary. A previous archived change removed a per-project LeanCTX column because session and health signals were low-signal; this change intentionally limits the new signal to metadata stored with an exact project root.

## Goals / Non-Goals

**Goals:**

- Add a bounded, cached, failure-isolated per-project LeanCTX status probe.
- Return stable summary counts that can be rendered in the existing project badge and drawer pattern.
- Preserve the existing site-level Dashboard aggregate and make the two scopes explicit.
- Keep the project overview secret-safe and read-only.
- Handle missing stores, unresolved identities, malformed files, and ai-dev unavailability without breaking the Projects page.

**Non-Goals:**

- No per-project LeanCTX configuration editor.
- No raw fact browsing in the Projects overview or the overview detail drawer.
- No fact mutation, import, restore, removal, or consolidation.
- No change to LeanCTX project identity, boundary policy, or storage format.
- No replacement of the existing git-backed `docs/knowledge` statistics.

## Decisions

### Use the existing project status provider and a batched LeanCTX scan

Extend the existing project tool status contract with an optional LeanCTX project status instead of creating a second project overview pipeline. The provider SHALL perform one bounded LeanCTX data scan per overview refresh, project the matching records by exact `project_root`, and join the results to the existing project list. Per-project CodeGraph probes keep their existing cache and concurrency behavior.

Alternative rejected: adding one LeanCTX shell invocation per project would create an avoidable N+1 path and repeatedly scan the same knowledge directories.

### Resolve and read project stores inside ai-dev

The scan SHALL execute in ai-dev and inspect only `knowledge/*/knowledge.json`. For each candidate record, it SHALL require an exact canonical `project_root` match to the requested workspace project root and SHALL validate that `project_hash` is non-empty and equals the knowledge directory basename; it SHALL not recompute LeanCTX's opaque hash algorithm. A missing match is empty; malformed JSON, duplicate matching roots, missing identity fields, or an identity mismatch is unknown. The scan SHALL emit only the normalized metadata projection from inside ai-dev.

Alternative rejected: reading the knowledge volume directly from ai-admin, because ai-admin intentionally does not mount LeanCTX data and bypassing `execInAiDev` would create a second container-boundary model.

### Return a normalized summary, not raw facts

The API type SHALL contain only numeric counts, a last-update timestamp, and an explicit state. Raw fact values, provenance payloads, project paths, hashes, secrets, and command errors must not cross either the ai-dev/Admin command boundary or the Admin API boundary.

The normalized projection is:

```text
leanctx: {
  state: "available" | "empty",
  activeFacts: number,
  archivedFacts: number,
  patterns: number,
  history: number,
  lastUpdated: string | null
} | null
```

`activeFacts` and `archivedFacts` SHALL follow LeanCTX's persisted fact lifecycle: facts with no `valid_until` are active and facts with `valid_until` are archived. `patterns` and `history` are the lengths of their corresponding top-level arrays. An empty result has all counts set to zero and `lastUpdated: null`; an unavailable or invalid result is `null`.

Alternative rejected: returning the complete `knowledge.json`, because it increases privacy exposure, payload size, and coupling to LeanCTX's persistence schema.

### Treat empty and unavailable as different states

No matching project store is a valid neutral state and SHALL NOT look like a failed health check. Probe failure, invalid project identity, timeout, duplicate matching roots, and malformed output remain `null`/unknown so operators can distinguish absence from infrastructure failure.

### Keep site aggregate and project summary separate

The existing site scan remains the source for Dashboard totals. The project scan reads only the selected project's exact store. The UI must label the project summary as project-scoped and the Dashboard metrics as site-level; it must not require the two samples to sum exactly.

### Read-only UI in the Projects overview

Render a compact badge with active fact count in the existing capability-badge cluster and expose secondary counts through the existing project drawer and accessible title/label affordance. Do not add action buttons. Any future maintenance workflow should have a separate detail surface with explicit project identity, audit, backup, dry-run, and rollback requirements.

### Preserve Admin authorization and shell safety

Reuse the existing authenticated Projects route; do not introduce a new unauthenticated endpoint. Project names and roots SHALL be validated/quoted using existing project discovery and shell-quoting boundaries. The scan SHALL never interpolate an untrusted project name into shell source and SHALL never fall back to the site-level aggregate when a project match is unavailable.

## Risks / Trade-offs

- [Project identity mismatch] A path-only or incorrect hash can show another project's facts → match exact persisted `project_root`, require non-empty `project_hash` equal to the store directory basename, reject duplicates, and return unknown on mismatch without recomputing the opaque hash.
- [Sensitive knowledge exposure] Counts and timestamps are safer than fact content but still reveal project activity → return aggregate metadata only and preserve existing Admin authorization.
- [N+1 probe cost] Each project adds a LeanCTX read → run one bounded in-container scan per overview and join results by exact root.
- [Count drift] Site and project probes run at different times → label scopes explicitly and do not enforce equality in the UI.
- [Schema drift] LeanCTX data may change → validate the known `facts`, `patterns`, `history`, `project_root`, `project_hash`, and `updated_at` fields; return unknown on incompatible required fields and never silently turn missing metrics into zero.
- [Large project list] Many projects can make cards slow → cache project summaries, invalidate on project sync, cap output size, and preserve partial results when one probe fails.
- [Prior low-signal decision] Per-project facts can still be sparse → present counts as neutral observability metadata, not as a health score or quality judgment.

## Migration Plan

No data migration is required. Deploy the Admin changes, let the existing project status cache fill on the first Projects request, and retain the current Dashboard site aggregate unchanged. Rollback is a code deployment rollback; no LeanCTX data or configuration is modified.
