FROM ubuntu:24.04

# ── 所有版本號集中管理 ────────────────────────────────
ARG UPGRADE_PACKAGES=true
ARG DOCKER_VERSION=29.5.3
ARG COMPOSE_VERSION=5.1.4
ARG BUILDX_VERSION=0.34.1
ARG OPENCODE_VERSION=1.17.3
ARG OPENCHAMBER_VERSION=1.12.4
ARG PLAYWRIGHT_VERSION=1.60.0
ARG OH_MY_OPENAGENT_VERSION=latest
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
    tree \
    less \
    nano \
    vim \
    python3 \
    python3-pip \
    python3-venv \
    openssh-client \
    rsync \
    tmux \
    htop \
    procps \
    lsof \
    # node-gyp / 原生模組編譯所需
    pkg-config \
    libssl-dev \
    libclang-dev \
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

RUN brew install gh glab

# ── Bun ────────────────────────────────────────────────
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH=/home/${USERNAME}/.bun/bin:${PATH}

# ── CodeGraph 知識圖譜工具 ────────────────────────────
RUN bun install -g @colbymchenry/codegraph

# ── LeanCTX — AI 代理的認知上下文層 ──────────────────
RUN curl -fsSL https://leanctx.com/install.sh | sh

# ── Global npm 套件（opencode / openchamber / openspec）
# 清除 bun 緩存，確保插件正確安裝（避免版本跳轉時的緩存損壞問題）
RUN rm -rf ~/.bun/install/cache && \
    bun install -g opencode-ai@${OPENCODE_VERSION} && \
    bun install -g @openchamber/web@${OPENCHAMBER_VERSION} --trust && \
    bun install -g @fission-ai/openspec --trust && \
    bun install -g @code-yeongyu/comment-checker --trust && \
    ln -sf /home/${USERNAME}/.bun/bin/bun /home/${USERNAME}/.bun/bin/node

# ── Playwright browsers (for MCP server & testing) ──────────
# Pin Playwright version to match @playwright/mcp compatibility.
# install --with-deps handles both system deps + browser download in one step.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_VERSION=${PLAYWRIGHT_VERSION}
RUN sudo mkdir -p /ms-playwright && sudo chmod 777 /ms-playwright && \
    bunx -y playwright@${PLAYWRIGHT_VERSION} install --with-deps chromium

USER root

# 設定範本存到非 VOLUME 路徑（供 runtime entrypoint 初始化使用）。
# 完整 MCP 設定由 entrypoint.d/02-init-config.sh 在每次啟動時重新生成。
RUN <<'EOF'
mkdir -p /etc/opencode
jq -n \
  --arg agent_plugin "oh-my-openagent@${OH_MY_OPENAGENT_VERSION}" \
  --arg superpowers_plugin "superpowers@git+https://github.com/obra/superpowers.git" \
  '{
    autoupdate: false,
    plugin: [$agent_plugin, $superpowers_plugin],
    mcp: {
      playwright: {
        type: "local",
        command: ["bunx", "-y", "@playwright/mcp@1.60.0"],
        enabled: true
      }
    }
  }' > /etc/opencode/opencode.json.default
EOF

# 複製設定檔（插件預下載改於 runtime entrypoint 執行，避免 build 超時）
RUN mkdir -p /home/${USERNAME}/.config/opencode && \
    cp /etc/opencode/opencode.json.default /home/${USERNAME}/.config/opencode/opencode.json && \
    chown -R ${USERNAME}:${USERNAME} /home/${USERNAME}/.config/opencode

# 預裝 superpowers 到 image 中，供 entrypoint 直接 symlink（避免 VOLUME 覆蓋 plugin cache）
RUN mkdir -p /opt/opencode/baked-plugins && \
    cd /tmp && \
    git clone --depth 1 https://github.com/obra/superpowers.git superpowers-bake && \
    cp -r superpowers-bake /opt/opencode/baked-plugins/superpowers && \
    rm -rf /tmp/superpowers-bake && \
    chown -R ${USERNAME}:${USERNAME} /opt/opencode

# 目錄預建（確保 volume mount 前所有人都正確）
RUN mkdir -p \
    /home/${USERNAME}/workspace \
    /home/${USERNAME}/.local/share/opencode \
    /home/${USERNAME}/.local/bin \
    /home/${USERNAME}/.local/state \
    /home/${USERNAME}/.ssh && \
    chmod 700 /home/${USERNAME}/.ssh && \
    chown -R ${USERNAME}:${USERNAME} /home/${USERNAME}/.local

# ── entrypoint 腳本注入（需 root 寫入）──────────────────
USER root
COPY --chown=${USERNAME}:${USERNAME} entrypoint.d/ /entrypoint.d/
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh /entrypoint.d/*.sh

USER ${USERNAME}

# CodeGraph MCP server 整合（自動配置 opencode）
RUN cd /home/${USERNAME} && codegraph install --target=opencode --yes

ENV HOME=/home/${USERNAME}
ENV PATH=/home/${USERNAME}/.local/bin:/home/${USERNAME}/.bun/bin:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

WORKDIR /home/${USERNAME}/workspace

VOLUME [ \
    "/home/${USERNAME}/workspace", \
    "/home/${USERNAME}/.local/share/opencode", \
    "/home/${USERNAME}/.config/opencode", \
    "/home/${USERNAME}/.cache/opencode", \
    "/home/${USERNAME}/.cache/oh-my-opencode", \
    "/home/${USERNAME}/.config/openchamber", \
    "/home/${USERNAME}/.ssh", \
    "/home/${USERNAME}/.config/git", \
    "/home/${USERNAME}/.ollama" \
]

EXPOSE 3000 4095

# tini 用絕對路徑，避免 PATH 未初始化時找不到
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]

# openchamber serve（daemon 模式）後接 logs follow
# 若要前景執行改為：openchamber serve --foreground
CMD ["/bin/bash", "-c", "openchamber serve && openchamber logs"]
