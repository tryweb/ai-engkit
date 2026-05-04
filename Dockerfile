FROM ubuntu:24.04

# ── 所有版本號集中管理 ────────────────────────────────
ARG UPGRADE_PACKAGES=true
ARG DOCKER_VERSION=29.4.1
ARG COMPOSE_VERSION=5.1.2
ARG BUILDX_VERSION=0.33.0
ARG OPENCODE_VERSION=1.14.33
ARG OPENCHAMBER_VERSION=1.9.10
ARG OH_MY_OPENAGENT_VERSION=latest
ARG LANCEDB_OPENCODE_PRO_VERSION=latest
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

# ── Global npm 套件（opencode / openchamber / openspec）
# 清除 bun 緩存，確保插件正確安裝（避免版本跳轉時的緩存損壞問題）
RUN rm -rf ~/.bun/install/cache && \
    bun install -g opencode-ai@${OPENCODE_VERSION} && \
    bun install -g @openchamber/web@${OPENCHAMBER_VERSION} --trust && \
    bun install -g @fission-ai/openspec --trust && \
    bun install -g @code-yeongyu/comment-checker --trust && \
    ln -sf /home/${USERNAME}/.bun/bin/bun /home/${USERNAME}/.bun/bin/node

USER root

# 設定範本存到非 VOLUME 路徑（供 runtime entrypoint 初始化使用）
RUN mkdir -p /etc/opencode && \
    echo "{\"autoupdate\":false,\"plugin\":[\"oh-my-openagent@${OH_MY_OPENAGENT_VERSION}\",\"lancedb-opencode-pro@${LANCEDB_OPENCODE_PRO_VERSION}\"]}" > /etc/opencode/opencode.json.default

# 複製設定檔並觸發插件預下載
RUN mkdir -p /home/${USERNAME}/.config/opencode && \
    cp /etc/opencode/opencode.json.default /home/${USERNAME}/.config/opencode/opencode.json
RUN timeout 30 opencode >/dev/null 2>&1 || true

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
