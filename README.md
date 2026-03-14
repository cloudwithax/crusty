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
- deterministic conversation threading with active-thread reuse
- long-term memory (sqlite or postgres + pgvector)
- context management with automatic summarization
- modular personality system via markdown files
- skills system for reusable instruction packages
- heartbeat scheduler with timezone-aware active hours
- reminder system with natural language time parsing
- openai-compatible api support
- secure pairing system
- first-boot ACP discovery for local agents and services exposed over HTTP

## quickstart

### docker (recommended)

docker is the preferred way to run crusty. it provides a sandboxed environment with all dependencies pre-installed, including chromium for web browsing and bash tools enabled by default.

tool operations now use an explicit default workspace:

- local runs default to the directory you started crusty from
- docker prefers `/workspace` when that mount exists and has content, otherwise it falls back to `/app`
- `CRUSTY_WORKSPACE` overrides the default in either mode

You can run crusty in one command with the built image:

```bash
# pull and run the image
docker run -d \
  --name crusty \
  -e OPENAI_API_KEY=your-api-key \
  -e TELEGRAM_BOT_TOKEN=your-telegram-bot-token \
  -e CRUSTY_WORKSPACE=/workspace \
  -v crusty-data:/app/data \
  -v $(pwd):/workspace \
  ghcr.io/cloudwithax/crusty:latest
```

or build it locally:

```bash
docker build -t crusty .
docker run -d \
  --name crusty \
  -e OPENAI_API_KEY=your-api-key \
  -e TELEGRAM_BOT_TOKEN=your-telegram-bot-token \
  -e CRUSTY_WORKSPACE=/workspace \
  -v crusty-data:/app/data \
  -v $(pwd):/workspace \
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
      - CRUSTY_WORKSPACE=/workspace
      - OPENAI_MODEL=gpt-4o
      - HEARTBEAT_EVERY=30m
    volumes:
      - crusty-data:/app/data
      - ./:/workspace
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
CRUSTY_WORKSPACE=/absolute/path/to/your/project
HEARTBEAT_EVERY=30m
CONVERSATION_THREAD_ACTIVE_WINDOW_MINUTES=30
MAX_CONTEXT_TOKENS=24000
ACP_DISCOVERY_ENABLED=true
ACP_DISCOVERY_TIMEOUT_MS=750
ACP_DISCOVERY_PATHS=/acp,/api/acp,/rpc/acp,/agent/acp
ACP_DISCOVERY_HOSTS=127.0.0.1,localhost
ACP_DISCOVERY_PORTS=3000,8000,8080
ACP_STDIO_AGENTS_JSON=[{"name":"goose","command":"goose","args":["acp","serve"]}]
ACP_STDIO_AGENTS_FILE=/absolute/path/to/acp-stdio-agents.json
ACP_BUN_STDIO_PROXY=true
ACP_STDIO_NODE_PATH=node

# optional but required for encrypted credential storage tools
CRUSTY_CREDENTIALS_MASTER_KEY=your-long-random-master-key
```

see .env.example for all options.

## ACP discovery

on first boot, crusty performs an aggressive scan of listening local tcp ports and probes common ACP HTTP endpoints such as `/acp`.

it can also launch known local ACP binaries over stdio when you provide a registry through `ACP_STDIO_AGENTS_JSON` or `ACP_STDIO_AGENTS_FILE`.

when crusty runs on Bun, stdio ACP agents are proxied through a tiny Node wrapper by default because direct Bun stdio interop is not reliable for every ACP server. set `ACP_BUN_STDIO_PROXY=false` to force direct Bun subprocess mode, or set `ACP_STDIO_NODE_PATH` if `node` is not on your `PATH`.

when it finds a compatible ACP agent, it persists the endpoint metadata and automatically registers a dedicated runtime tool like `acp_goose_desktop` so the main agent can delegate work to it.

subsequent boots restore the cached ACP-backed tools immediately from the database. if no cached endpoints exist, crusty re-runs discovery.

the agent also gets two ACP management tools:

- `list_acp_agents` to inspect active ACP integrations
- `rediscover_acp_agents` to refresh HTTP and/or stdio ACP discovery without restarting crusty

## telegram commands

- `/start` - show help
- `/clear` - clear memory and reset conversation
- `/context` - show context stats
- replies continue the exact thread they reference, while top-level messages reuse the latest active thread until the active window expires
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
