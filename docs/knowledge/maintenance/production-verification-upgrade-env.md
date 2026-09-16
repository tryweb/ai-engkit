# Production Verification Plan: Upgrade & Env Editor

## Scope

Verify the Upgrade pipeline and Environment Variable editor in a **production**
deployment (`docker-compose.yml`, `image: ghcr.io/tryweb/ai-engkit:latest`).

These features cannot be meaningfully tested in dev (see
`docs/knowledge/architecture/dev-verification-limitations.md`).
This plan assumes a running production instance with `ADMIN_PASSWORD` configured
and dashboard accessible at `http://localhost:8080` (or configured `ADMIN_PORT`).

---

## 1. Env Editor — Read/Write Verification

### 1.1 Verify env list loads

```bash
curl -s -b <session> http://localhost:8080/api/env | jq 'has("OPENCHAMBER_UI_PASSWORD")'
```

- [ ] **Expected**: `true` — returns full .env content as JSON
- [ ] Schema keys (`ADMIN_PORT`, `BACKUP_RETENTION`, etc.) present in response
- [ ] Values are NOT masked in API response (raw .env content)

### 1.2 Verify env editor page renders

```bash
curl -s -b <session> http://localhost:8080/env | grep -q "Env Variables"
```

- [ ] **Expected**: page renders with "Env Variables" heading
- [ ] All schema-defined keys shown in list with current values
- [ ] Password-type fields masked (`******`)
- [ ] "Reveal" toggle works on password fields
- [ ] Inline edit button present per variable

### 1.3 Verify single variable write

```bash
curl -s -b <session> -X PUT http://localhost:8080/api/env/BACKUP_RETENTION \
  -H "Content-Type: application/json" \
  -d '{"value":"3"}'
```

- [ ] **Expected**: `{"ok":true}`
- [ ] Readback: `curl -sb <session> http://localhost:8080/api/env | jq '.BACKUP_RETENTION'`
  → `"3"`

### 1.4 Verify validation

```bash
curl -s -b <session> -X PUT http://localhost:8080/api/env/CHAMBER_PORT \
  -H "Content-Type: application/json" \
  -d '{"value":"not-a-number"}'
```

- [ ] **Expected**: HTTP 400 with `{"error":"Invalid port: not-a-number"}`
- [ ] Invalid values are rejected; current value unchanged

### 1.5 Restore test value

```bash
curl -s -b <session> -X PUT http://localhost:8080/api/env/BACKUP_RETENTION \
  -H "Content-Type: application/json" \
  -d '{"value":"5"}'
```

- [ ] **Expected**: `{"ok":true}`

---

## 2. Env Editor — Apply via Restart (Tier 2)

Test that changing a Tier-2 variable (requires ai-dev restart) takes effect.

### 2.1 Change a visible variable

```bash
curl -s -b <session> -X PUT http://localhost:8080/api/env/OPENCHAMBER_UI_PASSWORD \
  -H "Content-Type: application/json" \
  -d '{"value":"verify-test-123"}'
```

- [ ] **Expected**: `{"ok":true}`

### 2.2 Trigger restart

```bash
curl -s -b <session> -X POST http://localhost:8080/api/env/restart
```

- [ ] **Expected**: `{"ok":true}`
- [ ] ai-dev container restarts (2-3s)
- [ ] Dashboard remains accessible during restart
- [ ] No error in admin container logs

### 2.3 Verify new env var is picked up

```bash
docker exec ai-engkit sh -c 'echo $OPENCHAMBER_UI_PASSWORD'
```

- [ ] **Expected**: `verify-test-123`
- [ ] New value is active in ai-dev container

### 2.4 Restore original value

```bash
curl -s -b <session> -X PUT http://localhost:8080/api/env/OPENCHAMBER_UI_PASSWORD \
  -H "Content-Type: application/json" \
  -d '{"value":"chamber"}'
curl -s -b <session> -X POST http://localhost:8080/api/env/restart
```

