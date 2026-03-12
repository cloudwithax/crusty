---
name: git-operations
description: "Comprehensive git workflows including branching, committing, merging, rebasing, undo/recovery, stashing, and conflict resolution. Use when the user asks about git, version control, repositories, commits, branches, merges, or code history."
---

# git operations

structured workflows for safe, effective git usage. always inspect before destructive operations.

## core workflow

follow this loop for any change:

1. `git status` - understand current state
2. `git diff` - review what changed
3. `git add <files>` - stage specific files (avoid `git add .` unless intentional)
4. `git commit -m "message"` - commit with a clear message
5. `git log --oneline -5` - verify the commit landed

## commit messages

format: `type: brief description`

types: feat, fix, refactor, docs, test, chore, style, perf

examples:
- `feat: add user authentication endpoint`
- `fix: handle null pointer in parser`
- `refactor: extract validation logic into helper`

## branching

```bash
# create and switch to new branch
git checkout -b feature/my-feature

# list branches
git branch -a

# switch branches
git checkout main

# delete local branch (safe - only if merged)
git branch -d feature/old-branch

# delete local branch (force)
git branch -D feature/old-branch

# track remote branch
git checkout --track origin/feature/remote-branch
```

## syncing with remote

```bash
# fetch latest without merging
git fetch origin

# pull with rebase (cleaner history)
git pull --rebase origin main

# push current branch
git push origin HEAD

# push and set upstream
git push -u origin feature/my-branch

# force push safely (only use on feature branches)
git push --force-with-lease origin feature/my-branch
```

never use `git push --force` - always use `--force-with-lease` to avoid overwriting others work

## undo and recovery recipes

### undo last commit but keep changes
```bash
git reset --soft HEAD~1
```

### undo last commit and unstage changes
```bash
git reset --mixed HEAD~1
```

### completely discard last commit
```bash
git reset --hard HEAD~1
```

### discard all uncommitted changes (dangerous)
```bash
git checkout -- .
# or
git restore .
```

### unstage a file
```bash
git restore --staged <file>
```

### recover a deleted branch
```bash
# find the commit hash
git reflog
# recreate the branch
git checkout -b recovered-branch <commit-hash>
```

### undo a pushed commit (safe for shared branches)
```bash
git revert <commit-hash>
```

### recover lost commits
```bash
git reflog
# find the entry, then
git cherry-pick <commit-hash>
```

## stashing

```bash
# save current changes
git stash

# save with description
git stash push -m "wip: login form"

# list stashes
git stash list

# apply most recent stash (keep in stash list)
git stash apply

# apply and remove from stash list
git stash pop

# apply a specific stash
git stash apply stash@{2}

# drop a stash
git stash drop stash@{0}
```

## conflict resolution

when you hit a merge conflict:

1. `git status` - identify conflicted files
2. read the conflicted file - look for `<<<<<<<`, `=======`, `>>>>>>>` markers
3. edit the file to resolve - remove markers, keep correct code
4. `git add <resolved-file>` - mark as resolved
5. `git commit` or `git rebase --continue` - finish the operation

### abort a failed merge or rebase
```bash
git merge --abort
git rebase --abort
```

## history inspection

```bash
# compact log
git log --oneline -20

# log with graph
git log --oneline --graph --all -20

# show a specific commit
git show <commit-hash>

# blame a file (who changed what)
git blame <file>

# search commit messages
git log --grep="search term"

# find commits that changed a file
git log --follow -- <file>

# diff between branches
git diff main..feature/branch
```

## interactive rebase (rewriting history)

only rewrite history on unshared branches

```bash
# rebase last N commits
git rebase -i HEAD~N
```

in the editor:
- `pick` - keep commit as is
- `squash` (or `s`) - merge into previous commit
- `fixup` (or `f`) - merge into previous, discard message
- `reword` (or `r`) - change commit message
- `drop` (or `d`) - remove commit
- `edit` (or `e`) - pause to amend

### move commits to a new branch
```bash
# on main with commits you want to move
git checkout -b new-branch
git checkout main
git reset --hard HEAD~N
```

## tags

```bash
# create lightweight tag
git tag v1.0.0

# create annotated tag
git tag -a v1.0.0 -m "release 1.0.0"

# push tags
git push origin --tags

# delete local tag
git tag -d v1.0.0

# delete remote tag
git push origin --delete v1.0.0
```

## safety rules

1. always `git status` and `git diff` before committing
2. never `git push --force` on shared branches - use `--force-with-lease`
3. never rewrite history that has been pushed to a shared branch
4. stash or commit before switching branches
5. use `git revert` instead of `git reset` on shared branches
6. inspect reflog before any destructive operation
7. when in doubt, create a backup branch: `git branch backup-$(date +%s)`
