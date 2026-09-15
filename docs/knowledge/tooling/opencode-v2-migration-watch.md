# OpenCode V2 Migration Watch

## Context

- Follow-up (2026-09-15): the slim-branch replacement evaluation led to a recommendation to pause active V2/slim validation and maintain V1 on `main`; no branch switch or runtime restoration was performed during that discussion. See [the evaluation disposition](../architecture/omo-slim-evaluation-disposition.md). The observations below are the dated 2026-09-14 baseline, not a description of the slim branch or a fresh upstream check.
- AI-EngKit pins OpenCode V1 (`Dockerfile: ARG OPENCODE_VERSION=1.18.30`, installed via `bun install -g opencode-ai@${OPENCODE_VERSION}`) with `oh-my-openagent@4.19.4` as the only `plugin[]` entry, plus `OPENCHAMBER_VERSION=1.23.1` (`bun install -g @openchamber/web@${OPENCHAMBER_VERSION}`).
- OpenCode V2 package split: git tags `v2.0.0`–`v2.0.3` exist, but V2 never publishes as `opencode-ai@2.x` — it ships as `@opencode/cli@2.0.3` (npm `latest`), `@opencode/client@2.0.3`, `@opencode/sdk@2.0.3`; `@opencode-ai/cli@beta` stays `0.0.0-beta-*`. Docs still say "OpenCode 2.0 is in beta", contradicting npm `latest=2.0.3`; treat 2.0.x as beta-until-officially-GA'd.
- OpenChamber released `v2-preview` (2026-09-14): test builds rebuilt on OpenCode v2 (`2.0.0-preview.4`, bundling OpenCode 2.0.3), explicitly "not a release", desktop binaries only (no container image), files replaced on every build, self-update to stable disabled.
- Decision (2026-09-03, reaffirmed 2026-09-14): stay on V1 for production; track V2 and migrate only after GA. **The OMO V2-line gate was dropped 2026-09-14**: upstream has no V2 timeline (see Problem/External plugin) — the migration gate is now "own continuation engine ready", not "OMO ships V2". Start the upstream-independent prep now (Server API shim, release-line decision, version-pipeline cross-major support, continuation engine design) — see the revalidated Solution below.
- lean-ctx (the other core integration) is **not** a plugin: it attaches via local stdio MCP (`mcp."lean-ctx"`), bash hooks, `AGENTS.md`/`instructions[]` rules, and skills, with no current opencode plugin installed. Assessed 2026-09-14 as **compatible-with-gaps** — no V2 plan needed, unlike `oh-my-openagent` (see Problem/lean-ctx integration).

## Problem

V2 has exactly three intentional breaking changes (`https://opencode.ai/v2/docs/migrate-v1/`):

1. Plugin API rewrite (`server(input)` → `Plugin.define({ id, setup(ctx) })`). V1 plugins do not load in V2.
2. Server API + client contract rewrite (still fluid during beta; `specs/v2/schema-changelog.md` records session/event/projection resets).
3. Terminal config `tui.json(c)` (layered) → single global `~/.config/opencode/cli.json` (auto-migrated on first V2 start; project-local client config is NOT migrated; service does not read it).

AI-EngKit's real breakpoints (grew from two to four on 2026-09-14):

