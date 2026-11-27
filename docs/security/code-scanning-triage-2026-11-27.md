# Code scanning ownership and remediation triage — 2026-11-27

## Scope and evidence

- Snapshot: 2026-11-27T08:52:37.384504+00:00; repository: `tryweb/ai-engkit`.
- Open alerts: **1015**; distinct advisory IDs: **342** (CVE/GHSA/GO aliases are not deduplicated).
- All rows are GitHub code-scanning alerts whose uploaded Grype messages identify image dependency matches; this is not a complete image/SBOM inventory or independent confirmation of exploitable application vulnerabilities.
- Scanned ref: `refs/heads/main`; commit: `42a257cdf297efecdbf0286912d084a1cc7192d1`.
- This is an ownership/remediation inventory, not a full code audit. No packages were changed, alerts dismissed, issues filed or images rebuilt.
- The CSV preserves all alert numbers, instance versions/paths, advisory links, fix-version evidence, owners and recommended actions.
- The adjacent summary JSON records retrieval time, input SHA-256, counts and limitations.

## Responsibility matrix

| Handling system | Alerts | Fix version reported | No fix version in scan | Project responsibility |
|---|---:|---:|---:|---|
| ai-engkit-admin-npm | 11 | 11 | 0 | Directly update Admin manifest/lockfile and validate. |
| codegraph-bundled-node | 15 | 15 | 0 | CodeGraph publishes a refreshed Node bundle; ai-engkit updates CODEGRAPH_VERSION. |
| docker-buildx-go | 2 | 2 | 0 | Buildx maintainers rebuild Go modules; ai-engkit updates BUILDX_VERSION. |
| docker-compose-go | 7 | 7 | 0 | Compose maintainers rebuild Go modules; ai-engkit updates COMPOSE_VERSION. |
| openchamber-managed-core-npm | 5 | 5 | 0 | OpenChamber updates dependencies; ai-engkit integrates a tested core release. |
| ubuntu-24.04-apt | 975 | 0 | 975 | Consume Ubuntu fixes in image; Canonical/source maintainers provide patches. |

**A missing fix version means only that the uploaded scan supplied none; it does not prove that no patch exists today. A reported fix is a scanner recommendation, not proof of installability or compatibility.**

## Work this project can perform directly

### A1 — Update Admin dependencies (11 alerts)

- `hono`: installed `4.13.3`; the highest reported fix among these ten alerts is `4.13.16`. Use a compatible `4.13.16` or later patched release and recheck all advisory ranges.
- `smol-toml`: installed `1.8.0`; reported fix `1.9.0` (one alert).
- Edit `src/admin/package.json` to express patched minimums, regenerate `src/admin/bun.lock`, and inspect the lockfile diff. The broad current ranges allow these updates but the committed lockfile retains the scanned versions.
- Validate Admin unit tests and typecheck, relevant HTTP/TOML regressions, rebuilt-image resolved versions, and a new Grype scan. Do not claim the 11 alerts fixed before the same image is rescanned.

### A2 — Refresh OS integration without claiming to author Ubuntu patches

- `Dockerfile:1,29-66` selects Ubuntu 24.04, installs APT packages and already defaults `UPGRADE_PACKAGES=true`.
- A fresh base/APT build can consume published patches; a reused cached RUN layer does not rerun `apt-get update`/`upgrade`. Arrange an intentional cache refresh; do not merely add a duplicate upgrade command.
- Check vendor advisory status, repository availability and package origin before deciding an upgrade is possible. Retain Ubuntu backport versions/epochs rather than comparing only upstream version numbers.
- Remove optional packages only after dependency/use review; building a smaller runtime image is a separate design change for this development-tool image.

### A3 — Improve triage evidence and release policy

- Preserve Grype JSON/SBOM as restricted CI artifacts with bounded retention; retain image digest and vulnerability DB metadata. SARIF alone lacks source-package/dependency-chain and fix-state detail.
- `.github/workflows/ci.yml:243-279` currently scans baseline/candidate JSON and candidate SARIF separately. Keep identity/DB consistency or derive presentations from one captured dataset where supported.
- `.github/scripts/grype-release-check.sh:33-90` blocks newly introduced Critical/High IDs relative to the baseline, not all existing backlog. Passing that gate is not evidence that existing risks have been remediated.
- Track existing actionable findings with an owner, target date and regression budget; distinguish vendor severity from GitHub security severity.
- Review `.grype.yaml`: headless Chromium is not inherently safe for untrusted sites. Existing ignored findings are outside this open-alert inventory; do not extend blanket ignore rules to make counts reach zero.

## Items requiring upstream packaging or patches

