# Historical: lean-ctx 3.9.19 triage blinded the agent to diagnostic output

## Context
ai-engkit's Docker image bakes a lean-ctx config into
`/home/devuser/.config/lean-ctx/config.toml` (Dockerfile ~lines 143–156).
The agent executes shell commands via lean-ctx's `ctx_shell` and reads files via
`ctx_read`. lean-ctx wraps and compresses command output to save tokens.

> **Current status (lean-ctx 3.9.20, verified 2026-08-28):** Upstream closed
> the 3.9.19 triage incident. Output filtering is now opt-in with
> `decision_loop.max_filter_level = 0` by default, `ctx_read` is exempt from
> triage, and documented lossless modes bypass it. `lean-ctx doctor` reports
> `Output triage: off`. Local whole-file `ctx_read` and plain `stat`, `head`,
> and `od -c` probes returned complete output without hatches. This document
> keeps the 3.9.19 incident and recovery evidence for historical diagnosis.

## Problem
Under lean-ctx 3.9.19, the original bake set
`compression_level = "standard"`, which was **more aggressive than lean-ctx's
upstream default (`lite`)**. At this level, lean-ctx's triage
pipeline returns the placeholder

```
[lean-ctx: N lines filtered by triage (level 2)]
```

instead of the actual output, whenever the content matches its filter heuristic —
**including** the low-level diagnostics the agent needs to recover from edit
failures: `od -c`, `sed | cat -A`, `xxd`, binary inventories, multi-line help
text, shell transcripts, etc. The filter applies to **both** live shell output
and `ctx_read` of persisted files. Re-measured 2026-08-24 under a *healthy*
`lite`: whole-file reads are still suppressed wholesale, while narrow
`lines:N-M` windows (roughly ≤ 6 lines / a few hundred chars) pass — the
decision is score-and-size based, not path-based.

**In 3.9.19, config-vs-daemon drift reproduced the same blindness.** The triage
tier was fixed when the lean-ctx daemon started; editing `compression_level` in
`config.toml` alone changes nothing for the running daemon. On 2026-08-24 the
disk said `lite` while every tool result still reported
`[lean-ctx: N lines filtered by triage (level 2)]` — until
`lean-ctx config apply` restarted the daemon.

Concrete failure mode (observed in an OpenChamber session titled
"AI-EngKit lean-ctx 過濾正交問題釐清"):

1. `Edit File` fails: `Could not find oldString in the file. It must match
   exactly, including whitespace, indentation, and line endings.`
2. Agent runs `sed -n '460,476p' file.tsx | od -c` to inspect the exact bytes.
3. The `od -c` output is triaged → `8 lines filtered by triage (level 2)`.
4. `ctx_read` of the same range also returns the filter placeholder.
5. Agent loops: can't edit (mismatch), can't diagnose (output hidden), can't edit.

## Solution
The current repository baseline is explicit `compression_level = "lite"`. The
3.9.20 fix means `off` is no longer required merely to prevent the 3.9.19
triage regression; `off` remains available for focused diagnostics.
The 2026-08-25 reliability gate classified the fleet as `disable-routing`, so
automatic Read, Search, and Shell routing remains disabled. CodeGraph and
native tools are authoritative; lean-ctx remains available for memory,
knowledge, and non-authoritative opt-in exploration. Escape hatches are not a
reliable correctness boundary under daemon or configuration drift.

The following 2026-08-24 runtime command is retained only as historical
reproduction evidence for the intermediate `lite` mitigation. It is not the
current repository policy, and Apply remains an explicit administrator action:

```bash
docker exec -u devuser ai-engkit-dev bash -c \
  'lean-ctx config set compression_level lite && lean-ctx config apply'
```

`apply` restarts ONLY the lean-ctx daemon, and both halves matter (observed
2026-08-24):

1. The daemon does **not** hot-reload config. Skipping `apply` leaves the old
   triage tier running even though `config.toml` already shows the new value —
   `config set` even answers `already set to lite — unchanged` while filtering
   continues at the old level.
2. After the daemon swap, every `ctx_*` MCP tool in **running sessions** hangs
   with `MCP error -32001: Request timed out` (the long-lived `opencode serve`
   hosts lean-ctx MCP children bound to the dead daemon). Recovery requires
   restarting OpenChamber / `opencode serve` — brand-new dispatched sessions
   stay broken too until then.

Historical intermediate image change (`Dockerfile` ~line 148); the current
baseline uses `off` instead:

```diff
- compression_level = "standard"
+ compression_level = "lite"
```

On 3.9.20, first check `lean-ctx doctor`. If `Output triage` is intentionally
active, use a documented per-command lossless mode or escape hatch (the
allowlist still applies):

```bash
LEAN_CTX_RAW=1 od -c file.tsx              # uncompressed this run
LEAN_CTX_DISABLED=1 sed -n '460,476p' …    # bypass compression + shell hook
lean-ctx raw "od -c file.tsx"              # CLI form
```

