# Convergence Record — Two Workers, One Trial Branch

> Branch: `trial/opencode-v2` | Date: 2026-10-02 | Status: **assessment + proposals only — no merges performed, no files reassigned**
> Rule in force: nobody commits or edits the other worker's files. This document records ownership, collisions found, and who must act on each item.

## 1. Ownership Map (as observed, not as wished)

| Area | Owner | Files | State |
|---|---|---|---|
| Trial scaffold, Cell 1 baseline, KB, DECISIONS | Sisyphus (this worker) | `docker-compose.v2.yml`, `Dockerfile` pins, `test/test-v2-trial.sh`, `trial/CELL1.md`, `.opencode/agents/*.md` (created), `trial/CELL2B.md`, `trial/TODO-SPEC.md`, `trial/B1-*`, `trial/M3-*`, `trial/DECISIONS.md`, `check-versions.sh`, `dependency-update.yml` | All committed |
| Cells 2–3 diagnostics track | Other worker | `trial/CELL2.md`, `trial/CELL3.md`, `.opencode/v2-diagnostics-catalog.json`, `.env` BREW/BUN additions | Committed (`9102f71`) |
| Providers V2降级页 + tests | Other worker | `src/admin/routes/providers.ts`, `src/admin/views/providers.tsx`, `src/admin/views/providers.test.tsx` | **Uncommitted** (10-file dirt) |
| Agent model pins (gemma free) | Other worker | `.opencode/agents/{explore,librarian,metis,momus,multimodal-looker,oracle}.md` (1 line each) | **Uncommitted** |
| KB failure-classification row | Other worker | `docs/knowledge/troubleshooting/opencode-model-request-failure-classification.md` | **Uncommitted** (evidence-grade, keep) |
| Admin native rewrite (22 files) | Sisyphus | `src/admin/{lib,routes,agent}/agent-model*`, `entrypoint.d/*omo*`, `scripts/migrate-omo-to-native.sh` etc. | Committed (`e71dcbd`) |

## 2. Cell Numbering Collision — Resolved by Definition

- Their `CELL2`/`CELL3` (committed 09-25) = **diagnostics track** (LSP→CLI checks, site catalog). Keep numbers; do not rename committed history.
- My planning-matrix cells (OMO-failure=2, native-config=3, shim=2b, admin=5…) were **working labels only** and are superseded: actual deliverables carry mechanism names (`CELL2B`, `TODO-SPEC`, `B1-*`, `M3-*`, `ADMIN-NATIVE-DESIGN`). No file on either side needs renaming. Future cells take the next free mechanism name, never bare numbers.

## 3. Interface Drift (Real, Latent, Documented — Not Patched)

Two V2-detection mechanisms now coexist:

| Side | Mechanism | Location |
|---|---|---|
| Providers page (theirs) | `opencode --version` regex probe per request (`/(?:^|\s)v?2\.\d+\.\d+\b/`) | `src/admin/routes/providers.ts:315-316` (their dirty file — **not touched**) |
| Agent-models stack (mine) | `OMO_ENABLED==="0"` env gate, inlined separately in `agent-models.ts:35`, `routes/agent-models.ts:17`, `agent-model-reconciler.ts:162`, plus `isNativeV2Enabled()` in `agent-model-types.ts:102` | Committed (`e71dcbd`) |

Divergence condition (env says v2, binary is v1, or vice versa) makes routing/OMO paths disagree. In trial compose both agree (`OMO_ENABLED=0` + 2.0.15), so this is latent, not live. **Adoption proposal (theirs to take or leave):** extract ONE shared `isOpenCodeV2()` (version-probe primary, env override) into `src/admin/lib/opencode-version.ts`; both sides call it. I deliberately did NOT create it — an unused shared helper is speculative code, and wiring it into their three files is their call.

## 4. Gemma Pins Are Live-Broken (Verified 2026-10-02, Zero Spend)

Their 6 agent files pin `model: openrouter/google/gemma-4-26b-a4b-it:free`. Probe in trial (`opencode run --agent librarian`, tiny prompt): instant `Error: API key expired` — the trial openrouter key is dead (401 confirmed 2026-09-29), so every pinned subagent fails before inference. Side evidence (positive): the pin IS honored by V2 native dispatch (it attempted that exact model), which further validates the Cell 1 mapping.

**Recommendation (theirs to decide):** either revert the six pins (fall back to agent default until key rotation) or rotate the openrouter key, after which the pins become an asset (free-tier subagents). Do NOT leave as-is: a new trial user hitting `explore` gets an auth wall with no explanation.

## 5. Their-10 Merge Checklist (for the owner, in order)

1. `docs/.../opencode-model-request-failure-classification.md` (+1 row, evidence-grade: free-tier gate with upstream refs) — merge as-is.
2. `src/admin/{routes/providers.ts, views/providers.tsx, views/providers.test.tsx}` — V2降级页 + test asserting hidden controls; verify `bun test` still 1183/0 after merge (suite ran green WITH these files present, so risk is low, but the owner runs it).
3. `.opencode/agents/*.md` pins — decide per §4 first (revert or rotate key), then merge.
4. Confirm no overlap with my committed Admin rewrite (verified: disjoint files — `routes/agent-models.ts` vs `routes/providers.ts`, `views/agent-models.tsx` vs `views/providers.tsx`).
5. After merge: single `git status` must show zero surprise files; trial image rebuild NOT required (no Dockerfile/entrypoint/image-content change in their 10 — providers page is served from `/opt/admin`, which IS baked... note: Admin UI changes take effect only after image rebuild + container recreate; flag for their rollout step).

## 6. Explicit Non-Goals of This Record

- No code written, no files modified, no commits made by this worker in this pass.
- No Cell renumbering performed.
- No shared helper created (would be speculative until adopted).
- Quota policy, billing, key rotation: untouched (owner's domain).
