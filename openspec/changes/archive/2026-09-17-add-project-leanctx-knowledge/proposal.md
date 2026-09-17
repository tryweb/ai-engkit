# Proposal

## Why

AI-EngKit Admin currently aggregates LeanCTX memory facts only at site level, while the Projects view shows per-project CodeGraph status and git-backed knowledge statistics. A previous change deliberately rejected per-project LeanCTX activity and health signals because they were low-signal or not reliably attributable; this proposal revisits that decision narrowly for project-keyed fact-store metadata, which is directly attributable and useful for diagnosing whether a project has stored LeanCTX knowledge.

## What Changes

- Add a read-only per-project LeanCTX knowledge summary to the Projects overview API and UI, alongside CodeGraph status.
- Report project-scoped active facts, archived facts, patterns, history entries, and last-updated time when the corresponding LeanCTX store is available.
- Resolve the store by exact `project_root` ownership recorded in LeanCTX knowledge data; do not reimplement the project hash or infer project facts from the site aggregate.
- Distinguish a valid empty store from an unavailable, malformed, or identity-mismatched store.
- Preserve failure isolation: an unavailable or malformed LeanCTX store reports an unknown state without failing the Projects page.
- Keep raw fact contents and all write operations out of the Projects overview; no fact editing, removal, restore, consolidation, or import is introduced.
- Retain the existing site-level LeanCTX dashboard aggregate as a separate view.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `admin-project-status`: add a per-project, read-only LeanCTX knowledge status and render it in the Admin Projects UI; retain the existing site-level dashboard aggregate.

## Impact

- Admin project overview response types, per-project status probing, caching, and failure handling.
- Admin Projects table/card UI, accessibility copy, and responsive layout.
- LeanCTX data access inside the ai-dev container through the existing Admin execution boundary.
- Existing Admin authorization and project-name/path quoting boundaries.
- Unit and integration tests for project probes, API serialization, unavailable stores, and UI states.
- No new dependency, configuration layer, or persistence format is required.
