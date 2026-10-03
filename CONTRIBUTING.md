# Contributing to snapback

Thanks for helping. snapback rewrites files in people's projects, so the bar for
changes to snapshot and restore code is correctness first.

## Setup

```bash
git clone https://github.com/Abelo9996/snapback
cd snapback
npm install        # also builds dist/ through the prepare script
npm test           # builds, then runs the vitest suite
npm run typecheck
```

Run the CLI from your checkout with `node dist/cli.js <command>` after `npm run build`.

## Ground rules

- **Tests use temporary directories only.** Never point a test, or a manual
  experiment with `undo` or `restore`, at a real project. Set `SNAPBACK_HOME` to a
  temp directory so snapshots do not land in your real storage directory.
- **Never touch the user's `.git`.** Every git call must go through `Store.git()`
  (explicit `--git-dir` and `--work-tree`, cleaned environment). The test
  "is never modified: HEAD, index, stash, refs and objects stay identical" must
  keep passing on every platform.
- **Anything that deletes or overwrites files needs a test** that shows the
  safety snapshot can bring the previous state back.
- Keep runtime dependencies minimal. Currently: `cac` and `chokidar`.
- CI runs on Linux, macOS and Windows with Node 20 and 22. Watch for path
  separators and line endings.

## Adding an agent integration

If an agent exposes hooks (like Claude Code's `PreToolUse`), add an installer in
`src/hooks.ts` that merges into the agent's config without clobbering it and
backs it up first, plus a handler that maps the agent's events to snapshot kinds.
Open an "Agent integration request" issue first if you are unsure about the
agent's hook format.

## Pull requests

- One topic per pull request, with a short description of the user-visible change.
- Add an entry under `Unreleased` in `CHANGELOG.md`.
- Plain writing in docs and CLI output: say what happens, skip the adjectives.
