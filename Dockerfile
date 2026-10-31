FROM ubuntu:24.04

# ── 所有版本號集中管理 ────────────────────────────────
ARG UPGRADE_PACKAGES=true
ARG DOCKER_VERSION=29.9.2
ARG COMPOSE_VERSION=5.6.1
ARG BUILDX_VERSION=0.38.1
ARG OPENCODE_VERSION=1.19.5
ARG OPENCHAMBER_VERSION=1.24.2
ARG GLAB_VERSION=1.126.0
ARG PLAYWRIGHT_VERSION=1.64.1
ARG PLAYWRIGHT_MCP_VERSION=0.0.83
ARG BUN_VERSION=1.4.2
ARG GH_VERSION=2.103.3
ARG MARKSMAN_VERSION=2026-02-08
ARG LEANCTX_VERSION=3.12.0
ARG OH_MY_OPENAGENT_VERSION=5.1.51
ARG OPENSPEC_VERSION=1.16.0
ARG CODEGRAPH_VERSION=1.6.2
ARG AI_ENGKIT_VERSION=dev
ARG USERNAME=devuser
ARG USER_UID=1000
# DOCKER_GID 僅作為 build-arg 接收，實際群組賦值由 entrypoint.d/docker-gid.sh 在 runtime 處理
ARG DOCKER_GID

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Asia/Taipei

