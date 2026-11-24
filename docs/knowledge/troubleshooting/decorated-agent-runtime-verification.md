# Decorated Agent Runtime Verification

> Historical V1/OMO investigation; the V2 runtime uses native OpenCode agents.

## Context

Agent model configuration is keyed by short OMO names such as `metis`, `momus`, and `sisyphus-junior`. Managed OpenCode can expose the same agents through `/agent` with decorated runtime names such as `Metis - Plan Consultant`.

Admin Apply verifies both the `/agent` assignment and model metadata from a successful agent request. The Agent Models list also compares configured, assigned, and recent-request models.

## Problem

A request addressed to the short config key can complete without returning assistant model metadata, while the decorated runtime name returns the expected `providerID` and `modelID`. Applying a valid model then reports `unverified` even though a real invocation uses the new model.

After Apply, the list can expose a second false failure. Verification sessions are temporary, so the most recent retained request may predate the configuration change. Treating that stale request as authoritative produces `runtime_mismatch` even when `/agent` already reports the configured assignment.

## Solution

- Probe request metadata with the short config key first.
- Only when parsing returns `null`, fetch `/agent`, map display names back through `displayNameToKey`, and retry with the distinct decorated runtime name.
- Derive provider connectivity from the current `/agent` assignment, not stale request history.
- Classify configured rows in this order:
  1. Missing assignment or disconnected assigned provider → `unverified`.
  2. Assigned model differs from configured model → `runtime_mismatch`.
  3. Recent request matches configured model → `effective`.
  4. Assignment matches but request is absent or stale → `awaiting_request`.

Apply itself still requires both assigned and request models to match before returning `verified`.

## Why It Works

The decorated-name retry follows the runtime identity OpenCode actually dispatches without changing persisted config keys. It is bounded: no retry occurs when the short name succeeds, when `/agent` already contains that name, or when no distinct mapped display name exists.

Checking assignment mismatch before request history ensures `awaiting_request` cannot hide a genuine runtime mismatch. A stale request only affects the usage-evidence state after the current assignment has already matched configuration.

## Side Effects / Tradeoffs

- A failed short-name probe may add one `/agent` request and one decorated-name request.
- `awaiting_request` can remain visible until a retained real invocation uses the configured model; it is intentionally not equivalent to `effective`.
- Historical request metadata remains useful evidence, but it is not authoritative for the current assignment after a configuration change.

## Evidence

- Red/green regression: `fetchSuccessfulRequestModel("testpass", "metis")` initially returned `null`; after the retry, it returned `{ modelID: "big-pickle", providerID: "opencode" }` and the command payload contained `Metis - Plan Consultant`.
- Stale-history regression: matching Momus assignment plus old Nvidia request metadata now returns `awaiting_request` with `providerConnected: true`.
- Targeted Agent Models suite: `73 pass`, `0 fail`, `207 expect() calls` across five files.
- Docker dev image rebuilt successfully after the final changes.
- Browser-authenticated batch Apply for `metis`, `momus`, and `sisyphus-junior` returned HTTP 200; every row was `verified` with assigned and request models both `opencode/big-pickle`.
- After reload, Metis was `effective`; Momus and Sisyphus Junior were `awaiting_request` because their retained requests still referenced older models rather than being falsely marked failed.
- Oracle final review: PASS with no blocking findings.

## Related Files

- `src/admin/lib/agent-model-live.ts` — runtime display-name resolution and request retry.
- `src/admin/lib/agent-models.ts` — configured/assigned/request effectiveness classification.
- `src/admin/lib/agent-model-types.ts` — `awaiting_request` effectiveness state.
- `src/admin/lib/agent-models.test.ts` — decorated-name retry regression.
- `src/admin/routes/agent-models-list.test.ts` — stale recent-request regression.
- `docs/knowledge/troubleshooting/native-agent-bridge-reconcile-race.md` — native model file synchronization before restart and verification.

## Tags

- agent-models
- decorated-agent-name
- runtime-verification
- request-metadata
- stale-history
- awaiting-request
- OpenCode
- OMO
