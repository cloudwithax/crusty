# syntax=docker/dockerfile:1

FROM alpine:3.21 AS base
WORKDIR /app

# install system dependencies + chromium for puppeteer
RUN apk add --no-cache \
    bash \
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
    bind-tools \
    iputils \
    ca-certificates \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ttf-freefont \
    font-noto-emoji

# install bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# puppeteer configuration
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

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

ENTRYPOINT ["bun", "run", "dist/index.js"]
