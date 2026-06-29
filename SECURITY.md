# Security Policy

English | [繁體中文](./docs/SECURITY_zh-TW.md)

This document describes the security model, risk profile, and vulnerability reporting process for ai-engkit.

## Supported use model

ai-engkit is designed for **trusted development environments**.

It is not intended to be exposed directly to untrusted networks without additional hardening.

## Security model

### Isolation boundaries

- Host credentials are **not** mounted into the container by default.
- SSH keys, Git credentials, and GitHub CLI state use dedicated Docker volumes inside the container.
- The primary cross-boundary capability is the Docker socket when enabled.

This means:

- a compromised container should not automatically gain access to host SSH or Git credentials
- container-local credentials remain isolated from host-side credential stores
- Docker socket access remains a high-trust capability and should only be enabled in environments you control

### High-risk areas

The highest-risk areas in this project are:

- Docker socket access
- credentials stored inside container volumes
- default passwords left unchanged
- third-party dependency and image supply chain risk

## Recommended security practices

### 1. Change default passwords

Set strong values for:

- `OPENCODE_SERVER_PASSWORD`
- `OPENCHAMBER_UI_PASSWORD`

Recommendations:

- at least 12 characters
- mixed upper/lowercase
- numbers and symbols
- avoid common or reused passwords

### 2. Limit network exposure

Prefer binding services to localhost when possible.

Example:

```yaml
services:
  ai-ui:
    ports:
      - "127.0.0.1:${CHAMBER_PORT:-8000}:3000"
```

### 3. Treat Docker socket access as privileged

If your use case does not require Docker access inside the container, disable it.

If it is required, treat the environment as privileged and trusted.

### 4. Use dedicated container credentials

- use separate SSH keys for container workflows when possible
- avoid reusing sensitive personal credentials unnecessarily
- rotate credentials periodically

### 5. Keep images and dependencies current

- CI includes vulnerability scanning
- dependency updates are automated
- use the latest safe release whenever possible

## Vulnerability reporting

### Private reporting

Please **do not** report security vulnerabilities through public GitHub issues.

Report vulnerabilities privately by email:

- Email: `tryweb@ichiayi.com`
- Subject: `[SECURITY] ai-engkit vulnerability report`

### Please include

- a clear description of the issue
- reproduction steps
- impact assessment
- affected versions or deployment conditions
- possible mitigation ideas, if available

## Security maintenance

Security-related updates are supported by CI/CD automation, including:

- dependency update checks
- build verification
- vulnerability scanning
- release gating for risky changes

The repository workflow `.github/workflows/dependency-update.yml` performs regular update and scan checks.

## Scope and limitations

ai-engkit reduces some credential exposure by isolating Git, SSH, and CLI state into dedicated container volumes, but it does **not** eliminate all risk.

In particular:

- Docker socket access remains powerful
- container compromise can still expose container-local secrets
- exposed web interfaces still require safe deployment practices

## Related documents

- [README.md](./README.md)
- [docs/GIT_AUTHENTICATION.md](./docs/GIT_AUTHENTICATION.md)
- [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md)
- [docs/SECURITY_zh-TW.md](./docs/SECURITY_zh-TW.md)