# ── 系統套件 + 條件升級（合併同一 layer）──────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    sudo \
    curl \
    wget \
    git \
    ca-certificates \
    tini \
    build-essential \
    file \
    bash \
    unzip \
    zip \
    jq \
    ripgrep \
    tree \
    less \
    nano \
    vim \
    python3 \
    python3-pip \
    python3-venv \
    python3-yaml \
    openssh-client \
    rsync \
    sqlite3 \
    tmux \
    htop \
    procps \
    lsof \
    # node-gyp / 原生模組編譯所需
    pkg-config \
    libssl-dev \
    && if [ "$UPGRADE_PACKAGES" = "true" ]; then \
        apt-get upgrade -y --no-install-recommends && \
        apt-get autoremove -y; \
    fi \
    && rm -rf /var/lib/apt/lists/*

# ── Docker CLI + Docker Compose Plugin（DooD 模式）──────
RUN curl -fsSL "https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_VERSION}.tgz" \
    | tar xz -C /tmp && \
    mv /tmp/docker/docker /usr/local/bin/ && \
    rm -rf /tmp/docker

RUN mkdir -p /usr/local/bin && \
    ARCH="$(dpkg --print-architecture)" && \
    case "$ARCH" in \
        amd64) GLAB_ARCH="amd64" ;; \
        arm64) GLAB_ARCH="arm64" ;; \
        *) echo "Unsupported glab architecture: $ARCH" >&2; exit 1 ;; \
    esac && \
    GLAB_TARBALL="glab_${GLAB_VERSION}_linux_${GLAB_ARCH}.tar.gz" && \
    curl -fsSL "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/${GLAB_TARBALL}" -o "/tmp/${GLAB_TARBALL}" && \
    curl -fsSL "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/checksums.txt" -o /tmp/checksums.txt && \
    grep -F "  ${GLAB_TARBALL}" /tmp/checksums.txt | head -n 1 | (cd /tmp && sha256sum -c -) && \
    tar -xzf "/tmp/${GLAB_TARBALL}" -C /tmp && \
    install -m 0755 /tmp/bin/glab /usr/local/bin/glab && \
    rm -rf /tmp/bin "/tmp/${GLAB_TARBALL}" /tmp/checksums.txt

# 安裝 Docker Compose V2 Plugin（從 GitHub 下載，安裝到 Docker CLI plugins 目錄）
# 之後可使用 `docker compose` 命令（plugin 模式，而非獨立的 docker-compose）
RUN mkdir -p /usr/local/lib/docker/cli-plugins && \
    curl -fsSL "https://github.com/docker/compose/releases/download/v${COMPOSE_VERSION}/docker-compose-linux-x86_64" \
    -o /usr/local/lib/docker/cli-plugins/docker-compose && \
    chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

RUN mkdir -p /usr/local/lib/docker/cli-plugins && \
    curl -fsSL "https://github.com/docker/buildx/releases/download/v${BUILDX_VERSION}/buildx-v${BUILDX_VERSION}.linux-amd64" \
    -o /usr/local/lib/docker/cli-plugins/docker-buildx && \
    chmod +x /usr/local/lib/docker/cli-plugins/docker-buildx

# ── 使用者建立 ─────────────────────────────────────────
# - shell 改為 /bin/bash（開發環境必要）
# - sudoers 用獨立檔案，visudo -c 語法驗證後才套用
RUN userdel -r ubuntu 2>/dev/null || true && \
    useradd -m -s /bin/bash -u ${USER_UID} -G sudo ${USERNAME} && \
    echo "${USERNAME} ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/${USERNAME} && \
    visudo -cf /etc/sudoers.d/${USERNAME} && \
    chmod 0440 /etc/sudoers.d/${USERNAME} && \
    mkdir -p /home/linuxbrew/.linuxbrew && \
    chown -R ${USERNAME}:${USERNAME} /home/linuxbrew

USER ${USERNAME}

# ── Homebrew ───────────────────────────────────────────
RUN curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh | bash

ENV HOMEBREW_PREFIX=/home/linuxbrew/.linuxbrew
ENV HOMEBREW_CELLAR=/home/linuxbrew/.linuxbrew/Cellar
ENV HOMEBREW_REPOSITORY=/home/linuxbrew/.linuxbrew/Homebrew
ENV PATH=/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}

# gh (GitHub CLI) — 從 GitHub Release 下載靜態二進位，避免 Homebrew 拉入 Go toolchain
RUN curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
    | sudo tar xz -C /usr/local --strip-components=1

# marksman (LSP) — 從 GitHub Release 下載獨立二進位，避免 Homebrew 拉入 .NET runtime
RUN curl -fsSL "https://github.com/artempyanykh/marksman/releases/download/${MARKSMAN_VERSION}/marksman-linux-x64" \
    -o /tmp/marksman && \
    sudo install -m 0755 /tmp/marksman /usr/local/bin/marksman && \
    rm /tmp/marksman

# ── Bun ────────────────────────────────────────────────
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"
ENV PATH=/home/${USERNAME}/.bun/bin:${PATH}

# ── CodeGraph 知識圖譜工具 ────────────────────────────
RUN bun install -g @colbymchenry/codegraph@${CODEGRAPH_VERSION} && \
    rm -rf ~/.bun/install/cache

# ── LeanCTX — AI 代理的認知上下文層 ──────────────────
RUN curl -fsSL "https://github.com/yvgude/lean-ctx/releases/download/v${LEANCTX_VERSION}/lean-ctx-x86_64-unknown-linux-musl.tar.gz" -o /tmp/lean-ctx.tar.gz && \
    sudo tar -xzf /tmp/lean-ctx.tar.gz -C /usr/local/bin lean-ctx && \
    sudo chmod +x /usr/local/bin/lean-ctx && \
    rm -f /tmp/lean-ctx.tar.gz

RUN sudo install -d -m 0755 /etc/lean-ctx
COPY --chmod=0644 docker/lean-ctx/config.default.toml /etc/lean-ctx/config.default.toml

ENV BASH_ENV="/home/${USERNAME}/.config/lean-ctx/env.sh"
ENV CLAUDE_ENV_FILE="/home/${USERNAME}/.config/lean-ctx/env.sh"
ENV LEANCTX_VERSION=${LEANCTX_VERSION}

# ── Global npm 套件（openspec / comment-checker）──────────────────────────
# 清除 bun 緩存，確保插件正確安裝（避免版本跳轉時的緩存損壞問題）
# opencode-ai and @openchamber/web are the image-managed core; they install into
# the isolated prefix below, not the user ~/.bun prefix. @openchamber/web@1.24.1
# fixed the unpublishable @openchamber/sdk pin (openchamber#3633) and declares
# the zod runtime dependency (openchamber#3635), so a direct registry install is
# safe again.
RUN rm -rf ~/.bun/install/cache && \
    bun install -g @fission-ai/openspec@${OPENSPEC_VERSION} --trust && \
    bun install -g @code-yeongyu/comment-checker --trust && \
    ln -sf /home/${USERNAME}/.bun/bin/bun /home/${USERNAME}/.bun/bin/node && \
    rm -rf ~/.bun/install/cache

# ── AI-EngKit managed core (isolated prefix + offline recovery baseline) ─────
# The pinned OpenChamber + OpenCode core installs into a dedicated image-owned
# Bun prefix (BUN_INSTALL), fully isolated from the user ~/.bun global prefix, so
# user `BUN_PACKAGES` installs cannot overwrite the core and vice versa. The
# installed tree is captured as a deterministic offline archive plus an integrity
# manifest and build metadata; startup recovery restores that exact tree with no
# network access. Root ownership is re-applied below and the paths are
# deliberately absent from entrypoint.d/00-fix-perms.sh so it survives startup
# permission fixing.
ENV AI_ENGKIT_CORE_ROOT=/opt/ai-engkit/core
ENV AI_ENGKIT_CORE_BASELINE=/opt/ai-engkit/core-baseline

COPY --chmod=0755 scripts/patch-openchamber-update-guard.py /opt/ai-engkit/scripts/patch-openchamber-update-guard.py
COPY --chmod=0755 scripts/ai-engkit-core.py /opt/ai-engkit/scripts/ai-engkit-core.py
COPY --chmod=0755 scripts/ai_engkit_core_lib.py /opt/ai-engkit/scripts/ai_engkit_core_lib.py
COPY --chmod=0755 scripts/ai-engkit-core-wrapper.sh /opt/ai-engkit/scripts/ai-engkit-core-wrapper.sh
COPY --chmod=0755 scripts/ai-engkit-db-compat.py /opt/ai-engkit/scripts/ai-engkit-db-compat.py
COPY --chmod=0644 scripts/ai_engkit_db_compat_model.py /opt/ai-engkit/scripts/ai_engkit_db_compat_model.py
COPY --chmod=0644 scripts/ai_engkit_db_compat_schema.py /opt/ai-engkit/scripts/ai_engkit_db_compat_schema.py
COPY --chmod=0644 scripts/ai_engkit_db_compat_gate.py /opt/ai-engkit/scripts/ai_engkit_db_compat_gate.py
COPY --chmod=0444 scripts/db-compat-baseline.json /opt/ai-engkit/core-baseline/opencode-v1-db.json

RUN sudo mkdir -p /opt/ai-engkit/core/generations /opt/ai-engkit/core-baseline && \
    sudo chown -R ${USERNAME}:${USERNAME} /opt/ai-engkit/core /opt/ai-engkit/core-baseline && \
    sudo chmod 0755 /opt/ai-engkit/core-baseline

# Full transitive/platform/symlinked closure into the isolated prefix. The
# opencode-ai postinstall hard-links the platform binary into
# opencode-ai/bin/opencode.exe, so the unused cross-platform optional source
# packages (opencode-linux-x64-*) can be dropped without losing the executable.
RUN rm -rf ~/.bun/install/cache && \
    BUN_INSTALL=/opt/ai-engkit/core/generations/.build \
      bun install -g opencode-ai@${OPENCODE_VERSION} @openchamber/web@${OPENCHAMBER_VERSION} --trust && \
    rm -rf /opt/ai-engkit/core/generations/.build/install/global/node_modules/opencode-linux-x64-* && \
    rm -rf /opt/ai-engkit/core/generations/.build/install/cache && \
    rm -rf ~/.bun/install/cache

# Version- and anchor-checked update guards applied to the managed core package
# (not the user prefix); a pin or upstream source-shape change fails the build
# instead of silently shipping reduced guard coverage.
RUN OPENCHAMBER_PACKAGE_DIR=/opt/ai-engkit/core/generations/.build/install/global/node_modules/@openchamber/web \
    OPENCHAMBER_EXPECTED_VERSION=${OPENCHAMBER_VERSION} \
    python3 /opt/ai-engkit/scripts/patch-openchamber-update-guard.py

RUN test "$(/opt/ai-engkit/core/generations/.build/bin/opencode --version)" = "${OPENCODE_VERSION}"

# OpenChamber ships PNG/SVG favicons but browsers also request /favicon.ico.
# Wrap the existing PNG in an ICO container so the request is served locally
# without maintaining a separate binary asset in the repository.
RUN python3 - <<'PY'
from pathlib import Path
import struct

dist = Path("/opt/ai-engkit/core/generations/.build/install/global/node_modules/@openchamber/web/dist")
png_path = dist / "favicon.png"
ico_path = dist / "favicon.ico"

if png_path.is_file() and not ico_path.exists():
    png = png_path.read_bytes()
    if png[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit("OpenChamber favicon.png is not a PNG")
    width, height = struct.unpack(">II", png[16:24])
    entry_width = 0 if width >= 256 else width
    entry_height = 0 if height >= 256 else height
    header = struct.pack("<HHH", 0, 1, 1)
    entry = struct.pack(
        "<BBBBHHII",
        entry_width,
        entry_height,
        0,
        0,
        1,
        32,
        len(png),
        22,
    )
    ico_path.write_bytes(header + entry + png)
PY

# Build the pristine offline baseline (deterministic archive + integrity
# manifest + build metadata from the pinned ARGs) and point `active` at the
# exact installed generation. Runtime recovery reads metadata.json; it never
# parses the repository or fetches packages.
RUN set -eux; \
    GENID="$(python3 /opt/ai-engkit/scripts/ai-engkit-core.py build-baseline \
      --root /opt/ai-engkit/core/generations/.build \
      --out-dir /opt/ai-engkit/core-baseline \
      --opencode-version "${OPENCODE_VERSION}" \
      --openchamber-version "${OPENCHAMBER_VERSION}" \
      --bun-version "${BUN_VERSION}" \
      --ai-engkit-version "${AI_ENGKIT_VERSION}")"; \
    mv /opt/ai-engkit/core/generations/.build "/opt/ai-engkit/core/generations/${GENID}"; \
    ln -sfn "generations/${GENID}" /opt/ai-engkit/core/active

# Re-capture the pinned v1 schema/migration identity from the actual isolated
# binary in a disposable XDG/HOME tree. The committed manifest is only accepted
# when it exactly matches this fresh database fixture.
RUN set -eu; \
    FIXTURE_ROOT="$(mktemp -d /tmp/ai-engkit-v119-db.XXXXXX)"; \
    trap 'rm -rf "$FIXTURE_ROOT"' EXIT; \
    mkdir -p "$FIXTURE_ROOT/config" "$FIXTURE_ROOT/cache" "$FIXTURE_ROOT/data"; \
    HOME="$FIXTURE_ROOT" \
      XDG_CONFIG_HOME="$FIXTURE_ROOT/config" \
      XDG_CACHE_HOME="$FIXTURE_ROOT/cache" \
      XDG_DATA_HOME="$FIXTURE_ROOT/data" \
      /opt/ai-engkit/core/active/bin/opencode db "SELECT 1" --format json >/dev/null; \
    python3 /opt/ai-engkit/scripts/ai-engkit-db-compat.py capture-baseline \
      --db "$FIXTURE_ROOT/data/opencode/opencode.db" \
      --out "$FIXTURE_ROOT/captured-baseline.json" \
      --opencode-version "${OPENCODE_VERSION}" \
      --openchamber-version "${OPENCHAMBER_VERSION}" >/dev/null; \
    cmp "$FIXTURE_ROOT/captured-baseline.json" \
      /opt/ai-engkit/core-baseline/opencode-v1-db.json

# Stable PATH wrappers (they pass BUN_INSTALL=active for their process only)
# plus ~/.bun compatibility symlinks for absolute-path consumers: the admin
# version probes read ~/.bun/bin/openchamber, and OpenChamber's own resolver
# falls back to ~/.bun/bin/opencode.
RUN sudo install -d -m 0755 /opt/ai-engkit/core/bin && \
    sudo install -m 0755 /opt/ai-engkit/scripts/ai-engkit-core-wrapper.sh /opt/ai-engkit/core/bin/opencode && \
    sudo install -m 0755 /opt/ai-engkit/scripts/ai-engkit-core-wrapper.sh /opt/ai-engkit/core/bin/openchamber && \
    ln -sf /opt/ai-engkit/core/bin/opencode /home/${USERNAME}/.bun/bin/opencode && \
    ln -sf /opt/ai-engkit/core/bin/openchamber /home/${USERNAME}/.bun/bin/openchamber

# ── Playwright browsers + MCP server (for browser automation & testing) ─────
# Playwright browsers and @playwright/mcp are versioned independently upstream.
# Pin both explicitly for reproducible builds.
# install --with-deps handles both system deps + browser download in one step.
# Full Chromium is required so @playwright/mcp can launch it via --executable-path
# (the MCP server does not auto-resolve to /ms-playwright without an explicit path).
# The headless shell is also installed so tests and MCP can use the smallest viable binary.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_VERSION=${PLAYWRIGHT_VERSION}
ENV PLAYWRIGHT_MCP_VERSION=${PLAYWRIGHT_MCP_VERSION}
ENV OH_MY_OPENAGENT_VERSION=${OH_MY_OPENAGENT_VERSION}
RUN sudo mkdir -p /ms-playwright && sudo chmod 777 /ms-playwright && \
    bunx -y playwright@${PLAYWRIGHT_VERSION} install --with-deps chromium && \
    rm -rf ~/.bun/install/cache

RUN bun install -g playwright@${PLAYWRIGHT_VERSION} @playwright/mcp@${PLAYWRIGHT_MCP_VERSION} && \
    rm -rf ~/.bun/install/cache

# pw-mcp: 動態解析 Playwright bundled Chromium 路徑並啟動 @playwright/mcp。
# 用 wrapper 是因為 bundled browser 的 revision 目錄（chromium-<rev>）會隨 Playwright 版本變動，
# 寫死路徑會在升版時失效。@playwright/mcp 預設 --browser 走的是 system Chrome channel，
# 因此必須用 --executable-path 明確指向 /ms-playwright 下的 bundled Chromium。
COPY --chmod=0755 scripts/pw-mcp.sh /tmp/pw-mcp.sh
RUN sudo install -m 0755 /tmp/pw-mcp.sh /usr/local/bin/pw-mcp && \
    sudo rm /tmp/pw-mcp.sh

USER root

# The core and its recovery baseline are image-owned: root-owned, with a
# read-only baseline. entrypoint.d/00-fix-perms.sh intentionally does not list
# these paths, so root ownership survives startup permission fixing.
RUN chown -R root:root /opt/ai-engkit/core /opt/ai-engkit/core-baseline && \
    chmod 0755 /opt/ai-engkit/core /opt/ai-engkit/core/generations /opt/ai-engkit/core/bin && \
    chmod 0755 /opt/ai-engkit/core-baseline && \
    chmod 0444 /opt/ai-engkit/core-baseline/core.tar.gz \
               /opt/ai-engkit/core-baseline/manifest.json \
               /opt/ai-engkit/core-baseline/metadata.json

# 設定範本存到非 VOLUME 路徑（供 runtime entrypoint 初始化使用）。
# 完整 MCP 設定由 entrypoint.d/02-init-config.sh 在每次啟動時重新生成。
RUN <<'EOF'
mkdir -p /etc/opencode
jq -n \
  --arg agent_plugin "oh-my-openagent@${OH_MY_OPENAGENT_VERSION}" \
  --arg playwright_mcp_version "${PLAYWRIGHT_MCP_VERSION}" \
  '{
    autoupdate: false,
    plugin: [$agent_plugin],
    lsp: {
      marksman: {
        command: ["marksman", "server"],
        extensions: [".md", ".markdown"]
      }
    },
    mcp: {
      playwright: {
        type: "local",
        command: ["pw-mcp"],
        enabled: true
      }
    }
  }' > /etc/opencode/opencode.json.default

jq -n \
  '{
    marksman: {
      command: ["marksman", "server"],
      extensions: [".md", ".markdown"]
    }
  }' > /etc/opencode/lsp.json.default
EOF

# AGENTS.md default snippet — consumed by entrypoint.d/02-init-config.sh
# at container startup (appends to user's ~/.config/opencode/AGENTS.md).
COPY .opencode/AGENTS.md.default /etc/opencode/AGENTS.md.default

# omo.jsonc default — consumed by entrypoint.d/02-init-config.sh
# at container startup (merges into user's ~/.omo/omo.jsonc).
COPY .opencode/omo.jsonc.default /etc/opencode/omo.jsonc.default

# 複製設定檔（插件預下載改於 runtime entrypoint 執行，避免 build 超時）
RUN mkdir -p /home/${USERNAME}/.config/opencode && \
    cp /etc/opencode/opencode.json.default /home/${USERNAME}/.config/opencode/opencode.json && \
    chown -R ${USERNAME}:${USERNAME} /home/${USERNAME}/.config/opencode

# 預裝 superpowers 到 image 中，供 entrypoint 直接 symlink（避免 VOLUME 覆蓋 plugin cache）
RUN mkdir -p /opt/ai-engkit && echo "$AI_ENGKIT_VERSION" > /opt/ai-engkit/VERSION && \
    mkdir -p /opt/opencode/baked-plugins && \
    cd /tmp && \
    git clone --depth 1 https://github.com/obra/superpowers.git superpowers-bake && \
    cp -r superpowers-bake /opt/opencode/baked-plugins/superpowers && \
    rm -rf /tmp/superpowers-bake && \
    chown -R ${USERNAME}:${USERNAME} /opt/opencode

# OpenChamber registration reconcile — shipped at a fixed path so both upgrade
# paths (host upgrade.sh, admin runUpgrade) can exec it inside ai-dev.
COPY --chmod=0755 scripts/reconcile-openchamber-projects.sh /opt/ai-engkit/scripts/reconcile-openchamber-projects.sh
COPY --chmod=0755 scripts/reconcile-agent-models.sh /opt/ai-engkit/scripts/reconcile-agent-models.sh
COPY --chmod=0755 scripts/agent-model-health.sh /opt/ai-engkit/scripts/agent-model-health.sh

# 預裝 baked skills 到 image（供 entrypoint 在 runtime 時 symlink 到 SKILLS_ROOT）
COPY .opencode/baked-skills /opt/opencode/baked-skills
RUN chown -R ${USERNAME}:${USERNAME} /opt/opencode/baked-skills

# ── ai-admin dashboard ─────────────────────────────────
COPY src/admin/ /opt/admin/
RUN bun install --cwd /opt/admin --no-cache 2>/dev/null || true

# ── Admin test fixtures (compose-overlay integration suite) ──
# compose-overlay.integration.test.ts shells out to real `docker compose`
# using repo-relative paths resolved from /opt/admin/lib: the fixtures land
# at /test/fixtures/compose-overlay/ and the production compose at /
# (repo root for that test). Ship both so the suite runs from the image in
# every CI step (docker run / docker exec) without a host checkout or daemon.
COPY test/fixtures/compose-overlay/ /test/fixtures/compose-overlay/
COPY docker-compose.yml /docker-compose.yml

# 目錄預建（確保 volume mount 前所有人都正確）
RUN mkdir -p \
    /home/${USERNAME}/workspace \
    /home/${USERNAME}/.local/share/opencode \
    /home/${USERNAME}/.local/share/lean-ctx \
    /home/${USERNAME}/.local/bin \
    /home/${USERNAME}/.local/state \
    /home/${USERNAME}/.local/state/lean-ctx \
    /home/${USERNAME}/.cache/lean-ctx \
    /home/${USERNAME}/.ssh && \
    chmod 700 /home/${USERNAME}/.ssh && \
    chown -R ${USERNAME}:${USERNAME} /home/${USERNAME}/.local

# git-credential-glab — git 經由 glab 的 config.yml 認證（取代明文 ~/.git-credentials）。
# 寫入 image 層（~/.local/bin 非 VOLUME 路徑），container recreate 後依然存在，
# 只有 git config 的 per-host helper 設定需要由 glab auth login 流程套用。
COPY --chmod=0755 scripts/git-credential-glab /home/${USERNAME}/.local/bin/git-credential-glab

# ── entrypoint 腳本注入（需 root 寫入）──────────────────
USER root
COPY --chown=${USERNAME}:${USERNAME} entrypoint.d/ /entrypoint.d/
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh /entrypoint.d/*.sh

USER ${USERNAME}

ENV HOME=/home/${USERNAME}
ENV PATH=/opt/ai-engkit/core/bin:/home/${USERNAME}/.local/bin:/home/${USERNAME}/.bun/bin:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

WORKDIR /home/${USERNAME}/workspace

VOLUME [ \
    "/home/${USERNAME}/workspace", \
    "/home/${USERNAME}/.local/share/opencode", \
    "/home/${USERNAME}/.local/share/lean-ctx", \
    "/home/${USERNAME}/.local/state/lean-ctx", \
    "/home/${USERNAME}/.config/opencode", \
    "/home/${USERNAME}/.cache/opencode", \
    "/home/${USERNAME}/.cache/oh-my-opencode", \
    "/home/${USERNAME}/.config/openchamber", \
    "/home/${USERNAME}/.ssh", \
    "/home/${USERNAME}/.config/git" \
]

EXPOSE 3000 4095

# tini 用絕對路徑，避免 PATH 未初始化時找不到
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]

CMD ["/bin/bash", "-c", "openchamber serve && /opt/ai-engkit/scripts/reconcile-agent-models.sh && exec openchamber logs"]
