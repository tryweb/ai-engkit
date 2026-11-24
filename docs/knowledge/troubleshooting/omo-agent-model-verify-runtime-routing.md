# OMO Agent-Model verify_runtime Agent Routing

> Historical V1-only investigation; the V2 runtime does not load this plugin.
> Keep for migration archaeology, not as current V2 operational guidance.

## Context

ai-engkit reconciles subagent models at startup (`reconcile-agent-models.sh`) and on admin apply
(`agent-model-live.ts`). Both run a live verification: create a session, POST a "Reply with
exactly OK." message, and read `info.providerID/modelID` from the response to confirm the agent
actually resolved to the configured model.

## Problem

Verification always ran as the **default agent** (`mode: "Sisyphus - ultraworker"` in the
response `info`) instead of the agent under test, so `verify_runtime` reported
`runtime_mismatch` even when config and `/agent` assignments were correct.

Root cause: the agent was sent in the **session-creation body**
(`{agent:$agent,title:...}`) but **omitted from the message POST body**:

```bash
# before — message body has no agent, so it runs as the default agent
-d '{"parts":[{"type":"text","text":"Reply with exactly OK."}]}'
```

OpenCode routes the message by the `agent` field in the **message** body; the session-level
agent is not sufficient. The E2E test (`test/test-agent-model-e2e.sh` `verify_child_model`)
always sent `agent` in both bodies — that was the working reference.

## Solution

Include `agent` in the message POST body, matching the E2E pattern:

```bash
# after
response="$(jq -nc --arg agent "$agent" '{agent:$agent,parts:[{type:"text",text:"Reply with exactly OK."}]}' \
  | curl -sS -m "${AGENT_MODELS_VERIFY_TIMEOUT:-20}" -w $'\n%{http_code}' \
    -H "Authorization: Basic $auth" -H 'Content-Type: application/json' \
    -X POST "$endpoint/session/$session/message" -d @- || true)"
```

Applied in two places:
- `scripts/agent-model-health.sh` → `verify_runtime()` (used by reconcile)
- `src/admin/lib/agent-model-live.ts` → `buildRequestVerificationScript()` (used by admin apply)

## Why It Works

OpenCode's `/session/<id>/message` endpoint dispatches to the agent named in the request body.
Without `agent`, the message falls through to the session's default agent, whose model may
differ from the configured target. Sending `agent:$agent` in the message makes the response
`info.mode` / `info.agent` match the agent under test.

## Side Effects / Tradeoffs

- Verification now actually exercises the target agent's model, so `runtime_mismatch` is a
  truthful signal instead of a false negative.
- Timeout per message attempt is configurable: `AGENT_MODELS_VERIFY_TIMEOUT` (default 20s),
  `AGENT_MODELS_VERIFY_RETRIES` (default 2). The first message right after a managed-server
  restart can hit a cold-provider timeout, hence the retry.

## Evidence

- Staging probe after fix: `AGENT_IN_RESPONSE=explore MODE_IN_RESPONSE=explore`
  (previously `Sisyphus - ultraworker`).
- Single-agent warm-server verify completes in 6-7s; reconcile total dropped from ~405s+
  (9 × 45s sequential) to 142-173s with parallel verification.
- Admin suite: 446 pass / 0 fail (includes `agent-model-live-route.test.ts` asserting the
  message body carries the agent).

## Related Files

- `scripts/agent-model-health.sh`
- `scripts/reconcile-agent-models.sh`
- `src/admin/lib/agent-model-live.ts`
- `src/admin/lib/agent-model-live-route.test.ts`
- `docs/knowledge/troubleshooting/omo-agent-model-verification-boundary.md`

## Tags

agent-model, verify_runtime, opencode-api, session-message, runtime-mismatch, agent-routing
