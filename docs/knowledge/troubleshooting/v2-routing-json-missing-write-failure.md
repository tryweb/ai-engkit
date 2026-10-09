# V2 Chain Writes Fail When routing.json Is Absent

## Context

On the V2 line (`OMO_ENABLED=0`) the Admin agent-models feature writes a
fallback chain to `~/.config/opencode/routing.json` and mirrors the chain head
into `~/.config/opencode/opencode.json` via `buildRoutingWriteCommand`. Startup
reconciliation (`scripts/reconcile-agent-models.sh` →
`bun run /opt/admin/lib/agent-model-reconcile-cli.ts`) uses the same write path.

## Problem

On a fresh V2 volume `routing.json` does not exist. Nothing seeds it: the
entrypoint only writes `opencode.json`, and `migrate-omo-to-native.sh` runs on
the V1 line. The B1 plugin intentionally treats an absent file as "routing
disabled" (see `v2-plugin-bake.md`).

The write command pipes `jq ... ${routingPath}` as its input, and jq exits `2`
on a missing file. The `> "$tmp" 2>/dev/null` redirect hides the error and the
`&&` chain aborts, so every write reported the generic fallback
`jq routing write failed`. CI run `37784678050` showed it for all 12 native
agents, yet the job passed because no assertion covered the reconcile outcome:

```
[agent-models] result {"agent":"atlas","status":"write_failed","error":"jq routing write failed","resolved":null}
... (×12)
[agent-models] reconciled: changed=12 applied=0 failed=12
[agent-models] reconciliation attempt 1 failed, retrying in 30s...
```

## Solution

`buildRoutingWriteCommand` seeds the empty routing shape when the file is
missing, before the first jq read:

```
[ -f ~/.config/opencode/routing.json ] || printf '%s\n' '{"version":1,"chains":{}}' > ~/.config/opencode/routing.json
```

The empty shape matches `readRoutingConfig`'s fallback (`{"version":1,"chains":{}}`)
and adds no chain, so the "no default chain is baked" property is preserved.
`opencode.json` is entrypoint-guaranteed (asserted by `test-v2.sh cell1`)
and needs no seed.

## Why It Works

The seed creates a file the write immediately overwrites (tmp → `chmod 600` →
`mv`), so final permissions stay `600`. jq then has a valid input and the chain
write succeeds; the exception also covers the single-agent and batch-apply
paths, which share `buildRoutingWriteCommand`.

## Side Effects / Tradeoffs

- The first chain write on a fresh volume now creates `routing.json` instead of
  failing; the B1 plugin's "absent = disabled" state is unchanged until a chain
  is written.
- Only `routing.json` is seeded; the fix relies on the entrypoint creating
  `opencode.json`.

## Evidence

- Reproduced in the running trial container `ai-engkit-v2` with a sandboxed
  `HOME`: a missing `routing.json` → `WRITE_FAILED exit=2`.
- Fixed command with a fresh `HOME` → `cmd exit=0`; `routing.json` =
  `{"version":1,"chains":{"plan":{"chain":[{"model":"opencode/space-bunny-free"}]}}}`
  and `opencode.json` `.agent.plan.model = "opencode/space-bunny-free"`.
- Unit regression `src/admin/lib/agent-model-config.test.ts` executes the
  command with `sh -c` against a missing `routing.json` and asserts exit `0`
  plus both files updated.
- Admin suite in CI mode (`OMO_ENABLED=1`): `1296 pass`, `2 skip`, `0 fail`
  across 96 files; `bun run typecheck` clean.
- CI run `37862545802` (commit `e533508`, branch `trial/opencode-v2`) passed all
  V2 jobs: `build-v2` Admin unit tests `1296 pass / 0 fail`, `compose
  isolation: PASS`; `trial-v2` log now reads
  `[agent-models] reconciled: changed=12 applied=12 failed=0` (was
  `applied=0 failed=12`); `cell1` reported `b1-routing`/`m3-enforcer`
  `plugin loaded (setup start logged)`; `scan-v2` and the GHCR trial push
  passed.

## Related Files

- `src/admin/lib/agent-model-config.ts` (`buildRoutingWriteCommand`)
- `src/admin/lib/agent-models.ts` (single + batch write paths)
- `src/admin/lib/agent-model-reconcile-cli.ts`, `scripts/reconcile-agent-models.sh`
- `.github/workflows/ci.yml` (`build-v2`, `trial-v2`)
- `docs/knowledge/tooling/v2-plugin-bake.md`

## Tags

- opencode-v2
- routing
- agent-models
- reconcile
- jq
- ci
- fresh-volume
