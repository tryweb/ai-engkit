# Spec Delta

## MODIFIED Requirements

### Requirement: Projects overview includes codegraph index status

The system SHALL include, for every project in the `GET /api/projects/overview` response, a `codegraph` field reporting the index state of `<project>/.codegraph` inside the ai-dev workspace: whether the project is indexed, file/node/edge counts, the last index timestamp, pending changes (added/modified/removed since the index), whether a re-index is recommended, and the index state when known. The response SHALL also include a `leanctx` field with this exact shape when the project's LeanCTX knowledge store is readable:

```json
{
  "state": "available",
  "activeFacts": 0,
  "archivedFacts": 0,
  "patterns": 0,
  "history": 0,
  "lastUpdated": null
}
```

The `leanctx` field SHALL use non-negative integer counts. Facts without `valid_until` SHALL count as active and facts with `valid_until` SHALL count as archived; `patterns` and `history` SHALL count their corresponding persisted arrays; `lastUpdated` SHALL be the persisted update timestamp or `null`. When no matching store exists, `leanctx` SHALL use `state: "empty"` with all counts zero and `lastUpdated: null`. The project store SHALL be selected only by exact canonical `project_root` ownership recorded in the candidate knowledge data; the implementation SHALL require a non-empty `project_hash` equal to the knowledge directory basename, SHALL NOT recompute LeanCTX's opaque hash algorithm, and SHALL reject duplicate matching roots. A project directory without a codegraph index SHALL be reported as not initialized rather than as an error. When either status probe fails (timeout, missing CLI/store access, identity resolution failure, duplicate or mismatched identity, malformed output, or ai-dev unavailability), the affected field SHALL be `null` and the response SHALL still succeed. The `leanctx` projection MUST NOT contain raw fact values, provenance, project paths, hashes, secrets, or command errors, and it MUST NOT be inferred from the site-level aggregate.

#### Scenario: Indexed project reports full status

- **WHEN** a project has a valid `.codegraph` index and a readable LeanCTX knowledge store whose exact `project_root` matches
- **THEN** the overview response includes the existing CodeGraph status and a `leanctx` object with the exact fields and counts defined above

#### Scenario: Never-indexed project reports not initialized

- **WHEN** a project directory exists but has no codegraph index
- **THEN** the overview includes `codegraph.initialized: false` and a valid project-scoped LeanCTX status when its store can be read, without any error indication

#### Scenario: Project has no LeanCTX knowledge

- **WHEN** a project has no matching LeanCTX knowledge store
- **THEN** the overview includes `leanctx.state: "empty"` with zero counts and does not treat the project as unhealthy

#### Scenario: Identity mismatch is unavailable

- **WHEN** a candidate knowledge record has a different `project_root`, an invalid or mismatched `project_hash`, or more than one record matches the requested root
- **THEN** the overview includes `leanctx: null` and does not use that candidate's counts or the site aggregate

#### Scenario: Malformed store is unavailable

- **WHEN** a candidate knowledge file is malformed or lacks a required identity/count field
- **THEN** the overview includes `leanctx: null` and the request still succeeds

#### Scenario: Probe failure does not fail the overview

- **WHEN** either status probe times out, loses ai-dev access, or returns malformed output
- **THEN** the affected `codegraph` or `leanctx` field is `null` and the overview request still succeeds

### Requirement: Tool status is presented per project in the Admin projects UI

The Admin Projects view SHALL render CodeGraph and LeanCTX Knowledge status in the existing project capability-badge area for every project. An indexed project SHALL show a positive CodeGraph badge; a not-indexed project SHALL show a distinct neutral badge (not an error); and a failed CodeGraph probe SHALL render as an unknown placeholder. A project with available LeanCTX knowledge SHALL show a text-bearing knowledge badge with active fact count; a project with `state: "empty"` SHALL show a distinct neutral "no knowledge" badge; and a failed LeanCTX probe SHALL render as an unknown placeholder. The existing project drawer or equivalent accessible in-page detail affordance SHALL expose archived facts, patterns, history, and last update time without exposing raw fact contents. The UI SHALL expose no fact editing, removal, restore, consolidation, import, or configuration controls. The existing site-level LeanCTX signal SHALL remain available on the Dashboard.

