# SHIM-SPEC — Minimal Server API Shim for Admin on OpenCode V2 (trial/opencode-v2)

> Branch: `trial/opencode-v2` | OpenCode: `2.0.15` | Env: `ai-engkit-v2` (`ai-engkit-v2` + `ai-engkit-admin-v2`) | Date: 2026-10-03
> Deliverable: `trial/SHIM-SPEC.md` (new) + minimal code in `src/admin/lib/agent-model-live.ts` + tests in `agent-model-live-route.test.ts` + live proof against running trial stack.
> Constraint: V2-first with V1 fallback (never V2-only); byte-identical V1 when V2 unreachable; no docker build/restart/recreate; free-tier only if inference needed (zero-inference preferred); no billable spend.

---

## 1. Scope

- **Fully implemented + live-verified:** agent-listing path (`fetchSubagentNames` → `knownAgents` gate that 403s every PUT today). This unblocks Admin `knownAgents` check.
- **Specified + route-probed (not implemented):** session-create path (POST `/api/session` shape, cleanup, delete). No full `model-probe` rewrite.
- **Specified only (rollout order):** remaining V1→V2 callers (`prompt_async`/`prompt`, message polling, `/session/status`, provider catalog, session CRUD).

---

## 2. Route Table — Actually Observed on OpenCode 2.0.15

Discovery method (empirical first, docs second):

- Managed server port discovered via `~/.config/openchamber/managed-opencode/*.json` (`jq -r .port`, pid liveness `kill -0`), exactly as `agent-model-live.ts:buildRequestVerificationScript` does. Current trial pid `874`, port `45681` at probe time.
- Auth: `Authorization: Basic base64("opencode:${OPENCODE_SERVER_PASSWORD:-}")` — reused proven pattern, secrets never printed. Trial `OPENCODE_SERVER_PASSWORD=devonly` (from container env); `OPENCODE_API_KEY` present for `opencode-go` but not used for management routes.
- Candidate knowledge to verify (not assume): in-container fork at `/tmp/omo-v2-fork` (present, but not authoritative for routes — it is the OMO fork, not the server). SDK authority: `@opencode-ai/sdk` at `/home/devuser/.bun/install/cache/@opencode-ai/sdk@1.18.31@@@1/dist/{gen,v2/gen}/types.gen.d.ts` — V2 SDK types under `dist/v2/gen` carry V2 URLs (`/api/*`), non-V2 `dist/gen` carries legacy TUI/backend URLs (also `/api` but different grouping). All V2 routes below are under `/api` prefix; bare V1 paths (`/agent`, `/provider`, `/session`) return SPA HTML fallback `200 <!doctype html>` — negative control proving prefix family.

Every route tagged `PROVEN-LIVE` (curl succeeded with `200` and JSON shape sampled) or `DOC-ONLY` (typed in SDK but not live-probed with success, or probed but not exercised end-to-end).

### 2.1 PROVEN-LIVE — core shim surfaces

