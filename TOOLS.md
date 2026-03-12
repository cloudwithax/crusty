# Tools

guidance on when and how to use specific tools effectively.

## Web Browsing

IMPORTANT: you MUST follow the snapshot-based workflow below for all browser interaction. do NOT guess at page structure or try to interact with elements without first taking a snapshot.

### tool priority (follow this order)

1. for quick page reads (articles, docs, APIs): use `web_fetch` FIRST. its faster than launching a browser.
2. for interactive sites or JS-heavy pages: use `browser_navigate` then IMMEDIATELY `browser_snapshot`
3. to interact with any element: ALWAYS use `browser_act` with a ref from `browser_snapshot`. never guess at selectors.
4. for long-form text extraction after youve already navigated: `browser_get_content`

### required workflow

every browser interaction MUST follow this pattern:

1. **navigate** to a page with `browser_navigate`
2. **snapshot** the page with `browser_snapshot` to see its structure and get element refs
3. **act** on elements using `browser_act` with a ref string from the snapshot (e.g. "e5")
4. **re-snapshot** after any page change (navigation, form submission, dynamic updates)

do NOT skip the snapshot step. do NOT try to click or type without refs.

### browser_snapshot

this is how you "see" the page. it returns a semantic tree of interactive elements (buttons, links, inputs) and content (headings, text), each with a string ref (e.g. e0, e5, e12).

example output:

```
[Page] GitHub - Search
URL: https://github.com/search

--- Interactive Elements ---
[e0] searchbox "Search GitHub" placeholder="Search GitHub"
[e1] button "Search"
[e2] link "Repositories"
[e3] link "Code"
[e5] link "crusty/README.md" -> /clxudiaea/crusty

--- Page Content ---
[e6] heading "Repository results"
[e7] text "A crab-themed telegram AI agent"
```

### browser_act

use refs from the snapshot to interact with elements. actions:

| action  | what it does                         | needs value? |
| ------- | ------------------------------------ | ------------ |
| click   | click the element                    | no           |
| type    | clear field and type text            | yes          |
| fill    | set value directly (fast, for forms) | yes          |
| hover   | mouse hover (tooltips, dropdowns)    | no           |
| select  | pick dropdown option                 | yes          |
| check   | check a checkbox                     | no           |
| uncheck | uncheck a checkbox                   | no           |
| focus   | focus the element                    | no           |
| clear   | clear an input field                 | no           |

examples:

```
click a link:    {"ref": "e5", "action": "click"}
type and submit: {"ref": "e1", "action": "type", "value": "crusty bot", "submit": true}
fill a form:     {"ref": "e3", "action": "fill", "value": "user@example.com"}
```

important: refs expire when the page changes. always re-run `browser_snapshot` after navigation, form submission, or clicking elements that load new content.

### browser_tabs

manage multiple tabs:

- `{"action": "list"}` - see all open tabs
- `{"action": "new", "url": "https://example.com"}` - open new tab
- `{"action": "switch", "id": "tab-2"}` - switch to a tab
- `{"action": "close", "id": "tab-1"}` - close a tab

### browser_wait

wait for async conditions before proceeding:

- `{"condition": "text", "value": "Results loaded"}` - wait for text to appear
- `{"condition": "url", "value": "/dashboard"}` - wait for URL to contain string
- `{"condition": "selector", "value": "#results"}` - wait for element to be visible
- `{"condition": "networkidle"}` - wait for network activity to stop

### web_fetch

for quickly reading web pages without the overhead of a full browser session. fetches the URL via HTTP and extracts readable text. much faster than navigate + get_content for simple pages.

best for: articles, documentation, API responses, static pages.
not ideal for: JavaScript-heavy SPAs, interactive sites, login-protected pages.

```
{"url": "https://docs.example.com/api"}
```

### web_search vs browser_navigate

- use `web_search` first to find URLs
- use `web_fetch` for quick reads of simple pages
- use `browser_navigate` + `browser_snapshot` for interactive sites or when you need to click/type

## Shell Commands

if a user asks you to run a shell command (like `uname`, `curl`, `ls`, `pwd`, etc.) and you dont have access to bash tools, tell them directly that shell access isnt enabled. do NOT guess or fabricate command output. ever. if you dont have a bash_execute or similar tool available, say so.

bad: "the result of uname -r is 6.11.9-gnu"
good: "i dont have shell access enabled rn, cant run that for you"

## Python Scripting

python3 is available in the environment. use python as the DEFAULT choice for any scripting, automation, or data processing tasks. prefer python over bash scripts for anything beyond simple one-liners.

### when to use python

- data processing, parsing, transformation
- file manipulation beyond basic operations
- api interactions and web requests
- calculations and math operations
- json/yaml/csv processing
- any multi-step automation
- anything requiring error handling or complex logic

### execution patterns

```bash
# run a script directly
python3 script.py

# run inline code
python3 -c "print('hello')"

# install packages if needed (use sparingly)
pip3 install package_name --break-system-packages

# use a virtual environment for project-specific deps
python3 -m venv .venv && source .venv/bin/activate && pip install package_name
```

### best practices

1. **default to python** - if the task could be done in bash OR python, choose python
2. **use f-strings** - modern string formatting
3. **handle errors** - wrap risky operations in try/except
4. **use pathlib** - for file path manipulation
5. **use requests** - for http operations (install if needed)
6. **use json module** - for json parsing, not jq in bash

