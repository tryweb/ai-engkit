# OpenCode Model Request Failure Classification

## Context

ai-engkit verifies configured agent models through a managed OpenCode server. A model request can fail at several layers: the provider, OpenCode's retry loop, the OpenCode HTTP API, or the outer `curl` transport.

These layers must be observed separately. A transport timeout does not prove that the provider timed out, and a connected provider or catalog entry does not prove that a model can answer a request.

This entry is the registry for confirmed model-request failure markers. Add provider-specific behavior here only after it is supported by runtime evidence or an authoritative upstream source.

## Problem

OpenCode `1.18.25` exposes both synchronous and asynchronous prompt APIs. The synchronous request:

```text
POST /session/:id/message
```

waits for the complete LLM turn. When a provider returns a retryable `429`, OpenCode can publish an error immediately but keep the synchronous HTTP request open while its retry policy runs. An outer `curl -m 90` then reports only a timeout.

This caused a confirmed rate-limit failure for `general` using `opencode/muse-spark-1.2-contributor-free` to be misclassified as `timeout` or `unreachable`:

- OpenCode started the provider stream at `15:05:42.531Z`.
- OpenCode logged `AI_APICallError: Rate limit exceeded. Please try again later.` at `15:05:43.279Z`.
- The assistant message contained zero tokens, no content part, and no error field.
- The synchronous Admin verification request did not return until the 90-second curl deadline.

The error existed after about 0.75 seconds, but the current probe observed only the blocking HTTP response body.

## Solution

### Use an error-aware asynchronous probe

The supported probe flow is:

1. Create a dedicated OpenCode session and retain its exact session ID.
2. Subscribe to `GET /event` before sending the request, or prepare to poll the session endpoints.
3. Send the request with `POST /session/:id/prompt_async`; it returns `204 No Content` without waiting for provider retries.
4. Correlate all observations by the exact session ID.
5. Stop as soon as one terminal signal appears:
   - `session.error` event;
   - assistant `info.error` from `GET /session/:id/message`;
   - terminal `session.status` / `session.idle` state;
   - successful assistant content with matching `providerID` and `modelID`.
6. Sanitize the reason, normalize the status, and persist both in the provider/model credential-scoped health cache.
7. Delete the probe session on every exit path.

Core logs may be used to diagnose an OpenCode observability gap, but production classification should prefer structured API events and message/status polling over log parsing.

### Retrieve and validate OpenRouter free models

Use OpenRouter's official `GET https://openrouter.ai/api/v1/models` catalog rather than inferring free access from a model name alone:

1. Select model IDs ending in `:free`.
2. Confirm `pricing.prompt`, `pricing.completion`, and `pricing.request` are all the string value `"0"`.
3. If the verifier requires tools, confirm `supported_parameters` contains `tools` (and/or `tool_choice`).
4. Map an OpenRouter catalog ID such as `google/gemma-4-26b-a4b-it:free` to the ai-engkit reference `openrouter/google/gemma-4-26b-a4b-it:free`.
5. Run the real inference probe; metadata proves pricing and declared capability, not live availability.

`openrouter/free` is a random free-model router and is not deterministic; use an explicit `:free` model for reproducible validation. Free models can still return quota/rate-limit, upstream availability, tool-support, or timeout failures.

### Normalize failure classes before rendering

Apply these rules in order:

1. A provider-specific quota/rate-limit marker normalizes to `quota_exceeded` and is terminal for the current probe. Do not add another ai-engkit retry on top of OpenCode's retry policy.
2. An explicit gateway/deadline/transport marker without a quota marker normalizes to `timeout`.
3. An abort/cancel marker normalizes to `aborted`.
4. A confirmed model-not-found or retired marker normalizes to `unavailable` or `retired`.
5. A transport timeout with no provider error is only `timeout`; never infer `quota_exceeded` from elapsed time or a free-model name.
6. A zero-token assistant message with no content and no error is an observability gap, not proof of success or a provider category.

### Provider marker registry

Keep provider-specific additions in this table. Add one row per independently verified marker and include the evidence surface and tested version/date.

| Provider ID | Normalized status | Confirmed marker | Preferred evidence surface | Verified environment |
|---|---|---|---|---|
| `opencode` | `quota_exceeded` | `AI_APICallError: Rate limit exceeded. Please try again later.` | `session.error`; OpenCode core log confirms the same session ID | OpenCode `1.18.25`, `muse-spark-1.2-contributor-free`, 2026-09-02 |
| `opencode` | `quota_exceeded` | `FreeUsageLimitError` or `GoUsageLimitError` in `APIError.data.responseBody` | assistant `info.error` or `session.error` | OpenCode upstream `1.18.x` retry source |
| `nvidia` | `quota_exceeded` | HTTP `429`, `Too Many Requests` | assistant `info.error`; `session.error` | OpenCode `1.18.25`, 2026-09-02 |
| `openrouter` | `quota_exceeded` | `Key limit exceeded (total limit)` | assistant `info.error` | OpenRouter via OpenCode `1.18.25`, 2026-09-03 |
| `openrouter` | `unavailable` | `No endpoints found that support tool use` | assistant `info.error` | OpenRouter via OpenCode `1.18.25`, 2026-09-03 |
| `openrouter` | `timeout` | `probe polling timed out after 90 seconds` with no terminal provider error | bounded message/status polling | OpenRouter via OpenCode `1.18.25`, 2026-09-03 |
| `openrouter` | `unavailable` | `tool use is not supported`, `Function calling is not supported`, or equivalent tool-capability marker | assistant `info.error` | OpenRouter via OpenCode `1.18.25`, 2026-09-03 |
| `opencode` | `unavailable` | `Error from provider (Console): OpenCode's free tier can only be used from within OpenCode` — free-tier anti-abuse gate (not quota): parent primary sessions pass, task-dispatched child subagent sessions fail with zero model time | assistant `info.error` in OpenChamber child session (Turn stats Model time `0.0s`); upstream `anomalyco/opencode#49680`, `#49580`, `#49588` | OpenCode `2.0.15` + OpenChamber `2.0.0`, `opencode/big-pickle` in `explore` subagent, ai-engkit-v2, 2026-09-25 |

