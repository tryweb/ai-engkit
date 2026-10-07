# V2 Agent Model Verification Scope

## Context

OpenCode V2 has both a static agent model from `GET /api/agent` and per-request model selection from the `routing.json` chain via the B1 routing plugin. Admin Agent Models exposes configuration, readiness, and inference verification.

## Problem

Two verification paths could overstate agent health:

- Readiness verification returned `healthy` without sending a request (`readiness verification does not probe`). Apply readiness could return `verified` after checking provider connectivity even when no SubAgent response was observed.
- V2 Verify All probed each model using a fixed `title` agent and an explicit model override. Apply inference also supplied a model override and omitted the target `agent` from the V2 prompt body. These checks could test a model without exercising the selected SubAgent's normal routing path.

`GET /api/agent` is not the effective model for each V2 request. In one live state, `routing.json` and `opencode.json` listed `plan=nvidia/z-ai/glm-5.3` and `prometheus=openrouter/dots-studio/dots-3-note-preview:free`, while `/api/agent` reported `opencode-go/kimi-k3` for both. User-captured model-switch and assistant-message metadata matched the configured routing chains.

## Solution

- Readiness is reported as `configured`, never `healthy` or `verified`; it confirms connected provider/configuration only and explicitly says no SubAgent request was sent.
- V2 inference sends a normal request for the target agent by including `agent` in the `/api/session/{id}/prompt` body and omitting the explicit model override.
- Inference compares the response's actual model to every entry in the configured chain, accepting a successful configured fallback and flagging an out-of-chain model.
- Verify All uses the target-agent inference path on V2. The V1 model-probe path remains unchanged.
- The UI labels `/api/agent` data as `Agent API model`; `Last request` identifies actual assistant-message metadata. V2 effectiveness is based on whether the last successful request used any model in the configured chain.

## Why It Works

OpenCode prompt resolution uses a request-level model override before the agent model, so pinning a model tests that model rather than the normal agent route. The V2 prompt body must also name the target agent. Omitting the model override and supplying the agent lets the routing plugin apply the configured chain; checking the assistant response metadata then verifies the actual selected SubAgent and model.

## Side Effects / Tradeoffs

- Inference verification sends real model requests and may consume provider quota; it remains an explicit opt-in on Apply and an inference-mode operation on Verify All.
- Readiness is intentionally not a liveness claim.
- A request that does not produce assistant model metadata is `unverified`; this does not identify whether the cause was provider latency, provider failure, or another runtime error.

## Evidence

- Before the fix, authenticated `POST /api/agent-models/verify` with `{"agents":["plan","prometheus"],"verification":"readiness"}` returned `status:"healthy"` for both despite the route's `readiness verification does not probe` reason.
- After the fix, the same live request returned `status:"configured"`, `healthy:0`, `configured:2`, and `provider connected; no SubAgent request was sent` for both agents.
- Admin suite: 1285 passed, 0 failed, 2 skipped; `bun run typecheck` passed.
- V2 request-script tests assert the target agent is in the prompt body and no configured model override is sent. Route tests assert actual SubAgent inference uses the request model and readiness is not healthy.
- The user's 12-agent request sample recorded 8 successful responses and 4 that did not return within 60 seconds. This task did not issue additional inference requests; the four timeout causes remain unconfirmed.

## Related Files

- `src/admin/lib/agent-model-live.ts`
- `src/admin/lib/agent-models.ts`
- `src/admin/lib/agent-model-reconciler.ts`
- `src/admin/routes/agent-models.ts`
- `src/admin/views/agent-models.tsx`
- `trial/b1-routing/index.ts`
- `trial/QUOTA-POLICY.md`

## Tags

- opencode-v2
- agent-models
- verification
- routing
- subagent
- readiness
