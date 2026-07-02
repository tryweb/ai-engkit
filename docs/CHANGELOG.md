# Changelog

All notable changes to ai-engkit are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.1.11] - 2026-07-02

### Changed
- Upgrade OpenCode from 1.17.12 to 1.17.13.

## [1.1.10] - 2026-07-01

### Changed
- Update the tracked latest version for oh-my-openagent from 4.14.1 to 4.14.2.

## [1.1.9] - 2026-07-01

### Changed
- Upgrade OpenCode from 1.17.11 to 1.17.12.
- Upgrade GitLab CLI from 1.105.0 to 1.106.0.
- Update the tracked latest version for oh-my-openagent from 4.13.0 to 4.14.1.
- Update the tracked latest version for @colbymchenry/codegraph from 1.1.2 to 1.1.6.
- Update the tracked latest version for lean-ctx from v3.8.15 to v3.8.17.

## [1.1.8] - 2026-06-30

### Changed
- Upgrade @playwright/mcp from 0.0.76 to 0.0.77.
- Update the tracked latest version for oh-my-openagent from 4.13.0 to 4.14.0.
- Update the tracked latest version for @colbymchenry/codegraph from 1.1.2 to 1.1.4.
- Update the tracked latest version for lean-ctx from v3.8.15 to v3.8.16.

## [1.1.7] - 2026-06-29

### Changed
- Upgrade OpenChamber from 1.13.7 to 1.13.8.
- Upgrade GitLab CLI from 1.103.0 to 1.105.0.
- Record the tracked latest version for @fission-ai/openspec as 1.5.0.

## [1.1.6] - 2026-06-28

### Changed
- Upgrade OpenChamber from 1.13.6 to 1.13.7.

## [1.1.5] - 2026-06-28

### Changed
- Update the tracked latest version for @colbymchenry/codegraph from 1.1.1 to 1.1.2.

## [1.1.4] - 2026-06-27

### Changed
- Upgrade OpenChamber from 1.13.5 to 1.13.6.

## [1.1.3] - 2026-06-27

### Changed
- Upgrade OpenChamber from 1.13.3 to 1.13.5.
- Update the tracked latest version for lean-ctx from v3.8.13 to v3.8.15.

## [1.1.2] - 2026-06-26

### Changed
- Upgrade Docker Engine from 29.6.0 to 29.6.1.
- Update the tracked latest version for lean-ctx from v3.8.12 to v3.8.13.

## [1.1.1] - 2026-06-25

### Changed
- Upgrade OpenCode from 1.17.10 to 1.17.11.
- Update the Ubuntu 24.04 APT package snapshot (1 packages have updates: tar (1.35+dfsg-3build1)).

## [1.1.0] - 2026-06-25

### Added
- Add `--output-dir .playwright-mcp` to pw-mcp wrapper so screenshots default to `.playwright-mcp/` instead of CWD

### Changed
- Translate zh-TW docs to English, relocate CONTRIBUTING & SECURITY to root, add GitHub templates

### Documentation
- Add OpenChamber project data architecture & rename recovery guide

## [1.0.2] - 2026-06-25

### Changed
- Update @colbymchenry/codegraph to latest tracked version 1.1.0 → 1.1.1

## [1.0.1] - 2026-06-24

### Changed
- Upgrade OpenCode 1.17.9 → 1.17.10
- Upgrade OpenChamber 1.13.2 → 1.13.3
- Update @colbymchenry/codegraph to latest tracked version 1.0.1 → 1.1.0
- Update lean-ctx to latest tracked version v3.8.11 → v3.8.12
- Update Ubuntu 24.04 APT package snapshot (1 package has updates: perl-base (5.38.2-3.2ubuntu0.2))

### Fixed
- Fix the `ai-engkit-ai-dev` typo in the `vuln-scan.md` skill Docker validation example to `ai-engkit-dev` (`codeforge-ai-dev` before the rename); the literal rename did not match the real container name in `docker-compose.dev.yml`.

## [1.0.0] - 2026-06-24

