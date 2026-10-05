---
description: List recent snap-back snapshots of this project, newest first
argument-hint: "[-n count | --all]"
disable-model-invocation: true
allowed-tools: Bash(snap-back *) Bash(npx -y @abelo9996/snap-back *)
---

The user ran `/snap-back:list`. Arguments: "$ARGUMENTS"

Run snap-back as `snap-back` if that command exists on PATH, otherwise as
`npx -y @abelo9996/snap-back`. From the project directory run
`snap-back list $ARGUMENTS` (pass the arguments through; with none it shows the
newest 20).

Show the result as a compact table: id, age, kind, files changed, label. Keep the
ids exactly as printed. Point out where the user's recent prompts begin
(`turn-start` rows) and any `safety` or `restore` rows from earlier rollbacks.

End with the two commands the user most likely wants next:
`snap-back diff <id>` to compare a snapshot with the current files, and
`/snap-back:undo <id>` to restore one. Do not restore anything from this command.
