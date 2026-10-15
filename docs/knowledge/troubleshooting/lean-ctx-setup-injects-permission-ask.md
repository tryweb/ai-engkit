# `lean-ctx setup` injects `permission: ask` into `opencode.json` (approval prompt on every native tool call)

## Context

- OpenCode V2 line (`OMO_ENABLED=0`), lean-ctx 3.10.x installed, lean-ctx runtime config keeps `permission_inheritance = "on"`.
- `entrypoint.d/02-init-config.sh` regenerates `~/.config/opencode/opencode.json` on **every** container start and preserves only `agent` and `providers` from the previous file (asserted by `src/admin/lib/v2-startup-config.test.ts`).
- The same script runs `lean-ctx setup --non-interactive --yes`, guarded by "the lean-ctx shell hook is not yet in `~/.bashrc`", and then `lean-ctx init --agent opencode` when the skill file is missing.

## Problem

Every native `shell` / `read` / `grep` / `glob` tool call required a manual approval in the UI, because the live config carried:

```json
"permission": { "bash": "ask", "glob": "ask", "grep": "ask", "read": "ask" }
```

Attribution was non-obvious — the key exists nowhere in the project:

- `grep -rn '"permission"'` over `entrypoint.d/`, `src/`, `scripts/`, `Dockerfile` → no writer.
- The Admin container's live source `/opt/admin/{lib,routes,server.ts}` → no writer, and no `.bak` writer either.
- The OpenChamber bundle never references `opencode.json` (0 matches).
- The entrypoint's own generator cannot emit it: `jq '{agent: (.agent // {}), providers: (.providers // {})}' opencode.json | jq 'has("permission")'` → `false`, and the base object it builds has only `$schema`/`plugin`/`lsp`/`mcp`.
- `opencode.json.bak` sat next to it with an identical nanosecond mtime and differed only by that block — no repo code writes `.bak`.

## Solution

Attribute it by replay, then neutralise it in the entrypoint.

1. **Replay in a throwaway `HOME`** (zero risk to the live config) — copy `opencode.json`, run `lean-ctx setup --non-interactive --yes --json`, and diff:

   ```bash
   rm -rf /tmp/fakehome && mkdir -p /tmp/fakehome/.config/opencode
   jq 'del(.permission)' ~/.config/opencode/opencode.json > /tmp/fakehome/.config/opencode/opencode.json
   HOME=/tmp/fakehome lean-ctx setup --non-interactive --yes --json >/dev/null
   jq -c '.permission' /tmp/fakehome/.config/opencode/opencode.json   # -> {"bash":"ask",...}
   ls -l /tmp/fakehome/.config/opencode/opencode.json.bak             # -> the .bak twin is created here too
   ```

   `lean-ctx setup` — its OpenCode "agent hooks / MCP config" step — is the writer, and it also creates the `.bak`. Note `--no-auto-approve` does **not** suppress the rules (verified: block removed → setup re-added it).

2. **Normalise after the lean-ctx block** in `entrypoint.d/02-init-config.sh` (see `# >>> lean-ctx native-tool permission normalisation >>>`): drop only the four native-tool keys lean-ctx injects, keep any other rule, and preserve the file mode.

3. **Clean an already-polluted container**:

   ```bash
   CFG=~/.config/opencode/opencode.json; M=$(stat -c '%a' "$CFG")
   jq 'del(.permission)' "$CFG" > "$CFG.tmp" && mv "$CFG.tmp" "$CFG" && chmod "$M" "$CFG"
   ```

## Why It Works

- The replay isolates the only writer outside the repository, so the fix targets the actual author instead of guessing at the entrypoint or the Admin.
- `permission` was never durable: the regeneration above drops it on every restart, and only `agent`/`providers` survive. Removing it therefore takes nothing away from a policy the user could have set — it only stops the vendor's write from surviving the boot in which it happened.
- The `ask` rules exist to push agents toward lean-ctx's own MCP tools. They are also ineffective as a control here: with `permission_inheritance = "on"` the MCP tools cannot show an interactive prompt, so the mirrored rule has no useful outcome, while the native tools it does affect stall on approval.

## Side Effects / Tradeoffs

- Deleting the key ignores the vendor's intent to steer native tools; a deliberate `ask` policy would need to be re-added by AI-EngKit itself (the entrypoint would have to manage the key, since user edits are not preserved).
- Only the four injected tool names are dropped; an unrelated `permission` key written by a user or another tool is left in place.
- Applies on container start — the running session keeps whatever the config had when the OpenCode server loaded it.

## Evidence

- Timeline of the affected boot: 17:07:51 container created; `~/.bashrc.lean-ctx.bak` 17:07:54.027 (pre-setup `.bashrc`, hook absent → guard passes → setup runs); `opencode.json` and `opencode.json.bak` 17:07:54.255 (same clock tick, identical ns mtime ≈ same-tick `mv`/`cp`); `.bashrc` 17:07:54.425.
- Replay output had the same byte size as the live pair: `opencode.json` 1931 B, `opencode.json.bak` ≈1834 B. `lean-ctx setup` writes no `.bak` when the file is already in the desired state (`status: already`, `mode=Replace`).
- Mock-HOME runs with the block pre-removed re-added it under both `--yes` and `--yes --no-auto-approve` (`fakehome4`, `fakehome5`).
- Integration check on the shipped fix: block removed → `lean-ctx setup` re-adds it → entrypoint snippet runs → `permission` absent, file mode `600` preserved, `agent` (12 keys) intact.
- `bun test lib/v2-startup-config.test.ts` → 5 pass (3 new cases: drops the ask rules, keeps unrelated rules, leaves clean configs untouched). `bash -n entrypoint.d/02-init-config.sh` clean.

## Related Files

- `entrypoint.d/02-init-config.sh` — generator (line ~344), lean-ctx block, and the new normalisation step
- `src/admin/lib/v2-startup-config.test.ts` — asserts which keys survive a restart; carries the new cases
- `docs/knowledge/tooling/lean-ctx-optimization.md` — `permission_inheritance` behaviour and why MCP tools cannot prompt
- `docs/knowledge/troubleshooting/lean-ctx-triage-blinds-diagnostic-output.md` — the other place lean-ctx mutates what the agent observes

## Tags

lean-ctx, opencode.json, permission, approval prompt, entrypoint, V2, setup, config ownership
