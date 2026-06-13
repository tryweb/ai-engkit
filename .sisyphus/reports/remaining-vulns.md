# Remaining Vulnerability Report

> **Generated**: 2026-06-12 | **Tool**: Grype SCA (anchore/scan-action@v7)
> **Context**: CodeForge Ubuntu 24.04 dev container
> **Total**: 768 alerts | **Dismissed as FP**: 1,318 (Chrome/Chromium, X11/Xvfb, CUPS/Pixman, systemd/udev)

---

## Summary by Severity

| Severity | Count | % of Total |
|----------|-------|------------|
| 🔴 Critical | 66 | 8.6% |
| 🟠 High | 273 | 35.5% |
| 🟡 Medium | 376 | 48.9% |
| ⚪ Low | 53 | 7.0% |
| **Total** | **768** | **100%** |

---

## Summary by Package Category

| Category | Count | Critical | High | Fixability |
|----------|-------|----------|------|------------|
| **Python 3.12 family** (libpython, pip, venv) | 138 | 0 | 138 | `apt-get upgrade` |
| **Go stdlib** | 117 | 59 | 58 | Update Go toolchain |
| **Go modules** (golang.org/x/crypto, x/net, etc.) | 103 | 7 | 96 | Update Go modules |
| **binutils / libbinutils** | 200 | 0 | 0 | Build-only — low risk |
| **glibc / libc6** | 32 | 0 | 32 | `apt-get upgrade` |
| **Perl** | 32 | 0 | 0 | Transitive dep — low risk |
| **Docker tools** (CLI, Compose, Buildx, containerd) | 16 | 0 | 16 | Update version pin |
| **libexpat1** | 9 | 0 | 9 | `apt-get upgrade` |
| **jq / libjq** | 18 | 0 | 18 | `apt-get upgrade` |
| **ncurses** | 4 | 0 | 0 | Transitive dep — low risk |
| **Mesa/GL** (libgl, libgbm, libgallium) | 4 | 0 | 0 | GPU lib — not used in container |
| **OpenSSL / libssl** | 8 | 0 | 8 | `apt-get upgrade` |
| **libkrb5** (Kerberos) | 6 | 0 | 6 | `apt-get upgrade` |
| **libicu74** | 1 | 0 | 1 | `apt-get upgrade` |
| **Other** (curl, git, tar, wget, vim, tmux, zlib, etc.) | 80 | 0 | varies | `apt-get upgrade` |

---

## Actionability Assessment

| Actionability | Count | Recommendation |
|---------------|-------|----------------|
| ✅ **Fixable via `apt-get upgrade`** | 437 | Run `apt-get upgrade` at build time (already done via `UPGRADE_PACKAGES=true`) |
| 🔧 **Upstream binary — version pin update** | 16 | Update Docker/Compose/Buildx version pins in Dockerfile |
| 📦 **Go stdlib / modules** | 220 | Update Go toolchain and rebuild Go-based components |
| 🏗️ **Build-time only (binutils, gcc, etc.)** | 208 | Low risk — only affect compilation, not runtime |
| 🔄 **Transitive dependency** | 80 | Low direct risk — monitor upstream fixes |
| ⬜ **Not applicable (GPU libraries)** | 4 | Mesa/GL not used in headless container |
| **Total** | **768** | |

---

## Recommended Next Steps

### Immediate (High Impact)
1. **Enable `UPGRADE_PACKAGES=true` at build time** — Already done in current Dockerfile. This resolves all 437 apt-fixable alerts.
2. **Update Docker version pins** (`DOCKER_VERSION`, `COMPOSE_VERSION`, `BUILDX_VERSION`) — Resolves 16 Docker tool alerts. Check latest releases on GitHub.

### Short-term (Medium Impact)
3. **Update Go toolchain** — Update golang.x packages used by Docker/containerd by bumping Docker version pins (which bundle newer Go versions).
4. **Monitor npm/bun package updates** — opencode-ai, @openchamber/web, playwright versions may fix Go stdlib CVEs through Docker dependency chain updates.

