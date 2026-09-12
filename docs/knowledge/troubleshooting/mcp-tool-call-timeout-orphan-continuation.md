# MCP Tool-Call Timeout Leaves Orphan Process That Finishes Anyway

## Context

In this harness (opencode + MCP), tool calls that run long — `ctx_shell` with
`sleep 40+` chained work, `bun run` Playwright scripts (~45–90 s) — frequently
fail with:

```
MCP error -32001: Request timed out
```

The channel is flaky above roughly 40–90 s of wall time per call. The timeout
is client-side: the underlying command keeps running to completion and its
artifacts appear later.

## Problem

Treating `-32001` as "the command failed" leads to blind reruns (duplicate
state-changing work) or to abandoning evidence that actually got produced.
Conversely, waiting inside one large call for a long job ("just one 6-minute
poll") reliably times out and loses the stdout.

## Solution

1. **Keep every call short** — chunk long waits into `sleep ≤ 40` steps with
   quick checks (e.g. `sleep 40; ssh host 'cat state'`), one call each.
2. **After a timeout, verify instead of rerunning**:
   ```bash
   ps aux | grep '<script>' | grep -v grep | wc -l   # orphan still alive?
   ls -la <expected-artifact>                          # did it finish anyway?
   ```
   A pair `bun ...` + `chrome` in ps = orphan in progress; when gone, its
   output file is the result. State/files on the target (host JSON, backups,
   scheduler state) are the authoritative evidence, not the lost stdout.
3. **No subprocesses inside orphan-prone scripts** — a Playwright script that
   shells out (`execSync("ssh ...")`) can hang on a network blip and never
   reach its screenshot step. Pre-fetch secrets to a local temp file
   (`ssh host 'grep ^ADMIN_PASSWORD= ...' > /tmp/x`) and have the script read
   the file — no subprocess.
4. **Prefer host-side evidence when the channel is bad** — `ssh cat` on state
   files/`ls backups` beats UI-automation scripts for proving things like
   scheduler runs; keep Playwright only for UI-state screenshots.

## Why It Works

- The timeout is an MCP transport limit, not a process kill — the orphan keeps
  its full runtime, so artifacts (screenshots, state-file writes, backups)
  appear at the original ETA. `ps` + artifact checks recover the result at
  zero cost.
- Short calls stay under the transport limit, so return values are not lost.
- Removing subprocesses from the script removes the hang mode (external
  command blocked inside the orphan), so even an orphaned script completes.

## Side Effects / Tradeoffs

- Orphaned Playwright scripts linger for minutes (bun + chrome, ~2 processes)
  until they finish; they hold the browser hostage for other runs — kill them
  individually (`pkill -f <script>`) if a new run is needed urgently.
- `pkill` in a compound command can return exit 1 (no match) and make the
  whole pipeline look failed — check artifacts separately.
- The lost stdout is not recoverable; design the script to persist everything
  worth keeping (file outputs / console.log to a file).

## Evidence

- `sleep 40` chains started failing with `-32001` in the same session where
  the identical command short (< 30 s) succeeded.
- `/tmp/pw-085.mjs` timed out client-side yet kept running: `ps` showed the
  bun+chrome pair for ~6 minutes afterward, and it produced
  `.playwright-mcp/194-auto-run-0805.png` at 08:10 long after the 08:05
  timeout.
- A second script embedding `execSync("ssh ...")` (pw-final) never reached its
  screenshot step even after 90+ s — no subprocess variant (pw-final2 with
  pre-fetched password file) also exceeded the limit but failed differently;
  host-side `ssh cat` reads of `maintenance-scheduler.json`,
  `db-maintenance-state.json`, and backup dirs confirmed the scheduler run
  without needing the UI at all.

## Related Files

- `docs/knowledge/troubleshooting/playwright-mcp-orphan-processes.md` — Chrome
  process leak cleanup (different problem: memory leak; this one: transport
  timeout + orphan continuation)
- `docs/knowledge/tooling/lean-ctx-shell-background-no-notification.md` —
  background shell jobs need polling too

## Tags

`#mcp` `#timeout` `#orphan-processes` `#playwright` `#verification`