## Why It Works
- In 3.9.20, output filtering is controlled by
  `decision_loop.max_filter_level`, which defaults to `0`; compression level no
  longer establishes whether output triage is active. `lean-ctx doctor` exposes
  the effective filter state.
- `ctx_read` is exempt from triage. `raw`, `full`, `full-compact`, `lines:`,
  `anchored:`, `diff`, `aggressiveness=0`, and `fresh` are pinned lossless
  bypasses by upstream tests.
- `LEAN_CTX_RAW=1` and `lean-ctx raw` skip compression for one invocation.
- `LEAN_CTX_DISABLED=1` additionally disables the shell hook for that invocation.
- The 2026-08-24 observation that hatches were ignored belongs to 3.9.19. On
  3.9.20 they are part of the tested bypass contract, but AI-EngKit still does
  not use lean-ctx output alone to establish correctness.

## Side Effects / Tradeoffs
- **Historical 3.9.19 behavior:** `lite` was less aggressive than `standard`,
  not zero — measured 2026-08-24
  under a freshly applied `lite`: whole-file `ctx_read` still returns the
  level-2 placeholder (sometimes substituted with unrelated context snippets,
  e.g. the repo `AGENTS.md` head), and plain `stat` / `od -c` / `head -20`
  output via `ctx_shell` is still suppressed. What works reliably: commands
  prefixed with `LEAN_CTX_RAW=1` or `LEAN_CTX_DISABLED=1`, and narrow
  `lines:N-M` windows (small outputs only; `lines:1-41` of a 41-line file was
  filtered). For correctness-sensitive raw output, use native tools; the
  hatches are only best-effort when daemon and configuration health is known.
- The repository's `compression_level = "lite"` baseline enables bounded token
  savings; changing it is a separate routing/reliability decision, not a
  3.9.20 triage workaround.
- Do not infer triage state from `compression_level`; check the `Output triage`
  line in `lean-ctx doctor`.

## Evidence
- OpenChamber session screenshot showing the `Edit File` → `od -c` filtered →
  `ctx_read` filtered loop (the trigger for this fix).
- Reproduced empirically: wrote a 6-line transcript file → under `standard`,
  every `ctx_read` window returned `[lean-ctx: 117 lines filtered by triage
  (level 2)]`; after applying `lite`, the same file read through cleanly.
- `lean-ctx config apply` output:
  `Updated compression_level = lite` followed by
  `[1/4] Validating config… [2/4] Restarting processes… [3/4] Running safety checks… [4/4] Config applied successfully.`

### 2026-08-24 re-verification (container restart → fresh daemon on `lite`)

- 41-line marker fixture: default / `full` / `raw`+`fresh` / `aggressiveness=0`
  / `protect` `ctx_read` → 41/41 lines filtered; `lines:5-10` → clean;
  `lines:1-41` → filtered (size-gated, not mode-gated).
- Plain `ctx_shell` `stat` / `od -c` / `head -20` → filtered; same commands
  prefixed with `LEAN_CTX_RAW=1` or `LEAN_CTX_DISABLED=1` → full output.
- `lean-ctx config set compression_level lite` → `already set to lite —
  unchanged`; `lean-ctx config apply` → `daemon stopped (PID …)` + new PID,
  while every `ctx_*` tool returned `-32001` until OpenChamber restarted.

### 2026-08-28 re-verification (lean-ctx 3.9.20)

- Upstream release: [v3.9.20 — Fixed: triage (community incident, 3.9.19)](https://github.com/yvgude/lean-ctx/releases/tag/v3.9.20).
- `lean-ctx --version` returned `3.9.20`; `lean-ctx doctor` returned
  `Output triage: off (decision_loop.max_filter_level = 0 — tool output is never dropped)`.
- A 40-line, 960-byte marker fixture had SHA-256
  `b3cba43c2b02a9303a0d28d3b629b59885003fdcbc893a0710ee6f2766bd96f0`.
  Normal whole-file `ctx_read` returned all 40 lines. Plain `ctx_shell` `stat`,
  `head -20`, and `od -c` returned complete output without `raw=true` or env
  hatches.
- This targeted probe confirms the 3.9.19 triage failure is not reproduced. It
  does not supersede the separate fleet G0-G4 requirement for routing changes.

## Related Files
- `Dockerfile` (~line 148, `compression_level` in baked `config.toml`)
- `.opencode/AGENTS.md.default` (`### lean-ctx Output Triage` guidance)
- `/home/devuser/.config/lean-ctx/config.toml` (runtime, in container)
- `/home/devuser/.config/lean-ctx/env.sh` (BASH_ENV-loaded hook)
- `docs/knowledge/tooling/lean-ctx-optimization.md` (companion: allowlist tuning)
- `opencode serve` process + OpenChamber PushWatcher (reconnects via ephemeral-port rediscovery after daemon or container restarts)

## Tags
lean-ctx, compression, triage, ctx_shell, ctx_read, diagnostic-output,
debuggability, blind-spot