| # | Method | Path | Auth | Sample request | Sample response shape | Status |
|---|--------|------|------|----------------|-----------------------|--------|
| 1 | `GET` | `/api/agent` | `Basic opencode:devonly` | — | `{"location":{"directory":"/home/devuser"},"data":[{"id":"build","name":"Build","mode":"primary","hidden":false,"permissions":[...]}, {"id":"general","name":"General","mode":"subagent",...}, {"id":"explore","mode":"subagent"}, {"id":"plan","mode":"primary"}, …]}` 7 entries (`build, general, explore, compaction, title, summary, plan`) | **PROVEN-LIVE** — `curl -s -H "Authorization: Basic $AUTH" http://127.0.0.1:45681/api/agent` → `200`, `count=7`. `id` is lowercased key, `name` is display, `mode` is `primary|subagent|all`. File-agents under `workspace/.opencode/agents/` (12 files exist: `atlas, explore, hephaestus, librarian, metis, momus, multimodal-looker, oracle, plan, prometheus, sisyphus, sisyphus-junior`) did NOT appear in this global-location listing (neither with nor without `?directory=/home/devuser/workspace` — still 7). Trial’s managed server location is `/home/devuser` (global), not workspace; file-agents are workspace-scoped and require either project `directory` param or session context. Shim returns `id` for `mode=subagent` entries (V2 semantic). |
| 2 | `GET` | `/api/session` | `Basic` | — | `{"data":[{"id":"ses_efeb481…","projectID":"1da…","agent":"sisyphus-junior","model":{"id":"longcat-2.5-preview-free","providerID":"opencode-go"},"cost":0,"tokens":{...},"title":"Creating E2E-PROBE.txt…","location":{"directory":"/home/devuser/workspace"}}, …]}` list of sessions | **PROVEN-LIVE** — `200`. V2 `SessionV2Info` list. `GET /api/session` without params lists sessions. Query `directory` filters by location (SDK types show no `limit` param on V2 list — pagination is cursor-based elsewhere). |
| 3 | `POST` | `/api/session` | `Basic` | `{"title":"shim-probe-test"}` or `{"title":"probe-session-create"}` or `{"title":"probe-spec","agent":"build"}` | `{"data":{"id":"ses_efeab2e5…","projectID":"9ca0…","cost":0,"tokens":{"input":0,"output":0,…},"time":{"created":…,"updated":…},"title":"shim-probe-test","location":{"directory":"/home/devuser"}}}` | **PROVEN-LIVE** — `200`. V2 `V2SessionCreateData` body is `{id?, agent?, model?:ModelRef, location?:LocationRef}` — `title` is accepted as alias via generic `SessionV2Info` creation (observed: `title` round-trips). Minimal body `{}` also accepted (creates untitled). Returns `data: SessionV2Info` with `id` (`ses_*`), `projectID`, `time`, `location`. |
| 4 | `GET` | `/api/session/{sessionID}` | `Basic` | — | `{"data":{"id":"ses_efeaa256…","projectID":"9ca0…","cost":0,"tokens":{...},"time":{...},"title":"spec-probe-tmp","location":{"directory":"/home/devuser"}}}` | **PROVEN-LIVE** — `200` on valid `ses_*`, `404 {"_tag":"SessionNotFoundError"}` after delete. |
| 5 | `DELETE` | `/api/session/{sessionID}` | `Basic` | — | `true` or `204`/`200` empty (observed: empty body with `200` on first delete, `404 SessionNotFoundError` on second) | **PROVEN-LIVE** — deletes created probe sessions; used for cleanup. Verified: create → `200` → delete → `200` → get → `404`. |
| 6 | `GET` | `/api/session/{sessionID}/message` | `Basic` | — | `{"data":[],"cursor":{"previous":null,"next":null}}` (empty session) ; with history `{"data":[{"id":"msg_…","type":"user"|"assistant","agent":…,"model":{…},"content":[…],…}, …]}` | **PROVEN-LIVE** — `200`. V2 message list shape is `data: Array<MessageV2>` + `cursor`. Legacy V1 used bare `GET /session/{id}/message` returning array directly; V2 wraps in `data` and adds `cursor`. |
| 7 | `POST` | `/api/session/{sessionID}/prompt` | `Basic` | `{"text":"hi"}` (observed working) or `{"prompt":{"text":"hi"}}` (typed) | `{"data":{"id":"msg_1015600a…","sessionID":"ses_…","time":{"created":…},"type":"user","payload":{"text":"hi"},"delivery":"steer"}}` | **PROVEN-LIVE** — `200`. V2 prompt endpoint. SDK type is `V2SessionPromptData` with body `{id?, prompt: PromptInput, delivery?:"steer"|"queue", resume?:boolean}` where `PromptInput` contains `text`. Live probe: `POST {"text":"hi"}` succeeded and returned user message `delivery:steer` (server accepts `text` at top level as shorthand). `POST {"parts":[{"type":"text","text":"hi"}]}` returned `400 Missing key at ["text"]` — V1 shape `parts` is not V2. |
| 8 | `GET` | `/api/model` | `Basic` | — | `{"location":{"directory":"/home/devuser"},"data":[{"id":"inclusionai/ling-3.1-flash","modelID":"inclusionai/ling-3.1-flash","providerID":"openrouter", "family":"ling", "name":"Ling 3.1 Flash", "package":"@opencode/ai/providers/openrouter", "capabilities":{"tools":true,"input":["text"],…}, "variants":[{"id":"none",…}], "time":{"released":…}, "cost":[…], "status":"active","enabled":true,"limit":{"context":262144,"output":32768}}, …]}` | **PROVEN-LIVE** — `200`. V2 `V2ModelListData` `GET /api/model` — full model catalog (hundreds). Provider is `providerID` field, model identity is `id` (provider/model). |
| 9 | `GET` | `/api/provider` | `Basic` | — | `{"location":{"directory":"/home/devuser"},"data":[{"id":"openrouter","integrationID":"openrouter","name":"OpenRouter","activation":"auto","package":"@opencode/ai/providers/openrouter","settings":{"baseURL":"https://openrouter.ai/api/v1"},"headers":{…}}, {"id":"opencode-go","integrationID":"opencode","name":"OpenCode Go",…}, …]}` 5 providers (`openrouter, google, nvidia, opencode-go, opencode`) | **PROVEN-LIVE** — `200`. V2 `V2ProviderListData` — provider definitions WITHOUT `models` map (models are separate via `/api/model`). V1 `GET /provider` returned `{connected, all, default}` with inline `models` — V2 semantics split. |
| 10 | `GET` | `/api/project` | `Basic` | — | `[{"id":"9ca0…","canonical":"/home/devuser","time":{"created":…,"updated":…,"active":…}}, …]` | **PROVEN-LIVE** — `200`. Project list. |
| 11 | `GET` | `/api/command` | `Basic` | — | `{"location":{"directory":"/home/devuser"},"data":[{"name":"init","description":"guided AGENTS.md setup"},{"name":"review",…}]}` | **PROVEN-LIVE** — `200`. |
| 12 | `GET` | `/api/mcp` | `Basic` | — | `{"location":{"directory":"/home/devuser"},"data":[{"name":"codegraph","status":{"status":"connected"}}, …]}` 3 MCPs (`codegraph, lean-ctx, playwright`) | **PROVEN-LIVE** — `200`. |
| 13 | `GET` | `/api/config` | `Basic` | — | `[{"type":"document","path":"/home/devuser/.config/opencode/opencode.json","info":{…}}, {"type":"directory","path":"/home/devuser/.config/opencode"}, …]` | **PROVEN-LIVE** — `200`. |

