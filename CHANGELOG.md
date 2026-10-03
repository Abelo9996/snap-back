# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
