---
name: snap-back
description: Checkpoint a project with snap-back before risky edits and roll back cleanly afterwards. Use this whenever you are about to make a large refactor, a multi-file rewrite, run codemods, formatters, migrations, `rm`, `git clean`, `sed -i` or any shell command that rewrites or deletes files, and whenever the user asks to undo, revert, rewind or roll back what an agent changed, even if they do not mention snap-back by name.
---

# snap-back

snap-back keeps snapshots of the project in a private git repository outside the
project directory. It never touches the project's own `.git`, branches, index or
stash, so checkpointing is safe even in a repo with uncommitted work.

Run it as `snap-back` if it is on PATH, otherwise as
`npx -y @abelo9996/snap-back`.

## Before a risky change

Take a labelled checkpoint first. It costs well under a second and gives the
user a precise way back if the change goes wrong:

```bash
snap-back snap -m "before: migrate auth to sessions"
```

Checkpoint before anything that touches many files or deletes files, and before
shell commands whose effects on the tree you cannot fully predict. You do not
need one before every small edit. If `snap-back hooks status` reports that Claude
Code hooks are installed, tool calls are already checkpointed automatically, but
a labelled `snap` still makes the history easier for the user to read.

If the user asks for automatic checkpoints in Claude Code, `snap-back hooks install`
adds the hooks to `.claude/settings.local.json`, which is personal and not meant to
be committed. Only pass `--shared` (which writes the usually committed
`.claude/settings.json`) when the user asks for the hooks to be shared with the
project, and relay any warning it prints about a machine-specific path.

## Looking at what changed

```bash
snap-back list            # newest first: id, time, kind, files changed, label
snap-back diff            # what `undo` would revert, as a unified diff
snap-back diff <id>       # snapshot <id> compared with the current files
snap-back diff <id> --stat
```

## Rolling back

Rolling back rewrites files in the working tree, so do it only when the user asks
for it, or to revert a change you just made yourself and are about to redo.
Preview first, then apply. You are not in an interactive terminal, so pass `--yes`
once you have checked the preview:

```bash
snap-back undo --dry-run              # back to before the last agent burst
snap-back undo --yes
snap-back restore <id> --dry-run      # back to a specific snapshot
snap-back restore <id> --yes -- src/  # only some paths
```

Every restore first records a safety snapshot and prints its id. Tell the user
that id: `snap-back restore <safety-id> --yes` puts everything back as it was.

## What it cannot undo

Only files inside the project are covered. Files matched by `.gitignore`, and
built-in ignores such as `node_modules/`, `.venv/` and `dist/`, are neither
saved nor deleted. Database writes, network calls, package installs outside the
project, pushed commits and anything else outside the working tree cannot be
rolled back; say so plainly if the user expects otherwise.