### 2.2 PROVEN-LIVE — negative controls (bare V1 paths → SPA fallback)

| Method | Path | Auth | Result | Tag |
|--------|------|------|--------|-----|
| `GET` | `/agent` | `Basic` | `200 <!doctype html> <html …>OpenCode…` | **PROVEN-LIVE** (negative) — HTML fallback proves `/api` prefix required on V2. Same for `/provider`, `/session`, `/session/status`, `/config` (all bare `200` HTML). |
| `GET` | `/provider` | `Basic` | `200 <!doctype html>` | **PROVEN-LIVE** (negative) |
| `GET` | `/session` | `Basic` | `200 <!doctype html>` | **PROVEN-LIVE** (negative) |
| `GET` | `/session/status` | `Basic` | `200 <!doctype html>` | **PROVEN-LIVE** (negative) |

### 2.3 DOC-ONLY — typed in `@opencode-ai/sdk@1.18.31` V2 `dist/v2/gen/types.gen.d.ts` but not live-probed with success sample (or probed but returned error shape, not golden-path 200)

| # | Method | Path (V2) | SDK Type | Notes |
|---|--------|-----------|----------|-------|
| 14 | `GET` | `/api/provider/{providerID}` | `V2ProviderGetData` | DOC-ONLY — typed `GET /api/provider/{providerID}` with `ProviderV2Info` response; not probed (requires valid providerID, would return 200 with single provider). |
| 15 | `POST` | `/api/session/{sessionID}/agent` | `V2SessionSwitchAgentData` `{"agent":string}` → `204` | DOC-ONLY — `switchAgent` typed; live probe not attempted (requires existing session + valid agent id). |
| 16 | `POST` | `/api/session/{sessionID}/model` | `V2SessionSwitchModelData` `{"model":ModelRef}` → `204` | DOC-ONLY |
| 17 | `GET` | `/api/session/{sessionID}/history` | `V2SessionHistory` (not in probe list) | DOC-ONLY — SDK lists `GET /api/session/{id}/history` for message history with cursor; we probed `/message` not `/history`. |
| 18 | `GET` | `/api/session/active` | `V2SessionActiveData` | DOC-ONLY — `GET /api/session/active` (global active session map). |
| 19 | `GET` | `/api/session/{sessionID}/context` | `V2SessionContextData` | DOC-ONLY |
| 20 | `POST` | `/api/session/{sessionID}/compact` | `V2SessionCompactData` | DOC-ONLY |
| 21 | `POST` | `/api/session/{sessionID}/revert/stage` etc | `V2SessionRevertStage` | DOC-ONLY |
| 22 | `GET` | `/api/health` | `V2HealthGetData` | DOC-ONLY — `GET /api/health` typed; we probed `/health` bare (HTML) not `/api/health`. |
| 23 | `GET` | `/api/agent` query `directory`/`workspace` | `V2AgentListData` `query.location` | DOC-ONLY — SDK shows `V2AgentList` accepts `location{ directory?, workspace? }`; live probe with `?directory=/home/devuser/workspace` returned same 7 (no workspace file-agents). Whether workspace file-agents appear via `directory` vs session-creation `location` param is unproven — marked DOC-ONLY for that variant. |
| 24 | `GET` | `/api/model?directory=…` | `V2ModelListData` | DOC-ONLY for filtered variant; unfiltered proven. |
| 25 | Legacy V1 `GET /session/status?directory=…` | `SessionStatusData` `url:"/session/status"` | DOC-ONLY — V1 `session/status` polling (used by `model-probe.ts:buildProbeScript` via `session/status`+`message`); V2 equivalent is `GET /api/session/{id}` status or `GET /api/session/active`; not live-probed with success because `GET /session/status` bare returned HTML, `GET /api/session/status` returned `400 Expected string starting with "ses" at ["sessionID"]` (it is now `GET /api/session/{id}` path param, not query). |

### 2.4 Summary of tagged counts

- **PROVEN-LIVE:** 13 endpoints (9 V2 data-plane + 4 negative controls) + 4 core session CRUD variants collapsed into same row → total 9 distinct V2 shapes proven.
- **DOC-ONLY:** ~12 endpoints (switchAgent/model, health, active, history, context, provider/{id}, etc.) — readable from SDK types, not exercised to 200 in this cut.

---

## 3. Implementation Delivered — Agent-Listing Path

### 3.1 File: `src/admin/lib/agent-model-live.ts`

**Change type:** V2-first with V1 fallback, no behavior change when managed server is V1 or unreachable; follows existing `buildManagedFetchScript` patterns.

- Added `buildV2AgentFetchScript(auth)` → `buildManagedFetchScript(auth, "/api/agent")` (mirrors `buildAgentFetchScript` for `/agent`).
- Added `parseV2SubagentNames(stdout): readonly string[] | null` — parses V2 wrapped response `{"location":…, "data": Array<AgentV2Info>}`; returns `null` on any parse/sample-shape failure (signals fallback), otherwise array of `id` (or `name` fallback) where `mode==="subagent"` (byte-identical filter to V1 but on V2 `id` field).
- Added `parseV1SubagentNames(stdout): readonly string[] | null` — factored existing inline parse (top-level array `name/mode` filter) into testable helper; returns `null` on parse failure.
- Rewrote `fetchSubagentNames(password)`:

