# syntax=docker/dockerfile:1

FROM oven/bun:1 AS base
WORKDIR /app

# install chromium dependencies for puppeteer
RUN apt-get update && apt-get install -y \
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
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# puppeteer configuration
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# install dependencies
FROM base AS install
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# production image
FROM base AS release
COPY --from=install /app/node_modules ./node_modules
COPY . .

# create data directory for sqlite and ensure bun user can write to it
RUN mkdir -p /app/data && chown -R bun:bun /app/data

# ============================================================
# build arguments - pass at build time with --build-arg
# ============================================================

# required credentials (no defaults, must be provided at runtime)
ARG OPENAI_API_KEY
ARG TELEGRAM_BOT_TOKEN

# openai configuration
ARG OPENAI_BASE_URL
ARG OPENAI_MODEL=gpt-4o

# inference settings
ARG INFERENCE_RPM_LIMIT=40

# browser settings
ARG BROWSER_HEADLESS=true
ARG BROWSER_VIEWPORT=1280x800

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

# openai configuration
ENV OPENAI_BASE_URL=${OPENAI_BASE_URL}
ENV OPENAI_MODEL=${OPENAI_MODEL}

# inference settings
ENV INFERENCE_RPM_LIMIT=${INFERENCE_RPM_LIMIT}

# browser settings
ENV BROWSER_HEADLESS=${BROWSER_HEADLESS}
ENV BROWSER_VIEWPORT=${BROWSER_VIEWPORT}

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

# run as non-root user for security
USER bun

ENTRYPOINT ["bun", "run", "index.ts"]