### B1 — OpenChamber managed-core npm dependencies (5 alerts)

- Registry metadata for `@openchamber/web@1.24.2` explicitly declares the direct dependencies `simple-git: ^3.36.0` and `@simplewebauthn/server: 13.3.1`; `simple-git@3.36.0` declares `@simple-git/argv-parser: ^1.1.0` as a transitive dependency of OpenChamber.
- Request/select an OpenChamber release using patched dependencies: `4.0.1` is the higher reported `simple-git` fix across its three alerts (the other two report `4.0.0`), argv-parser reports `2.0.1`, and SimpleWebAuthn reports `13.3.2`. These are distinct package targets, not an instruction to force incompatible major overrides.
- `simple-git` 4.x does not satisfy OpenChamber's current `^3.36.0` range; rebuilding the same manifest cannot be relied on to fix it. The exact `13.3.1` WebAuthn pin also requires a manifest change upstream.
- ai-engkit owns selecting/testing the parent release. Do not change OPENCODE_VERSION/OPENCHAMBER_VERSION without explicit approval; do not edit the running managed-core tree (recovery restores the baseline). Rebuild its baseline and verify compatibility after any approved change.
- The critical simple-git advisories merit prompt reachability review: attacker-controlled Git configuration/arguments and the relevant Git operation are preconditions, not established facts about ai-engkit.

### B2 — CodeGraph bundled Node (15 alerts)

- Scanned file: `@colbymchenry/codegraph-linux-x64/node`, installed Node `24.22.1`. The scan reports `24.22.3` as a fix on the same major line for all 15 matches.
- Node.js provides the runtime fix; the CodeGraph platform-package maintainer must ship it in the embedded bundle. ai-engkit can then update `CODEGRAPH_VERSION` (currently `1.6.4`) after compatibility checks.
- Installing another system Node or changing the Bun-based `node` symlink does not replace this embedded executable. No available parent release containing the fix was verified in this pass.

### B3 — Docker Compose / Buildx embedded Go modules (9 alerts)

- Dockerfile currently pins Compose `5.8.0` and Buildx `0.39.1`. Module fixes in the table below are not plugin release versions.
- The library maintainers publish patches; Compose/Buildx maintainers rebuild and release binaries; ai-engkit selects/tests those binaries. An APT, npm or system Go update does not modify already compiled plugin code.
- `github.com/moby/go-archive` in Buildx is not automatically a daemon-only false positive. Check the advisory and included/reachable code before suppressing it.

## Non-OS package worklist

| Owner | Package | Installed instance version | Reported fix versions (per advisory) | Alerts |
|---|---|---|---|---:|
| ai-engkit-admin-npm | `hono` | `4.13.3` | 4.13.11; 4.13.16; 4.13.5; 4.13.7 | 10 |
| ai-engkit-admin-npm | `smol-toml` | `1.8.0` | 1.9.0 | 1 |
| codegraph-bundled-node | `node` | `24.22.1` | 22.23.5,24.22.3,26.13.1; 24.22.3,26.13.1 | 15 |
| docker-buildx-go | `github.com/moby/go-archive` | `v0.2.0` | 0.3.0 | 1 |
| docker-buildx-go | `golang.org/x/crypto` | `v0.58.0` | 0.58.1-0.20261009181718-2f1f834330b2 | 1 |
| docker-compose-go | `github.com/klauspost/compress` | `v1.20.0` | 1.20.2 | 1 |
| docker-compose-go | `go.opentelemetry.io/otel` | `v1.46.0` | 1.47.0 | 1 |
| docker-compose-go | `go.opentelemetry.io/otel/sdk` | `v1.46.0` | 1.47.0 | 1 |
| docker-compose-go | `go.opentelemetry.io/otel/trace` | `v1.46.0` | 1.47.0 | 1 |
| docker-compose-go | `golang.org/x/crypto` | `v0.57.0` | 0.58.1-0.20261009181718-2f1f834330b2 | 1 |
| docker-compose-go | `golang.org/x/net` | `v0.60.0` | 0.62.0 | 2 |
| openchamber-managed-core-npm | `@simple-git/argv-parser` | `1.1.1` | 2.0.1 | 1 |
| openchamber-managed-core-npm | `@simplewebauthn/server` | `13.3.1` | 13.3.2 | 1 |
| openchamber-managed-core-npm | `simple-git` | `3.36.0` | 4.0.0; 4.0.1 | 3 |

## Ubuntu/APT worklist by installed binary package

