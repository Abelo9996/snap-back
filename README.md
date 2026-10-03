# snap-back

English | [简体中文](README.zh-CN.md)

Roll back whatever a coding agent did to your files with one command, without touching your own git history.

snap-back snapshots your project before and during an agent's work: edits, deletions, new files, and the side effects of shell commands the agent ran. It works with any agent (Codex, Claude Code, OpenCode, Cursor, Aider, DeepSeek Harness, or a script you wrote) because it watches files, not the agent.

[![CI](https://github.com/Abelo9996/snap-back/actions/workflows/ci.yml/badge.svg)](https://github.com/Abelo9996/snap-back/actions/workflows/ci.yml)

![snap-back wrapping an agent-like script that deletes two files and rewrites a third, then snap-back undo restoring all three](docs/demo.gif)

## Quickstart

Requires Node 20 or newer and git on your PATH.

```bash
# Run your agent between two checkpoints
npx @abelo9996/snap-back wrap -- codex

# Didn't like the result? See what it changed, then roll it back
npx @abelo9996/snap-back diff
npx @abelo9996/snap-back undo
```

`undo` shows the files it will restore and delete and asks before changing anything. To stop typing `npx github:...`, install it once:

```bash
npm install -g @abelo9996/snap-back
snap-back undo
```

## Safety: what it touches and what it never touches

snap-back writes to:

- **Its own storage directory**, one shadow git repository per project:
  - Linux: `$XDG_DATA_HOME/snap-back/` (default `~/.local/share/snap-back/`)
  - macOS: `~/Library/Application Support/snap-back/`
  - Windows: `%LOCALAPPDATA%\snap-back\`
  - Override with `SNAP_BACK_HOME` (`SNAPBACK_HOME` is still read).
  - If a `snapback` directory from a version before the rename exists in that location, it keeps being used, so existing snapshots stay available.
- **Files in your project, only when you run `undo` or `restore`**, and only after showing you the list and getting a yes (or `--yes`). Before every restore it records a safety snapshot of the current files, so a restore can itself be undone.
- **`.claude/settings.local.json`, only when you run `snap-back hooks install`** (or `.claude/settings.json` with `--shared`). Existing settings are merged, never replaced, and the previous file is copied to `<file>.snap-back-backup-<timestamp>` first.

snap-back never touches:

- Your project's `.git` directory: no commits, branches, tags, index changes, stashes or config. Every git call uses an explicit `--git-dir` pointing at the shadow repository, and inherited `GIT_*` environment variables are stripped. The test suite hashes every file in `.git` before and after a full snapshot, restore, undo and gc cycle and requires them to be identical.
- Files your `.gitignore` excludes, and the built-in ignores: `node_modules/`, `.venv/`, `venv/`, `__pycache__/`, `dist/`, `build/`, `out/`, `target/`, `.next/`, `.nuxt/`, `.svelte-kit/`, `.turbo/`, `.cache/`, `coverage/`, `.gradle/`, `.terraform/` and a few others (see `BUILTIN_IGNORES` in `src/store.ts`). These are never saved, so a restore never deletes or overwrites them.
- Anything outside the project directory. snap-back refuses to run with your home directory or a filesystem root as the project.

## How it works

```mermaid
flowchart LR
    A[Agent edits files<br/>in your project] --> P[(Project work tree)]
    P -- "git --git-dir=SHADOW --work-tree=PROJECT add -A" --> S[(Shadow repo<br/>~/.local/share/snap-back/&lt;name&gt;-&lt;hash&gt;)]
    S -- "restore / undo<br/>checkout into work tree" --> P
    G[(Your .git)] -. never read or written .- S
```

Each snapshot is a commit in the shadow repository. Its tree is the full set of non-ignored files at that moment, so restoring is exact: modified files get their old contents back, deleted files reappear, and files that did not exist in the snapshot are removed (along with directories that become empty). Unchanged files are stored once, so frequent snapshots are cheap.

Every snapshot has a kind. `undo` rolls back to the newest "before" marker whose files differ from what you have now:

| Kind | Recorded by | Marks the start of a burst |
| --- | --- | --- |
| `manual` | `snap-back snap` | yes |
| `wrap-start`, `wrap`, `wrap-end` | `snap-back wrap` | `wrap-start` |
| `turn-start`, `pre-tool`, `post-tool` | Claude Code hooks | `turn-start` (each prompt you send) |
| `watch-start`, `watch` | `snap-back watch` | yes, each debounced burst |
| `safety`, `restore` | `undo` and `restore` | `restore` |

Running `undo` twice walks back two bursts. To reverse an undo, run the `snap-back restore <id>` command it printed.

## Setup per agent

| Agent | Setup | Granularity of `undo` |
| --- | --- | --- |
| Claude Code | `snap-back hooks install --agent claude` | the last prompt's changes; every Edit, Write, MultiEdit, NotebookEdit, Bash and PowerShell call is also checkpointed |
| Codex CLI | `snap-back wrap -- codex` | the whole session, plus a snapshot every 30 s while it runs |
| OpenCode, Aider, Gemini CLI, any CLI agent | `snap-back wrap -- <command>` | the whole session |
| Cursor, IDE agents, anything else | `snap-back watch` in a terminal | each burst of changes (1.5 s of quiet ends a burst) |

### Claude Code

```bash
snap-back hooks install --agent claude           # writes .claude/settings.local.json
snap-back hooks install --agent claude --shared  # writes .claude/settings.json instead
snap-back hooks status                           # reports both files
snap-back hooks uninstall                        # removes the hooks from both files
```

The hooks run `snap-back hook claude` on `UserPromptSubmit`, `PreToolUse` and `PostToolUse`. The hook always exits 0 and prints nothing to stdout, so it can never block a tool call or inject text into the conversation.

By default the hooks go into `.claude/settings.local.json`, which holds your personal settings and is not meant to be committed. If git lists it as untracked, add it to `.gitignore`. Use `--shared` to write `.claude/settings.json`, which projects usually commit, when everyone on the project should get the hooks.

If snap-back is not installed globally, the hook command points at the absolute path of the copy you ran (for `npx`, a directory in the npx cache). That path exists only on your machine, so `--shared` prints a warning in that case. Run `npm install -g @abelo9996/snap-back` first to get the portable `snap-back hook claude` command, then install the hooks. Use `--command <cmd>` to set the command yourself.

`uninstall` takes `--shared` or `--local` to clean only one file. Reinstalling replaces hook entries from an earlier install that used a different command, including the `snapback hook claude` form from before the rename.

Claude Code's built-in rewind covers edits made through its own file tools. snap-back also covers files changed by shell commands (`rm`, codemods, formatters, generators) and works the same way across every agent you use.

### Agent Skill

`skills/snap-back/SKILL.md` teaches an agent to checkpoint before risky edits and how to roll back. Install it with:

```bash
npx skills add Abelo9996/snap-back
```

## Commands

```text
snap-back snap [-m label]               take a snapshot now
snap-back list [-n 20] [--all] [--json] list snapshots, newest first
snap-back diff                          what `undo` would revert
snap-back diff <id> [<id2>] [--stat]    compare a snapshot with now, or two snapshots
snap-back undo [--dry-run] [--yes]      roll back the last agent burst
snap-back restore <id> [--yes] [-- <paths>...]
                                       restore everything, or only some paths
snap-back watch [--debounce 1500]       snapshot on file changes
snap-back wrap [--interval 30] -- <cmd> checkpoint, run cmd, checkpoint
snap-back hooks install|uninstall|status --agent claude [--shared|--local]
snap-back gc [--keep 100] [--keep-days 14] [--yes]
snap-back status
```

All commands accept `--dir <path>`. By default the project is the nearest directory that already has snapshots, else the nearest git root, else the current directory.

Extra ignore patterns go in a `.snap-back-ignore` file at the project root (gitignore syntax). It is applied after the built-in list, so `!build/` there re-includes a built-in ignore. A `.snapbackignore` file from before the rename is still read.

## Limitations

- **Only files in the project are covered.** Database writes, network calls, deployed infrastructure, global package installs, pushed commits and messages sent cannot be undone by restoring files.
- `undo` reverts every file change since the marker it picks, including edits you made by hand after the agent finished. It lists the files first, and the safety snapshot it records keeps your edits, so `snap-back restore <safety-id> -- <path>` gets any of them back.
- Ignored files are not snapshotted. If an agent damages something in `node_modules/` or another ignored path, reinstall or rebuild it.
- Nested git repositories inside the project are recorded only as a pointer to their current commit, not their file contents; nested repositories with no commits are skipped.
- File watching (`watch`) can miss changes on network filesystems and some container mounts.
- Large binary files are stored in full each time they change. Run `snap-back gc` to prune old snapshots; ids of the remaining snapshots change after gc.
- On Windows, `wrap` runs the command through the shell so `.cmd` shims resolve; quote arguments accordingly.
- Agent detection in `watch` labels is a best-effort scan of the process list.

## Roadmap

- Hook integrations for more agents as they ship hook APIs (Codex, OpenCode, Cursor).
- `snap-back undo --interactive` to pick files from the last burst.
- Size limits for large binaries.
- A `snap-back log --agent <name>` filter and per-session grouping.

## Related projects

snap-back is part of a small set of tools for evaluating and living with coding agents:

- [nerf-watch](https://github.com/Abelo9996/nerf-watch): detects silent model and cost changes behind an API.
- [rerun-bench](https://github.com/Abelo9996/rerun-bench): measures how consistent an agent is across reruns of the same task.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports with a reproduction in a temp directory are the most useful kind.

## License

MIT. See [LICENSE](LICENSE).