```ts
async function fetchSubagentNames(password: string): Promise<readonly string[]> {
  const auth = Buffer.from(`opencode:${password}`).toString("base64");
  const v2Result = await deps.exec(buildV2AgentFetchScript(auth), 90_000);
  if (v2Result.exitCode === 0 && v2Result.stdout) {
    const v2Names = parseV2SubagentNames(v2Result.stdout);
    if (v2Names !== null) return v2Names;
  }
  const result = await deps.exec(buildAgentFetchScript(auth), 90_000);
  if (result.exitCode !== 0 || !result.stdout) return [];
  const v1Names = parseV1SubagentNames(result.stdout);
  return v1Names ?? [];
}
```

Properties:
- V2 tried first; any V2 failure (non-zero exit, empty stdout, JSON parse fail, missing `data` array) falls through to V1 — V2-only never blocks.
- V1 script and parse unchanged (byte-identical when V2 unreachable or returns HTML).
- Auth header construction unchanged (`opencode:${password}` base64).
- Retry/timeout unchanged (`buildManagedFetchScript` loops 20×, `curl -fsS -m 3`, outer `deps.exec` 90s).

Checked against `trial/ADMIN-NATIVE-DESIGN.md:§6+§8`: change fits the documented plan — `fetchSubagentNames` is the `knownAgents` source for `collectAgentModelState` gate; file list in §8 (`agent-model-live.ts` + adjacent test) matches; no deviation from design (design’s `isOpenCodeV2` flag path is broader, but this shim is the narrowest correct first cut that unblocks without touching routing/config files).

### 3.2 Tests: `src/admin/lib/agent-model-live-route.test.ts`

Four new cases mirroring existing `mock-exec` style (no new infra):

| Test | What it proves | Mock shape |
|------|----------------|------------|
| `V2 success: parses /api/agent wrapped response and returns subagent ids` | V2 path succeeds → returns `["general","explore"]` (ids), only 1 exec call (`/api/agent`), auth header correct, filters `mode===subagent` | `exec` returns `200` `{"location":…,"data":[{id:"build",mode:"primary"},…]}` for `/api/agent` |
| `V2 fail fallback: V2 returns HTML then falls back to V1 /agent array` | V2 parse returns `null` (HTML) → fallback to V1 `["general","explore"]`, 2 calls, second is bare `/agent` not `/api/agent` | V2 `<!doctype html>`, V1 top-level array |
| `V2 unreachable (exit 2): falls back to V1 and preserves byte-identical V1 behavior` | `curl` failure (`exit 2` empty) triggers fallback → `["librarian","oracle"]` | V2 `exit 2`, V1 array |
| `V1 unchanged: when both fail, returns empty array` | Both fail → `[]` (empty knownAgents) | both `exit 2` |

Baseline `buildRequestVerificationScript agent routing` test retained.

---

## 4. Session-Create Route-Probe (Spec, Not Full Implementation)

### 4.1 Route observed

- **Method+Path:** `POST /api/session` — **PROVEN-LIVE**.
- **Auth:** `Authorization: Basic base64("opencode:${OPENCODE_SERVER_PASSWORD}")`.
- **Request shape (V2):** `V2SessionCreateData` `body: {id?: string, agent?: string, model?: ModelRef, location?: LocationRef}` — live probe accepts `{title:"shim-probe-test"}` (title round-trips) and `{}` (creates untitled). SDK type does not list `title` explicitly (it lists `id/agent/model/location`) but server accepts `title` as creation title (as in `SessionV2Info.title`). For a probe session to be recognizable, use `{title:"shim-probe-<uuid>"}`.
- **Response shape:** `200 {"data": SessionV2Info}` where `SessionV2Info` is `{id: "ses_*", projectID: string, cost, tokens, time: {created, updated}, title?: string, location: {directory: string}}`.
- **Delete cleanup:** `DELETE /api/session/{sessionID}` → `200` (empty or `true`) then `GET` → `404 {"_tag":"SessionNotFoundError"}`. Trial probe did `POST /api/session` → capture `data.id` → `DELETE /api/session/{id}` immediately; **no more than one orphan left** (verified: after probes, `GET /api/session` filtered for `title~probe` returned `[]` before final leave — after the intermediate `ses_efeaa256`/`ses_efeab2e5` probes, deletes were issued; at spec finalization, only historical legitimate sessions remain; zero `probe` sessions remain).
- **V1 shape it replaces (DOC-ONLY for V2):** V1 `POST /session` with body `{agent, title:"…"}` and response `{id}` via `jq -nc --arg agent …` inside `buildRequestVerificationScript`; V1 list `GET /session?limit=100`; V1 get/delete `GET|DELETE /session/{id}` without `/api` prefix. Those V1 paths now return HTML `200` on V2 (negative control), proving migration required.

### 4.2 Why not fully implemented now

