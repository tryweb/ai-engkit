# Cell 2 — V2 Diagnostics without LSP: v1 8+1 Servers → CLI Check Commands

> Branch: `trial/opencode-v2` | Workdir: `/home/devuser/workspace/ai-engkit` | Date: 2026-09-25
> Deliverable: this notes file only. No source files touched. Fixtures live in `/tmp/opencode/lsp-cell2/` (outside repo, not committed). Review-ready after TS + Python close-out.

## 1. Authority & Tool Inventory (verified 2026-09-25, v2 container side)

| Tool | Version | Source |
|------|---------|--------|
| `biome` | 2.5.14 | global bun (`~/.bun/bin/biome`) |
| `pyright` | 1.1.414 | global bun |
| `python3` + pyyaml | 3.12.3 | system `/usr/bin/python3` |
| `marksman` | 2026-02-08 | image-baked (server-mode; v2 inert, kept for record only) |
| `docker` | 29.8.1 | DooD socket (`docker build --check` usable) |
| `bun` / `node` | 1.4.2 | image executors |
| MISSING | — | `ruff`, `yamllint`, `hadolint`, `markdownlint`, bare `tsc`/`tsserver` (see §4: install on demand, not upfront) |

Scope anchor: v1 catalog `src/admin/lib/lsp-catalog.ts:25-93` (8 entries) + always-on `marksman` (`entrypoint.d/02-init-config.sh:293-294`). CELL2 covers exactly these 9, nothing more (karpathy: nothing speculative).

## 2. Mapping Table — v1 `serverKey` → v2 CLI (provenance: `biome`/`pyright` runs below are dev-shell-side command-shape proofs; v2-container proofs are cell2 E2E (yaml/Dockerfile) + TS/Python/Go close-outs, see §4/§6)

| # | v1 `serverKey` (exts) | v2 CLI command | Fixture | Result 2026-09-25 |
|---|----------------------|----------------|---------|-------------------|
| 1 | `typescript` (.ts/.tsx/.js/.jsx/.mts/.cts) | `bunx tsc --noEmit` (version follows repo lockfile; known-good `5.8.3`, NOT `7.0.2` which ships no classic `tsserver`) | user project (v1 admin context already `bun run typecheck` green) | **OPEN** — user to close loop in v2 container |
| 2 | `biome` (.js/.jsx/.ts/.tsx/.json) | `biome check <path>` | covered by rows 3–5 | green (see below) |
| 3 | `json` (.json/.jsonc) | `biome check sample.json` | trailing comma after `"version"` | exit 1 — `4:1 Expected a property but instead found '}'` |
| 4 | `css` (.css/.scss/.less) | `biome check sample.css` | `colour: red` | exit 1 — `2:3 lint/correctness/noUnknownProperty` |
| 5 | `html` (.html/.htm) | `biome check sample.html` | unclosed `<div><span>` | exit 1 — unclosed-tag parses `5:1/6:1/7:1` + `useHtmlLang 2:1`. Bonus: biome 2.5.14 covers HTML, no extra package needed |
| 6 | `yaml-ls` (.yaml/.yml) | `python3 -c yaml.safe_load` (zero-install fallback; `yamllint` only if a repo demands it) | tab-indented line 2 | exit 1 — `ScannerError: found character '\t'`, `line 2, column 1` |
| 7 | `dockerfile` | `docker build --check -f Dockerfile .` (lints only, needs daemon; no `hadolint` install) | clean `FROM ubuntu:24.04` + one `RUN` | exit 0 — `Check complete, no warnings found` |
| 8 | `pyright` (.py/.pyi) | `pyright <file>` (+ `ruff check .` iff repo already uses ruff) | `return "hi " + username` | exit 1 — `2:20 reportUndefinedVariable` (**dev-shell run**; v2 binary MISSING → cell2 SKIP, install on demand) |
| 9 | `marksman` (.md) | **none active** (gap, decision in §4) | `sample.md` (double-H1 + trailing spaces) | NOT RUN — `markdownlint` missing; v2 treats docs as CI/manual-check, not server-push |

