FROM ubuntu:24.04

# ── 所有版本號集中管理 ────────────────────────────────
ARG UPGRADE_PACKAGES=false
ARG DOCKER_VERSION=25.0.4
ARG COMPOSE_VERSION=2.24.5
ARG OPENCODE_VERSION=1.3.7
ARG OPENCHAMBER_VERSION=1.9.4
ARG USERNAME=devuser
ARG USER_UID=1000
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
    && if [ "$UPGRADE_PACKAGES" = "true" ]; then \
        apt-get upgrade -y --no-install-recommends && \
        apt-get autoremove -y; \
    fi \
    && rm -rf /var/lib/apt/lists/*

# ── Docker CLI + Compose（DooD 模式）─────────────────
RUN curl -fsSL "https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_VERSION}.tgz" \
    | tar xz -C /tmp && \
    mv /tmp/docker/docker /usr/local/bin/ && \
    rm -rf /tmp/docker

RUN curl -fsSL "https://github.com/docker/compose/releases/download/v${COMPOSE_VERSION}/docker-compose-linux-x86_64" \
    -o /usr/local/bin/docker-compose && \
    chmod +x /usr/local/bin/docker-compose

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
    bun install -g @openchamber/web@${OPENCHAMBER_VERSION} && \
    bun install -g @fission-ai/openspec && \
    # bun 作為 node shim：讓呼叫 `node` 的腳本也能運作
    # 注意：若有工具嚴格檢查 node 版本字串可能有問題
    ln -sf /home/${USERNAME}/.bun/bin/bun /home/${USERNAME}/.bun/bin/node

# ── opencode 設定檔（取代無效的 OPENCODE_CONFIG env var）
RUN mkdir -p /home/${USERNAME}/.config/opencode && \
    echo '{"autoupdate":false}' > /home/${USERNAME}/.config/opencode/config.json

# ── 目錄預建（確保 volume mount 前所有人都正確）────────
RUN mkdir -p \
    /home/${USERNAME}/workspace \
    /home/${USERNAME}/.local/share/opencode \
    /home/${USERNAME}/.local/bin \
    /home/${USERNAME}/.ssh && \
    chmod 700 /home/${USERNAME}/.ssh

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
    "/root/.ollama" \
]

EXPOSE 3000 4095

# tini 用絕對路徑，避免 PATH 未初始化時找不到
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]

# openchamber serve（daemon 模式）後接 logs follow
# 若要前景執行改為：openchamber serve --foreground
CMD ["/bin/bash", "-c", "openchamber serve && openchamber logs"]
