# Crusty

```
    _____
   /     \
  |  o o  |
   \_____/
  /|     |\
 / |     | \
(  |_____|  )
 \_/     \_/
```

a telegram ai agent with web browsing capabilities, long-term memory, and a modular personality system. crusty scuttles across the web, digging up information and helping with research tasks.

## features

- web browsing via puppeteer with stealth mode - navigates websites while avoiding bot detection
- multi-turn conversations - agentic loop with 5-20 iterations and tool execution
- long-term memory - semantic keyword matching with emotional weighting
- modular personality system - dynamic prompt assembly from markdown files
- skills system - reusable instruction packages following the agent skills standard
- heartbeat scheduler - periodic tasks with timezone-aware active hours
- self-review - failure pattern detection and counter-checks
- openai-compatible api support - works with various llm providers
- secure pairing system - one user per crab

## installation

```bash
# install dependencies
bun install

# link the cli globally (optional)
bun link
```

## usage

```bash
# run the setup wizard
crusty setup

# start the bot
crusty start

# start as daemon (systemd user service)
crusty start -d

# stop the daemon
crusty stop

# check daemon status
crusty status

# show help
crusty --help
```

## setup

the interactive setup wizard (`crusty setup`) configures:

1. api settings - openai key, base url, model
2. telegram bot token
3. browser settings - headless mode, viewport
4. cog customization - personality, identity, heartbeat
5. pairing code generation
6. configuration validation

## environment variables

create a `.env` file:

```bash
# required
OPENAI_API_KEY=your-api-key
TELEGRAM_BOT_TOKEN=your-telegram-bot-token

# api (optional)
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o
INFERENCE_RPM_LIMIT=40

# browser (optional)
BROWSER_HEADLESS=true
BROWSER_VIEWPORT=1280x800

# bootstrap (optional)
AGENTS_BOOTSTRAP_MAX_CHARS=20000
AGENTS_SOUL_EVIL_ENABLED=false

# heartbeat (optional)
HEARTBEAT_EVERY=30m
HEARTBEAT_TIMEZONE=America/New_York
HEARTBEAT_DAYS=1,2,3,4,5
HEARTBEAT_START=09:00
HEARTBEAT_END=18:00
```

## telegram commands

once paired, use these commands:

- `/start` - initialize and show help
- `/clear` - clear memory and reset conversation
- `/skill` or `/skill list` - list available skills
- `/skill new` - create a new skill interactively
- `/skill <name>` - view skill details
- `/skill cancel` - abort skill creation

## project structure

```
crusty/
├── index.ts              # entry point with graceful shutdown
├── cli/                  # cli commands (setup, start, stop, status)
│   ├── index.ts          # command router
│   ├── setup.ts          # interactive configuration wizard
│   ├── pairing.ts        # one-time pairing system
│   └── daemon.ts         # systemd user service management
├── core/                 # agent system
│   ├── agent.ts          # multi-turn conversation loop
│   ├── bootstrap.ts      # system prompt assembly
│   ├── skills.ts         # skill discovery and registry
│   └── skill-wizard.ts   # interactive skill creation
├── telegram/             # telegram bot integration
│   └── bot.ts            # long polling, session management
├── tools/                # tool registry and implementations
│   ├── registry.ts       # central registry with zod validation
│   ├── browser.ts        # web browsing tools
│   ├── todo.ts           # todo list management
│   └── skill.ts          # skill loading tools
├── memory/               # long-term memory system
│   └── service.ts        # keyword extraction, emotional weighting
├── scheduler/            # background tasks
│   ├── heartbeat.ts      # periodic task scheduling
│   └── self-review.ts    # failure pattern detection
├── data/                 # database
│   └── db.ts             # sqlite singleton with wal mode
└── cogs/                 # modular system prompts
    ├── SOUL.md           # agent personality and behavior
    ├── IDENTITY.md       # communication style
    ├── HEARTBEAT.md      # scheduled task instructions
    └── skills/           # skill storage
```

## bootstrap system

the bootstrap system loads markdown files in order to assemble the system prompt:

1. `SOUL.md` (cogs/) - required: agent personality and behavior
2. `TOOLS.md` (root) - optional: tool-specific instructions
3. `IDENTITY.md` (root or cogs/) - optional: identity configuration
4. `USER.md` (root) - optional: user-specific instructions
5. `HEARTBEAT.md` (cogs/) - optional: scheduled task instructions
6. `BOOTSTRAP.md` (root) - optional: bootstrap configuration

template variables are supported: `{{CURRENT_TIME}}`, `{{CURRENT_DATE}}`, `{{WORKING_DIR}}`

## skills

skills are reusable instruction packages that extend the agent's capabilities.

### skill locations

- `.crusty/skills/<name>/` - project local
- `cogs/skills/<name>/` - project local
- `~/.config/crusty/skills/<name>/` - global

### skill format

```yaml
---
name: my-skill
description: what this skill does
license: MIT
---

## instructions

skill content here...
```

## tools

### browser tools

- `browser_navigate(url)` - navigate to url
- `browser_click(selector)` - click element
- `browser_type(selector, text)` - type into input
- `browser_scroll(direction)` - scroll page
- `browser_get_content()` - extract page text
- `web_search(query)` - search multiple engines

### todo tools

- `create_todo(title, items)` - create todo list
- `update_todo(todoId, items)` - update items
- `mark_complete(todoId, itemIndex)` - mark complete
- `get_todo(todoId)` - retrieve todo

### skill tools

- `skill(name)` - load skill by name
- `read_skill_file(skill_name, filename)` - read skill files

## memory system

long-term memory with:

- keyword extraction and stop-word filtering
- emotional weight calculation (1-10 scale)
- recency boost for recent memories
- 15% random recall chance when no matches found

## heartbeat scheduler

configurable periodic tasks with:

- flexible frequency (30m, 1h, 2d)
- timezone-aware scheduling
- active hours support (overnight windows too)
- self-review integration for failure pattern detection

## testing

```bash
# run all tests
bun test

# run specific test file
bun test core/bootstrap.test.ts
```

## license

mit
