# Contributing to ai-engkit

English | [繁體中文](./docs/CONTRIBUTING_zh-TW.md)

Thanks for your interest in contributing to ai-engkit.

ai-engkit is a self-hosted AI engineering environment built around OpenCode, OpenChamber, browser automation, code navigation, and a reproducible Docker-based workflow.

We welcome:

- bug reports
- documentation improvements
- small fixes
- test improvements
- feature proposals
- security hardening ideas
- developer experience improvements

---

## First-time contributors

If this is your first contribution, a good place to start is:

- documentation fixes
- troubleshooting clarifications
- example or config cleanup
- small test improvements
- non-breaking workflow polish

Look for issues labeled:

- `good first issue`
- `documentation`
- `help wanted`

If you are unsure whether a change is small enough to implement directly, please open an issue first.

---

## Before you start

Please open an issue before starting work if your change:

- adds a new feature
- changes runtime behavior
- changes default configuration
- changes bundled tools or versions
- changes security-sensitive behavior
- changes container architecture or startup flow
- is a large refactor

You can usually open a pull request directly for:

- typo fixes
- documentation improvements
- small non-breaking test fixes
- minor config or example corrections
- link fixes
- formatting cleanup that does not change behavior

---

## Development setup

### Requirements

- Git
- Docker
- Docker Compose

### Clone and prepare

```bash
git clone https://github.com/YOUR_USERNAME/ai-engkit.git
cd ai-engkit
git remote add upstream https://github.com/tryweb/ai-engkit.git
git checkout -b feature/your-change

cp .env.example .env
```

### Start the development environment

```bash
docker compose -f docker-compose.dev.yml build --no-cache
docker compose -f docker-compose.dev.yml up -d
```

### Verify the environment

```bash
docker compose -f docker-compose.dev.yml ps
./test/run-tests.sh
```

---

## Contribution workflow

1. Fork the repository
2. Create a focused branch
3. Make your change
4. Run the relevant tests
5. Update documentation if needed
6. Open a pull request

Please keep changes focused. Small pull requests are much easier to review and merge.

---

## Pull request expectations

A good pull request should clearly explain:

- what changed
- why it changed
- how it was tested
- whether there is any operational impact
- whether there are any breaking changes

Please keep pull requests:

- small and focused
- limited to one purpose
- aligned with the existing project structure
- documented if user-facing behavior changes
- tested locally when applicable

If your pull request changes behavior, setup flow, tooling, or defaults, please update the relevant docs such as:

- `README.md`
- `docs/ARCHITECTURE.md`
- `docs/TOOLING.md`
- `docs/TROUBLESHOOTING.md`
- `docs/GIT_AUTHENTICATION.md`

---

## Branch naming

Suggested branch naming:

- `fix/...`
- `feat/...`
- `docs/...`
- `refactor/...`
- `test/...`
- `ci/...`

Examples:

- `fix/upgrade-env-merge`
- `docs/clarify-workspace-mount`
- `test/add-gh-auth-check`

---

## Commit message guidance

Please use clear, descriptive commit messages.

Conventional prefixes are preferred:

- `feat:`
- `fix:`
- `docs:`
- `refactor:`
- `test:`
- `build:`
- `ci:`
- `chore:`

Examples:

- `fix: preserve custom env values during upgrade`
- `docs: clarify bind mount workspace setup`
- `test: add validation for gh auth volume`

---

## Testing

Run the relevant checks before opening a pull request.

### Standard test run

```bash
./test/run-tests.sh
```

### Full build and test cycle

```bash
./test/test-full.sh
```

### Notes

- If your change affects setup, container startup, dependency installation, auth flow, or bundled tooling, prefer running the full test flow.
- If you cannot run the full test flow, explain what you tested in the pull request.

---

## Style guidelines

### Shell scripts

- use `#!/usr/bin/env bash`
- use `set -euo pipefail`
- prefer `snake_case` for functions
- quote variables
- prefer `[[ ... ]]` over `[ ... ]`
- fail loudly instead of silently ignoring errors

### Docker and Compose

- keep configuration explicit and readable
- document any new environment variables
- avoid changing defaults without discussion
- prefer backward-compatible changes when possible

### Documentation

- keep docs practical and copy-paste friendly
- update docs when behavior changes
- prefer concise examples over abstract explanation

---

## Security issues

Please do **not** open a public GitHub issue for security vulnerabilities.

Report security issues according to [SECURITY.md](./SECURITY.md).

---

## Maintainer expectations

Please expect review feedback on:

- scope
- naming
- test coverage
- documentation
- operational impact

Large or design-heavy changes may be redirected to an issue for discussion before merge.

Review timing may vary depending on change complexity and maintainer availability.

---

## Questions and support

If you are unsure how to approach a change, open an issue first and describe:

- the problem
- your proposed solution
- any tradeoffs or open questions

This usually leads to faster and cleaner contributions.

---

## License

By contributing, you agree that your contributions will be licensed under the project's [MIT License](./LICENSE).
