# Grype Image-Scan Triage Pitfalls

## Context

`tryweb/ai-engkit` scans the built image with Grype (`anchore/scan-action`, `.github/workflows/ci.yml`
`Vulnerability Scan` job) and uploads SARIF to code scanning. A 2026-11-27 snapshot had 1,015 open
alerts, all from Grype. Triaging them surfaced repeated misreadings worth avoiding.

## Problem

- GitHub's `security_severity_level` disagrees with the scanner message: 29 of 31 UI "critical"
  alerts described themselves as "medium" in the Grype message text. Trusting the UI count alone
  overstates urgency.
- One advisory fans out across binary packages: a single Python CVE produced 38 alerts
  (`libpython3.12-minimal`, `-stdlib`, `python3.12`, …). Alert count is not finding count —
  group by advisory ID first (342 distinct IDs behind the 1,015).
- SARIF `Fix Version` empty does not mean unfixable; it means the uploaded scan reported none.
  Ubuntu rows (`ubuntu:distro:ubuntu:24.04` namespace) all showed empty fixes while fixes may exist.
- `grype dir:` on a Bun workspace reports `No vulnerabilities found` even for known-vulnerable
  pins: the cataloger does not parse `bun.lock`, and bare `package.json` without a supported
  lockfile yields nothing. Zero matches here is a tool blind spot, not a clean bill.
- The per-alert substance (affected symbols, preconditions) lives in `rule.full_description`,
  not in the one-line message. Skipping it leads to dismissing reachable findings or escalating
  dead code.

## Solution

1. Pull alerts with `gh api .../code-scanning/alerts --paginate`, pipe through `jq -s 'add'`
   (never `--slurp` with `--jq`), and group by advisory ID before anything else.
2. Compare `rule.security_severity_level` against the severity word in
   `most_recent_instance.message.text`; report disagreement instead of picking one silently.
3. Treat empty `Fix Version` as "not reported", and check the vendor tracker from a connected
   host before claiming "no fix".
4. For Bun workspaces, verify with `bun audit` plus advisory vulnerable-range checks against
   resolved versions (`bun.lock`), not with `grype dir:`.
5. Read `rule.full_description` for every candidate before classifying reachability.

## Why It Works

Each pitfall is a place where the pipeline silently changes meaning: GitHub re-ranks severity,
Grype expands one advisory per binary package, SARIF drops fix-state detail present in JSON/SBOM
output, and the directory scanner skips an unsupported lockfile format. Checking each layer
explicitly restores the original signal.

## Side Effects / Tradeoffs

- `bun audit` uses a different DB than Grype; clean in one is not clean in the other. Use both,
  and let the CI image rescan be the source of truth for closing alerts.
- Preserving Grype JSON/SBOM as CI artifacts (bounded retention) costs storage but keeps
  `artifact.upstreams` and fix-state detail that SARIF alone loses.

## Evidence

- 2026-11-27: 1,015 open → 342 advisory IDs; 29/31 UI-critical described as medium.
- `src/admin` Hono 4.13.3 → 4.13.23: `grype dir:src/admin` reported 0 matches both before and
  after; `bun audit` + GHSA range checks confirmed the fix, and CI rescan closed all 11 alerts
  as `fixed` (run `45970585021`, commit `57183ac`).
- Scan help tables list `Fix Version` empty for all 975 Ubuntu rows.

## Related Files

- `.github/workflows/ci.yml` (scan job, `severity-cutoff`)
- `.github/scripts/grype-release-check.sh`
- `docs/security/code-scanning-triage-2026-11-27.*`

## Tags

grype, code-scanning, triage, sarif, bun, severity
