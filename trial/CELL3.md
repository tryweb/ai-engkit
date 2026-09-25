# Cell 3 — V2 Site Diagnostics Catalog: Admin Decides, Repos Consume

> Branch: `trial/opencode-v2` | Workdir: `/home/devuser/workspace/ai-engkit` | Date: 2026-09-25
> Deliverable: Phase 1 done 2026-09-25 — spec + `.opencode/v2-diagnostics-catalog.json` + `cell3()` green (no source changes; `.env` gains `BREW_PACKAGES="go"` + `BUN_PACKAGES="pyright @biomejs/biome typescript@5.8.3"`, gitignored).
> Motivation: stop one-by-one reactive installs (go, then pyright, then ruff…) — one catalog, one Apply.

## 1. Split of Ownership (decision, not a question)

- **Admin (site-wide) owns executors**: which binaries exist + their fallback versions. Mechanism: existing `BUN/BREW/APT_PACKAGES` + `01-install-packages.sh` boot self-heal + `lsp-managed.env` persistence. No new install plumbing.
- **Repos own rules**: which check command + rule versions (`tsconfig`/`pyproject`/`biome.json`/lockfiles) + `AGENTS.md` one-liner. V2 agent reads the repo, not a server.

## 2. Catalog Kinds (why ruff is special — the review answer)

| Kind | Meaning | Members |
|------|---------|---------|
| `global-executor` | Admin installs; project-local resolution wins **when the repo has it** (caveat: repos without a local install get the global version as-is — fallback safety is conditional, not absolute) | `go` (brew 1.27.1 runs `go.mod` 1.24 directly; `GOTOOLCHAIN=auto` covers the reverse — old toolchain meeting newer `go.mod`), `pyright`/`biome`/`typescript@5.8.3` (bun; `bunx` prefers repo-local iff present), `yamllint`/`hadolint`/`markdownlint-cli` (default OFF, enabled on demand) |
| `project-managed` | Catalog lists it (so every language has an answer) but Admin does NOT install; repo owns via venv/lockfile | `ruff` — bare binary has no per-project fallback, so it cannot track a repo pin the way `bunx`/`GOTOOLCHAIN` do: global ruff vs repo `pyproject.toml` (`target-version`, rule selects) drifts, and the extra diagnostics are ones the repo CI (pinned older ruff) would never emit. Standard Python practice is venv-pinned ruff. Template `AGENTS.md` tells repos to add it to requirements |

So: ruff goes project-venv **by version-pinning argument**, not by vote. Same lens keeps `typescript` global-pinned (npm fallback chain exists when the repo has it) — consistent, not arbitrary. Corrected 2026-09-25 per karpathy review: earlier "hallucination" wording downgraded (ruff does read repo config; the risk is version drift, not fabrication), and the `bunx`-fallback safety now states its precondition.

## 3. Data Shape (mirrors `src/admin/lib/lsp-catalog.ts`, adds `kind`)

```ts
// sketch — field names follow lsp-catalog.ts conventions
{ key: "pyright", kind: "global-executor", source: "bun", package: "pyright",
  version: null /* latest */ | "1.1.414",
  provides: ["Typecheck: pyright  (py/pyi)"],
  check: "command -v pyright && pyright --version" }
{ key: "ruff", kind: "project-managed", source: "venv",
  provides: ["Lint: ruff check ."],
  check: "repo has ruff in requirements/venv (not probed globally)" }
```

## 4. Rollout in Two Phases (karpathy review 2026-09-25: full Admin page upfront is the 200-line answer to a 50-line problem)

**Phase 1 (this cell): catalog data file + docs + `cell3()` assertions. `.env` hand-edited. No UI, no routes, no reconciler changes.**
**Phase 2 (only iff Phase 1 proves hand-editing painful): Admin page** copying `/lsp` (table, `PUT` overrides, `POST /apply`, drift via `execInAiDev`), new route only.

- Phase 1 table per catalog entry: enabled | pinned version | observed version | drift (`missing_install`/`version_mismatch`; `project-managed` rows show `repo-owned`, never drift) — as data + assertions, not UI.
- `PUT`/`POST /apply` semantics (for Phase 2): writes `*_PACKAGES` + pins to `lsp-managed.env`, triggers recreate note (same side-effect contract as `POST /api/lsp/apply`: `.env` unchanged on failure).
- v1 `/lsp` is NOT touched by this cell in either phase (surgical: the inert-page cleanup, if ever, is a separate change).

## 5. Initial Catalog Decisions (one Apply, then stop asking one-by-one)

ON at launch: `go`, `pyright`, `biome`, `typescript@5.8.3`. OFF by default: `yamllint`, `hadolint`, `markdownlint-cli`. `project-managed`: `ruff` (venv template only).

## 6. `cell3()` Assertions (Phase 1 — wired 2026-09-25, green: 10 PASS + 4 SKIP)

- Catalog file exists with all 8 keys (7 decisions + ruff; v1 json/css/html consolidated under biome) and every entry has `kind`.
- For each `global-executor`+enabled: `command -v` + version probe green in `ai-engkit-v2`.
- For each default-OFF: absent is PASS (records decision, not failure) — same SKIP idiom as cell2 §6.
- `ruff` row asserts `project-managed` (never installed globally by Apply).

## 7. Open Items

- [x] Reviewed 2026-09-25 (karpathy): ruff argument corrected, two-phase rollout, v1 untouched — see §2/§4.
- [x] Phase 1 done 2026-09-25: catalog data + `cell3()` green (go 1.27.1, pyright 1.1.414, biome 2.5.14, tsc 5.8.3 in v2).
- [x] Done 2026-09-25: v2 global `AGENTS.md` carries Diagnostics Policy (sentinel-external, volume-persisted) + mirrored to `.opencode/AGENTS.md.default` (next image build); explicit-request override added same day after Test-v2-02 still asked (user prompt ordered both "LSP 驗證" and install-gate — policy now wins outright, no question UI).
- [ ] Phase 2 iff Phase 1 proves hand-editing painful: Admin page (separate change).
- [ ] Phase 2 iff Phase 1 proves hand-editing painful: Admin page (separate change).