Ubuntu/source-project maintainers provide patches for all entries below; ai-engkit consumes fixes or removes unnecessary dependencies. These are **binary package groups**, not authoritative source-package groups. Obtain `artifact.upstreams` from Grype JSON/SBOM or the scanned image's dpkg Source metadata before merging them by source project. Do not use the current agent container as proof of the scanned image's package inventory.

| Installed package | Instance version(s) | Alerts | Fix version reported | No fix version in scan |
|---|---|---:|---:|---:|
| `libpython3.12-minimal` | `3.12.3-1ubuntu0.17` | 38 | 0 | 38 |
| `libpython3.12-stdlib` | `3.12.3-1ubuntu0.17` | 38 | 0 | 38 |
| `libpython3.12t64` | `3.12.3-1ubuntu0.17` | 38 | 0 | 38 |
| `python3.12` | `3.12.3-1ubuntu0.17` | 38 | 0 | 38 |
| `python3.12-minimal` | `3.12.3-1ubuntu0.17` | 38 | 0 | 38 |
| `python3.12-venv` | `3.12.3-1ubuntu0.17` | 38 | 0 | 38 |
| `xserver-common` | `2:21.1.12-1ubuntu1.9` | 38 | 0 | 38 |
| `xvfb` | `2:21.1.12-1ubuntu1.9` | 38 | 0 | 38 |
| `rsync` | `3.2.7-1ubuntu1.5` | 34 | 0 | 34 |
| `binutils` | `2.42-4ubuntu2.11` | 27 | 0 | 27 |
| `binutils-common` | `2.42-4ubuntu2.11` | 27 | 0 | 27 |
| `binutils-x86-64-linux-gnu` | `2.42-4ubuntu2.11` | 27 | 0 | 27 |
| `libbinutils` | `2.42-4ubuntu2.11` | 27 | 0 | 27 |
| `libctf-nobfd0` | `2.42-4ubuntu2.11` | 27 | 0 | 27 |
| `libctf0` | `2.42-4ubuntu2.11` | 27 | 0 | 27 |
| `libgprofng0` | `2.42-4ubuntu2.11` | 27 | 0 | 27 |
| `libsframe1` | `2.42-4ubuntu2.11` | 27 | 0 | 27 |
| `libgssapi-krb5-2` | `1.20.1-6ubuntu2.12` | 18 | 0 | 18 |
| `libk5crypto3` | `1.20.1-6ubuntu2.12` | 18 | 0 | 18 |
| `libkrb5-3` | `1.20.1-6ubuntu2.12` | 18 | 0 | 18 |
| `libkrb5support0` | `1.20.1-6ubuntu2.12` | 18 | 0 | 18 |
| `libssl-dev` | `3.0.13-0ubuntu3.16` | 13 | 0 | 13 |
| `libssl3t64` | `3.0.13-0ubuntu3.16` | 13 | 0 | 13 |
| `openssl` | `3.0.13-0ubuntu3.16` | 13 | 0 | 13 |
| `git` | `1:2.43.0-1ubuntu7.4` | 11 | 0 | 11 |
| `git-man` | `1:2.43.0-1ubuntu7.4` | 11 | 0 | 11 |
| `libcups2t64` | `2.4.7-1.2ubuntu7.14` | 11 | 0 | 11 |
| `libexpat1` | `2.6.1-2ubuntu0.7` | 11 | 0 | 11 |
| `libsqlite3-0` | `3.45.1-1ubuntu2.11` | 10 | 0 | 10 |
| `sqlite3` | `3.45.1-1ubuntu2.11` | 10 | 0 | 10 |
| `libxi6` | `2:1.8.1-1ubuntu0.1` | 9 | 0 | 9 |
| `libgnutls30t64` | `3.8.3-1.1ubuntu3.6` | 8 | 0 | 8 |
| `cpp` | `4:13.2.0-7ubuntu1` | 7 | 0 | 7 |
| `cpp-x86-64-linux-gnu` | `4:13.2.0-7ubuntu1` | 7 | 0 | 7 |
| `g++` | `4:13.2.0-7ubuntu1` | 7 | 0 | 7 |
| `g++-x86-64-linux-gnu` | `4:13.2.0-7ubuntu1` | 7 | 0 | 7 |
| `gcc` | `4:13.2.0-7ubuntu1` | 7 | 0 | 7 |
| `gcc-x86-64-linux-gnu` | `4:13.2.0-7ubuntu1` | 7 | 0 | 7 |
| `libc-bin` | `2.39-0ubuntu8.12` | 7 | 0 | 7 |
| `libc-dev-bin` | `2.39-0ubuntu8.12` | 7 | 0 | 7 |
| `libc6` | `2.39-0ubuntu8.12` | 7 | 0 | 7 |
| `libc6-dev` | `2.39-0ubuntu8.12` | 7 | 0 | 7 |
| `python3-pip` | `24.0+dfsg-1ubuntu1.3` | 7 | 0 | 7 |
| `python3-pip-whl` | `24.0+dfsg-1ubuntu1.3` | 7 | 0 | 7 |
| `cpp-13` | `13.3.0-6ubuntu2~24.04.1` | 6 | 0 | 6 |
| `cpp-13-x86-64-linux-gnu` | `13.3.0-6ubuntu2~24.04.1` | 6 | 0 | 6 |
| `g++-13` | `13.3.0-6ubuntu2~24.04.1` | 6 | 0 | 6 |
| `g++-13-x86-64-linux-gnu` | `13.3.0-6ubuntu2~24.04.1` | 6 | 0 | 6 |
| `gcc-13` | `13.3.0-6ubuntu2~24.04.1` | 6 | 0 | 6 |
| `gcc-13-base` | `13.3.0-6ubuntu2~24.04.1` | 6 | 0 | 6 |
| `gcc-13-x86-64-linux-gnu` | `13.3.0-6ubuntu2~24.04.1` | 6 | 0 | 6 |
| `libgcc-13-dev` | `13.3.0-6ubuntu2~24.04.1` | 6 | 0 | 6 |
| `libstdc++-13-dev` | `13.3.0-6ubuntu2~24.04.1` | 6 | 0 | 6 |
| `libdbus-1-3` | `1.14.10-4ubuntu4.1` | 4 | 0 | 4 |
| `libasound2-data` | `1.2.11-1ubuntu0.5` | 3 | 0 | 3 |
| `libasound2t64` | `1.2.11-1ubuntu0.5` | 3 | 0 | 3 |
| `libpopt0` | `1.19+dfsg-1build1` | 3 | 0 | 3 |
| `libsasl2-2` | `2.1.28+dfsg1-5ubuntu3.1` | 3 | 0 | 3 |
| `libsasl2-modules-db` | `2.1.28+dfsg1-5ubuntu3.1` | 3 | 0 | 3 |
| `libtirpc-common` | `1.3.4+ds-1.1build1` | 3 | 0 | 3 |
| `libtirpc3t64` | `1.3.4+ds-1.1build1` | 3 | 0 | 3 |
| `patch` | `2.7.6-7build3` | 3 | 0 | 3 |
| `wget` | `1.21.4-1ubuntu4.5` | 3 | 0 | 3 |
| `bsdutils` | `1:2.39.3-9ubuntu6.6` | 2 | 0 | 2 |
| `dash` | `0.5.12-6ubuntu5` | 2 | 0 | 2 |
| `gpgv` | `2.4.4-2ubuntu17.6` | 2 | 0 | 2 |
| `libavahi-client3` | `0.8-13ubuntu6.2` | 2 | 0 | 2 |
| `libavahi-common-data` | `0.8-13ubuntu6.2` | 2 | 0 | 2 |
| `libavahi-common3` | `0.8-13ubuntu6.2` | 2 | 0 | 2 |
| `libblkid1` | `2.39.3-9ubuntu6.6` | 2 | 0 | 2 |
| `libelf1t64` | `0.190-1.1ubuntu0.2` | 2 | 0 | 2 |
| `libevent-core-2.1-7t64` | `2.1.12-stable-9ubuntu2.2` | 2 | 0 | 2 |
| `libmount1` | `2.39.3-9ubuntu6.6` | 2 | 0 | 2 |
| `librtmp1` | `2.4+20151223.gitfa8646d.1-2build7` | 2 | 0 | 2 |
| `libsmartcols1` | `2.39.3-9ubuntu6.6` | 2 | 0 | 2 |
| `libsystemd0` | `255.4-1ubuntu8.19` | 2 | 0 | 2 |
| `libudev1` | `255.4-1ubuntu8.19` | 2 | 0 | 2 |
| `libuuid1` | `2.39.3-9ubuntu6.6` | 2 | 0 | 2 |
| `libxfont2` | `1:2.0.6-1+deb13u1build0.24.04.2` | 2 | 0 | 2 |
| `mount` | `2.39.3-9ubuntu6.6` | 2 | 0 | 2 |
| `tar` | `1.35+dfsg-3ubuntu0.4` | 2 | 0 | 2 |
| `util-linux` | `2.39.3-9ubuntu6.6` | 2 | 0 | 2 |
| `coreutils` | `9.4-3ubuntu6.3` | 1 | 0 | 1 |
| `dpkg` | `1.22.6ubuntu6.6` | 1 | 0 | 1 |
| `dpkg-dev` | `1.22.6ubuntu6.6` | 1 | 0 | 1 |
| `libdpkg-perl` | `1.22.6ubuntu6.6` | 1 | 0 | 1 |
| `libfontenc1` | `1:1.1.8-1build1` | 1 | 0 | 1 |
| `libglib2.0-0t64` | `2.80.0-6ubuntu3.10` | 1 | 0 | 1 |
| `libpam-modules` | `1.5.3-5ubuntu5.7` | 1 | 0 | 1 |
| `libpam-modules-bin` | `1.5.3-5ubuntu5.7` | 1 | 0 | 1 |
| `libpam-runtime` | `1.5.3-5ubuntu5.7` | 1 | 0 | 1 |
| `libpam0g` | `1.5.3-5ubuntu5.7` | 1 | 0 | 1 |
| `libxml2` | `2.9.14+dfsg-1.3ubuntu3.10` | 1 | 0 | 1 |
| `libxrender1` | `1:0.9.10-1.1ubuntu0.1` | 1 | 0 | 1 |
| `libyaml-0-2` | `0.2.5-1build1` | 1 | 0 | 1 |
| `libzstd1` | `1.5.5+dfsg2-2build1.1` | 1 | 0 | 1 |
| `openssh-client` | `1:9.6p1-3ubuntu13.20` | 1 | 0 | 1 |
| `python3-pkg-resources` | `68.1.2-2ubuntu1.2` | 1 | 0 | 1 |
| `python3-setuptools` | `68.1.2-2ubuntu1.2` | 1 | 0 | 1 |
| `python3-setuptools-whl` | `68.1.2-2ubuntu1.2` | 1 | 0 | 1 |
| `vim` | `2:9.1.0016-1ubuntu7.20` | 1 | 0 | 1 |
| `vim-common` | `2:9.1.0016-1ubuntu7.20` | 1 | 0 | 1 |
| `vim-runtime` | `2:9.1.0016-1ubuntu7.20` | 1 | 0 | 1 |
| `zip` | `3.0-13ubuntu0.2` | 1 | 0 | 1 |

