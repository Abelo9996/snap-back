#!/usr/bin/env node
import path from "node:path";
import { createInterface } from "node:readline";
import { cac } from "cac";
import { GitMissingError, gitVersion } from "./git.js";
import {
  claudeHookStatus,
  handleClaudeHook,
  type HookScope,
  installClaudeHooks,
  runningFromNpxCache,
  uninstallClaudeHooks,
} from "./hooks.js";
import { findProjectRoot, UnsafeRootError } from "./paths.js";
import { InterruptedError } from "./lock.js";
import { Store, StoreError, VERSION, type RestorePlan, type RestoreResult, type Snapshot } from "./store.js";
import { watchProject } from "./watch.js";
import { wrapCommand } from "./wrap.js";

const useColor = !process.env.NO_COLOR && process.stdout.isTTY;
const c = (code: number, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s: string) => c(2, s);
const bold = (s: string) => c(1, s);
const red = (s: string) => c(31, s);
const green = (s: string) => c(32, s);
const yellow = (s: string) => c(33, s);

// `snap-back list | head` closes the pipe early; that is not an error.
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE" || e.code === "EOF") process.exit(0);
  throw e;
});

const out = (s = "") => process.stdout.write(s + "\n");
const err = (s = "") => process.stderr.write(s + "\n");

interface GlobalOpts {
  dir?: string;
  yes?: boolean;
  "--"?: string[];
}

function rootFrom(opts: GlobalOpts): string {
  return findProjectRoot(opts.dir ?? process.cwd());
}

async function openStore(opts: GlobalOpts, create = true): Promise<Store> {
  return Store.open(rootFrom(opts), { create });
}

const NO_SNAPSHOTS_HINT = [
  "snap-back can only roll back changes made after a checkpoint. Next time, start the agent with",
  "`snap-back wrap -- <agent>`, keep `snap-back watch` running, or run `snap-back hooks install` for Claude Code.",
].join("\n");

