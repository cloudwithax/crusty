---
name: bash
description: shell and terminal command execution, file operations, system utilities, and command chaining
license: MIT
---

# Shell Tools Usage Guide

you have access to shell tools for executing commands and managing files in the terminal. this guide explains when and how to use each tool effectively.

## tool overview

you have four shell tools available:

| tool | purpose | when to use |
|------|---------|-------------|
| `bash_execute` | run any shell command | scripts, package managers, search, system info |
| `bash_read_file` | read file contents | view configs, source code, logs |
| `bash_write_file` | write/create files | create scripts, configs, save output |
| `bash_list_dir` | list directory contents | explore filesystem, find files |

## decision tree: which tool to use

```
need to run a command or script?
  └─> bash_execute

need to see whats in a file?
  └─> bash_read_file (NOT bash_execute with cat)

need to create or modify a file?
  └─> bash_write_file (NOT bash_execute with echo/cat)

need to see whats in a directory?
  └─> bash_list_dir (NOT bash_execute with ls)
```

always prefer the specialized tools over bash_execute when they fit the task. they are safer and more reliable.

## bash_execute: running commands

use this for anything that isnt covered by the other tools:

```
good uses:
- bun install, npm install, pip install (package management)
- grep -r "pattern" . (searching file contents)
- find . -name "*.ts" (finding files by name)
- ps aux | grep node (checking processes)
- curl https://api.example.com (http requests)
- git status, git diff (version control)
- bun run build, npm test (running scripts)
- mkdir -p src/components (creating directories)

bad uses (use other tools instead):
- cat file.txt (use bash_read_file)
- echo "content" > file.txt (use bash_write_file)
- ls -la /app (use bash_list_dir)
```

### chaining commands

you can chain commands with && (run next if previous succeeds) or | (pipe output):

```bash
# install deps then run tests
bun install && bun test

# find files and count them
find . -name "*.ts" | wc -l

# search and show context
grep -r "TODO" . | head -20
```

### handling long-running commands

for commands that might take a while, increase the timeout:

```json
{
  "command": "bun run build",
  "timeout": 60000
}
```

default is 30 seconds, max is 120 seconds (2 minutes).

### working directory

by default commands run in /app (project root). change it with workdir:

```json
{
  "command": "bun test",
  "workdir": "/app/packages/api"
}
```

## bash_read_file: viewing file contents

always use this instead of bash_execute with cat:

```json
{
  "path": "/app/package.json"
}
```

for large files, limit to first N lines:

```json
{
  "path": "/app/logs/app.log",
  "lines": 100
}
```

## bash_write_file: creating and modifying files

always use this instead of bash_execute with echo or heredocs:

```json
{
  "path": "/app/config.json",
  "content": "{\n  \"debug\": true\n}"
}
```

to append instead of overwrite:

```json
{
  "path": "/app/notes.txt",
  "content": "new line\n",
  "append": true
}
```

important: parent directories must exist. create them first with bash_execute:

```bash
mkdir -p /app/src/utils
```

## bash_list_dir: exploring directories

always use this instead of bash_execute with ls:

```json
{
  "path": "/app/src"
}
```

to include hidden files (dotfiles):

```json
{
  "path": "/app",
  "all": true
}
```

## blocked commands

these commands are blocked for safety:
- sudo, su, doas, pkexec (privilege escalation)
- rm -rf, rm with / or ~ paths (destructive deletion)
- reboot, shutdown, poweroff, halt (system control)
- mkfs, dd to devices, shred, wipe (destructive disk ops)
- chmod 777, chown on system paths (dangerous permissions)

if you need to do something that hits these restrictions, explain to the user why and ask them to do it manually.

## common patterns

### check if a file exists
```bash
test -f /app/config.json && echo "exists" || echo "not found"
```

### get file info
```bash
stat /app/package.json
```

### search for text in files
```bash
grep -rn "searchterm" --include="*.ts" .
```

### count lines of code
```bash
find . -name "*.ts" -exec wc -l {} + | tail -1
```

### check disk space
```bash
df -h
```

### check memory
```bash
free -h
```

### list running processes
```bash
ps aux | grep -v grep | grep node
```

### download a file
```bash
curl -o output.json https://api.example.com/data
```

## error handling

when a command fails:
1. check the stderr output for error messages
2. check the exit code (0 = success, non-zero = failure)
3. common issues:
   - file not found: verify the path with bash_list_dir
   - permission denied: the command might be blocked
   - command not found: the tool might not be installed
