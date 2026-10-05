# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.2] - 2026-10-05

### Added

- Claude Code plugin: `/plugin marketplace add Abelo9996/open-agent-lab`, then
  `/plugin install snap-back@open-agent-lab`. It ships the skill, the commands
  `/snap-back:undo`, `/snap-back:list` and `/snap-back:status`, and the
  `UserPromptSubmit`, `PreToolUse` and `PostToolUse` hooks, so no settings file is
  edited. The hooks use a global install when one is on PATH and otherwise run
  through `npx`, and the snapshot after a tool call runs in the background.
- Codex plugin manifest (`.codex-plugin/plugin.json`) with the skill and an icon.
- `snap-back status` reports when the plugin's hooks last ran, and warns when
  hooks from `snap-back hooks install` are installed as well, since both then run.

## [0.1.1] - 2026-10-04

### Fixed

- `undo` no longer deletes files that the snapshot never recorded because its
  ignore rules excluded them. Before, if an agent rewrote `.gitignore` so that
  `.env` or a local data directory became visible, `undo` restored `.gitignore`
  and deleted those files. They are now listed as kept and left alone.
- Running `undo` again after reaching the oldest change no longer re-applies
  what the previous undo removed. It says there is nothing older and prints the
  command that reverses the last undo. With several bursts, repeated undos walk
  back one burst at a time instead of toggling between the last two states.
- `undo` and `restore` no longer claim to restore or delete nested git
  repositories, which only have their commit recorded. They are listed as
  skipped.
- A file that is ignored now but will be overwritten by a restore is saved in
  the safety snapshot first, so its current contents can be recovered.
- Ctrl-C during a snapshot or restore no longer leaves a lock file that made
  every later command (and every Claude Code hook) wait 30 seconds and fail.
  snap-back finishes the operation, then exits. Locks left by a killed process
  are detected by pid and taken over at once, and a stray `index.lock` in the
  shadow repository is cleared.
- The project root is now the nearest directory that has snapshots or a `.git`.
  Before, a snapshot taken once in a parent folder such as `~/code` captured
  every repository below it, so changes inside those repositories were not
  recorded and `undo` reverted files in unrelated projects.
- `snap-back list | head` and other closed pipes no longer crash with EPIPE.
- `status` and `gc` report the space the shadow repository really uses on disk.

### Changed

- New file contents are written into pack files instead of one loose object per
  file. On a 20,000-file project the first snapshot went from about 11 s and
  80 MB to about 3 s and 6 MB, and undoing a codemod that touched every file went
  from about 18 s to about 9 s.
- `undo` and `restore` print the project directory when it is not the current
  directory, and say that a safety snapshot is taken before asking to proceed.
- `undo`, `diff` and `restore` with no snapshots explain how to get protected
  next time (`wrap`, `watch` or `hooks install`).
- `list` names its count column CHANGED and explains it. `wrap` labels show the
  command name instead of its full path.

## [0.1.0] - 2026-10-03

First release on npm as `@abelo9996/snap-back`.

### Added

- Shadow git repository per project, stored outside the project, that never reads or writes the project's own `.git`.
- `snap`, `list`, `diff`, `undo`, `restore` (full and partial), `gc` and `status` commands.
- `wrap -- <command>`: checkpoint before and after an agent command, with periodic snapshots while it runs.
- `watch`: debounced snapshots on file changes, labelled with detected agent processes.
- `hooks install|uninstall|status --agent claude`: merges Claude Code `UserPromptSubmit`, `PreToolUse` and `PostToolUse` hooks into `.claude/settings.local.json` (or `.claude/settings.json` with `--shared`) with a backup.
- Safety snapshot before every restore, so restores can be undone.
- Respect for `.gitignore`, `.git/info/exclude`, a built-in ignore list and an optional `.snap-back-ignore`.
- Agent Skill at `skills/snap-back/SKILL.md`.

### Changed (from the pre-release `snapback` name)

- Renamed from `snapback` to `snap-back`. The repository is now
  github.com/Abelo9996/snap-back and the command is `snap-back`.
- Claude Code hooks now run `snap-back hook claude`. Reinstalling the hooks replaces
  entries written as `snapback hook claude`, and uninstalling removes them.
- The storage directory is now named `snap-back`. An existing `snapback` storage
  directory is still used, so snapshots taken before the rename stay available.
- `SNAP_BACK_HOME` and `SNAP_BACK_DEBUG` replace `SNAPBACK_HOME` and
  `SNAPBACK_DEBUG`; the old names are still read.
- The project ignore file is now `.snap-back-ignore`. `.snapbackignore` is still read.
- The Agent Skill moved to `skills/snap-back/SKILL.md`.
- `hooks install` now writes `.claude/settings.local.json` by default instead of
  `.claude/settings.json`, so the hooks (and any machine-specific path in the hook
  command) are not committed by accident. `--shared` writes `.claude/settings.json`
  and prints a warning when the hook command contains a path that exists only on
  this machine. `--local` is still accepted.
- `hooks uninstall` removes the hooks from both settings files unless `--shared` or
  `--local` picks one, and `hooks status` and `status` report each file.
- Library API: `installClaudeHooks` takes `shared` instead of `local`,
  `uninstallClaudeHooks` takes an optional `scope` and returns results for each
  file, and `claudeHookStatus` reports both files.