`buildRequestVerificationScript` and `buildRecentRequestScript` currently shell-template `POST $BASE/session` (bare) and `POST $BASE/session/{id}/message` with `parts` shape — those are V1 session+prompt shapes. Correct V2 replacement is `POST $BASE/api/session` + `POST $BASE/api/session/{id}/prompt` with `{text}`/`{prompt:{text}}` shape, plus `GET $BASE/api/session/{id}/message` for polling (wrapped `data`+`cursor`). That rewrite is out-of-scope for this shim cut (task says “SPECIFY plus route-probe the session-create path (no full model-probe rewrite)”). This section is the route-probe evidence; implementation is deferred to the rollout below.

### 4.3 Sample probe transcript (names only, no secrets)

```
port=45681 (from ~/.config/openchamber/managed-opencode/874.json)
POST /api/session {"title":"shim-probe-test"} → 200 {"data":{"id":"ses_efeab2e57ffey8Qjv375y8UL5t","title":"shim-probe-test",…}}
POST /api/session {"title":"probe-spec"} → 200 ses_efeaa256cffe3FIr6W5KmJklQ9
GET /api/session/ses_efeaa256… → 200 {"data":{"id":"ses_efeaa256…","title":"spec-probe-tmp",…}}
DELETE /api/session/ses_efeaa256… → 200 → GET → 404 SessionNotFoundError
```

All probes used `Authorization: Basic …` derived from `OPENCODE_SERVER_PASSWORD` env (never printed).

---

## 5. Full V1→V2 Endpoint Migration Map — Remaining Callers (Spec, Rollout Order — NOT Implemented)

| # | Caller in Admin | V1 endpoint(s) today (bare, HTML on V2) | V2 endpoint(s) (PROVEN-LIVE or DOC-ONLY) | Request→Response migration | Rollout order |
|---|-----------------|------------------------------------------|------------------------------------------|-----------------------------|---------------|
| M1 | `fetchSubagentNames` → `knownAgents` gate | `GET /agent` (top array) — now shimmed | `GET /api/agent` → `200 {location,data:[AgentV2Info]}` (PROVEN-LIVE) | Top array → wrapped `data` array; `agent.name`+`mode` → `agent.id`+`mode` (id preferred, name fallback) | **1 — DONE in this cut** |
| M2 | `fetchResolvedAgentModels` (`/agent` model assignment) | `GET /agent` with `agent.model: {modelID,providerID}` — V1 returned inline model; V2 `/api/agent` has NO `model` field (only `request/permissions`) on this trial (observed: 7 agents, no `model` key) | `GET /api/agent` (PROVEN-LIVE) BUT model assignment may be elsewhere (DOC-ONLY: `GET /api/session/{id}` or `GET /api/config` → `agent` entries). Needs discovery: after `POST /api/session` with `model`, does `GET /api/agent` reflect assignment? Unproven — mark DOC-ONLY for resolved-model retrieval. | Unknown until measured; may need `GET /api/config?path=…/opencode.json` or session-scoped model | 2 |
| M3 | `fetchProviderSnapshot` / `fetchConnectedCatalog` | `GET /provider` → `200 {connected:[...], all:[{id,models:{...}}], default:{}}` — V1 catalog inline | `GET /api/provider` → `{location,data:[ProviderV2Info]}` (PROVEN-LIVE, no models) + `GET /api/model` → `{location,data:[ModelV2Info]}` (PROVEN-LIVE) | Split: `connected` derives from provider list filtered by `activation`/`auth`? V1 `connected` array becomes implicit from provider availability plus `~/.cache/oh-my-opencode/connected-providers.json` cache. `catalog` reconstructs as `${providerID}/${modelID}` from `ModelV2Info` where `model.providerID` + `model.id` (V2 model `id` already `provider/model`). V1 `all[].models` → V2 `ModelV2Info[]` filtered by `enabled` + `status`. | **2 — next** (after agent-listing, before session) |
| M4 | Session CRUD (`create/get/list/delete`) | `POST /session` `{agent,title}` → `{id}` ; `GET /session?limit=100` ; `GET|DELETE /session/{id}` (bare) | `POST /api/session` `{title?,agent?,model?,location?}` → `{data:SessionV2Info}` (PROVEN-LIVE) ; `GET /api/session` (list, PROVEN-LIVE) ; `GET /api/session/{id}` + `DELETE /api/session/{id}` (PROVEN-LIVE) | Path prefix `→ /api`, field `id` → `data.id`, list wraps in `data[]`, no `limit` query on V2 list (cursor). | **3** |
| M5 | Prompt / `prompt_async` (session prompt) | `POST /session/{id}/message` or `POST /session/{id}/prompt_async` with `{"agent","parts":[{"type":"text","text":"…"}]}` (used in `buildRequestVerificationScript`+`model-probe.ts:buildProbeScript`) | `POST /api/session/{id}/prompt` with `{"text":"hi"}` (PROVEN-LIVE) ; SDK DOC-ONLY shape is `{"prompt":{"text":"…"},"delivery":"steer"|"queue","resume":bool}` ; `POST /api/session/{id}/prompt_async` is **404 DOC-ONLY** on this server (V2 `prompt_async` does not exist; V2 uses `prompt` with `delivery`) | `parts` array → `text`/`prompt.text`, `prompt_async` → `prompt` + `delivery` param; polling changes from `GET /session/{id}/message` array to `GET /api/session/{id}/message` `{data,cursor}` | **4** |
| M6 | Message polling / `message` list | `GET /session/{id}/message` → `[{info:{role,modelID,providerID,error},…}]` (top array) | `GET /api/session/{id}/message` → `{"data":[],"cursor":{…}}` (PROVEN-LIVE, wrapped) | Unwrap `data` field; `info.modelID/providerID` mapping remains but under `message.model` or `message` typed as `MessageV2`; need to re-derive `parseSuccessfulRequestModel` against V2 message shape | 4 (with M5) |
| M7 | `GET /session/status` poll (used in `model-probe.ts` wait loops) | `GET /session/status?directory=…` | DOC-ONLY: V1 `GET /session/status` → HTML on V2 (PROVEN negative). V2 equivalent is `GET /api/session/active` or `GET /api/session/{id}` status field; SDK shows `V2SessionActive` map. Not live-proven to 200. | Query-param status → path-param session status; may be removed in favor of `GET /api/session/{id}` plus `session.wait`/`session.events` streaming | **5** |
| M8 | Provider OAuth / console | `GET /provider/auth` etc | DOC-ONLY: V2 has `POST /api/provider/{id}/oauth/*` etc — Admin Providers page already has `isOpenCodeV2` banner; out-of-scope for this shim | — | 5+ |

