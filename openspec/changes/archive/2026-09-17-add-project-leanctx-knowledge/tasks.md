# Tasks

## 1. Per-Project LeanCTX Projection

- [x] 1.1 Define the normalized `LeanCtxProjectStatus` contract with `available` and `empty` states, non-negative counts, and nullable `lastUpdated`, then verify type and serialization tests cover the exact wire shape
- [x] 1.2 Implement one bounded read-only ai-dev scan over `knowledge/*/knowledge.json` that projects only facts/patterns/history metadata, matches exact canonical `project_root`, validates non-empty `project_hash` against the store directory basename without recomputing its opaque algorithm, rejects duplicates/mismatches, and returns empty or unknown as specified; verify valid, empty, malformed, and mismatched stores
- [x] 1.3 Add tests proving the scan never emits raw fact values, provenance, paths, hashes, secrets, or command errors and never invokes LeanCTX mutation commands; verify projected output contains only the approved fields

## 2. Project Status Provider and API

- [x] 2.1 Extend the existing project status provider with a cached batched LeanCTX scan and preserve existing CodeGraph probe caching/concurrency, then verify one LeanCTX scan is used per overview refresh and project sync invalidates the result
- [x] 2.2 Extend `GET /api/projects/overview` with the `leanctx` field while preserving existing CodeGraph and git-backed knowledge statistics, then verify available, empty, unknown, timeout, ai-dev-unavailable, and partial-failure responses
- [x] 2.3 Verify the existing authenticated Projects route remains the only API surface and that project names/roots are safely quoted or validated, then add regression tests for crafted names and site-aggregate fallback

## 3. Projects UI

- [x] 3.1 Add a LeanCTX Knowledge badge to the existing project capability-badge area beside CodeGraph with explicit available, empty, and unknown text states, then verify accessible labels do not rely on color alone
- [x] 3.2 Extend the existing project drawer/detail affordance with archived facts, patterns, history, and last update time, then verify raw facts and all mutation/configuration controls are absent
- [x] 3.3 Preserve existing CodeGraph rendering and update responsive layout/copy for the additional badge and drawer content, then verify desktop, tablet, mobile, and keyboard interactions through the supported browser QA flow

## 4. Site Aggregate Compatibility

- [x] 4.1 Preserve the Dashboard site-level LeanCTX aggregate and its existing semantics while adding project-level status, then verify the two scopes remain separately labeled and do not require exact count equality
- [x] 4.2 Add regression coverage for site-scan failure concurrent with per-project scan failure, then verify each affected scope reports unavailable independently and the Dashboard/Projects pages still render

## 5. Verification

- [x] 5.1 Run focused Admin unit and route tests for project status, LeanCTX projection, and UI rendering, then verify all existing and new scenarios pass without weakening prior tests
- [x] 5.2 Run TypeScript diagnostics and the repository's applicable build/test checks for every changed module, then verify no new diagnostics or failures are introduced