- **External plugin**: no in-repo `server(input)` code exists; the break is upstream — `oh-my-openagent@4.19.4` must release a V2 port, but **upstream has no committed V2 timeline** (see Evidence): issue #6169 (timeline ask) triaged to the owner and unanswered since 2026-08-06; two v2 compat-bridge PRs (#7104, #7570) both withdrawn by the author; community native sibling adapter #7903 (354 tests pass) unreviewed since 2026-09-07. ROADMAP "Why Not OpenCode-Native" states OpenCode is "one adapter target among several. Not the center of the architecture." `omo.jsonc.default` is OMO's own schema (`agents.*.tools.{read,bash,edit,write,webfetch}`, `models[]` with separate `variant`), not opencode native config, so editing it changes nothing until upstream moves. OMO `5.0.0-beta.62` (2026-09-14) still depends on `@opencode-ai/sdk@1.18.22` — **not** a V2-API line yet. Treat the OMO gate as **unreliable**; the migration gate is the own continuation engine (Solution item 6).
- **Self-owned Server API clients**: all `curl`-in-shell, no `@opencode-ai/client`. Endpoints that break: `POST /session`, `POST /session/:id/prompt_async`, `POST /session/:id/message`, `GET /session/:id/message`, `GET /session/status`, `GET /session/:id/state`, `GET /agent`, `GET /provider`, `GET /api/session?directory&limit&cursor`, `DELETE /session/:id`.
- **Install strategy (new)**: `opencode-ai@2.x` has never been published; the V2 CLI is `@opencode/cli` (npm tarballs `@opencode/cli-<os>-<arch>`), so the `bun install -g opencode-ai@${OPENCODE_VERSION}` line has no V2 target. OpenChamber v2 has no container image and its branch `Dockerfile` is byte-identical to main (still unpinned `npm install -g opencode-ai` → resolves V1), so a container built from the v2 branch today would mix the v2 UI/client with the V1 binary.
- **OpenChamber dual-track (new)**: `opencode-v2-refactoring` branch (full cutover, commit `00667e75`, +28.8k/−30.8k) versus open PR #3007 "support OpenCode V2 compatibility" (dual-runtime: legacy `opencode` owned child + `opencode2` via `service start` + `Service.discover()`). `main` is still V1-only (1.23.1 / `@opencode-ai/sdk@1.18.30`) — do not assume which track wins.
- **lean-ctx integration (NOT a breakpoint)**: unlike OMO, lean-ctx no longer installs an opencode plugin (legacy cleanup only) — its runtime path is stdio MCP + shell hooks + `AGENTS.md`/skills, all V2-compatible. Three V2 gaps instead, all V1-config-driven (no hard break): (1) `permission_inheritance`/`shadow_mode` read/write the V1 `permission` object — silent no-op mirroring on V2-native `permissions[]` config (security-relevant: native guards stop applying to `ctx_shell`/`ctx_read`/`ctx_edit`); (2) its config writer emits only the V1 `mcp."lean-ctx"` shape (`enabled: true`, no `mcp.servers`/`disabled`) — works via V2's V1-normalizer, fragile during beta; (3) `lean-ctx import opencode` reads V1 `~/.local/share/opencode/opencode.db` — V2 isolates storage (opencode #34831), so V2 history is invisible to the importer. Upstream has zero opencode2 tracking (no issue/PR/commit mentions it as of v3.10.1, 2026-09-06).

## Solution

Watch stance (revalidated 2026-09-14) + GA migration checklist. Split into **prep now** (upstream-independent, safe on V1) and **GA-only steps** (blocked on upstream):

### Prep now (upstream-independent)

