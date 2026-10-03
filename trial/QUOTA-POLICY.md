# Trial Quota Policy (trial/opencode-v2)

> Status: **ACTIVE** since 2026-10-03 (user-approved). Scope: **experiment spend only** — inference run by agents during v2 trial verification, billed to the user's provider keys. This is NOT a product feature (see Backlog P1 in `trial/DECISIONS.md`).

## Tiers

| Tier | Scope | Authorization |
|---|---|---|
| Tier 0 | Metadata probes, unit harnesses, log forensics ($0) | Standing — proceed, report after |
| Tier 1 | Free-tier models + tiny prompts, est. <$0.001/run | **Standing auto-approve** — M2/E2E, M3 probes, B1 regressions, hook checks run without asking |
| Tier 2 | Paid models or long sessions, est. >$0.01/run | **Per-run approval** — report model + estimate + purpose first, burn only on explicit go |

## Envelope

- **Monthly cap: $5** (at measured ~$0.00006/micro-probe this is ~80k probes — the cap is a circuit breaker, not a budget).
- **Fuse action on cap: STOP + report.** No warning line (amounts are too small for graduated response to matter).
- Paid models default: **NEVER USE** unless a free-tier behavior is provably non-comparable for the question at hand.

## Discipline (non-negotiable per burn)

1. Free-tier-first model choice; tiny prompts; stop after 3 failed attempts per probe (failures pre-inference cost $0 — prefer failing fast over retrying blind).
2. Every burn appends to `trial/BURN-LOG.md`: model, prompt shape, result, exact spend where emitted, running total.
3. Secrets never printed, never committed, never leave the trial containers except via the owner's own handoff.
4. Dead keys / 403s / gated models are evidence, not invitations to try harder — record and move on.

## Current Key Inventory (trial, metadata only)

| Provider | Key state | Inference |
|---|---|---|
| `opencode-go` | live (user-provided, length-verified) | YES — free-tier models |
| openrouter | 401 dead | no |
| google | 401 dead | no |
| nvidia | lists OK, invoke 403 (no entitlement) | no |
| opencode/big-pickle | no key; Console free tier UI-sessions only | no (CLI gated) |
