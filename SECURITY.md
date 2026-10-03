# Security policy

snap-back writes to and restores files in your project, so bugs that lose data or touch files outside the project are treated as security issues.

## Reporting

Report privately through GitHub: open the [Security tab](https://github.com/Abelo9996/snap-back/security) and choose "Report a vulnerability". Please do not open a public issue.

Include the snap-back version or commit, your OS, the commands you ran, and what happened to which files.

You can expect an acknowledgement within 7 days.

## In scope

- A restore or undo that deletes or overwrites files it should not, or loses data without a safety snapshot
- Any change to the project's own `.git` directory, index, branches or stash
- Path handling that lets a snapshot or restore reach outside the project root
- The hooks installer clobbering existing agent settings

## Out of scope

External side effects an agent caused (database writes, network calls, files outside the project), which snap-back documents that it cannot undo.

## Supported versions

Only the latest release and `main` receive fixes while the project is at 0.x.