1. Keep `OPENCODE_VERSION`/`OPENCHAMBER_VERSION` pinned on V1; evaluate V2 only in an isolated image. Do not install `opencode-ai@2.x` — it does not exist; the V2 CLI is `@opencode/cli` (tarballs `@opencode/cli-<os>-<arch>` via `prepare-opencode-cli.mjs` in OpenChamber's desktop build).
2. Centralize the curl-based Server API calls behind one shim now (V1/V2-agnostic), so GA migration is a single rewrite to `@opencode/client@2.0.3` (`OpenCode.make({baseUrl})` → `session.create/prompt` → `event.subscribe()`; service via `Service.discover/ensure/stop`).
3. Track **both** OpenChamber V2 tracks, not just opencode releases: `opencode-v2-refactoring` branch cutover vs open PR #3007 (dual-runtime). Gate on: `@openchamber/web@2.x` on npm **or** an official OpenChamber container image for v2.
4. Decide the AI-EngKit v2.x release line now: v1.18.x tags mirror opencode minor versions; plan a separate v2.x line (major = breaking) coexisting with v1.x — mirroring opencode V1/V2 coexistence — so the eventual flip is a release-strategy change, not a scramble.
5. Extend `.opencode/scripts/check-versions.sh` + `.github/workflows/dependency-update.yml` to support cross-major pin-source switches (`opencode-ai` → `@opencode/cli`) — the v2 flip is then a config change, not a pipeline rewrite.
6. Design the continuation engine now (the OMO feature V2 lacks) on v2-native surfaces: `session.hook("prompt"/"context")` for routing, `event.subscribe` on `session.idle`/`session.status`, `session.synthetic`/`session.interrupt` for idle-continuation. Community port #7903 proves the surface works (11 agents + 12 `team_*` tools + 17 skills registered via transforms on real `opencode2`). Decide: own thin v2 plugin vs consume OMO's extracted Core layer (ROADMAP: 19 harness-agnostic Core packages + Adapter layer) — do **not** wait on OMO publishing a V2 line.

### GA-only steps (blocked on upstream gates)

7. Only touch `omo.jsonc.default` / `entrypoint.d/02-init-config.sh` plugin generation (`plugin: [...]` tuple → `plugins: [{package, options}]`) when the continuation engine (prep item 6) is ready on V2. Do **not** gate on `oh-my-openagent` shipping a V2 line — upstream has no committed timeline (Evidence), so the 5.0.0 line stays "watch, not adopt" and stops being a migration blocker.
8. New skills/commands already use V2-preferred layout (`.opencode/skills/<id>/SKILL.md`, `.opencode/commands/*.md`); keep it. Merge any `CLAUDE.md` fallback content into `AGENTS.md` (V2 only discovers `AGENTS.md`).
9. At GA: ask OpenCode to convert config to native V2 format in place (`permission/tools` → ordered `permissions[]` with `bash→shell`, `task→subagent`, `write/patch→edit`; `agent/mode` → `agents` with `prompt→system`, `disable→disabled`, `model#variant`; `snapshot→snapshots`, `attachment→media`, `command→commands`, `mcp.*.enabled→disabled`, `provider.npm→package` with `aisdk:` prefix). Keep V1 setup until each area is verified.
10. At GA, re-verify features V2 documents as dropped-or-changed: LSP accepted-but-ignored (baked `lsp.json.default` + marksman become inert), webfetch text-only settlement, health via `GET /api/status` (no `/healthz`), shared background service + `--standalone`/`--server http://localhost:4096`.
11. At GA, verify lean-ctx on a V2-native config: `permission_inheritance` mirroring onto `ctx_shell`/`ctx_read`/`ctx_edit` (V1 `permission` → V2 `permissions[]`), and MCP registration under `mcp.servers` if we stop relying on V1 compat. If V2-native config is adopted and mirroring is a no-op, lean-ctx's shadow-mode guard surface is lost — decide own-guard or wait for upstream.

## Why It Works

- Outside the three breaking areas, V2 normalizes supported V1 config/agents/commands/skills/`.opencode/` files in memory without rewriting source — no flag-day needed (`migrate-v1` guide).
- AI-EngKit's config is runtime-generated (`02-init-config.sh`), so migration is a generator change, not a static-file edit; skills/commands need no move (`skill(s)/`, `command(s)/` both discovered).
- V1/V2 data dirs are independent (shared db file, separate `session_v2` tables, no V1 history import, copy-on-write), so parallel trial cannot corrupt V1 state.
- The "prep now" items are **V1/V2-agnostic**: a Server API shim and a check-versions cross-major source switch behave identically against V1 today and are the exact seam GA migration needs — prep work never becomes throwaway.
- The prep is also **failure-safe**: if opencode v2 never GA's (or OpenChamber's dual-track PR #3007 wins with a different runtime shape), the shim, release-line tooling, and the continuation-engine design (prep item 6) still pay for themselves on V1 maintenance — the engine design is V1/V2-agnostic and can be field-tested as OMO-hook practice today.

## Side Effects / Tradeoffs

- Beta API drift: pin exact versions when trialing — do **not** trust `@latest` for V2 packages, because npm `latest` resolves to `2.0.3` while the docs still say "beta" (package-vs-docs contradiction observed 2026-09-14). Expect re-pins. No official single-package V1+V2 dual-target pattern exists (community: build-time guard or separate `2.x` line).
- OpenChamber `v2-preview` is **ephemeral and unreproducible**: files are replaced on every build, the version is CI-stamped (repo `package.json` still says `1.23.1`), and it does not self-update to a stable version. Never base a Dockerfile pin on a preview asset.
- OpenChamber publishes **no official container image** (Docker Hub org count 0; ghcr has only `openchamber-relay`, `workspace-egress-gateway`, `opencode-workspace`). Desktops are signed binaries; the only supported server path is build-from-source `Dockerfile`, which is **not** v2-ready as of 2026-09-14 (still installs V1 `opencode-ai`).
- Known beta gaps to re-check at GA: silent TUI-plugin load failure after `cli.json` migration (upstream #46408 refs); V1 session history not imported (#41217, partial fix `migration.v1-v2`); ecosystem reports V2 plugin context lacks compaction-context and restarted-child-session recovery hooks (goal-plugin notes).
- Plan-mode system-reminder gap is **unconfirmed** — no first-party V2 doc found; do not cite as fact.
- OMO's official stance makes "wait for OMO V2" a **false dependency** (revalidated 2026-09-14): ROADMAP "Why Not OpenCode-Native" treats OpenCode as "one adapter target among several. Not the center of the architecture"; #6169 (timeline ask) triaged 2026-08-06, unanswered; #7903 (community native adapter) unreviewed since 2026-09-07. Plan migration as OMO-independent (prep item 6).
- V2 plugin surface that survives (verified by #7847/#7903, not docs): `event.subscribe` (decoded `OpenCodeEvent`s), `session.hook("context")` — exposes `event.system`/`event.messages`/`event.tools` together (the prompt-rewrite + tool-stripping surface), `tool.hook("execute.before/after")`, `agent.transform` (lazy until first registry materialization; `agent.reload()` forces), `ctx.mcp.transform`, `catalog.transform`, `catalog.updated` (model catalog **empty at setup**, populates async — a setup-time snapshot silently drops every agent onto its first fallback). Missing: `SessionDomain.list`/`messages` (session-history tools must read the SQLite store read-only), `session.hook("model.request")` model field is readonly (fallback must be reactive off `session.execution.failed` + `switchModel`, never proactive), compaction hooks, `session.todo` API (todo/boulder continuation = no-op), `ctx.shell` is only `{hook("create.before")}` (full `ShellApi` hangs off the HTTP client surface the plugin Context never hands out).
- V2 disables tmux/zellij multiplexers by default (native subagent rendering); revisit any flow assuming multiplexer availability.
- lean-ctx is V1-shaped but V2-compatible-with-gaps (assessed 2026-09-14): no V2 upgrade plan needed for its core MCP/hooks workflow; the three gaps are config-writer shape (V1 `mcp."lean-ctx"`, no `mcp.servers`), permission mirroring (V1 `permission` object → silent no-op on V2-native config; the only security-relevant one), and `import opencode` (V1 `opencode.db`; V2 storage isolated per opencode #34831). opencode2's MCP-loading beta bug #37532 (servers from config not recognized) is opencode's, not lean-ctx's — attribute "MCP not configured" symptoms there.
- V2 accepts `lsp` config but does not run language servers — the baked `lsp.json.default` (marksman) and any LSP-dependent workflows become inert at GA.

## Evidence

- Inventory method (2026-09-03): `codegraph_explore` + `ctx_glob **/opencode.json*` (0 hits in repo) + `ctx_read .opencode/omo.jsonc.default` (94 lines, V1-style tools/models) + `ctx_search Dockerfile` (`OPENCODE_VERSION=1.18.27` at the time, `OH_MY_OPENAGENT_VERSION=4.19.4`, superpowers baked to `/opt/opencode/baked-plugins/superpowers`).
- Plugin/API surface: background explore found no `.opencode/plugin/*.ts`; 8+ curl endpoints enumerated in `src/admin/lib/model-probe.ts`, `agent-model-live.ts`, `agent-model-history.ts`, `agent/commands.ts`, `scripts/agent-model-health.sh`, `scripts/reconcile-agent-models.sh`, `test/test-agent-model-e2e.sh`.
- Revalidation (2026-09-14): npm registry probes — `opencode-ai` `latest=1.18.30` (no 2.x), `@opencode/cli` `latest=2.0.3`, `@opencode/client` `2.0.3`, `@opencode/sdk` `2.0.3`, `@opencode-ai/cli/cli` `beta=0.0.0-beta-19271`, `@openchamber/web` `latest=1.23.1` (no 2.x), `oh-my-openagent` `5.0.0-beta.62` → `@opencode-ai/sdk@1.18.22`. GitHub API — openchamber `v2-preview` tag `ccd3596` (prerelease, desktop-only assets, body "bundling OpenCode 2.0.3"); opencode tags `v2.0.0`–`v2.0.3` with **no GitHub Release objects** (404); branch `opencode-v2-refactoring` tip `e5f76d0`, cutover commit `00667e75`, `Dockerfile` byte-identical to main; PR #3007 open.
- External: `https://opencode.ai/v2/docs/migrate-v1/` (breaking changes + field map), `https://opencode.ai/v2/docs/build/plugins/`, `/build/sdk`, `/build/client`, `/cli/config`; `specs/v2/schema-changelog.md` @ `df23b7f` (event-sourced sessions, `session_pending`, finite history, tool registry, permissions V2, compaction, `/api/*` routes); V1 `1.18.30` (2026-09-09 changelog).
- OMO v2 stance (2026-09-14, `gh api` on `code-yeongyu/oh-my-openagent`): ROADMAP.md "Why Not OpenCode-Native" — OpenCode plugin API "makes it trivial to break the main agent loop", "We treat OpenCode as one adapter target among several. Not the center of the architecture."; issue #6169 (v2 migration timeline) open since 2026-07-17, triaged to @code-yeongyu 2026-08-06, **unanswered**; #7847 (v2 loader rejects `{id, server}` shape on `@opencode-ai/cli@0.0.0-beta-19192`) open, includes downstream ask to expose a supported-feature subset in doctor; PRs #7104 (v2 beta compat foundation) and #7570 (dual-host `{id, server, setup}`) both **withdrawn by author within 2h** — #7570 self-documented degradations: todo/boulder continuation no-ops, compaction hooks no surface, contract validated by QA not compiler; #7903 (native v2 sibling adapter: 11 agents, 10 base + 19 config-gated tools incl. 12 `team_*`, 4 MCP built-ins, 17 skills via transforms; pinned `@opencode-ai/plugin@0.0.0-beta-17793`; `bun test` 354 pass / 62 files, `tsgo --noEmit` clean, 38 QA evidence bundles) **open, unreviewed** — zero dependency on `omo-opencode` (per ROADMAP adapter direction); OMO releases 2026-09-08..13 all `v5.0.0-beta.49`–`.62`, none V2-API (`@opencode-ai/sdk@1.18.22` pinned).
- lean-ctx assessment (2026-09-14, librarian + local): yvgude/lean-ctx @ `221542810d` (v3.10.1) — MCP writer emits V1 shape (`rust/src/hooks/agents/opencode.rs` L34-39, merged under top-level `mcp`; `rootKey: "mcp"` in `docs/integrations/client-constraints-matrix-v1.md` L100-107); no current plugin installed (uninstaller only removes "OpenCode Plugin (legacy)"); `permission_inheritance` "v1 supports OpenCode" (`rust/src/core/ide_permissions.rs` L13-19); `import opencode` joins project→session→message→part on `~/.local/share/opencode/opencode.db` (`rust/src/core/import/opencode.rs` L20-51, PR #1732 / issue #1731); upstream guide disclaims first-class status (`docs/guides/opencode.md`); **zero** issues/PRs/commits mention `opencode2` or "opencode v2". Local: `entrypoint.d/02-init-config.sh` L308-312 registers `mcp."lean-ctx"` (`type: local, command: ["lean-ctx"]`); lean-ctx TOML baseline has no harness-specific keys; data dirs self-managed under `~/.local/share/lean-ctx/`. opencode side: #34831 (V2 storage isolation) open; #37532 (V2 MCP from config not recognized) open.
- Validation: doc-only update; no build/test impact. All facts cross-checked against live npm registry + GitHub API on 2026-09-14.

## Related Files

- `Dockerfile` (OPENCODE_VERSION, OPENCHAMBER_VERSION, OH_MY_OPENAGENT_VERSION, baked superpowers, `lsp.json.default`)
- `entrypoint.d/02-init-config.sh` (runtime opencode.json generation)
- `.opencode/omo.jsonc.default` (OMO agent/model/tool schema)
- `.opencode/scripts/check-versions.sh` (pin source mappings — needs cross-major switch support for `opencode-ai` → `@opencode/cli`), `.github/workflows/dependency-update.yml`
- `src/admin/lib/model-probe.ts`, `src/admin/lib/agent-model-live.ts`, `src/admin/lib/agent-model-history.ts`, `src/admin/lib/agent-model-reconciler.ts`
- `src/admin/agent/commands.ts` (OPENCODE_SESSION_PROBE_SCRIPT, pgrep fallback)
- `scripts/agent-model-health.sh`, `scripts/reconcile-agent-models.sh`, `test/test-agent-model-e2e.sh`
- `src/admin/lib/leanctx.ts`, `src/admin/lib/leanctx-schema.ts`, `src/admin/routes/leanctx.ts` (admin lean-ctx config editor/API)
- `.opencode/skills/*/SKILL.md`, `.opencode/commands/opsx-*.md`, `.opencode/AGENTS.md.default`

## Tags

- opencode-v2
- openchamber-v2
- migration-watch
- plugin-api
- server-api
- oh-my-openagent
- omo-v2-stance
- continuation-engine
- lean-ctx
- package-split
- install-strategy
- release-strategy
- version-pinning