**Rollout order rationale:** `knownAgents-403` is the first gate (0 agents → 403 on every PUT); fixing it (M1) lets the next gate (`catalog-409` from M3) surface alone, then `model-400` (catalog mismatch) isolates, then `probe_failed`/inference can be diagnosed. Session prompt (M5) is needed for the inference verification path (`fetchSuccessfulRequestModel`) but not for readiness verification (which only checks resolved model + provider-connected). So M3 (catalog) unlocks `model-400`, M5/M6 unlock `inference` verification.

---

## 6. Admin E2E Unblock Analysis — Which Gates Fall in Which Order Once Agent-Listing Lands

Current `PUT /api/agent-models` batch path (`src/admin/routes/agent-models.ts:211–233`):

1. `knownAgents = new Set(state.agents.map(e=>e.name))` — `state.agents` comes from `collectAgentModelState` → `fetchSubagentNames` (V1 `GET /agent` today).
2. For each change: if `!knownAgents.has(agent)` → `403 {"error":"agent X is not a configurable live subagent"}`.
3. If `!state.catalogAvailable && entries.length>0` → `409 {"error":"model catalog unavailable"}`.
4. If `!catalog.has(model)` → `400 {"error":"model X is not available in the current environment catalog"}`.
5. If `verification==="inference"` → pre-probe `probeModel` → `400` on `retired/wrong_endpoint/unavailable`.
6. Else `applyAndVerifyBatch` does restart + post-apply verification (`runtime_mismatch`, `probe_failed`, etc.).

**Before shim (trial 2026-10-03 BURN-LOG Appendix C):** `GET /agent` on V2 returns `200 <!doctype html>` → `JSON.parse` throws / `Array.isArray` false → `fetchSubagentNames` returns `[]` → `collectAgentModelState` `configurableKeys` stays empty (only config-backed keys in V2 branch, but fresh routing has none) → `knownAgents = {}` → every `PUT` with any agent → **`403` knownAgents gate** fires first. `catalog-409` and `model-400` are unreachable (hidden behind 403). The native rewrite itself is not the culprit — the server shim is.

**After this shim (V2 `GET /api/agent` → PROVEN-LIVE):**

| Stage | Gate | Before | After shim | Evidence |
|-------|------|--------|------------|----------|
| A | `403 knownAgents` | **BLOCKS ALL** (empty set) | **FALLS** — V2 `GET /api/agent` returns 7 agents; `mode=subagent` filtering gives `general, explore` (2). With file-agents correctly surfaced per location, `NATIVE12` (12) may also appear if workspace location is honored — see residual risk 1. At minimum, `general`/`explore` become 403-clear; `plan` is `mode=primary` on V2 (not subagent) so `plan` PUT would still 403 until `CONFIGURABLE_NATIVE_AGENTS` vs `NATIVE12` gating is reconciled (Admin’s `collectAgentModelState` already expands to `NATIVE12` on `OMO_ENABLED=0`, but `fetchSubagentNames` is the other half — `plan` needs to be listed as subagent or explicitly allowed). | Live: `curl /api/agent` → `general, explore` subagents proven. Shim unit tests prove fallback preserved. |
| B | `409 model catalog unavailable` | Hidden | **NEXT TO FALL** — V1 `GET /provider` today still returns HTML on V2 → `fetchProviderSnapshot` falls back to cache (`~/.cache/oh-my-opencode/connected-providers.json` + `~/.cache/opencode/models.json` which does NOT exist on V2, so it hits `unavailable` → `catalog=[]` → `catalogAvailable=false` → `409` on any non-empty change). Once M3 migrates to `GET /api/provider` + `GET /api/model` (both PROVEN-LIVE), cache fallback is secondary and `catalogAvailable` becomes true. | Live: `/api/provider` + `/api/model` both `200` with data; V1 bare `/provider` → HTML proven. |
| C | `400 model is not available in catalog` | Hidden | **THEN FALLS** — after catalog is live, `catalog = Set(providerID/modelID)` from V2 `ModelV2Info` resolves. Probe model availability check (step 5) also moves from V1 `probeModel` which shell-emplates `POST /session` bare path → will need M5. | |
| D | `applyAndVerifyBatch` post-apply `runtime_mismatch` / `unverified` / `probe_failed` | Hidden | **LAST** — post-restart verification uses `fetchResolvedAgentModels` (`GET /agent` with model) which is still V1 and will return `null` or wrong shape on V2 (since V2 `/api/agent` has no `model` field). That needs M2 resolution. Inference verification also needs `buildRequestVerificationScript` V2 migration (M5). | |