- [ ] **Expected**: Both return `{"ok":true}`

---

## 3. Upgrade — Version Check

### 3.1 Check update API

```bash
curl -s -b <session> http://localhost:8080/api/versions/check-update | jq .
```

- [ ] **Expected**: Response with `current`, `latest`, `update_available` fields
- [ ] `current` matches `/opt/ai-engkit/VERSION` content
- [ ] `update_available` is `true` if GHCR has a newer version
- [ ] `status` is `"update-available"` or `"up-to-date"` (not `"check-failed"`)
- [ ] If production has version `dev` → investigate (should not happen in production)

### 3.2 Verify Dashboard badge

- [ ] Navigate to Dashboard → Component Versions card
- [ ] AI-EngKit row shows either `✓ Latest` or `▲ Upgrade`
- [ ] Badge matches `/api/versions/check-update` result
- [ ] No `? unavailable` badge (that indicates dev mode)

---

## 4. Upgrade — Full Pipeline

### Prerequisites

- Production host must have network access to `ghcr.io` and `raw.githubusercontent.com`
- Sufficient disk space for image pull + backup
- `docker compose` CLI available (mounted Docker socket)

### 4.1 Pre-flight: compose file exists

Skip this test if `docker-compose.yml` is not mounted (will fail at
pre-flight check automatically).

```bash
docker exec ai-engkit-admin test -f /opt/ai-engkit/compose.yml && echo "ok"
```

- [ ] **Expected**: `ok`

### 4.2 Start upgrade

```bash
UPGRADE_RESPONSE=$(curl -s -b <session> -X POST http://localhost:8080/api/upgrade)
echo "$UPGRADE_RESPONSE" | jq .
```

- [ ] **Expected**: `{"status":"started","log_url":"/api/upgrade/log"}`
- [ ] If `409 {"error":"Upgrade already in progress"}` → check if another
      upgrade is running, wait, or check `/api/upgrade/status`

### 4.3 Monitor SSE log stream

```bash
# Watch progress for up to 5 minutes
timeout 300 curl -s -b <session> http://localhost:8080/api/upgrade/log
```

- [ ] **Expected**: SSE events streamed with fields `id`, `step`, `status`, `message`, `timestamp`
- [ ] Events arrive in chronological order
- [ ] `id` field is monotonic (no gaps)

### 4.4 Step-by-step verification

Monitor `/api/upgrade/status` during the pipeline:

```bash
curl -s -b <session> http://localhost:8080/api/upgrade/status | jq .
```

| Step | Expected event | Expected duration |
|------|---------------|-------------------|
| **1. digest_compare** | `docker pull ghcr.io/...` → success/fail | ~10-60s |
| **2. backup** | `.env` + Compose inputs + settings copied to `/opt/ai-engkit/backups/pre-<ts>/`; overlay inputs included when configured | ~1s |
| **3. merge_env** | Upstream `.env.example` fetched, new keys appended | ~3-5s |
| **4. recreate** | Effective base-plus-overlay validated, then `docker compose up -d --force-recreate ai-dev` | ~10-30s |
| **5. poll_health** | ai-dev container becomes "Up" | ~5-30s |
| **6. reconcile** | Missing OpenChamber project registrations restored (add-only) | ~1-5s |
| **7. cleanup** | `docker image prune -f` | ~2-5s |

### 4.5 Verify events

- [ ] Each step emits `"running"` when it starts
- [ ] Each step emits `"success"` or `"failure"` when done
- [ ] Step 1: pull output mentions image digest
- [ ] Step 2: backup path includes timestamp
- [ ] Step 4: container is recreated (new container ID)
- [ ] Step 7: any dangling images removed

### 4.6 Verify upgrade status on completion

```bash
curl -s -b <session> http://localhost:8080/api/upgrade/status | jq .
```