## RSA Key Generation

openssh-client is available for generating RSA and other SSH keys using `ssh-keygen`.

### common patterns

```bash
# generate a 4096-bit rsa key
ssh-keygen -t rsa -b 4096 -f ~/.ssh/id_rsa -N ""

# generate ed25519 key (modern, recommended)
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ""

# generate key with comment
ssh-keygen -t rsa -b 4096 -f /path/to/key -C "user@example.com" -N ""

# generate key with passphrase
ssh-keygen -t rsa -b 4096 -f /path/to/key -N "passphrase"
```

### key types

| type     | recommendation                                    |
| -------- | ------------------------------------------------- |
| ed25519  | preferred for new keys, modern and secure         |
| rsa 4096 | widely compatible, use when ed25519 not supported |
| ecdsa    | acceptable alternative                            |
| rsa 2048 | minimum acceptable, prefer 4096                   |

### usage tips

1. **always specify output path** - use `-f /path/to/key` to control where the key is saved
2. **use empty passphrase for automation** - `-N ""` for unattended scripts
3. **add comments** - `-C "description"` helps identify keys later
4. **check existing keys first** - dont overwrite without asking

## Hooks

hooks are scheduled tasks that run automatically at defined intervals. you can create, remove, list, and toggle hooks during conversation.

### when to create a hook

proactively suggest or create a hook when the user's request implies recurring behavior:

| user says                    | you should                                          |
| ---------------------------- | --------------------------------------------------- |
| "remind me every hour to..." | create a hook with `every: 1h`                      |
| "check X every morning"      | create a hook with `every: 1d` and time constraints |
| "let me know if Y happens"   | create a monitoring hook                            |
| "keep track of Z daily"      | create a daily summary hook                         |
| "alert me when..."           | create a condition-checking hook                    |
| "every week, do..."          | create a hook with `every: 7d`                      |

### hook creation tips

1. **name it well** - use descriptive hyphenated names like `morning-weather`, `hourly-stretch-reminder`
2. **set appropriate intervals** - don't poll too frequently unless needed
3. **be specific in instructions** - the hook runs independently, so instructions should be self-contained
4. **use active hours** - for reminders during work hours, set timezone/days/start/end
5. **explain what you did** - tell the user you created a hook and when it will run

### hook instructions format

when writing hook instructions, be specific about:

- what condition to check (if any)
- what action to take
- when to respond with HOOK_OK (no action needed)
- what message format to use when action IS needed

example:

```
check if it's time to remind the user to take a break.

if more than 2 hours have passed since last reminder, send a friendly reminder about taking a short break.

if no reminder is needed, respond with: HOOK_OK
```

### available hook tools

- `create_hook` - create a new scheduled hook
- `remove_hook` - delete a hook permanently
- `list_hooks` - show all configured hooks and their status
- `toggle_hook` - enable/disable a hook without deleting it

## Learning Machine

you have a self-improving knowledge system that stores discovered patterns, gotchas, and fixes. this helps you avoid repeating mistakes and apply proven solutions.

### two knowledge systems

| system        | what it stores                   | how it evolves                       |
| ------------- | -------------------------------- | ------------------------------------ |
| **memories**  | user facts, preferences, context | user-initiated via save_memory       |
| **learnings** | error patterns, fixes, workflows | you discover through trial and error |

### when to save a learning

save a learning when you:

1. **fix a tool error** - record what broke and how you fixed it
2. **discover a gotcha** - non-obvious quirk that could trip you up again
3. **receive user correction** - they told you to do something differently
4. **find a working pattern** - successful approach worth remembering
5. **learn domain context** - project-specific knowledge

### learning categories

| category      | use for                                |
| ------------- | -------------------------------------- |
| error_pattern | tool failures, api errors, timeouts    |
| gotcha        | non-obvious quirks, edge cases         |
| fix           | solutions that worked                  |
| preference    | user corrections and style preferences |
| workflow      | successful multi-step patterns         |
| context       | domain/project-specific knowledge      |

### example saves

after fixing a browser timeout:

```
save_learning(
  title="browser navigation needs explicit wait",
  learning="when navigating to slow pages, use wait_for_load option or the page may time out before content is ready",
  category="fix",
  tool_name="browser"
)
```

after user correction:

```
save_learning(
  title="user prefers concise code comments",
  learning="keep code comments brief - one line per comment, no obvious statements",
  category="preference"
)
```

after discovering project context:

```
save_learning(
  title="api uses snake_case",
  learning="this project's api returns snake_case keys, not camelCase. transform before using in frontend",
  category="context"
)
```

### workflow

1. before complex tasks, relevant learnings are automatically retrieved and injected into your context
2. when tools fail, the error is auto-captured (you can enhance with more context using save_learning)
3. when you successfully apply a learning, use apply_learning to boost its confidence
4. high-confidence, frequently-applied learnings surface more prominently

### available learning tools

- `save_learning` - save a discovered pattern, gotcha, or fix
- `search_learnings` - find relevant learnings for the current task
- `apply_learning` - mark a learning as successfully applied (increases confidence)
- `learning_stats` - view your knowledge base statistics
