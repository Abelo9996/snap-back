---
description: Roll the project back to before the agent's last burst of changes (or to a snapshot id), preview first
argument-hint: "[snapshot-id]"
disable-model-invocation: true
allowed-tools: Bash(snap-back *) Bash(npx -y @abelo9996/snap-back *)
---

The user ran `/snap-back:undo` to roll back file changes. Arguments: "$ARGUMENTS"

Run snap-back as `snap-back` if that command exists on PATH, otherwise as
`npx -y @abelo9996/snap-back`. Run it from the project directory.

1. Preview without changing anything:
   - No arguments: `snap-back undo --dry-run`. This targets the files as they were
     before the last burst of agent changes (normally the user's previous prompt).
   - A snapshot id in the arguments: `snap-back restore <id> --dry-run`.
2. If the preview says there is nothing to undo, or the id is unknown, tell the user
   and stop. Suggest `/snap-back:list` to pick a snapshot id.
3. Otherwise apply exactly what was previewed, adding `--yes` because this is not an
   interactive terminal: `snap-back undo --yes` or `snap-back restore <id> --yes`.
   Do not apply anything other than what the preview showed.
4. Report briefly what the command printed: how many files were restored, how many
   of them were deleted files brought back, any secret or `.env` among them, any
   big directory it could not rebuild (with the size and rebuild command it
   showed), and the safety snapshot id. Give the user the exact command that
   reverses this rollback (`snap-back restore <safety-id> --yes`).

snap-back restores untracked and gitignored files (such as `.env` and local data)
and files a shell command changed, which `/rewind` does not. It does not store the
built-in big directories (`node_modules/`, `dist/`, caches) or files over the size
cap; those are only recorded, so reinstall or rebuild them. Only files inside the
project are covered, and database writes, installs, network calls or pushed commits
cannot be undone. Say so if the user's request implies otherwise. Do not edit files
yourself to imitate an undo.
