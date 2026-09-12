FROM ubuntu:24.04

# ── 所有版本號集中管理 ────────────────────────────────
ARG UPGRADE_PACKAGES=true
ARG DOCKER_VERSION=29.8.0
ARG COMPOSE_VERSION=5.5.1
ARG BUILDX_VERSION=0.37.1
ARG OPENCODE_VERSION=1.18.30
ARG OPENCHAMBER_VERSION=1.23.1
ARG GLAB_VERSION=1.117.0
ARG PLAYWRIGHT_VERSION=1.63.0
ARG PLAYWRIGHT_MCP_VERSION=0.0.80
ARG BUN_VERSION=1.3.14
ARG GH_VERSION=2.100.0
ARG MARKSMAN_VERSION=2026-02-08
ARG LEANCTX_VERSION=3.10.1
ARG OH_MY_OPENAGENT_VERSION=4.19.4
ARG OPENSPEC_VERSION=1.13.0
ARG CODEGRAPH_VERSION=1.6.0
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

# ── Global npm 套件（opencode / openchamber / openspec）
# 清除 bun 緩存，確保插件正確安裝（避免版本跳轉時的緩存損壞問題）
RUN rm -rf ~/.bun/install/cache && \
    bun install -g opencode-ai@${OPENCODE_VERSION} && \
    bun install -g @openchamber/web@${OPENCHAMBER_VERSION} --trust && \
    bun install -g @fission-ai/openspec@${OPENSPEC_VERSION} --trust && \
    bun install -g @code-yeongyu/comment-checker --trust && \
    # Remove cross-platform opencode binaries shipped as optional dependencies.
    # The container runs linux/amd64 with glibc; baseline/musl stubs are never used.
    rm -rf ~/.bun/install/global/node_modules/opencode-linux-x64-* && \
    ln -sf /home/${USERNAME}/.bun/bin/bun /home/${USERNAME}/.bun/bin/node && \
    rm -rf ~/.bun/install/cache

# OpenChamber ships PNG/SVG favicons but browsers also request /favicon.ico.
# Wrap the existing PNG in an ICO container so the request is served locally
# without maintaining a separate binary asset in the repository.
RUN python3 - <<'PY'
from pathlib import Path
import struct

dist = Path.home() / ".bun/install/global/node_modules/@openchamber/web/dist"
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
ENV PATH=/home/${USERNAME}/.local/bin:/home/${USERNAME}/.bun/bin:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

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
