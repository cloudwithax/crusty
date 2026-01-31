---
name: example-hook
description: an example hook to demonstrate the hooks system
every: 1h
enabled: false
timezone: America/New_York
days: 1,2,3,4,5
start: 09:00
end: 17:00
---

# Example Hook

this is an example hook file. hooks are scheduled tasks that run at defined intervals.

## configuration

frontmatter fields:

| field | required | description | example |
|-------|----------|-------------|---------|
| name | no | display name for the hook | `my-hook` |
| description | no | brief description of what the hook does | `checks for updates` |
| every | **yes** | how often to run (Xs, Xm, Xh, Xd) | `30m`, `1h`, `5m` |
| enabled | no | whether the hook is active (default: true) | `true` |
| timezone | no | timezone for active hours | `America/New_York` |
| days | no | comma-separated days to run (0=Sun, 6=Sat) | `1,2,3,4,5` |
| start | no | start time for active hours (24h) | `09:00` |
| end | no | end time for active hours (24h) | `17:00` |

## instructions

everything below the frontmatter is passed to the agent as instructions. the agent will:

1. read these instructions
2. determine if any action is needed
3. if action needed, send a message to the user
4. if no action needed, respond with `HOOK_OK` (suppressed)

## example use cases

- **reminder hook** - remind user about daily standup at 9am
- **weather hook** - check weather and notify if rain expected
- **health check hook** - ping an endpoint and alert if down
- **digest hook** - summarize unread items every evening