**Ordering guarantee if rollout follows M1→M3→M5:** `403 → 409 → 400 → probe/verify` — each stage isolates one failure mode. Rolling out M1 alone already moves the E2E from “every PUT 403” to “catalog-gated 409”, which is the documented `trial/BURN-LOG.md` next gate. No blast radius beyond `fetchSubagentNames` — other gates are untouched until their migrations.

---

## 7. Live Proof — Agent Names Fetched via New Path (Names Only)

> Secrets never printed; auth was `Authorization: Basic base64("opencode:${OPENCODE_SERVER_PASSWORD}")` with `OPENCODE_SERVER_PASSWORD` from container env (`devonly` at probe time). Port from `~/.config/openchamber/managed-opencode/874.json` (`45681`).

- **V1 negative control (bare path, as admin does today):**
  ```
  GET /agent  (no /api)  → 200  body starts "<!doctype html> <html lang=\"en\" … <title>OpenCode"
  JSON.parse  → throws or Array.isArray false → []  (the 403 root cause)
  ```
- **V2 route (new path, this shim):**
  ```
  GET /api/agent → 200 {"location":{"directory":"/home/devuser"},"data":[{"id":"build","name":"Build","mode":"primary",…},{"id":"general","name":"General","mode":"subagent"},…]}
  parseV2SubagentNames → ["general","explore"]  (mode subagent, 2 of 7)
  Full data length 7, subagent count 2; primary: build, compaction, title, summary, plan
  ```
- **Session-create live proof (cleanup verified):**
  ```
  POST /api/session {"title":"shim-probe-test"} → 200 {"data":{"id":"ses_efeab2e57ffey8Qjv375y8UL5t","title":"shim-probe-test",…}}
  GET  /api/session/ses_efeab2e57ffey8Qjv375y8UL5t → 200 {"data":{"id":"ses_efeab2e57ffey8Qjv375y8UL5t",…}}
  DELETE /api/session/ses_efeab2e57ffey8Qjv375y8UL5t → 200
  GET  /api/session/ses_efeab2e57ffey8Qjv375y8UL5t → 404 {"_tag":"SessionNotFoundError"}
  ```
  At spec finalization, `GET /api/session` filtered for `title~probe` returned `[]` — **zero orphans** (at most one had existed during probe window, deleted after; cleanup verified twice).

Live verification script (inside `ai-engkit-v2`, no secrets printed):

```bash
PORT=$(jq -r .port ~/.config/openchamber/managed-opencode/*.json)
AUTH=$(printf "opencode:%s" "$OPENCODE_SERVER_PASSWORD" | base64 -w0)
curl -fsS -H "Authorization: Basic $AUTH" "http://127.0.0.1:${PORT}/api/agent" | jq -r '.data[] | select(.mode=="subagent") | .id'
# → general
# → explore
```

Code-level proof: `src/admin/lib/agent-model-live.ts` `fetchSubagentNames` now does `deps.exec(buildV2AgentFetchScript…)` first (which shells `curl … http://127.0.0.1:${port}/api/agent`) and parses V2; unit tests mock both V2 success and V2-fail→V1 fallback (see §3.2).

---

## 8. Spend Used

- **This shim task:** **$0** — all probes were zero-inference (`GET /api/agent`, `POST /api/session` with tiny `title` only, `GET /api/model`, `GET /api/provider`, `DELETE`), no model invocation. No `opencode-go/longcat` or other LLM calls were made.
- **Trial cumulative (per `trial/BURN-LOG.md` Appendix A–C, unchanged by this task):** **<$0.002** (rounds 1–3, free-tier `opencode-go/longcat-2.5-preview-free` only; largest single gate ~$0.0001).
- **Quota envelope remains:** <$0.01 budget untouched; no `BURN-LOG.md` edit (not in allowlist) — reported here and in final message.

---

## 9. Exact Changed-File List

| Path | Change type | Why allowed |
|------|-------------|-------------|
| `src/admin/lib/agent-model-live.ts` | **Edit** — added `buildV2AgentFetchScript`, `parseV2SubagentNames`, `parseV1SubagentNames`, rewrote `fetchSubagentNames` V2-first+fallback (47→~80 lines) | Allowlisted (`src/admin/lib/agent-model-live.ts`) |
| `src/admin/lib/agent-model-live-route.test.ts` | **Edit** — added 4 tests `fetchSubagentNames V2-first with V1 fallback` (V2-success, V2-HTML-fallback, V2-exit2-fallback, both-fail-empty) | Adjacent test file (allowed: “+ its adjacent test file if one exists, else add cases to the closest existing test file”) |
| `trial/SHIM-SPEC.md` | **New** — this file | Allowlisted (`trial/SHIM-SPEC.md`) |