#### Scenario: Indexed project shows positive badge with detail

- **WHEN** a project is reported indexed with pending changes of zero
- **THEN** the CodeGraph badge shows a positive text state, and its existing detail affordance shows the last index time, counts, and re-index recommendation

#### Scenario: Not-indexed project shows neutral badge

- **WHEN** a project's CodeGraph status is not initialized
- **THEN** the CodeGraph badge shows a neutral "not indexed" text state, and no error styling

#### Scenario: LeanCTX knowledge shows project summary

- **WHEN** a project's LeanCTX status is `state: "available"` with active facts
- **THEN** the LeanCTX Knowledge badge shows the active fact count and the project detail affordance exposes archived facts, patterns, history, and last update time without raw fact content

#### Scenario: Empty LeanCTX knowledge shows neutral badge

- **WHEN** a project's LeanCTX status is `state: "empty"`
- **THEN** the LeanCTX Knowledge badge shows a neutral "no knowledge" text state and no error styling

#### Scenario: Unknown probe renders placeholder

- **WHEN** either project's `codegraph` or `leanctx` field is `null`
- **THEN** the corresponding status area renders an unknown text placeholder without failing or blocking the Projects view

#### Scenario: Projects view exposes no mutation controls

- **WHEN** an administrator opens a project status detail
- **THEN** the view exposes summary metadata only and no controls that write, remove, restore, import, or consolidate LeanCTX knowledge

### Requirement: Dashboard includes site-level leanCTX statistics

The Admin Dashboard SHALL continue to present leanCTX statistics aggregated across all projects with leanCTX state: the number of projects with stored memory facts, the total number of memory facts across all projects, the number of projects with recorded agent activity within the last 24 hours, and the number of projects with a cached health score. The statistics SHALL be derived from the same leanCTX state files under the ai-dev container, aggregated across every knowledge directory in one scan. The statistics SHALL remain separate from the per-project `leanctx` overview field, SHALL NOT expose raw facts, and SHALL NOT replace the per-project summary. The Dashboard SHALL retain its existing scope and SHALL NOT present per-project session activity as if it were attributable to a project. When the scan fails, the Dashboard SHALL render the statistics as unavailable without failing the page.

#### Scenario: Dashboard shows aggregated leanCTX statistics

- **WHEN** the site scan succeeds
- **THEN** the Dashboard shows the number of projects with memory facts, the total memory fact count, the number of projects active within 24 hours, and the health coverage count

#### Scenario: Per-project and site-level counts coexist

- **WHEN** the Projects overview and Dashboard are both available
- **THEN** the Projects view exposes exact project-root summaries while the Dashboard continues to expose the site-level aggregate without requiring their samples to sum exactly

#### Scenario: Scan failure renders statistics unavailable

- **WHEN** the leanCTX site scan fails (timeout or read failure)
- **THEN** the Dashboard renders the leanCTX statistics as unavailable and the page still loads

### Requirement: Status probes are bounded and cached

The system SHALL run CodeGraph, the batched per-project LeanCTX scan, and the site-level LeanCTX status probe with a timeout and SHALL cache results with a time-to-live so repeated requests within the TTL do not re-probe. A probe that exceeds the timeout SHALL yield an unavailable result for the affected scope (a project's `codegraph` or `leanctx` field, or the site-level leanCTX statistics) and SHALL NOT block the rest of the response. The project status probe cache SHALL be invalidated by project sync so newly added projects are probed on their first overview request. The LeanCTX scan SHALL be read-only with respect to knowledge facts, history, patterns, and archives; it SHALL not invoke mutation operations or write knowledge data as a side effect of probing.

#### Scenario: Overview within TTL uses cache

- **WHEN** an overview request repeats within the probe cache TTL
- **THEN** the response is served from the cache without re-running CodeGraph or the batched LeanCTX scan

#### Scenario: Timeout yields unavailable result and page still loads

- **WHEN** a status probe exceeds the timeout
- **THEN** the affected project field is `null`/unknown or the Dashboard leanCTX statistics are unavailable, and the response still succeeds

#### Scenario: Probe does not mutate knowledge

- **WHEN** the Projects overview performs a LeanCTX status scan
- **THEN** no facts, history entries, patterns, archives, or configuration values are added, removed, restored, consolidated, or imported