### Changed
- **Project rename**: `tryweb/Codeforge` → `tryweb/ai-engkit`. Rationale: the name "Codeforge" is already used by 10+ commercial products and open source projects in the AI coding tools market, creating too much search noise. The new name `ai-engkit` directly communicates the project's identity as **Your Self-hosted AI Engineering Kit for Dev & Ops** and avoids naming collisions.
  - The GitHub repository now has a permanent 301 redirect, so existing `tryweb/Codeforge` links continue to work.
  - The GHCR image was renamed to `ghcr.io/tryweb/ai-engkit:*` (CI internal tag `codeforge:ci` → `ai-engkit:ci`).
  - Docker Compose `container_name` changed from `codeforge` / `codeforge-dev` to `ai-engkit` / `ai-engkit-dev`.
  - The install command `curl ... tryweb/Codeforge/refs/heads/main/install.sh` was updated to `tryweb/ai-engkit`.
  - `.sisyphus/boulder.json` and `evidence/*.txt` were intentionally left unchanged because local paths and historical records should not be rewritten.
- Known leftover: the Docker example in `vuln-scan.md` still uses `ai-engkit-ai-dev` (originally `codeforge-ai-dev`). The typo predates the rename and remains for later cleanup.

## [0.17.1] - 2026-06-23

### Changed
- Upgrade Docker Compose from 5.1.4 to 5.2.0.
- Upgrade Playwright from 1.61.0 to 1.61.1.

## [0.17.0] - 2026-06-23

### Added
- Add the `vuln-scan` skill to combine GitHub code scanning alert triage with Dockerfile version updates.

### Fixed
- Fix Playwright MCP failing to find a browser by adding the `pw-mcp` wrapper. It resolves bundled Chromium under `/ms-playwright` and passes it to `@playwright/mcp` through `--executable-path`, avoiding the default system Chrome channel selected by `--browser`. Full Chromium is back in the image (the earlier `--only-shell` change was reverted), while the headless shell remains as the minimum fallback.

## [0.16.5] - 2026-06-22

### Changed
- Update the tracked latest version for oh-my-openagent from 4.12.1 to 4.13.0.

## [0.16.4] - 2026-06-21

### Changed
- Upgrade OpenCode from 1.17.8 to 1.17.9.

## [0.16.3] - 2026-06-20

### Changed
- Update the tracked latest version for oh-my-openagent from 4.12.0 to 4.12.1.
- Update the tracked latest version for lean-ctx from v3.8.9 to v3.8.11.

## [0.16.2] - 2026-06-20

### Fixed
- Fix the CodeGraph MCP config key test mismatch by checking both `.mcp.codegraph` (entrypoint format) and `.mcpServers.codegraph` (legacy format).

### Changed
- Update the tracked latest version for oh-my-openagent from 4.12.0 to 4.12.1.
  - CodeGraph init guidance: provide explicit guidance instead of failing silently when the workspace is not initialized.
  - CodeGraph MCP bootstrap: LazyCodex pre-initializes the CodeGraph runtime during the MCP serve phase.
  - Background task polling: no longer misleads users into polling `background_output`.
  - Ultraresearch: workers now prefer collaborative teams and real-time broadcast of findings.

## [0.16.1] - 2026-06-20

### Other
- Dockerfile image slimming (bun cache cleanup, remove libclang-dev), image 4.24GB → 3.70GB
- update GitHub Actions to Node 24 native versions

## [0.16.0] - 2026-06-20

### Added
- add .dockerignore to reduce build context size
- replace brew-installed gh and marksman with static binaries
  (saves ~2GB, image 6.27GB → 4.25GB)
- upgrade gh from 2.67.0 to 2.95.0
- add GH_VERSION and MARKSMAN_VERSION to dependency-update.yml

