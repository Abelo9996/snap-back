---
name: snapback
description: Checkpoint a project with snapback before risky edits and roll back cleanly afterwards. Use this whenever you are about to make a large refactor, a multi-file rewrite, run codemods, formatters, migrations, `rm`, `git clean`, `sed -i` or any shell command that rewrites or deletes files, and whenever the user asks to undo, revert, rewind or roll back what an agent changed, even if they do not mention snapback by name.
---

# snapback

snapback keeps snapshots of the project in a private git repository outside the
project directory. It never touches the project's own `.git`, branches, index or
stash, so checkpointing is safe even in a repo with uncommitted work.

Run it as `snapback` if it is on PATH, otherwise as
`npx -y github:Abelo9996/snapback`.

## Before a risky change

Take a labelled checkpoint first. It costs well under a second and gives the
user a precise way back if the change goes wrong:

```bash
snapback snap -m "before: migrate auth to sessions"
```

Checkpoint before anything that touches many files or deletes files, and before
shell commands whose effects on the tree you cannot fully predict. You do not
need one before every small edit. If `snapback hooks status` reports that Claude
Code hooks are installed, tool calls are already checkpointed automatically, but
a labelled `snap` still makes the history easier for the user to read.

## Looking at what changed

```bash
snapback list            # newest first: id, time, kind, files changed, label
snapback diff            # what `undo` would revert, as a unified diff
snapback diff <id>       # snapshot <id> compared with the current files
snapback diff <id> --stat
```

## Rolling back

Rolling back rewrites files in the working tree, so do it only when the user asks
for it, or to revert a change you just made yourself and are about to redo.
Preview first, then apply. You are not in an interactive terminal, so pass `--yes`
once you have checked the preview:

```bash
snapback undo --dry-run              # back to before the last agent burst
snapback undo --yes
snapback restore <id> --dry-run      # back to a specific snapshot
snapback restore <id> --yes -- src/  # only some paths
```

Every restore first records a safety snapshot and prints its id. Tell the user
that id: `snapback restore <safety-id> --yes` puts everything back as it was.

## What it cannot undo

Only files inside the project are covered. Files matched by `.gitignore`, and
built-in ignores such as `node_modules/`, `.venv/` and `dist/`, are neither
saved nor deleted. Database writes, network calls, package installs outside the
project, pushed commits and anything else outside the working tree cannot be
rolled back; say so plainly if the user expects otherwise.
