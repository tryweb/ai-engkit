# Git Hosting PAT Auto-Check Cadence and Stale `Checked` Timestamp

## Context

Admin Dashboard → Git Hosting shows per-host `Checked <timestamp> · N days remaining`
for GitLab PAT credential health. Operators seeing a `Checked` time many hours
old may suspect the auto-check is broken.

## Problem

`Checked 2026-10-23T09:01:01.796Z` was still displayed on 2026-10-24T03:39Z
(~18.6 h later), looking like the checker had stalled for "over 24 hours".
In fact the mechanism was healthy; the timestamp semantics were misunderstood.
Related questions from the same session: does Rotate reset the check time, and
does a container restart auto-check or just reset the timestamp?

## Solution

No fix needed. Rules for reading that page:

1. `Checked` updates only on scheduler `tick()` (every 24 h) or a startup tick
   after admin container restart — not continuously. Anything under 24 h old
   is normal.
2. `Checked` is UTC (`Z` suffix). The same instant shows as `17:01 +0800` in
   container file mtimes — compare in the same timezone before concluding
   staleness.
3. Pressing **Rotate credential** resets that host's `checked_at` to press time
   (success, already-current, and failure paths all rewrite it), but the page
   does **not** auto-reload — refresh the page to see the new time.
4. A container restart performs a **real** check (inspect each host +
   GitHub), fire-and-forget, ~1 s after start. It does not merely reset the
   timestamp.

## Why It Works

- `GitHostingAuthScheduler` defaults to `DEFAULT_GIT_HOSTING_AUTH_CHECK_INTERVAL_MS
  = 86_400_000` (24 h) unless `GIT_HOSTING_AUTH_CHECK_INTERVAL_MS` is set
  (`src/admin/lib/git-hosting-auth-scheduler.ts:21,65-71`). No override was set
  in the `ai-engkit-admin` container.
- `start()` runs one full `tick()` fire-and-forget, then `setInterval(intervalMs)`
  (`git-hosting-auth-scheduler.ts:218-225`). `server.ts:410` starts it at boot.
- Observed: container `StartedAt 2026-10-23T09:01:01.007Z`, state file
  `checked_at 2026-10-23T09:01:01.796Z` — the 0.8 s gap is a real
  inspect-two-hosts-plus-GitHub round trip, proving the startup check ran.
- `POST /api/auth/glab/rotate` → `persistRotationState` → `stateForRotation`
  stamps `checked_at: new Date(now).toISOString()` on all three outcome paths,
  scoped to that hostname only (`src/admin/routes/glab-auth.ts:84-137`).
- Frontend `rotateGlab` only updates the inline result span, no
  `location.reload()` (`src/admin/views/git-hosting.tsx:228-254`).

## Side Effects / Tradeoffs

- Container restart resets the 24 h timer (interval-based `setInterval`, not
  cron); frequent restarts delay the next periodic tick, but the startup tick
  covers the gap.
- `days_remaining` is a snapshot from check time and can drift up to 24 h;
  harmless against the 7-day rotation threshold.
- A failed startup/periodic check overwrites that host's entry as `unhealthy`
  with an `error_code` (and logs `Git hosting auth scheduler ...`), rather
  than preserving the last healthy state — red on the page means a check
  really ran and failed.
- Possible future improvement: show a "stale check (>N h)" hint in
  `GitLabHealthRow`, and reload or patch the row after Rotate.

## Evidence

- Logs / observed behavior:
  - `docker inspect ai-engkit-admin --format '{{.State.StartedAt}}'` →
    `2026-10-23T09:01:01.007059314Z`
  - `cat /opt/ai-engkit/admin-data/git-hosting-auth-state.json` (inside
    container) → both hosts `healthy`, `checked_at 2026-10-23T09:01:01.796Z`
  - `docker logs ai-engkit-admin --since 30h | grep -icE 'git hosting auth scheduler'` → `0` (no errors)
  - No `GIT_HOSTING_AUTH_CHECK_INTERVAL_MS` in container env (defaults apply)
- Diagnostics: `docker ps` showed `ai-engkit-admin Up 19 hours`, consistent
  with an ~18.6 h-old `Checked` and a next tick due ~2026-10-24T09:01Z.
- Docs / source references: `src/admin/lib/git-hosting-auth-scheduler.ts`
  (tick/start), `src/admin/server.ts:387-413` (scheduler wiring),
  `src/admin/routes/glab-auth.ts:84-137,192-218` (rotate + persist),
  `src/admin/views/git-hosting.tsx:32-49,228-254` (row + rotateGlab).

## Related Files

- `src/admin/lib/git-hosting-auth-scheduler.ts`
- `src/admin/lib/git-hosting-auth-state.ts`
- `src/admin/routes/glab-auth.ts`
- `src/admin/views/git-hosting.tsx`
- `src/admin/server.ts`

## Tags

- git-hosting
- gitlab-pat
- credential-health
- scheduler
- admin-dashboard
- troubleshooting