Every green row emits `file:line` diagnostics an agent can consume — the functional replacement for `lsp_diagnostics` push in v1.

## 3. Per-Project `AGENTS.md` Pattern (v2 canonical)

```text
# workspace/<ts-proj>/AGENTS.md
Typecheck: bunx tsc --noEmit
Lint: biome check .

# workspace/<py-proj>/AGENTS.md
Typecheck: pyright
Lint: ruff check .   # only if repo uses ruff
```

Language version/pinning follows the repo (`package.json` lockfile, `tsconfig`/`pyrightconfig`/`biome.json`), never a global server. Container guarantees executors (`bun`/`node`/`python3`); project guarantees rules. Host IDE keeps its own LSP for humans (`WORKSPACE_PATH` bind) — out of scope for agent diagnostics.

## 4. Open Items (must close before `cell2()` assertions are wired)

- [ ] **TS close-out (user)**: `docker exec ai-engkit-v2 sh -c 'cd /home/devuser/workspace/<proj> && bunx tsc --noEmit'` green-or-expected-errors; then 8002 session in `<proj>` runs same via `AGENTS.md`.
- [ ] **Python close-out (user)**: `docker exec ai-engkit-v2 git clone <url> /home/devuser/workspace/<py-proj>` (named volume — clone inside container, not host); add `AGENTS.md`; verify `pyright` output; record here.
- [ ] **Decide md**: `markdownlint-cli` via `BUN_PACKAGES` vs drop active md check (docs → CI/manual). No install until a repo proves need.
- [ ] **On-demand only**: `ruff`/`yamllint`/`hadolint` install iff a cloned repo's `AGENTS.md` names them — never upfront.
- [x] **Done 2026-09-25**: `test/test-v2-trial.sh cell2()` wired and green (8 PASS + 2 SKIP). Asserts marksman-only `lsp` (not `lsp:false` — no entrypoint change needed for this posture), mcp keys, karpathy symlink, python-yaml + docker presence, yaml/Dockerfile fixture E2E. `AGENTS.md` Typecheck lines per trial project remain with TS/Python close-out above.

## 5. Verification Log (2026-09-25)

```bash
for t in biome bun node python3 pyright ruff yamllint hadolint markdownlint tsc tsserver; do command -v "$t" || echo "$t MISSING"; done
biome --version            # 2.5.14
pyright --version          # 1.1.414
python3 -c "import yaml"   # pyyaml OK
biome check sample.json/css/html   # all exit 1 with file:line errors (see §2)
python3 -c yaml.safe_load sample.yaml   # ScannerError line 2 col 1
pyright sample.py          # 2:20 reportUndefinedVariable
docker build --check -f Dockerfile .    # no warnings, exit 0
```

## 6. Addendum 2026-09-25 — Go (out of v1 scope, proven in v2)

Go was never in the v1 LSP catalog (no `gopls`), so this is a new-language path, not a regression. Verified on `simple-fileurl` (8002, `go.mod` go 1.24):

- Toolchain: v2 image ships no Go → declared `BREW_PACKAGES="go"` in `.env` (entrypoint `01-install-packages.sh` self-heals every boot; apt 1.22 + `GOTOOLCHAIN=auto`也能動，選 brew 為求一步到位). Installed `go 1.27.1`. Fish: first `command -v go` probe raced the brew link step — retry, don't reinstall.
- Diagnostics: `go vet ./...` exit 0 + `go build ./...` exit 0, both silent-green in v2 container 2026-09-25 (deps e.g. `x/crypto v0.35.0` download via module proxy inside container). **Go close-out DONE.**
- `gopls` absent is expected and irrelevant: never in v1 catalog, no v2 runtime to host it — do NOT install. AI verdict "無法執行 LSP 驗證" used the wrong criterion; per this cell, vet+build green IS the verification.
- Project contract: `simple-fileurl/AGENTS.md` = `Typecheck: go vet ./...` / `Build: go build ./...`.
- Rule restated: new language = declare executor via `*_PACKAGES` env (persistent), versions follow repo files — never manual global installs.