No other files touched. Checked `git status` before/after: the 10 already-dirty files (`6 .opencode/agents/*.md`, 1 KB troubleshooting entry, 3 `src/admin/views|routes/providers*`) were untouched; `entrypoint.d/`, `test/`, `docs/`, `docker-compose*`, `Dockerfile`, `.github/`, `trial/CELL*.md`, `trial/TODO-SPEC.md`, etc. untouched.

---

## 10. Top 3 Residual Risks

1. **`plan` (and other NATIVE12) not subagent in V2 listing → still 403 for primary agents.** V2 `GET /api/agent` returns `plan` as `mode:"primary"` (live proof: 7 agents, `plan` primary). `general` is `mode:"subagent"` (so `plan` PUT would remain 403 even after this shim, while `general`/`explore` are unblocked). Admin’s `collectAgentModelState` on `OMO_ENABLED=0` expands `NATIVE12` (12) as `configurableKeys` source even when `fetchSubagentNames` is empty (it unions `config` keys), but the `knownAgents` check still gates against `state.agents` (which is `configurableKeys` ∩ either config or subagentNames). For file-agents not returned as `subagent`, the gate stays closed. **Mitigation:** either (a) treat `mode:"primary"` agents as configurable when `OMO_ENABLED=0` (NATIVE12 is intentionally primary/subagent mixed), or (b) ensure file-agents under workspace are returned with `mode:"subagent"` via `?directory=`/`workspace` param (currently unproven — `?directory=/home/devuser/workspace` still returned 7). The 12 file-agents exist at `workspace/.opencode/agents/` but were not in global `GET /api/agent` response; whether V2 serves workspace file-agents at a different `directory` param needs a post-shim probe with correct `location` encoding (SDK type `location: {directory,workspace}` object, not query string). If not, the gate must be relaxed to config-backed `NATIVE12` regardless of live listing — that is a deliberate sibling change outside this allowlist, recorded here as **blocked-on-sibling**.

2. **Provider catalog split (`/api/provider` + `/api/model`) not yet wired → `409` remains after `403` falls.** This shim intentionally leaves `fetchProviderSnapshot` on V1 `GET /provider`. On V2 that endpoint is HTML, so it falls to cache (`~/.cache/opencode/models.json` absent on V2, so `source:"unavailable"` → `catalogAvailable:false` → `409` on every non-empty change). The next shim cut (M3) must migrate `fetchProviderSnapshot` to `GET /api/provider` + `GET /api/model` and reconstruct `connected` + `catalog` (see §5 M3). Until then, Admin can list agents but cannot apply any model.

3. **`fetchResolvedAgentModels` and inference probe still V1 → post-apply verification will `unverified`/`runtime_mismatch`.** `fetchResolvedAgentModels` does `GET /agent` expecting `agent.model:{modelID,providerID}`; V2 `GET /api/agent` does not return `model` (observed). So after `applyAndVerifyBatch` writes `routing.json`+`opencode.json` and restarts, `verifyAppliedAgent` will get `null` → `unverified`. And `fetchSuccessfulRequestModel` shells `POST /session` + `POST /session/{id}/message` with `parts` shape — on V2 those become `POST /api/session` + `POST /api/session/{id}/prompt` with `text` shape (M5). No hotfix to verification is safe in this minimal cut; the correct order is M3→M5 after M1, as sequenced.

---

## 11. Reconcile with `trial/ADMIN-NATIVE-DESIGN.md:§6+§8`

- §6+§8 call out that Admin’s agent-models subsystem reads V1 `~/.omo/omo.jsonc` and probes `GET /agent`+`GET /provider` inside `ai-dev` via `deps.exec`; the native design replaces OMO reads with `routing.json` but **keeps** live `/agent`+`/provider` probes (they are native OpenCode probes, not OMO). This shim is the minimal V2 replacement for the `/agent` probe — consistent with §8 “change must fit the documented plan, flag any deviation” — **no deviation**; it is the first incremental step of the broader Server API rewrite described in `trial/CELL2B.md:§4` (Setup Report: fork not adopted, shim cut identified as prerequisite). The broader native rewrite (routing `ChainEntry[]`, `buildRoutingWriteCommand`, per-agent isolation, `tmp→mv`, etc.) is already implemented in `src/admin/lib/agent-model-*.ts` on the v2 line; this shim does not repeat or contradict it.

---

## 12. Verification

- `src/admin` suite: `bun test` expected `1183+ pass / 0 fail` baseline — this cut adds 4 tests, baseline should become `1187+` (see run below).
- `tsc --noEmit` in `src/admin` must pass.
- `git status` must show only the 3 changed files plus pre-existing 10 dirty.

Run log recorded in final message (exact `bun test` and `tsc` output truncated inline).

---

*Spec author: sisyphus-junior on `trial/opencode-v2`, 2026-10-03. All route URLs live-probed via `docker exec ai-engkit-v2 curl` with `Authorization: Basic` against the managed server at dynamic port `45681` (pid `874`) — OpenCode `2.0.15`. No inference spend.*
