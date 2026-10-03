# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

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

## [0.1.0] - 2026-10-03

### Added

- Shadow git repository per project, stored outside the project, that never reads or writes the project's own `.git`.
- `snap`, `list`, `diff`, `undo`, `restore` (full and partial), `gc` and `status` commands.
- `wrap -- <command>`: checkpoint before and after an agent command, with periodic snapshots while it runs.
- `watch`: debounced snapshots on file changes, labelled with detected agent processes.
- `hooks install|uninstall|status --agent claude`: merges Claude Code `UserPromptSubmit`, `PreToolUse` and `PostToolUse` hooks into `.claude/settings.json` with a backup.
- Safety snapshot before every restore, so restores can be undone.
- Respect for `.gitignore`, `.git/info/exclude`, a built-in ignore list and an optional `.snapbackignore`.
- Agent Skill at `skills/snapback/SKILL.md`.
