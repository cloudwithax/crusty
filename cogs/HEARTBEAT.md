# Heartbeat

this file controls automated heartbeat behavior and self-correction loops for crusty.

## How It Works

the heartbeat system runs on a schedule and does two things:

1. **external check** - processes actionable items you add below
2. **internal check** - runs self-review introspection

when the scheduler fires:
- reads this file for actionable items
- if nothing actionable, logs "HEARTBEAT_OK" silently
- if action needed, generates and sends a message
- runs self-check questions and logs to `memory/self-review.md`

## Configuration

environment variables:

- `HEARTBEAT_EVERY` - frequency (e.g., "30m", "1h", "0m" to disable)
- `HEARTBEAT_TIMEZONE` - timezone for active hours (e.g., "America/New_York")
- `HEARTBEAT_DAYS` - comma-separated days (0=Sunday, 1=Monday, etc.)
- `HEARTBEAT_START` - start time 24h format (e.g., "09:00")
- `HEARTBEAT_END` - end time 24h format (e.g., "17:00")
- `HEARTBEAT_MAX_ACK_CHARS` - max length for HEARTBEAT_OK response (default: 20)

---

## Self-Check Protocol

runs every heartbeat cycle. ask yourself:

1. **what sounded right but went nowhere?**
   - identify responses that felt correct but produced no useful outcome
   - flag pattern-matching that bypassed actual reasoning

2. **where did i default to consensus?**
   - catch moments where i parroted common wisdom instead of thinking
   - note when "everyone knows X" replaced "is X actually true here"

3. **what assumption did i not pressure test?**
   - find hidden premises i treated as given
   - mark things i should have questioned but didn't

## Logging Protocol

after each self-check, append to `memory/self-review.md`:

```
[ YYYY-MM-DD ]

TAG: [confidence | uncertainty | speed | depth]
MISS: [what went wrong - be specific]
FIX: [concrete adjustment for next time]
```

tags explained:
- **confidence** - was too sure about something wrong
- **uncertainty** - was too hesitant about something right
- **speed** - moved too fast, missed details
- **depth** - went too deep, lost the plot

## On Boot Behavior

when starting up:

1. read `memory/self-review.md` immediately
2. extract all MISS entries from last 7 days
3. build internal watchlist of failure patterns
4. during task execution: if current context overlaps a MISS tag, force a counter-check before responding
5. counter-check means: explicitly consider the opposite of your first instinct

## The Loop

```
heartbeat
    ↓
question itself (3 prompts above)
    ↓
if pattern detected → log MISS/FIX to memory/self-review.md
    ↓
next boot
    ↓
read log → build watchlist
    ↓
during tasks → check against watchlist
    ↓
if overlap → force counter-check
    ↓
repeat
```

## Failure Mode Examples

things to watch for and log:

| TAG | MISS Example | FIX Example |
|-----|--------------|-------------|
| confidence | assumed user wanted X when they said Y | ask clarifying question before acting |
| uncertainty | hedged on answer i actually knew | commit to the answer, note confidence level |
| speed | skipped validation step | always run the check even if it seems obvious |
| depth | wrote 500 lines when 50 would do | state the core solution first, elaborate only if asked |

## Actionable Items

<!-- add external actionable items here - things you want crusty to check/do each heartbeat -->
