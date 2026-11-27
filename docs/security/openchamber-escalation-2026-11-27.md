# OpenChamber upstream escalation pack — 5 managed-core findings (2026-11-27)

## Status

- All 5 alerts still **open** on `refs/heads/main` after CI run `45970585021` (commit `57183ac`).
- This pack is evidence for requesting/selecting a fixed upstream parent. No dependency changed, no alert dismissed.

## Findings (scanner-reported, reachability not assessed)

| # | Alert | Advisory | UI severity | Instance version | Reported fix | Advisory vulnerable range |
|---|---|---|---|---:|---|---|
| 10602 | [GHSA-x6jw-m9v5-85vh](https://github.com/advisories/GHSA-x6jw-m9v5-85vh) | simple-git trailer-command guard bypass | critical | simple-git 3.36.0 | 4.0.1 | `>= 3.15.0, < 4.0.1` |
| 10603 | [GHSA-858h-whjf-mvg5](https://github.com/advisories/GHSA-858h-whjf-mvg5) | simple-git long-option abbreviation bypass | high | simple-git 3.36.0 | 4.0.0 | `<= 3.36.0` |
| 10612 | [GHSA-g4wm-2vf7-vfgr](https://github.com/advisories/GHSA-g4wm-2vf7-vfgr) | simple-git config-include command execution | high | simple-git 3.36.0 | 4.0.0 | `<= 3.36.0` |
| 10613 | [GHSA-v5rq-49vh-5v5c](https://github.com/advisories/GHSA-v5rq-49vh-5v5c) | argv-parser omits `VISUAL` from unsafe editors | critical | @simple-git/argv-parser 1.1.1 | 2.0.1 | `< 2.0.1` |
| 10837 | [GHSA-6hxq-p678-4hr2](https://github.com/advisories/GHSA-6hxq-p678-4hr2) | SimpleWebAuthn attestation trust-anchor check | low | @simplewebauthn/server 13.3.1 | 13.3.2 | `<= 13.3.1` |

All instance paths are under `/opt/ai-engkit/core/generations/<id>/install/global/node_modules/…` (image scan `ai-engkit:ci`).

## Dependency-chain evidence (registry, 2026-11-27)

Current pins (`Dockerfile:8-9`): `OPENCODE_VERSION=1.19.6`, `OPENCHAMBER_VERSION=1.24.2`.

- `@openchamber/web@1.24.2` declares `simple-git: ^3.36.0` and `@simplewebauthn/server: 13.3.1` (direct).
- `simple-git@3.36.0` declares `@simple-git/argv-parser: ^1.1.0` (transitive via simple-git).
- `^3.36.0` cannot resolve to 4.x, and `13.3.1` is exact: rebuilding the same manifest cannot fix these 5.

Verified fixed parent:

- `@openchamber/web@2.8.1` (registry `latest`) declares `simple-git: ^4.0.2` and `@simplewebauthn/server: 13.3.3`.
- `simple-git@4.0.2` declares `@simple-git/argv-parser: 2.0.1` (exact).
- `^4.0.2` resolves `>= 4.0.2`, above every reported simple-git fix (4.0.0/4.0.1); `13.3.3` is above `13.3.2`; `2.0.1` equals the argv-parser fix.

## Ask

1. Request/select an `@openchamber/web` release whose resolved tree is at or above: simple-git `4.0.1`, argv-parser `2.0.1`, SimpleWebAuthn server `13.3.2`. `2.8.1` satisfies this on paper.
2. Confirm the release's supported `@opencode-ai/sdk` / `@opencode/client` pairing before adoption.

## Compatibility caveats (do not silent-bump)

- `2.8.1` depends on `@opencode/client 2.4.2` / `@openchamber/sdk 2.8.1`; this repo pins the v1 line (`opencode-ai 1.19.6`, OpenChamber `1.24.2`). A major-line move needs coordinated review.
- Per repo policy, do not change `OPENCODE_VERSION` / `OPENCHAMBER_VERSION` without explicit approval.
- After any approved change: rebuild the managed-core baseline, re-verify update guards and DB-compat fixtures, run Admin + integration suites, rebuild the image, and confirm the 5 alerts report `fixed` (not dismissed) in a new scan.
- Reachability is `not-assessed` for all 5: exploitation needs attacker-controlled Git config/args plus the relevant Git operation — preconditions, not established facts about ai-engkit.

## Acceptance

- New image scan shows the 5 alert numbers as `fixed`.
- `bun install --frozen-lockfile` equivalent holds for the managed-core baseline (no drift).
- No package-category-wide ignore added to `.grype.yaml` for these advisories.