### Other
- add knowledge entry for test container name mismatch
- add docker image slimming issue tracker link (#17)

## [0.15.1] - 2026-06-20

### Changed
- Update the tracked latest version for oh-my-openagent from 4.11.1 to 4.12.0.

## [0.15.0] - 2026-06-20

### Added
- add markdown LSP support for project-level `.md` navigation

### Changed
- expand tooling and authentication docs
- add knowledge capture scaffold
- add knowledge base placeholders
- add knowledge base references

## [0.14.0] - 2026-06-20

### Added
- Add `karpathy-guidelines` as a baked global skill (Karpathy's four code quality principles).

## [0.13.1] - 2026-06-19

### Changed
- Upgrade Docker Engine from 29.5.3 to 29.6.0.

### Fixed
- Fix CHANGELOG comparison links for v0.12.6 and v0.13.0.

## [0.13.0] - 2026-06-19

### Added
- Add the baked skills mechanism: `enable-project-knowledge` and `knowledge-capture` are built in as global skills.
- Add automatic symlinking of baked skills into `~/.config/opencode/skills/` during entrypoint startup.
- Add the versioned `bootstrap-knowledge.sh` script to `.opencode/scripts/`.

### Changed
- Update the README OpenChamber badge from 1.13.1 to 1.13.2.

## [0.12.6] - 2026-06-18

### Fixed
- auto-start dev container and detect container name in release skill

### Changed
- install glab from official release binary

## [0.12.5] - 2026-06-18

### Changed
- Upgrade Docker Buildx from 0.34.1 to 0.35.0.
- Upgrade OpenChamber from 1.13.1 to 1.13.2.

## [0.12.4] - 2026-06-17

### Changed
- Upgrade OpenCode from 1.17.7 to 1.17.8.
- Update the tracked latest version for oh-my-openagent from 4.10.0 to 4.11.0.
- Update the tracked latest version for lean-ctx from v3.8.7 to v3.8.8.

## [0.12.3] - 2026-06-17

### Changed
- Upgrade OpenChamber from 1.13.0 to 1.13.1.

## [0.12.2] - 2026-06-16

### Changed
- Update the tracked latest version for lean-ctx to v3.8.7.

## [0.12.1] - 2026-06-16

### Changed
- Upgrade OpenChamber from 1.12.4 to 1.13.0.
- Upgrade Playwright from 1.60.0 to 1.61.0.

## [0.12.0] - 2026-06-15

### Added
- Add lean-ctx XDG Base Directory support (v3.8.5+).
  - Dockerfile: add `BASH_ENV` / `CLAUDE_ENV_FILE` so bash automatically loads the lean-ctx environment.
  - Dockerfile: pre-create `~/.local/share/lean-ctx`, `~/.local/state/lean-ctx`, and `~/.cache/lean-ctx` directories.
  - Dockerfile: add `lean-ctx-data` / `lean-ctx-state` volumes so vector indexes, the knowledge base, and sessions persist.
  - `docker-compose.yml` / `docker-compose.dev.yml`: add `lean-ctx-data` / `lean-ctx-state` named volumes.
  - `entrypoint.d/00-fix-perms.sh`: add lean-ctx directory permission repair.
  - `entrypoint.d/02-init-config.sh`: detect the legacy single-dir layout automatically and run `lean-ctx doctor --fix` migration.
  - `docs/ARCHITECTURE.md`: add lean-ctx volumes to the architecture diagram and persistence strategy table.

### Removed
- Remove the Ollama local LLM inference engine from Docker Compose, the Dockerfile, entrypoint, docs, and tests.
- Remove the `lancedb-opencode-pro` OpenCode plugin from the entrypoint, tests, and docs.

## [0.11.10] - 2026-06-14

### Changed
- Upgrade OpenCode from 1.17.6 to 1.17.7.

## [0.11.9] - 2026-06-14

### Changed
- Update APT packages.

## [0.11.8] - 2026-06-14

### Changed
- Update APT packages.

## [0.11.7] - 2026-06-14

### Changed
- Upgrade OpenCode from 1.17.4 to 1.17.6.

## [0.11.6] - 2026-06-13

### Changed
- Update the tracked latest version for lean-ctx to v3.8.4.
- Update APT packages.

## [0.11.5] - 2026-06-13

### Changed
- Update the tracked latest version for lean-ctx to v3.8.3.
- Update APT packages.

## [0.11.4] - 2026-06-11

### Fixed
- Separate version management for Playwright core and `@playwright/mcp`.
  - Manage Playwright core (1.60.0) and `@playwright/mcp` (0.0.76) independently, fixing the previous incorrect assumption that they had to stay on the same version.

### Changed
- Adjust CI so the image is built once and shared between jobs via artifacts.

## [0.11.3] - 2026-06-11

### Changed
- Pin Playwright to version 1.60.0 and add runtime smoke tests.

## [0.11.2] - 2026-06-11

### Added
- Add the `vuln-scan` skill for vulnerability scanning and version auditing.

### Changed
- Upgrade Docker from 29.4.1 to 29.5.3, Compose from 5.1.2 to 5.1.4, and Buildx from 0.33.0 to 0.34.1.

## [0.11.1] - 2026-06-11

### Changed
- Upgrade OpenCode from 1.16.2 to 1.17.3.
- Upgrade OpenChamber from 1.12.3 to 1.12.4.

## [0.11.0] - 2026-06-06

### Added
- Add Playwright browsers to the Docker image so MCP server workflows and tests are supported.
  - Install Chromium (about 291 MB) and 97 system dependencies.
  - Support both Playwright MCP browser automation and the Playwright test runner.

## [0.10.0] - 2026-06-06

### Added
- Add the lean-ctx MCP server to provide context engineering capabilities.
  - Install lean-ctx v3.7.5 in the Dockerfile via the universal installer.
  - Add the lean-ctx MCP server config block to `entrypoint.d/02-init-config.sh`.
  - Provide 69 MCP tools such as `ctx_read`, `ctx_shell`, `ctx_search`, and `ctx_tree`.

### Changed
- Upgrade OpenCode from 1.16.0 to 1.16.2.
- Upgrade OpenChamber from 1.12.1 to 1.12.3.

## [0.9.3] - 2026-06-05

### Changed
- Upgrade OpenCode from 1.15.13 to 1.16.0.

## [0.9.2] - 2026-06-05

### Changed
- Upgrade `@openchamber/web` from 1.11.7 to 1.12.1.

## [0.9.1] - 2026-06-02

### Added
- Bake Playwright MCP into the image so AI agents can drive browsers natively.
  - Dockerfile: add Playwright MCP configuration to the `/etc/opencode/opencode.json.default` template.
  - `entrypoint.d/02-init-config.sh`: include Playwright MCP when regenerating `~/.config/opencode/opencode.json` so it is not overwritten.
  - `test/run-tests.sh`: add two assertions to verify that the Playwright MCP config exists and uses `bunx`.
  - Replace the old workflow of AI-written Playwright scripts executed through bash with native MCP tooling.
  - New developers no longer need to install `@playwright/mcp` manually.

### Changed
- Upgrade `@openchamber/web` from 1.10.4 to 1.11.7.
- Upgrade OpenCode from 1.14.48 to 1.15.13 ([release notes](https://github.com/anomalyco/opencode/releases/tag/v1.15.13)).
- Replace the graph knowledge tool graphify (`graphifyy`) with `@colbymchenry/codegraph`.
  - Dockerfile: `uv tool install graphifyy` → `bun install -g @colbymchenry/codegraph`.
  - Update `README.md` and the test scripts together.
- Add a Git Authentication section for first-time users.
- Correct the credential volume mount explanation in the docs.
- Add documentation for the versioned `glab` credential helper path issue (#4).

### Fixed
- Clarify how host and container credentials are isolated.

## [0.8.3] - 2026-05-13

### Fixed
- Remove the blocking OpenCode warm-up step and increase the CI job timeout.

## [0.8.2] - 2026-05-13

### Changed
- Upgrade OpenCode from 1.14.33 to 1.14.48.
- Upgrade OpenChamber from 1.9.10 to 1.10.4.

## [0.8.1] - 2026-05-06

### Fixed
- Make skills create symlinks directly from the baked image instead of copying them into cache.
- Remove tmpfs mounts that conflict with named volumes.
- Bake Superpowers into the image so it is not masked by volume mounts.
- Keep the plugin cache and increase the warm-up timeout.

## [0.8.0] - 2026-05-05

### Added
- Add the Superpowers plugin (agentic skills framework) to the default plugins.
  - Provide 14 skills such as `brainstorming`, `systematic-debugging`, and `test-driven-development`.
- Add Superpowers to the default `docker-compose.yml` configuration so it works without setting `.env`.
- Make `entrypoint.d/02-init-config.sh` automatically create the Superpowers skills symlink.
  - Fix OpenCode #20940: changes to `skills.paths` from the plugin `config()` hook were not visible to skill discovery.
  - Make all existing projects discover Superpowers skills automatically.

### Changed
- Change the default plugins in `.env.example` to `oh-my-openagent,superpowers@git+https://github.com/obra/superpowers.git`.
- Remove the legacy release tests because the plugin is no longer used.

## [0.7.1] - 2026-05-04

### Fixed
- Fix Superpowers plugin detection failures in CI integration tests by wrapping the `jq` command in an explicit shell.
- Fix the `OPENCODE_PLUGINS` environment variable configuration in `docker-compose.dev.yml`.
- Fix consistency issues in `entrypoint.d/02-init-config.sh`.

## [0.7.0] - 2026-05-04

### Added
- Install graphify (the knowledge graph tool) through `uv tool install graphifyy`.
- Add the Superpowers plugin (agentic skills framework).
- Add graphify and Superpowers verification tests to `run-tests.sh`.

### Changed
- Remove the legacy plugin that had caused release test failures.

## [0.6.2] - 2026-04-25

### Changed
- Upgrade OpenCode to 1.14.33.
- Upgrade OpenChamber to 1.9.10.

## [0.6.1] - 2026-04-24

### Fixed
- Fix group inheritance when `entrypoint.sh` re-executes `exec sudo -E -u devuser -- env PATH="$PATH" "$@"`.
- Fix the `permission denied` error when running `docker ps` inside the OpenChamber Web UI terminal.

## [0.6.0] - 2026-04-23

### Added
- Add Docker Buildx v0.32.1 installation to support multi-platform builds.
- Add `git credential.helper store` configuration during startup.

### Fixed
- Fix the git credential helper to use `sudo -u devuser HOME=...` so it does not write into `/root`.

## [0.5.16] - 2026-04-22

### Changed
- Upgrade OpenCode to 1.14.20.
- Upgrade OpenChamber to 1.9.7.

## [0.5.15] - 2026-04-17

### Changed
- Upgrade OpenCode to 1.4.7.

## [0.5.14] - 2026-04-15

### Changed
- Upgrade OpenChamber to 1.9.5.

## [0.5.13] - 2026-04-12

### Fixed
- Remove the `NAPI_RS_FORCE_WASI` environment variable to fix the LanceDB initialization issue (`lancedb/lancedb#3267`).
- Fix Docker Compose issues in the CI workflow.

## [0.5.12] - 2026-04-11

### Added
- Add README.md documentation for configuring the memory plugin.

### Fixed
- Remove the `sg docker` wrapper from `entrypoint.sh` to fix environment variable inheritance.
  - This issue caused tools such as `memory_stats` to report the embedding service as offline.
- Add stale plugin cache cleanup to `entrypoint.d/02-init-config.sh`.
- Hardcode plugins in `docker-compose.dev.yml` to avoid host shell environment contamination.
- Fix the plugin name in `.env.example` (`oh-my-opencode` → `oh-my-openagent`).
- Fix the `test/test-memory-e2e.sh` script.

## [0.5.11] - 2026-04-10

### Added
- Add the `glab-config` volume so `glab` (GitLab CLI) auth state persists.
- Add the `06-init-glab-cli.sh` initialization script to create `~/.config/glab-cli` automatically.
- Update `00-fix-perms.sh` to repair permissions for `glab-cli`, `gh`, `ssh`, and `git`.

## [0.5.10] - 2026-04-10

### Added
- Upgrade OpenCode to 1.4.3.

## [0.5.9] - 2026-04-10

### Security
- Upgrade Docker CLI from v25.0.4 to v29.4.0 (eliminating about 20 CVE alerts).
- Upgrade Docker Compose from v2.24.5 to v5.1.2 (eliminating about 68 CVE alerts, including 6 critical ones).
- Add `docs/backlog.md` to track security technical debt.
- Add a version tracking section to `docs/SECURITY.md`.

## [0.5.8] - 2026-04-10

### Added
- Upgrade OpenCode to 1.3.12.

### Fixed
- Switch Docker Compose to the plugin installation model instead of a standalone `docker-compose` binary.
- Update `test-memory-e2e.sh` to use the hook-based test approach.
- Update `release-memory-test.sh` to use the `docker compose` command.

## [0.5.6] - 2026-04-08

### Added
- Add the `05-init-gh-cli.sh` initialization script to create `~/.config/gh` automatically.
- Add the `gh-config-dev` volume to `docker-compose.dev.yml`.

### Changed
- Update `entrypoint.sh` to run `05-init-gh-cli.sh` through `sudo`.
- Update `docs/ARCHITECTURE.md` with `gh-config` volume documentation.
- Update `docs/TROUBLESHOOTING.md` with GitHub CLI permission troubleshooting.

## [0.5.5] - 2026-04-08

### Added
- Add the `gh-config` named volume so `gh` auth data persists.

## [0.5.4] - 2026-04-08

### Added
- Add the full Memory E2E test script (`test-memory-e2e.sh`).
- Add a retry mechanism for the Memory plugin (up to 3 tries).
- Add the version extraction step to the release skill.
- Add version badges to `README.md`.

### Changed
- Downgrade OpenCode to 1.3.7.
- Upgrade OpenChamber to 1.9.4.
- Fix Docker Compose command compatibility.
- Fix the container name in `release-memory-test.sh`.

### Fixed
- Fix Memory plugin initialization on OpenCode 1.3.7.
- Fix the logic so `release-memory-test.sh` stops when tests fail.

## [0.5.2] - 2026-04-07

### Fixed
- Fix the `sed` command in the CI workflow so it replaces the container name correctly.

## [0.5.1] - 2026-04-07

### Added
- Add a documentation update check step to the release skill.

### Changed
- Reorder the release steps so docs are checked before committing.

### Fixed
- Fix `OLLAMA_BASE_URL` being overridden by the host environment in the dev setup.

## [0.5.0] - 2026-04-07

### Added
- Add multi-model switching.
- Add a named volume as the default workspace.
- Add `glab` (GitLab CLI).

### Changed
- Use named volumes as the default persistence strategy.
- Update `install.sh` and `.env.example`.
- Improve the entrypoint script structure.

## [0.3.3] - 2026-04-02

### Added
- Initial release.
- Ubuntu 24.04-based Docker development environment.
- Integrate the OpenCode AI coding assistant (v1.3.13).
- Integrate the OpenChamber web UI (v1.9.3).
- Integrate a local LLM inference engine (later removed).
- Support the LanceDB vector search plugin.
- Include GitHub CLI.
- Provide a full developer toolchain (`git`, `python`, `tmux`, `jq`, and more).
- Establish automated CI/CD workflows.
- Add vulnerability scanning with Grype.
- Create an integration test suite (39 test cases).

### Changed
- Use a two-container design (`ai-dev` + LLM inference container, later removed).
- Use Docker named volumes for persistence.
- Support bind mount local development mode.
- Add health checks and automatic restarts.
- Support dynamic package installation.

## [0.3.0] - 2026-04-02

### Added
- Add the `docs/SECURITY.md` security policy.
- Add the `docs/TROUBLESHOOTING.md` troubleshooting guide.
- Add the `docs/ARCHITECTURE.md` architecture guide.
- Add the `docs/CONTRIBUTING.md` contributor guide.

### Changed
- Improve the `README.md` document structure.


---

## Format

### Types

- `Added` - new features
- `Changed` - changes to existing functionality
- `Deprecated` - soon-to-be removed features
- `Removed` - removed features
- `Fixed` - bug fixes
- `Security` - security-related changes

### Example

```markdown
## [1.1.0] - 2026-04-15

### Added
- Add GPU support.
- Add multi-model switching.

### Changed
- Upgrade Ollama to the latest version.

### Fixed
- Fix container restart issues.
- Fix permission errors.
```

---

> 📖 This changelog follows the [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) format.

[Unreleased]: https://github.com/tryweb/ai-engkit/compare/v1.1.11...HEAD
[0.3.0]: https://github.com/tryweb/ai-engkit/releases/tag/v0.3.0
[0.3.3]: https://github.com/tryweb/ai-engkit/compare/v0.3.0...v0.3.3
[0.5.0]: https://github.com/tryweb/ai-engkit/compare/v0.3.3...v0.5.0
[0.5.1]: https://github.com/tryweb/ai-engkit/compare/v0.5.0...v0.5.1
[0.5.2]: https://github.com/tryweb/ai-engkit/compare/v0.5.1...v0.5.2
[0.5.4]: https://github.com/tryweb/ai-engkit/compare/v0.5.2...v0.5.4
[0.5.5]: https://github.com/tryweb/ai-engkit/compare/v0.5.4...v0.5.5
[0.5.6]: https://github.com/tryweb/ai-engkit/compare/v0.5.5...v0.5.6
[0.5.8]: https://github.com/tryweb/ai-engkit/compare/v0.5.6...v0.5.8
[0.5.9]: https://github.com/tryweb/ai-engkit/compare/v0.5.8...v0.5.9
[0.5.10]: https://github.com/tryweb/ai-engkit/compare/v0.5.9...v0.5.10
[0.5.11]: https://github.com/tryweb/ai-engkit/compare/v0.5.10...v0.5.11
[0.5.12]: https://github.com/tryweb/ai-engkit/compare/v0.5.11...v0.5.12
[0.5.13]: https://github.com/tryweb/ai-engkit/compare/v0.5.12...v0.5.13
[0.5.14]: https://github.com/tryweb/ai-engkit/compare/v0.5.13...v0.5.14
[0.5.15]: https://github.com/tryweb/ai-engkit/compare/v0.5.14...v0.5.15
[0.5.16]: https://github.com/tryweb/ai-engkit/compare/v0.5.15...v0.5.16
[0.6.0]: https://github.com/tryweb/ai-engkit/compare/v0.5.16...v0.6.0
[0.6.1]: https://github.com/tryweb/ai-engkit/compare/v0.6.0...v0.6.1
[0.6.2]: https://github.com/tryweb/ai-engkit/compare/v0.6.1...v0.6.2
[0.7.0]: https://github.com/tryweb/ai-engkit/compare/v0.6.2...v0.7.0
[0.7.1]: https://github.com/tryweb/ai-engkit/compare/v0.7.0...v0.7.1
[0.8.0]: https://github.com/tryweb/ai-engkit/compare/v0.7.1...v0.8.0
[0.8.1]: https://github.com/tryweb/ai-engkit/compare/v0.8.0...v0.8.1
[0.8.2]: https://github.com/tryweb/ai-engkit/compare/v0.8.1...v0.8.2
[0.8.3]: https://github.com/tryweb/ai-engkit/compare/v0.8.2...v0.8.3
[0.9.1]: https://github.com/tryweb/ai-engkit/compare/v0.8.3...v0.9.1
[0.9.2]: https://github.com/tryweb/ai-engkit/compare/v0.9.1...v0.9.2
[0.9.3]: https://github.com/tryweb/ai-engkit/compare/v0.9.2...v0.9.3
[0.10.0]: https://github.com/tryweb/ai-engkit/compare/v0.9.3...v0.10.0
[0.11.0]: https://github.com/tryweb/ai-engkit/compare/v0.10.0...v0.11.0
[0.11.1]: https://github.com/tryweb/ai-engkit/compare/v0.11.0...v0.11.1
[0.11.2]: https://github.com/tryweb/ai-engkit/compare/v0.11.1...v0.11.2
[0.11.3]: https://github.com/tryweb/ai-engkit/compare/v0.11.2...v0.11.3
[0.11.4]: https://github.com/tryweb/ai-engkit/compare/v0.11.3...v0.11.4
[0.11.5]: https://github.com/tryweb/ai-engkit/compare/v0.11.4...v0.11.5
[0.11.6]: https://github.com/tryweb/ai-engkit/compare/v0.11.5...v0.11.6
[0.11.7]: https://github.com/tryweb/ai-engkit/compare/v0.11.6...v0.11.7
[0.11.8]: https://github.com/tryweb/ai-engkit/compare/v0.11.7...v0.11.8
[0.11.9]: https://github.com/tryweb/ai-engkit/compare/v0.11.8...v0.11.9
[0.11.10]: https://github.com/tryweb/ai-engkit/compare/v0.11.9...v0.11.10
[0.12.0]: https://github.com/tryweb/ai-engkit/compare/v0.11.10...v0.12.0
[0.12.1]: https://github.com/tryweb/ai-engkit/compare/v0.12.0...v0.12.1
[0.12.2]: https://github.com/tryweb/ai-engkit/compare/v0.12.1...v0.12.2
[0.12.3]: https://github.com/tryweb/ai-engkit/compare/v0.12.2...v0.12.3
[0.12.4]: https://github.com/tryweb/ai-engkit/compare/v0.12.3...v0.12.4
[0.12.5]: https://github.com/tryweb/ai-engkit/compare/v0.12.4...v0.12.5
[0.12.6]: https://github.com/tryweb/ai-engkit/compare/v0.12.5...v0.12.6
[0.13.0]: https://github.com/tryweb/ai-engkit/compare/v0.12.6...v0.13.0
[0.13.1]: https://github.com/tryweb/ai-engkit/compare/v0.13.0...v0.13.1
[0.14.0]: https://github.com/tryweb/ai-engkit/compare/v0.13.1...v0.14.0
[0.15.0]: https://github.com/tryweb/ai-engkit/compare/v0.14.0...v0.15.0
[0.15.1]: https://github.com/tryweb/ai-engkit/compare/v0.15.0...v0.15.1
[0.16.0]: https://github.com/tryweb/ai-engkit/compare/v0.15.1...v0.16.0
[0.16.1]: https://github.com/tryweb/ai-engkit/compare/v0.16.0...v0.16.1
[0.16.2]: https://github.com/tryweb/ai-engkit/compare/v0.16.1...v0.16.2
[0.16.3]: https://github.com/tryweb/ai-engkit/compare/v0.16.2...v0.16.3
[0.16.4]: https://github.com/tryweb/ai-engkit/compare/v0.16.3...v0.16.4
[0.16.5]: https://github.com/tryweb/ai-engkit/compare/v0.16.4...v0.16.5
[0.17.0]: https://github.com/tryweb/ai-engkit/compare/v0.16.5...v0.17.0
[0.17.1]: https://github.com/tryweb/ai-engkit/compare/v0.17.0...v0.17.1
[1.0.0]: https://github.com/tryweb/ai-engkit/compare/v0.17.1...v1.0.0
[1.0.1]: https://github.com/tryweb/ai-engkit/compare/v1.0.0...v1.0.1
[1.0.2]: https://github.com/tryweb/ai-engkit/compare/v1.0.1...v1.0.2
[1.1.0]: https://github.com/tryweb/ai-engkit/compare/v1.0.2...v1.1.0
[1.1.1]: https://github.com/tryweb/ai-engkit/compare/v1.1.0...v1.1.1
[1.1.2]: https://github.com/tryweb/ai-engkit/compare/v1.1.1...v1.1.2
[1.1.3]: https://github.com/tryweb/ai-engkit/compare/v1.1.2...v1.1.3
[1.1.4]: https://github.com/tryweb/ai-engkit/compare/v1.1.3...v1.1.4
[1.1.5]: https://github.com/tryweb/ai-engkit/compare/v1.1.4...v1.1.5
[1.1.6]: https://github.com/tryweb/ai-engkit/compare/v1.1.5...v1.1.6
[1.1.7]: https://github.com/tryweb/ai-engkit/compare/v1.1.6...v1.1.7
[1.1.8]: https://github.com/tryweb/ai-engkit/compare/v1.1.7...v1.1.8
[1.1.9]: https://github.com/tryweb/ai-engkit/compare/v1.1.8...v1.1.9
[1.1.10]: https://github.com/tryweb/ai-engkit/compare/v1.1.9...v1.1.10
[1.1.11]: https://github.com/tryweb/ai-engkit/compare/v1.1.10...v1.1.11