When adding a provider:

- preserve the provider's exact marker text;
- record whether evidence came from an API response, SSE event, status poll, or diagnostic log;
- record the OpenCode/provider version and observation date;
- add a regression fixture before changing classification code;
- do not generalize a marker to other providers without independent evidence.

## Why It Works

`prompt_async` separates request submission from completion. The verifier can observe `session.error`, `message.updated`, and `session.status` while OpenCode applies its own retry policy instead of blocking on the synchronous response.

Session-ID correlation prevents errors from concurrent model probes from being assigned to the wrong agent. This mattered during the incident because `opencode/muse-spark-1.2-contributor-free` and `nvidia/moonshotai/kimi-k3` produced different rate-limit errors in overlapping verification windows.

Persisting the normalized status and sanitized reason together allows the server-rendered Agent Models page to restore the same detail icon and tooltip after reload. Cache entries remain scoped by provider, credential fingerprint, and model reference, so credentials or model changes force a new observation.

## Side Effects / Tradeoffs

- Asynchronous probing requires bounded polling or an SSE subscription and explicit cleanup.
- SSE consumers must subscribe before sending the prompt or fall back to message/status polling to avoid missing an early event.
- OpenCode may retry provider errors internally; the verifier should show the first confirmed terminal marker without adding another retry loop.
- Structured error persistence can vary by OpenCode version. In `1.18.25`, the confirmed `opencode` rate-limit was present in the core log while the assistant message had no error field.
- Core-log parsing is version-sensitive and should remain a diagnostic fallback, not the primary product contract.
- Reasons must be sanitized before caching or rendering; never persist authorization headers, API keys, tokens, passwords, or full credentials.
- A provider marker registry requires maintenance when provider error formats or OpenCode schemas change.

## Evidence

- Runtime configuration: `general` used `opencode/muse-spark-1.2-contributor-free`.
- OpenCode core log for session `ses_f9d5874d8ffeTvz0DqlR2OIoci`:
  - stream started at `2026-09-02T15:05:42.531Z`;
  - `AI_APICallError: Rate limit exceeded. Please try again later.` logged at `2026-09-02T15:05:43.279Z`.
- The same session's SQLite records showed the expected provider/model, zero input/output tokens, one user text part, an assistant message with no content parts, and no persisted assistant error.
- Admin runtime logs showed `POST /api/agent-models/verify` returning HTTP `200` after approximately 91 seconds, matching the inner `curl -m 90` deadline rather than the provider error time.
- A separate `nvidia/moonshotai/kimi-k3` session emitted HTTP `429` / `Too Many Requests`, proving concurrent provider failures must be correlated by session ID.
- OpenRouter official model metadata exposed zero pricing and tool support for `cohere/north-mini-code:free`, `dots-studio/dots-3-note-preview:free`, `google/gemma-4-26b-a4b-it:free`, and `liquid/lfm-2.5-2.6b:free`; the fifth selected catalog entry was not present in the live metadata response.
- Dev inference verification of 14 deterministic `:free` models produced 10 `healthy`, 2 `quota_exceeded`/upstream rate-limit, 1 `unavailable` due to missing tool support, and 1 `timeout`; `openrouter/free` timed out and was excluded from deterministic validation.
- A random dev sample of 20 OpenRouter models produced 2 `healthy`, 14 `quota_exceeded` due to `Key limit exceeded (total limit)`, 3 `unavailable` due to missing tool-capable endpoints, and 1 `timeout`.
- OpenRouter official references: <https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties>, <https://openrouter.ai/docs/guides/overview/models.md>, <https://openrouter.ai/docs/guides/routing/model-variants/free>, <https://openrouter.ai/docs/guides/routing/routers/free-router>.
- Official OpenCode server documentation distinguishes synchronous `POST /session/:id/message` from asynchronous `POST /session/:id/prompt_async` and documents `GET /event`.
- OpenCode source publishes `session.error` and exposes `session.status` retry state; its retry policy classifies `429`, rate-limit, and too-many-requests markers as retryable.
- Upstream references:
  - <https://opencode.ai/docs/server>
  - <https://opencode.ai/docs/sdk>
  - <https://github.com/anomalyco/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts#L295-L330>
  - <https://github.com/anomalyco/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/opencode/src/session/retry.ts#L17-L175>
  - <https://github.com/anomalyco/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/schema/src/v1/session.ts#L651-L657>

## Related Files

- `src/admin/lib/model-probe.ts` — probe transport, classification, sanitization, and health cache.
- `src/admin/lib/agent-models.ts` — per-agent verification orchestration and cached state projection.
- `src/admin/views/agent-models.tsx` — verification status, detail icon, tooltip, and reload rendering.
- `src/admin/lib/model-metadata.ts` — normalized pricing/capability metadata used for model selection.
- `docs/knowledge/troubleshooting/managed-opencode-health-timeout-during-reconciliation.md`
- `docs/knowledge/troubleshooting/omo-agent-model-verification-boundary.md`
- `docs/knowledge/troubleshooting/opencode-provider-connected-vs-catalog.md`

## Tags

`opencode` `provider` `model-request` `failure-classification` `rate-limit` `quota_exceeded` `prompt_async` `session.error` `timeout` `agent-models`
