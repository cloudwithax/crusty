# Crusty

```
  ░░
░░░░              ░░░░░░
░░░░  ░░            ░░░░░░
░░░░  ░░        ░░    ░░▒▒
░░░░░░▒▒          ░░▒▒░░▒▒
  ░░▒▒                ░░▒▒
    ░░▒▒  ░░░░░░░░  ░░▒▒
      ░░░░░░░░░░░░░░░░
    ░░░░░░░░██░░██░░░░░░
    ▒▒░░░░░░░░░░░░░░░░▒▒
  ░░░░▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒░░░░
  ░░░░  ▒▒░░    ░░▒▒  ░░░░
  ░░    ▒▒        ▒▒    ░░

```

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue.svg)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-1.3.0-f9f1e1.svg)](https://bun.sh/)
[![CI](https://github.com/cloudwithax/crusty/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/cloudwithax/crusty/actions/workflows/docker-publish.yml)

a telegram ai agent with web browsing, long-term memory, and a modular personality system.

## features

- web browsing with stealth mode
- multi-turn agentic conversations with tool execution
- long-term memory (sqlite or postgres + pgvector)
- context management with automatic summarization
- modular personality system via markdown files
- skills system for reusable instruction packages
- heartbeat scheduler with timezone-aware active hours
- reminder system with natural language time parsing
- openai-compatible api support
- secure pairing system

## quickstart

### docker (recommended)

docker is the preferred way to run crusty. it provides a sandboxed environment with all dependencies pre-installed, including chromium for web browsing and bash tools enabled by default.

You can run crusty in one command with the built image:

```bash
# pull and run the image
docker run -d \
  --name crusty \
  -e OPENAI_API_KEY=your-api-key \
  -e TELEGRAM_BOT_TOKEN=your-telegram-bot-token \
  -v crusty-data:/app/data \
  ghcr.io/cloudwithax/crusty:latest
```

or build it locally:

```bash
docker build -t crusty .
docker run -d \
  --name crusty \
  -e OPENAI_API_KEY=your-api-key \
  -e TELEGRAM_BOT_TOKEN=your-telegram-bot-token \
  -v crusty-data:/app/data \
  crusty
```

## docker compose

create a `docker-compose.yml`:

```yaml
services:
  crusty:
    image: ghcr.io/cloudwithax/crusty:latest
    container_name: crusty
    restart: unless-stopped
    environment:
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
      - OPENAI_MODEL=gpt-4o
      - HEARTBEAT_EVERY=30m
    volumes:
      - crusty-data:/app/data
      - ./cogs:/app/cogs:ro # mount custom personality files

volumes:
  crusty-data:
```

then run:

```bash
docker compose up -d
```

### pairing

on first boot, the bot generates a 6-character pairing code and prints it to the logs. copy this code and send it to your bot on telegram to complete pairing.

```bash
# view logs to get the pairing code
docker logs crusty
```

look for a line like: `pairing code: ABC123`

### adding an external cogs directory

mount your cogs folder as a volume:

```bash
docker run -d \
  --name crusty \
  -e OPENAI_API_KEY=your-api-key \
  -e TELEGRAM_BOT_TOKEN=your-telegram-bot-token \
  -v crusty-data:/app/data \
  -v ./my-cogs:/app/cogs:ro \
  ghcr.io/cloudwithax/crusty:latest
```

### viewing logs

```bash
docker logs -f crusty
```

## local installation

```bash
bun install
bun link        # optional, links cli globally
crusty setup    # configure api keys, telegram token, etc
crusty start    # start the bot
```

## daemon mode

```bash
crusty start -d   # start as systemd user service
crusty stop       # stop the daemon
crusty status     # check daemon status
```

## environment variables

create a `.env` file:

```bash
# required
OPENAI_API_KEY=your-api-key
TELEGRAM_BOT_TOKEN=your-telegram-bot-token

# optional
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o
HEARTBEAT_EVERY=30m
MAX_CONTEXT_TOKENS=24000
```

see .env.example for all options.

## telegram commands

- `/start` - show help
- `/clear` - clear memory and reset conversation
- `/context` - show context stats
- `/memory` - show memory stats
- `/reminders` - list pending reminders
- `/skill` - manage skills

## customization

edit the markdown files in `cogs/` to customize personality and behavior:

- `SOUL.md` - core personality and behavior
- `IDENTITY.md` - communication style
- `HEARTBEAT.md` - scheduled task instructions

create skills in `cogs/skills/<name>/SKILL.md` or `~/.config/crusty/skills/<name>/SKILL.md`.

all skills used MUST follow the [agent skill format](https://agentskills.io/).

## license

MIT