## Data quality and disposition

- GitHub severity counts: `{'high': 290, 'medium': 568, 'low': 124, 'critical': 31, 'unknown': 2}`.
- Scanner message severity counts: `{'medium': 965, 'low': 36, 'high': 12, 'critical': 2}`.
- Severity disagreement is not itself evidence of a false positive. No automatic severity override or dismissal was made.
- Rule help is shared by rule ID and can describe a different instance than `most_recent_instance`. The CSV uses the instance message/path for installed versions and ownership and retains the rule-help version/path separately.
- Rule-help/instance inconsistencies: #9781. Remediation versions from inconsistent help require confirmation against the advisory/raw scan.
- Reachability and exploitability remain `not-assessed` for every row. None is classified as a confirmed false positive, accepted risk, or verified remediation.
- Open-alert API results are not a transactional snapshot; rerun inventory after rebuilding. Ignored/dismissed alerts, other branches and aliases require separate review.

## Suggested implementation order and acceptance criteria

1. **Direct Admin update:** patch Hono and smol-toml manifest/lockfile; tests/typecheck pass; new image confirms versions and targeted alerts disappear.
2. **OpenChamber escalation in parallel:** provide five alert links and dependency-chain evidence; agree on a compatible parent release or a reviewed temporary backport, then validate baseline/recovery and core compatibility.
3. **Bundled tooling updates:** identify CodeGraph/Compose/Buildx releases that actually include the module/runtime fixes; compare installed binaries and rescan rather than assuming the latest release is fixed.
4. **OS refresh:** obtain exact source-package/fix-state data; refresh build inputs for published fixes and maintain an owner-reviewed backlog for not-yet-fixed findings.
5. **Exception governance:** require advisory + package/version scope, evidence, reviewer and expiry/review trigger for every VEX/ignore decision. No package-category-wide dismissal.

## Source references

- GitHub: https://github.com/tryweb/ai-engkit/security/code-scanning
- Local integration: `Dockerfile`, `src/admin/package.json`, `src/admin/bun.lock`, `.grype.yaml`, `.github/workflows/ci.yml`, `.github/scripts/grype-release-check.sh`.
- OpenChamber registry metadata: https://registry.npmjs.org/@openchamber/web/1.24.2
- simple-git registry metadata: https://registry.npmjs.org/simple-git/3.36.0
- Grype dpkg matching: https://github.com/anchore/grype/blob/main/grype/matcher/dpkg/matcher.go
- Per-alert and vendor/advisory links are retained in the CSV.
