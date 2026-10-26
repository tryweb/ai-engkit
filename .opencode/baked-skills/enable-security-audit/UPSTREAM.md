# UPSTREAM.md — enable-security-audit vendor record (V2)

## Upstream

- Repository: https://github.com/cloudflare/security-audit-skill
- Pinned commit: `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8`
- Pinned date: 2026-09-17 (Clarify guidance and full audit modes)
- License: MIT (Copyright (c) 2025-2026 Cloudflare, Inc.)
- Vendored path in this repo: `.opencode/baked-skills/enable-security-audit/skill/` (21 files: 20 under `skills/security-audit/` + `LICENSE`)

## File map (upstream `skills/security-audit/` → `skill/`)

| Upstream | Vendored as | Notes |
|---|---|---|
| `SKILL.md` | `SKILL.md.template` | **Renamed on vendor.** OpenCode recursively scans config dirs for `SKILL.md`; a nested copy would register as a global skill and break opt-in. `bootstrap.sh` restores the filename on install. Guard: `find skill -name SKILL.md` must be empty. |
| `RECONNAISSANCE.md` | same | Phase 1 prompts |
| `HUNTING.md` | same | Phase 2 orchestration |
| `ATTACK-CLASSES.md` | same | Core/wildcard/obvious-things prompts |
| `MEMORY-SAFETY-AND-BINARY.md` | same | Native-target hunting classes |
| `AI-AND-LLM.md` | same | Prompt-injection / agent-tool classes |
| `WEB-PROTOCOL-AND-AUTH.md` | same | HTTP-framing / cache / auth-protocol classes |
| `CLIENT-SIDE.md` | same | DOM / messaging / UI-redress / prototype-pollution |
| `SUPPLY-CHAIN-AND-RELEASE.md` | same | Dependency / CI / release / signing classes |
| `CLOUD-AND-DEPLOYMENT.md` | same | IAM / IaC / container / serverless classes |
| `PROTOCOLS-RPC-AND-MESSAGING.md` | same | RPC / serialization / queue / webhook classes |
| `RESOURCE-EXHAUSTION-AND-AVAILABILITY.md` | same | Quota / queue / worker / spend classes |
| `DATA-ISOLATION-AND-LIFECYCLE.md` | same | Tenant / cache / export / backup / restore classes |
| `DESKTOP-MOBILE-AND-LOCAL-IPC.md` | same | App / deep-link / webview / IPC classes |
| `VALIDATION-AND-REPORTING.md` | same | Phases 3–6 validation + reporting |
| `report-schema.json` | same | Findings verdict schema |
| `validate-findings.cjs` | same, `+x` | Zero-dependency findings validator (`node <file>.cjs`) |
| `validate-findings.test.cjs` | same | Validator tests (run with `bun test`, not `node --test`) |
| `validate-coverage-ledger.cjs` | same, `+x` | Zero-dependency ledger validator |
| `validate-coverage-ledger.test.cjs` | same | Validator tests (run with `bun test`) |
| `LICENSE` | `LICENSE` | MIT, kept in-tree for auditability |

## V2 adjustments (vs V1 handover)

1. **No omo / no `team_mode`.** V1 distinguished "audit needs no team mode;
   `security-research` needs `team_mode.enabled=true` + restart". On the V2
   line (`OMO_ENABLED=0`) there is no `~/.omo/omo.jsonc` at all and no
   team-mode toggle exists. `bootstrap.sh` therefore contains **zero**
   omo logic. The routing note says so explicitly so agents use native
   subagents for isolated hunters/verifiers instead of looking for a toggle.
2. **Entrypoint upgrade slot.** The generic baked-skill symlink block needs
   no change (it picks up any dir containing `SKILL.md`); the one-line
   registration is the `UPGRADEABLE_SKILLS` entry
   `"security-audit:$SKILLS_ROOT/enable-security-audit"` in
   `entrypoint.d/02-init-config.sh`.
3. **Admin capability.** Same four-place sync as V1
   (`PROJECT_FEATURES` → marker detection → route → frontend), applied to
   the V2 admin paths (`src/admin/lib/projects.ts`,
   `src/admin/lib/projects-overview.ts`, `src/admin/routes/projects.ts`,
   `src/admin/static/projects-page.js` + `src/admin/views/projects.tsx`
   filter). Disable is **true deletion** (tree + note segment; `AGENTS.md`
   deleted when emptied) — unlike knowledge/maintenance/openspec, whose
   disable is a no-op.
4. **Runtime trivia (unchanged).** Container `node` is a Bun shim:
   `node <file>.cjs` runs, `node --test` does not; validator tests run
   with `bun test`. `~/.omo/omo.jsonc` absence is expected on V2, not a
   misconfiguration. Shell lint is `bash -n` + behavior tests (no
   shellcheck in image).

## Update SOP (re-vendor)

1. Re-vendor the tree from the new upstream commit.
2. **`mv skill/SKILL.md skill/SKILL.md.template`** (most commonly forgotten).
3. `find skill -name SKILL.md` must print nothing.
4. Diff every file line by line — this tree drives sub-agents; review it
   like code, not data.
5. Run the validator suites with `bun test` (not `node --test`).
6. Bump `skill-version` in `bootstrap.sh` (drives auto-upgrade).
7. Update the pin/date table at the top of this file.
8. Rebuild the image. Enabled projects auto-`--force` on next start;
   a hand-installed tree at the same path is overwritten by design
   (documented, expected).

## Policy

- `--force` refreshes the **whole tree**, including hand edits. Prompts
  must stay reproducible across runs; local tweaks belong in the project
  outside `.opencode/skills/security-audit/` or in a forked skill name.
- Version marker: `bootstrap.sh` carries `<!-- skill-version: X.Y.Z -->`;
  the installed `SKILL.md` gets the same marker prepended; upgrade state
  is tracked in `~/.config/opencode/.skill-versions` as
  `security-audit=X.Y.Z`. No enabled projects → no marker written
  (expected, not a bug).

## History

| Date | Upstream SHA | skill-version | Notes |
|---|---|---|---|
| 2026-10-26 | `c1c8a8c` | 1.0.1 | Initial V2 vendor (full 21-file tree, V2 routing note, no omo) |
