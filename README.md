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
BROWSER_HEADLESS=true
HEARTBEAT_EVERY=30m
MAX_CONTEXT_TOKENS=24000
```

see `AGENTS.md` for the full list of environment variables.

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

## license

MIT
