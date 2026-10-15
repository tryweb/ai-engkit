# V2 has no LSP runtime — but check-tool binaries like `pyright-langserver` exist

## Context

`~/.config/opencode/AGENTS.md` (generated from `.opencode/AGENTS.md.default`)
carries the V2 Diagnostics Policy that tells agents how to verify code without a
language server. The V2 line ships diagnostics *packages* (`BUN_PACKAGES`) that
provide executables whose names look like language servers. Anyone reading the
policy or inspecting `~/.bun/bin` can reach the wrong conclusion about what is
registered and what runs.

## Problem

The old policy bullet read:

> V2 environments run no LSP runtime (`opencode.json:lsp` is marksman-only).
> `gopls`, `typescript-language-server`, `pyright-langserver` etc. **do not
> exist there** and MUST NOT be installed …

The "no LSP runtime" half is correct, but "`pyright-langserver` … does not
exist" is **false**: `pyright-langserver` and `tsserver` are present in
`~/.bun/bin`. The doc conflated two different things — "is a registered/
running LSP server" vs "binary exists on PATH" — so a correct environment read
looked like a contradiction, and a session could wrongly conclude an LSP was
available.

## Solution

Split the two claims in the policy (applied to both the repo template and the
live user file):

- V2 registers only `marksman` in `opencode.json:lsp`, and upstream V2 starts no
  language server.
- The binaries `pyright`/`pyright-langserver`, `tsc`/`tsserver`, `biome` **do**
  exist (from `BUN_PACKAGES`) but are check-command tools, not registered LSPs.
- Everything else (`gopls`, `rust-analyzer`, `clangd`,
  `typescript-language-server`, `yaml-language-server`,
  `vscode-json-language-server`, `bash-language-server`, `pylsp`, …) is absent
  and MUST NOT be installed.

Rule of thumb: **existence on PATH ≠ a working LSP.** Judge LSP availability by
`jq '.lsp' ~/.config/opencode/opencode.json`, not by `command -v`.

## Why It Works

Registration and installation are independent axes:

- `entrypoint.d/02-init-config.sh` builds the `lsp` block as always-on
  `marksman` plus any catalog server enabled via the `LSP_SERVERS` env var. With
  `LSP_SERVERS` unset, the block is `{"marksman": …}` only.
- `BUN_PACKAGES` (`.env.example`: `pyright @biomejs/biome typescript@5.8.3`)
  installs `~/.bun/bin` executables used by the per-language check commands
  (`pyright`, `bunx tsc --noEmit`, `biome check`). `pyright` and `typescript`
  happen to ship `*-langserver`/`tsserver` entry points, but nothing registers
  them as LSPs.
- The same catalog (`entrypoint.d/02-init-config.sh` LSP_CATALOG_JSON,
  `src/admin/lib/lsp-catalog.ts`) lists servers such as
  `typescript-language-server` and `yaml-language-server` that are **not**
  installed at all — they only matter if an admin enables them via
  `LSP_SERVERS`, which is an explicit environment change, not the default.

## Side Effects / Tradeoffs

- `pyright-langserver` is present partly by design: the admin LSP catalog can
  enable a `pyright` server pointing at it. In the default V2 posture it stays
  unregistered, so agent guidance must not treat it as usable.
- Enabling `LSP_SERVERS` (e.g. `typescript`) does not install the missing
  server binaries — the catalog entry alone is inert until the binary exists.
- The template edit only reaches a running install after image rebuild +
  container recreate (or a manual edit of `~/.config/opencode/AGENTS.md`); see
  `agents-md-default-sentinel-deadlock.md` for the propagation path.

## Evidence

- `jq '.lsp' ~/.config/opencode/opencode.json` → only `marksman`.
- `test/test-v2.sh` cell2 asserts `.lsp | keys == ["marksman"]` and comments
  "Upstream V2 accepts lsp but runs none".
- `command -v`: `pyright-langserver`, `tsserver`, `pyright`, `tsc`, `biome`,
  `marksman` present; `gopls`, `rust-analyzer`, `clangd`, `typescript-language-server`,
  `yaml-language-server`, `vscode-json-language-server`, `bash-language-server`,
  `pylsp` absent (2026-10-15 inspection of the ai-engkit v2 container).
- `ls -l ~/.bun/bin` confirms `pyright-langserver -> ../install/global/node_modules/pyright/langserver.index.js`
  and `tsserver -> ../install/global/node_modules/typescript/bin/tsserver`.
- `test/authority-guidance.test.sh` does not assert the Diagnostics Policy text
  (only the `@ai-engkit` authority block), so the wording fix is safe.

## Related Files

- `.opencode/AGENTS.md.default` (template, V2 Diagnostics Policy)
- `~/.config/opencode/AGENTS.md` (live injected file)
- `entrypoint.d/02-init-config.sh` (LSP block + catalog, ~L286-311)
- `src/admin/lib/lsp-catalog.ts`
- `.env.example` (`BUN_PACKAGES`)
- `test/test-v2.sh` (cell2 LSP posture assertion)
- `docs/knowledge/tooling/opencode-v2-migration-watch.md` (V2 accepts `lsp`, runs none)

## Tags

- lsp
- v2
- diagnostics
- agents-md
- pyright
- environment
