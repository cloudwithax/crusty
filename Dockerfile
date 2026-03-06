# syntax=docker/dockerfile:1

FROM debian:bookworm-slim AS base
WORKDIR /app

# install system dependencies + chromium for agent-browser automation
RUN apt-get update && apt-get install -y \
    curl \
    unzip \
    git \
    wget \
    jq \
    vim \
    nano \
    htop \
    tree \
    net-tools \
    dnsutils \
    iputils-ping \
    ca-certificates \
    chromium \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    python3 \
    python3-pip \
    python3-venv \
    openssh-client \
    build-essential \
    procps \
    file \
    sudo \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# install node.js lts (includes npm and npx) via nodesource
RUN curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - \
    && apt-get install -y nodejs --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# install homebrew via linuxbrew user (homebrew refuses to run as root)
RUN useradd -m -s /bin/bash linuxbrew \
    && echo 'linuxbrew ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers
RUN NONINTERACTIVE=1 su linuxbrew -c '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'

# add homebrew to path for all users
ENV PATH="/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}"

# wrapper script so root (and the bot) can invoke brew as the linuxbrew user
RUN printf '#!/bin/bash\nexec su linuxbrew -s /bin/bash -c '"'"'/home/linuxbrew/.linuxbrew/bin/brew "$@"'"'"' -- "$@"\n' > /usr/local/bin/brew \
    && chmod +x /usr/local/bin/brew

# install bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# install agent-browser for browser automation
RUN npm install -g agent-browser

# docker detection for bash tools
ENV CRUSTY_DOCKER=true

# install dependencies (include dev deps for build step)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# copy source
COPY . .

# build typescript to javascript
RUN bun run build

# create data directory for sqlite
RUN mkdir -p /app/data

# ============================================================
# build arguments - pass at build time with --build-arg
# ============================================================

# required credentials (no defaults, must be provided at runtime)
ARG OPENAI_API_KEY
ARG TELEGRAM_BOT_TOKEN

# database configuration (optional, uses sqlite if not provided)
ARG DATABASE_URL

# openai configuration
ARG OPENAI_BASE_URL
ARG OPENAI_MODEL=gpt-4o

# inference settings
ARG INFERENCE_RPM_LIMIT=40

# bootstrap configuration
ARG AGENTS_BOOTSTRAP_MAX_CHARS=20000

# soul-evil hook settings
ARG AGENTS_SOUL_EVIL_ENABLED=false
ARG AGENTS_SOUL_EVIL_CHANCE=0.1
ARG AGENTS_SOUL_EVIL_WINDOW_START=22:00
ARG AGENTS_SOUL_EVIL_WINDOW_END=06:00
ARG AGENTS_SOUL_EVIL_TIMEZONE=America/New_York

# heartbeat scheduler settings
ARG HEARTBEAT_EVERY=30m
ARG HEARTBEAT_MAX_ACK_CHARS=500
ARG HEARTBEAT_TIMEZONE=America/New_York
ARG HEARTBEAT_DAYS
ARG HEARTBEAT_START
ARG HEARTBEAT_END

# ============================================================
# environment variables - populated from build args
# ============================================================

# required credentials
ENV OPENAI_API_KEY=${OPENAI_API_KEY}
ENV TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}

# database configuration
ENV DATABASE_URL=${DATABASE_URL}

# openai configuration
ENV OPENAI_BASE_URL=${OPENAI_BASE_URL}
ENV OPENAI_MODEL=${OPENAI_MODEL}

# inference settings
ENV INFERENCE_RPM_LIMIT=${INFERENCE_RPM_LIMIT}

# bootstrap configuration
ENV AGENTS_BOOTSTRAP_MAX_CHARS=${AGENTS_BOOTSTRAP_MAX_CHARS}

# soul-evil hook settings
ENV AGENTS_SOUL_EVIL_ENABLED=${AGENTS_SOUL_EVIL_ENABLED}
ENV AGENTS_SOUL_EVIL_CHANCE=${AGENTS_SOUL_EVIL_CHANCE}
ENV AGENTS_SOUL_EVIL_WINDOW_START=${AGENTS_SOUL_EVIL_WINDOW_START}
ENV AGENTS_SOUL_EVIL_WINDOW_END=${AGENTS_SOUL_EVIL_WINDOW_END}
ENV AGENTS_SOUL_EVIL_TIMEZONE=${AGENTS_SOUL_EVIL_TIMEZONE}

# heartbeat scheduler settings
ENV HEARTBEAT_EVERY=${HEARTBEAT_EVERY}
ENV HEARTBEAT_MAX_ACK_CHARS=${HEARTBEAT_MAX_ACK_CHARS}
ENV HEARTBEAT_TIMEZONE=${HEARTBEAT_TIMEZONE}
ENV HEARTBEAT_DAYS=${HEARTBEAT_DAYS}
ENV HEARTBEAT_START=${HEARTBEAT_START}
ENV HEARTBEAT_END=${HEARTBEAT_END}

# entrypoint runs the bot (agent-browser daemon starts on first use)
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]