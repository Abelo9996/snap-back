---
description: Show where snap-back stores this project's snapshots, what changed since the last one, and whether hooks are recording
disable-model-invocation: true
allowed-tools: Bash(snap-back *) Bash(npx -y @abelo9996/snap-back *)
---

The user ran `/snap-back:status`.

Run snap-back as `snap-back` if that command exists on PATH, otherwise as
`npx -y @abelo9996/snap-back`. From the project directory run `snap-back status`.

Summarize in a few lines: the project directory, the number of snapshots and the
latest one, how many files changed since it, and the storage size.

This plugin records snapshots through its own hooks (before each prompt, and before
and after every Edit, Write, MultiEdit, NotebookEdit, Bash and PowerShell call), so
no `snap-back hooks install` is needed. If the output says hooks are also installed
in `.claude/settings.local.json` or `.claude/settings.json`, tell the user both run
and that `snap-back hooks uninstall` removes the settings copy. If `git` is reported
missing, say that snap-back needs git on PATH.