/** Open an existing store, or explain that there is nothing recorded yet. Returns null after printing. */
async function openExisting(opts: GlobalOpts, what: string): Promise<Store | null> {
  const root = rootFrom(opts);
  try {
    return await Store.open(root, { create: false });
  } catch (e) {
    if (!(e instanceof StoreError) || !/No snapshots yet/.test(e.message)) throw e;
    err(`snap-back: nothing to ${what}: there are no snapshots for ${root} yet.`);
    err(NO_SNAPSHOTS_HINT);
    process.exitCode = 1;
    return null;
  }
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function fmtTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function ago(d: Date): string {
  const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function describe(s: Snapshot): string {
  return `${bold(s.id)} ${dim("(" + fmtTime(s.time) + ", " + ago(s.time) + ")")} ${s.label}`;
}

async function confirm(question: string, opts: GlobalOpts): Promise<boolean> {
  if (opts.yes) return true;
  if (!process.stdin.isTTY) {
    err("Not running in an interactive terminal. Re-run with --yes to confirm.");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>((r) => rl.question(`${question} [y/N] `, r));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function printPlan(plan: RestorePlan, max = 30): void {
  const rows = [
    ...plan.write.map((p) => ({ p, t: green("restore") })),
    ...plan.remove.map((p) => ({ p, t: red("delete ") })),
  ].sort((a, b) => a.p.localeCompare(b.p));
  for (const r of rows.slice(0, max)) out(`  ${r.t}  ${r.p}`);
  if (rows.length > max) out(dim(`  ...and ${rows.length - max} more`));
}

function printLeftAlone(plan: RestorePlan, max = 10): void {
  if (plan.keep.length) {
    out("Left alone: the snapshot's ignore rules (such as its .gitignore) excluded these, so snap-back never recorded them:");
    for (const p of plan.keep.slice(0, max)) out(`  ${yellow("keep   ")}  ${p}`);
    if (plan.keep.length > max) out(dim(`  ...and ${plan.keep.length - max} more`));
  }
  if (plan.nested.length) {
    out("Not restored: nested git repositories. snap-back records only their commit, not their files:");
    for (const p of plan.nested.slice(0, max)) out(`  ${yellow("skip   ")}  ${p}/`);
    if (plan.nested.length > max) out(dim(`  ...and ${plan.nested.length - max} more`));
  }
}

async function runRestore(
  store: Store,
  ref: string,
  paths: string[] | undefined,
  opts: GlobalOpts & { dryRun?: boolean },
  heading: string,
  undo = false,
): Promise<number> {
  const plan = await store.planRestore(ref, paths);
  out(heading);
  if (store.root !== process.cwd()) out(dim(`Project: ${store.root}`));
  if (!plan.write.length && !plan.remove.length) {
    printLeftAlone(plan);
    out("Files already match that snapshot. Nothing to do.");
    return 0;
  }
  out(`${plural(plan.write.length, "file")} to restore, ${plural(plan.remove.length, "file")} to delete:`);
  printPlan(plan);
  printLeftAlone(plan);
  if (opts.dryRun) {
    out(dim("Dry run: nothing changed."));
    return 0;
  }
  out(dim("Your current files are saved as a safety snapshot first, so this can be reversed."));
  if (!(await confirm("Proceed?", opts))) {
    out("Cancelled. Nothing changed.");
    return 1;
  }
  let res: RestoreResult;
  let code = 0;
  try {
    res = await store.restore(ref, paths, { undo });
  } catch (e) {
    if (!(e instanceof InterruptedError)) throw e;
    res = e.value as RestoreResult;
    err("snap-back: interrupted, but the restore had already started, so it was completed first.");
    code = 130;
  }
  out(`Done: ${res.written} restored, ${res.removed} deleted.`);
  out(`Your files from before this ${undo ? "undo" : "restore"} are saved as ${bold(res.safety.id)}. To get them back: snap-back restore ${res.safety.id}`);
  return code;
}

const cli = cac("snap-back");
cli.option("--dir <path>", "Project directory (default: the git root or snap-back project containing the cwd)");

cli
  .command("snap", "Take a snapshot now")
  .option("-m, --message <label>", "Label for the snapshot")
  .action(async (opts: GlobalOpts & { message?: string }) => {
    const store = await openStore(opts);
    const s = await store.snapshot({ kind: "manual", label: opts.message || "manual checkpoint" });
    out(`Snapshot ${bold(s!.id)} (${s!.filesChanged} file(s) changed since the previous one)`);
  });

cli
  .command("list", "List snapshots, newest first")
  .alias("ls")
  .option("-n, --limit <n>", "How many to show", { default: 20 })
  .option("--all", "Show every snapshot")
  .option("--json", "Machine-readable output")
  .action(async (opts: GlobalOpts & { limit: number; all?: boolean; json?: boolean }) => {
    const store = await openStore(opts, false).catch((e) => {
      if (e instanceof StoreError) return null;
      throw e;
    });
    const list = store ? await store.list(opts.all ? undefined : Number(opts.limit)) : [];
    if (opts.json) {
      out(JSON.stringify(list.map((s) => ({ ...s, time: s.time.toISOString() })), null, 2));
      return;
    }
    if (!list.length) {
      out("No snapshots yet. Take one with `snap-back snap`, or start `snap-back watch`.");
      return;
    }
    out(dim(`${pad("ID", 9)} ${pad("TIME", 19)} ${pad("AGO", 8)} ${pad("KIND", 11)} ${pad("CHANGED", 7)} LABEL`));
    for (const s of list) {
      const label = s.agent ? `${s.label} ${dim("[" + s.agent + "]")}` : s.label;
      out(`${bold(pad(s.id, 9))} ${pad(fmtTime(s.time), 19)} ${pad(ago(s.time), 8)} ${pad(s.kind, 11)} ${pad(String(s.filesChanged), 7)} ${label}`);
    }
    out(dim("CHANGED: files that differ from the snapshot below it. Roll back the last burst with `snap-back undo`."));
  });

cli
  .command("diff [from] [to]", "Show changes. No ids: what `undo` would revert. One id: that snapshot vs now.")
  .option("--stat", "Summary only")
  .option("--name-only", "File names and status only")
  .action(async (from: string | undefined, to: string | undefined, opts: GlobalOpts & { stat?: boolean; nameOnly?: boolean }) => {
    const store = await openExisting(opts, "diff");
    if (!store) return;
    let base = from;
    if (!base) {
      const t = await store.undoTarget();
      if (!t) {
        out("No changes to undo, so nothing to compare. Use `snap-back diff <id>` to compare a snapshot from `snap-back list` with now.");
        return;
      }
      base = t.hash;
      err(dim(`Comparing ${t.id} (${t.label}) with the current files`));
    }
    const paths = opts["--"]?.length ? store.toProjectPaths(opts["--"]) : undefined;
    const text = await store.diff({ from: base, to, paths, stat: opts.stat, nameOnly: opts.nameOnly, color: useColor });
    process.stdout.write(text || "No differences.\n");
  });

cli
  .command("undo", "Roll back to the snapshot before the last agent burst")
  .option("-y, --yes", "Do not ask for confirmation")
  .option("--dry-run", "Show what would change without changing anything")
  .action(async (opts: GlobalOpts & { dryRun?: boolean }) => {
    const store = await openExisting(opts, "undo");
    if (!store) return;
    const target = await store.undoTarget();
    if (!target) {
      const last = await store.lastUndo();
      if (last && last.undo.tree === (await store.currentTree())) {
        out(`Nothing older to undo: the last undo (${last.undo.id}, ${ago(last.undo.time)}) already went back to the oldest recorded change.`);
        if (last.safety) out(`To reverse that undo: snap-back restore ${last.safety.id}`);
      } else {
        out("Nothing to undo: every checkpoint matches the current files.");
      }
      return;
    }
    process.exitCode = await runRestore(store, target.hash, undefined, opts, `Undo rolls back to ${describe(target)}`, true);
  });

cli
  .command("restore <id>", "Restore files to a snapshot. Add `-- <paths>` to restore only some paths.")
  .option("-y, --yes", "Do not ask for confirmation")
  .option("--dry-run", "Show what would change without changing anything")
  .action(async (id: string, opts: GlobalOpts & { dryRun?: boolean }) => {
    const store = await openExisting(opts, "restore");
    if (!store) return;
    const paths = opts["--"]?.length ? store.toProjectPaths(opts["--"]) : undefined;
    const target = await store.resolve(id);
    process.exitCode = await runRestore(store, target.hash, paths, opts, `Restoring ${paths ? paths.join(", ") + " from " : ""}${describe(target)}`);
  });

cli
  .command("watch", "Snapshot automatically whenever files change")
  .option("--debounce <ms>", "Quiet period that ends a burst of changes", { default: 1500 })
  .action(async (opts: GlobalOpts & { debounce: number }) => {
    const store = await openStore(opts);
    const first = await store.snapshot({ kind: "watch-start", label: "watch started" });
    err(`snap-back: watching ${store.root} (baseline ${first!.id}). Ctrl-C to stop.`);
    const handle = watchProject(store, {
      debounceMs: Number(opts.debounce),
      onSnapshot: (s) => err(`snap-back: ${s.id} ${fmtTime(s.time)} ${s.filesChanged} file(s)${s.agent ? " [" + s.agent + "]" : ""}`),
      onError: (e) => err(`snap-back: snapshot failed: ${(e as Error).message}`),
    });
    await handle.ready;
    await new Promise<void>((resolve) => {
      const stop = () => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        void handle.close().then(resolve);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });
    err("snap-back: stopped watching.");
  });

cli
  .command("wrap", "Run an agent command between two checkpoints: snap-back wrap -- <command>")
  .option("--interval <seconds>", "Also snapshot every N seconds while it runs (0 disables)", { default: 30 })
  .allowUnknownOptions()
  .action(async (opts: GlobalOpts & { interval: number }) => {
    const argv = opts["--"] ?? [];
    if (!argv.length) {
      err("Usage: snap-back wrap -- <agent command>   (for example: snap-back wrap -- codex)");
      process.exitCode = 1;
      return;
    }
    const store = await openStore(opts);
    const res = await wrapCommand(store, argv, { intervalMs: Number(opts.interval) * 1000, log: err });
    process.exitCode = res.exitCode;
  });

cli
  .command("hooks <action>", "Install or remove agent hooks: hooks install|uninstall|status --agent claude")
  .option("--agent <name>", "Agent to integrate with", { default: "claude" })
  .option("--shared", "Use .claude/settings.json, which projects usually commit, instead of .claude/settings.local.json")
  .option("--local", "Use only .claude/settings.local.json (the default for install)")
  .option("--command <cmd>", "Command that runs snap-back inside the hook (default: auto-detected)")
  .action(async (action: string, opts: GlobalOpts & { agent: string; shared?: boolean; local?: boolean; command?: string }) => {
    if (opts.agent !== "claude") {
      err(`No hook integration for "${opts.agent}" yet. Use \`snap-back wrap -- ${opts.agent}\` or \`snap-back watch\` instead.`);
      process.exitCode = 1;
      return;
    }
    if (opts.shared && opts.local) {
      err("Pass either --shared or --local, not both.");
      process.exitCode = 1;
      return;
    }
    const root = rootFrom(opts);
    const rel = (file: string) => path.relative(root, file).split(path.sep).join("/");
    const scope: HookScope | undefined = opts.shared ? "shared" : opts.local ? "local" : undefined;
    if (action === "install") {
      const r = installClaudeHooks(root, { shared: opts.shared, command: opts.command });
      if (!r.added.length) {
        out(`snap-back hooks are already installed in ${r.file}`);
      } else {
        out(`Added snap-back hooks (${r.added.join(", ")}) to ${r.file}`);
        if (r.replaced) out(`Replaced ${r.replaced} hook(s) from an earlier install that used a different command.`);
        if (r.backup) out(`Backup of the previous file: ${r.backup}`);
        out(`Hook command: ${r.command}`);
      }
      if (r.scope === "shared" && r.machineSpecific) {
        err(yellow(`Warning: the hook command contains a path that exists only on this machine:`));
        err(yellow(`  ${r.command}`));
        err(yellow(`${rel(r.file)} is usually committed, and anyone else who uses it gets a hook that fails.`));
        err(yellow("Install snap-back globally so the hook can use the portable command `snap-back hook claude`:"));
        err(yellow("  npm install -g @abelo9996/snap-back"));
        err(yellow("  snap-back hooks install --shared"));
        err(yellow("Or run `snap-back hooks install` without --shared to keep the hooks in .claude/settings.local.json."));
      } else if (r.added.length && runningFromNpxCache() && !opts.command) {
        out(yellow("Note: snap-back is running from the npx cache, so the hook points into that cache."));
        out(yellow("For a stable hook, run `npm install -g @abelo9996/snap-back` and then reinstall the hooks."));
      }
      if (r.scope === "local" && r.created) {
        out(`${rel(r.file)} holds personal settings. If git lists it as untracked, add it to .gitignore.`);
      }
      if (r.alsoIn) {
        const flag = r.scope === "shared" ? "--local" : "--shared";
        out(`snap-back hooks are also in ${rel(r.alsoIn)}. To remove them from there: snap-back hooks uninstall ${flag}`);
      }
      if (r.added.length) out("Restart Claude Code (or open /hooks) so it picks up the new hooks.");
    } else if (action === "uninstall") {
      const { results, errors } = uninstallClaudeHooks(root, { scope });
      for (const r of results) {
        out(r.removed ? `Removed ${r.removed} snap-back hook(s) from ${r.file}` : `No snap-back hooks found in ${r.file}`);
        if (r.backup) out(`Backup of the previous file: ${r.backup}`);
      }
      for (const e of errors) err(`snap-back: ${e.message}`);
      if (errors.length) process.exitCode = 1;
    } else if (action === "status") {
      for (const st of claudeHookStatus(root)) {
        if (scope && st.scope !== scope) continue;
        const state = st.error ? `unreadable (${st.error})` : st.installed ? "installed" : "not installed";
        out(`Claude Code hooks in ${rel(st.file)}: ${state}`);
      }
    } else {
      err(`Unknown action "${action}". Use install, uninstall or status.`);
      process.exitCode = 1;
    }
  });

cli.command("hook <agent>", "Internal: called by agent hooks").action(async (agent: string) => {
  // Never fail the agent's tool call: errors go to stderr, exit code stays 0.
  try {
    const chunks: Buffer[] = [];
    if (!process.stdin.isTTY) for await (const ch of process.stdin) chunks.push(ch as Buffer);
    if (agent === "claude") await handleClaudeHook(Buffer.concat(chunks).toString("utf8"));
  } catch (e) {
    err(`snap-back hook: ${(e as Error).message}`);
  }
  process.exitCode = 0;
});

cli
  .command("gc", "Delete old snapshots")
  .option("--keep <n>", "Always keep at least the newest N snapshots", { default: 100 })
  .option("--keep-days <days>", "Keep every snapshot newer than this many days", { default: 14 })
  .option("-y, --yes", "Do not ask for confirmation")
  .action(async (opts: GlobalOpts & { keep: number; keepDays: number }) => {
    const store = await openStore(opts, false);
    if (!(await confirm("Prune old snapshots? Ids of the remaining snapshots will change.", opts))) {
      out("Cancelled.");
      return;
    }
    const before = store.diskUsage();
    const r = await store.gc({ keep: Number(opts.keep), keepDays: Number(opts.keepDays) });
    const after = store.diskUsage();
    out(`Kept ${r.after} of ${r.before} snapshots. Storage: ${(before / 1e6).toFixed(1)} MB -> ${(after / 1e6).toFixed(1)} MB`);
  });

cli.command("status", "Show where snapshots live and what changed since the last one").action(async (opts: GlobalOpts) => {
  const root = rootFrom(opts);
  out(`project:   ${root}`);
  out(`git:       ${gitVersion() ?? red("not found")}`);
  const store = await Store.open(root, { create: false }).catch(() => null);
  if (!store) {
    out("snapshots: none yet (run `snap-back snap` or `snap-back watch`)");
  } else {
    const all = await store.list();
    out(`storage:   ${store.gitDir} (${(store.diskUsage() / 1e6).toFixed(1)} MB)`);
    out(`snapshots: ${all.length}`);
    if (all[0]) out(`latest:    ${describe(all[0])}`);
    out(`pending:   ${await store.pendingChanges()} file(s) changed since the latest snapshot`);
  }
  const installedIn = claudeHookStatus(root)
    .filter((st) => st.installed)
    .map((st) => path.relative(root, st.file).split(path.sep).join("/"));
  out(`hooks:     Claude Code ${installedIn.length ? "installed in " + installedIn.join(" and ") : "not installed"}`);
});

cli.help();
cli.version(VERSION);

async function main(): Promise<void> {
  try {
    cli.parse(process.argv, { run: false });
    if (!cli.matchedCommand) {
      if (cli.args.length) {
        err(`Unknown command: ${cli.args[0]}`);
        process.exitCode = 1;
      }
      if (!cli.options.help && !cli.options.version) cli.outputHelp();
      return;
    }
    await cli.runMatchedCommand();
  } catch (e) {
    if (e instanceof InterruptedError) {
      err(`snap-back: ${e.message}`);
      process.exitCode = 130;
      return;
    }
    if (e instanceof GitMissingError) {
      err(e.message);
      process.exitCode = 2;
      return;
    }
    if (e instanceof StoreError || e instanceof UnsafeRootError) {
      err(`snap-back: ${e.message}`);
    } else {
      err(`snap-back: ${(e as Error).message}`);
      if (process.env.SNAP_BACK_DEBUG || process.env.SNAPBACK_DEBUG) err((e as Error).stack ?? "");
    }
    process.exitCode = 1;
  }
}

void main();