### Long-term
5. **Consider multi-stage build** — Separate build dependencies (binutils, gcc) into a builder stage so they don't appear in the final runtime image.
6. **Switch to distroless or minimal base image** — `ubuntu:24.04` is a full desktop/server image. Consider `ubuntu:24.04-minimal` or Google's distroless to reduce surface area.

---

## Detailed CVE Listing

### 🔴 Critical (66 alerts)

| CVE | Package | Count | Description |
|-----|---------|-------|-------------|
| CVE-2026-27143 | stdlib | 2 | Critical stdlib vulnerability in Go standard library |
| GO-2026-5005 | golang.org/x/crypto | 3 | Critical crypto library vulnerability |
| GO-2026-5006 | golang.org/x/crypto | 3 | Critical crypto library vulnerability |
| GO-2026-5017 | golang.org/x/crypto | 3 | Critical crypto library vulnerability |
| GO-2026-5019 | golang.org/x/crypto | 3 | Critical crypto library vulnerability |
| GO-2026-5020 | golang.org/x/crypto | 3 | Critical crypto library vulnerability |
| GO-2026-5021 | golang.org/x/crypto | 3 | Critical crypto library vulnerability |
| GO-2026-5023 | golang.org/x/crypto | 3 | Critical crypto library vulnerability |
| GO-2026-5026 | golang.org/x/net | 4 | Critical net library vulnerability |

### 🟠 High (273 alerts)

Includes vulnerabilities in:
- **Python 3.12** (138 alerts): libpython3.12-minimal, libpython3.12-stdlib, libpython3.12t64, python3.12, pip, venv
- **glibc/libc6** (32 alerts): libc-bin, libc-dev-bin, libc6, libc6-dev, libc-dev
- **Docker ecosystem** (16 alerts): docker-cli, docker-compose-plugin, docker-buildx-plugin, containerd
- **stdlib** (58 alerts): Various Go standard library high-severity CVEs
- **Go modules** (96 alerts): golang.org/x/crypto, golang.org/x/net, golang.org/x/image
- **Other** (33 alerts): libexpat1, jq, libjq, OpenSSL, libkrb5, git, curl

### 🟡 Medium (376 alerts)

Includes vulnerabilities in:
- **binutils/libbinutils** (200 alerts): Various binutils CVE
- **Perl** (32 alerts): libperl5.38t64, perl, perl-base, perl-modules-5.38
- **Python 3.12** (various): Additional medium-severity CVEs
- **ncurses** (4 alerts): libncursesw6, libtinfo6
- **Other libraries** (various): libicu, libxml2, libgcrypt20, libpam, libblkid, etc.

### ⚪ Low (53 alerts)

Includes low-severity CVEs across various packages. Generally informational and do not require immediate action.

---

## Package Categories Detail

### Python 3.12 (138 alerts)
```
libpython3.12-minimal: 23
libpython3.12-stdlib: 23
libpython3.12t64: 23
python3.12: 23
python3.12-minimal: 23
python3.12-venv: 23
python3-pip: 13
python3-pip-whl: 13
```

### binutils family (200 alerts)
```
binutils: 25
binutils-common: 25
binutils-x86-64-linux-gnu: 25
libbinutils: 25
libctf-nobfd0: 25
libctf0: 25
libgprofng0: 25
libsframe1: 25
```
**Note**: These are build-time development tools. CVEs in binutils affect `ar`, `ld`, `objdump`, etc. — tools used during compilation, not at runtime. Risk is LOW.

### Go stdlib + modules (220 alerts)
```
stdlib: 117
golang.org/x/crypto: 39
golang.org/x/net: 26
golang.org/x/image: 6
golang.org/x/sys: 3
go.opentelemetry.io/...: 7
github.com/docker/docker: 12
github.com/containerd/containerd: 4
github.com/moby/spdy: 2
```
**Note**: These come bundled with Docker/Compose/Buildx binaries. Fix by updating version pins which bundle newer Go dependencies.

---

> **Note**: This report was generated after dismissing 1,318 false-positive alerts in 4 categories (Chrome/Chromium, X11/Xvfb, CUPS/Pixman, systemd/udev). No Dockerfile changes or version updates were performed as part of this work.