- [ ] **Expected**: `{"state":"completed", ...}` (or `"failed"` if errors)
- [ ] `progress_pct` is `100` for completed
- [ ] `events` array contains all 7 steps

### 4.7 Verify post-upgrade version

```bash
curl -s -b <session> http://localhost:8080/api/versions/check-update | jq .
```

- [ ] If upgrade succeeded: `update_available` should now be `false`
      (version should equal latest)
- [ ] Dashboard badge should show `✓ Latest`

### 4.8 Verify backup was created

```bash
ls -la /opt/ai-engkit/backups/
```

- [ ] Backup directory exists with timestamp name
- [ ] Contains `.env`, `compose.yml`, and OpenChamber settings
- [ ] Overlay installations also contain the staged base and overlay backup data

### 4.9 Verify rollback on failure (negative test)

If any step fails:
- [ ] Failed step emits `"failure"` with error message
- [ ] Pipeline state becomes `"failed"`
- [ ] Backup files remain in `/opt/ai-engkit/backups/` for manual restore
- [ ] Dashboard shows failure status

---

## 5. SSE Lifecycle Verification

### 5.1 Verify event deduplication

```bash
# Connect to SSE, collect first event batch
curl -s -b <session> http://localhost:8080/api/upgrade/log?history=1 | head -1 | jq .
```

- [ ] Each event has `id` field
- [ ] Reconnecting sends same events but client can skip by `lastEventId`

### 5.2 Verify `/api/upgrade/status` bootstrap

```bash
# After upgrade completes or fails
curl -s -b <session> http://localhost:8080/api/upgrade/status | jq '.events | length'
```

- [ ] Events count matches full pipeline log
- [ ] State is `"completed"` or `"failed"` (not `"running"`)

### 5.3 Verify 409 → attach behavior

If another user/script calls POST `/api/upgrade` while already running:

```bash
curl -s -b <session> -X POST http://localhost:8080/api/upgrade
# Expect 409, then:
curl -s -b <session> http://localhost:8080/api/upgrade/status | jq '.state'
```

- [ ] **Expected**: 409 response includes `status.state` = `"running"`
- [ ] Client can attach to existing run's SSE stream

---

## 6. Cleanup

```bash
# Restart admin container if needed
docker restart ai-engkit-admin

# Verify dashboard accessible
curl -sf http://localhost:8080/login | grep -q "ai-admin" && echo "ok"
```

- [ ] Dashboard accessible after restart
- [ ] No stale upgrade state

---

## Summary Checklist

| # | Check | Result |
|---|-------|--------|
| 1.1 | Env list API returns JSON | □ |
| 1.2 | Env editor page renders | □ |
| 1.3 | Single variable write + readback | □ |
| 1.4 | Validation rejects invalid values | □ |
| 2.1-2.3 | Env change → restart → ai-dev picks up new var | □ |
| 3.1 | Version check API returns correct data | □ |
| 3.2 | Dashboard badge matches check result | □ |
| 4.1 | Compose file exists | □ |
| 4.2-4.7 | Full upgrade pipeline (6 steps) | □ |
| 4.8 | Backup created | □ |
| 4.9 | Rollback on failure | □ |
| 5.1 | SSE events have monotonic IDs | □ |
| 5.2 | `/api/upgrade/status` mirrors event log | □ |
| 5.3 | 409 → attach works | □ |
| 6 | Cleanup | □ |

## Related Files

- `src/admin/routes/env.ts` — env API + restart endpoint
- `src/admin/routes/upgrade.ts` — upgrade API + SSE
- `src/admin/lib/upgrade.ts` — upgrade pipeline implementation
- `src/admin/routes/versions.ts` — version check endpoint
- `docs/knowledge/architecture/dev-verification-limitations.md`
- `docs/knowledge/architecture/operations-pipeline-environment-agnostic.md`
- `docs/knowledge/architecture/admin-env-editor-dataflow.md`

## Tags

`#production` `#verification` `#upgrade` `#env-editor` `#sse` `#testing`
