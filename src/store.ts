import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { requireGit, runGit, type RunOptions, type RunResult } from "./git.js";
import { withLock } from "./lock.js";
import { assertSafeRoot, canonical, shadowDirFor } from "./paths.js";

export const VERSION = "0.1.0";

export type SnapshotKind =
  | "manual"
  | "watch-start"
  | "watch"
  | "wrap-start"
  | "wrap"
  | "wrap-end"
  | "turn-start"
  | "pre-tool"
  | "post-tool"
  | "safety"
  | "restore";

/**
 * Kinds that mark the state *before* an agent burst. `undo` rolls back to the
 * newest one of these whose content differs from the current files.
 */
export const BOUNDARY_KINDS: ReadonlySet<SnapshotKind> = new Set<SnapshotKind>([
  "manual",
  "watch-start",
  "watch",
  "wrap-start",
  "turn-start",
  "restore",
]);

/** Boundary kinds are recorded even when nothing changed, so bursts never merge. */
const ALWAYS_RECORD: ReadonlySet<SnapshotKind> = new Set<SnapshotKind>([
  "manual",
  "watch-start",
  "wrap-start",
  "turn-start",
  "restore",
]);

export const BUILTIN_IGNORES = [
  ".git/",
  "node_modules/",
  ".venv/",
  "venv/",
  "__pycache__/",
  "*.pyc",
  ".mypy_cache/",
  ".pytest_cache/",
  ".ruff_cache/",
  ".tox/",
  "dist/",
  "build/",
  "out/",
  "target/",
  ".next/",
  ".nuxt/",
  ".svelte-kit/",
  ".turbo/",
  ".parcel-cache/",
  ".cache/",
  "coverage/",
  ".gradle/",
  ".terraform/",
  ".DS_Store",
  "Thumbs.db",
];

/**
 * Prefix of the bookkeeping files inside each shadow repository (lock, metadata,
 * nested-repo list). It keeps the spelling from before the rename to snap-back so
 * shadow repositories created by older versions keep working, and so old and new
 * versions running at the same time still share one lock.
 */
const STORAGE_PREFIX = "snapback";

/** Project files with extra ignore patterns. The first is the name used before the rename. */
export const IGNORE_FILES = [".snapbackignore", ".snap-back-ignore"];

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export interface Snapshot {
  id: string;
  hash: string;
  tree: string;
  time: Date;
  kind: SnapshotKind;
  label: string;
  agent?: string;
  filesChanged: number;
}

export interface SnapshotInput {
  kind: SnapshotKind;
  label?: string;
  agent?: string;
  force?: boolean;
}

export interface RestorePlan {
  target: Snapshot;
  /** Paths (relative to the project root, forward slashes) to write from the snapshot. */
  write: string[];
  /** Paths that exist now but not in the snapshot; they will be deleted. */
  remove: string[];
  paths?: string[];
}

export interface RestoreResult {
  safety: Snapshot;
  after: Snapshot | null;
  written: number;
  removed: number;
}

export class StoreError extends Error {}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function parseMessage(body: string): { label: string; kind: SnapshotKind; agent?: string } {
  const lines = body.replace(/\r/g, "").split("\n");
  const label = lines[0] ?? "";
  let kind: SnapshotKind = "manual";
  let agent: string | undefined;
  for (const line of lines) {
    // Trailer names predate the rename to snap-back; they are part of the storage format.
    const m = /^Snapback-(Kind|Agent):\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    if (m[1] === "Kind") kind = m[2].trim() as SnapshotKind;
    else agent = m[2].trim();
  }
  return { label, kind, agent };
}

function oneLine(s: string, max = 120): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 3) + "..." : flat;
}

export class Store {
  readonly root: string;
  readonly gitDir: string;

  private constructor(root: string) {
    this.root = canonical(root);
    this.gitDir = shadowDirFor(this.root);
  }

  /** Open the store for a project root. Creates the shadow repository on first use. */
  static async open(root: string, opts: { create?: boolean } = {}): Promise<Store> {
    requireGit();
    const s = new Store(root);
    assertSafeRoot(s.root);
    if (!existsSync(s.root) || !statSync(s.root).isDirectory()) {
      throw new StoreError(`Project directory does not exist: ${s.root}`);
    }
    if (!s.exists()) {
      if (opts.create === false) {
        throw new StoreError(`No snapshots yet for ${s.root}. Run \`snap-back snap\` to create the first one.`);
      }
      await s.init();
    }
    return s;
  }

  exists(): boolean {
    return existsSync(path.join(this.gitDir, "HEAD"));
  }

  private get lockPath(): string {
    return path.join(this.gitDir, `${STORAGE_PREFIX}.lock`);
  }

  private async init(): Promise<void> {
    mkdirSync(path.dirname(this.gitDir), { recursive: true });
    await runGit(["init", "--quiet", "--bare", this.gitDir]);
    await runGit(["--git-dir", this.gitDir, "config", "core.bare", "false"]);
    await runGit(["--git-dir", this.gitDir, "symbolic-ref", "HEAD", "refs/heads/main"]);
    // Keep the shadow repo independent of the user's global git settings that would
    // change file bytes or run code.
    const cfg: [string, string][] = [
      ["core.autocrlf", "false"],
      ["core.safecrlf", "false"],
      ["core.fsmonitor", "false"],
      ["core.quotepath", "false"],
      ["core.logAllRefUpdates", "false"],
      ["gc.auto", "0"],
      ["maintenance.auto", "false"],
      ["commit.gpgsign", "false"],
      ["user.name", "snap-back"],
      ["user.email", "snap-back@localhost"],
    ];
    for (const [k, v] of cfg) await runGit(["--git-dir", this.gitDir, "config", k, v]);
    mkdirSync(path.join(this.gitDir, "no-hooks"), { recursive: true });
    writeFileSync(
      path.join(this.gitDir, `${STORAGE_PREFIX}.json`),
      JSON.stringify({ root: this.root, created: new Date().toISOString(), version: VERSION }, null, 2) + "\n",
    );
    this.refreshExcludes();
  }

  /** Built-in ignores, then the project's .git/info/exclude, then .snapbackignore and .snap-back-ignore. */
  private refreshExcludes(): void {
    const parts = ["# snap-back built-in ignores", ...BUILTIN_IGNORES];
    const extras: [string, string][] = [
      [path.join(this.root, ".git", "info", "exclude"), ".git/info/exclude"],
      ...IGNORE_FILES.map((name): [string, string] => [path.join(this.root, name), name]),
    ];
    for (const [extra, name] of extras) {
      try {
        if (existsSync(extra) && statSync(extra).isFile()) {
          parts.push(`# from ${name}`);
          parts.push(readFileSync(extra, "utf8"));
        }
      } catch {
        // unreadable exclude files are not fatal
      }
    }
    try {
      parts.push("# nested git repositories without commits", readFileSync(this.nestedFile, "utf8"));
    } catch {
      // none recorded
    }
    const content = parts.join("\n") + "\n";
    const file = path.join(this.gitDir, "info", "exclude");
    mkdirSync(path.dirname(file), { recursive: true });
    let old = "";
    try {
      old = readFileSync(file, "utf8");
    } catch {
      // first write
    }
    if (old !== content) writeFileSync(file, content);
    // Store and restore exact bytes: no line-ending conversion, no clean/smudge
    // filters (git-lfs and friends), whatever the project's .gitattributes says.
    const attrs = path.join(this.gitDir, "info", "attributes");
    if (!existsSync(attrs)) writeFileSync(attrs, "* -text -eol -filter -ident -working-tree-encoding\n");
  }

  /** Run git against the shadow repo with the project as its work tree. */
  git(args: string[], opts: RunOptions = {}): Promise<RunResult> {
    const base = [
      "--git-dir",
      this.gitDir,
      "--work-tree",
      this.root,
      "--literal-pathspecs",
      "-c",
      `core.hooksPath=${path.join(this.gitDir, "no-hooks")}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "advice.addEmbeddedRepo=false",
      "-c",
      "commit.gpgsign=false",
    ];
    return runGit([...base, ...args], { cwd: this.root, ...opts });
  }

  private async headHash(): Promise<string | null> {
    const r = await this.git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { allowFail: true });
    return r.code === 0 ? r.stdout.trim() : null;
  }

  /** Stage the whole work tree into the shadow index and return its tree hash. Caller holds the lock. */
  private async stageTree(): Promise<string> {
    this.refreshExcludes();
    // A nested git repository without a commit makes `git add` fail outright.
    // Exclude each one we hit (remembered in the shadow repo) and try again.
    for (let attempt = 0; ; attempt++) {
      const r = await this.git(["add", "-A", "--ignore-errors", "."], { allowFail: true });
      if (r.code === 0) break;
      const nested = /error: '(.+?)\/?' does not have a commit checked out/.exec(r.stderr);
      if (nested && attempt < 50) {
        this.addNestedRepo(nested[1]);
        this.refreshExcludes();
        continue;
      }
      if (/^fatal:/m.test(r.stderr) || !/^(warning|error): /m.test(r.stderr)) {
        throw new StoreError(`git add failed: ${r.stderr.trim()}`);
      }
      // Unreadable files and similar per-file errors: snapshot everything else.
      break;
    }
    return (await this.git(["write-tree"])).stdout.trim();
  }

  private get nestedFile(): string {
    return path.join(this.gitDir, `${STORAGE_PREFIX}-nested-repos`);
  }

  private addNestedRepo(rel: string): void {
    const line = "/" + rel.replace(/\/+$/, "") + "/";
    let cur = "";
    try {
      cur = readFileSync(this.nestedFile, "utf8");
    } catch {
      // first entry
    }
    if (!cur.split("\n").includes(line)) writeFileSync(this.nestedFile, cur + line + "\n");
  }

  /** Tree hash for the files as they are right now (does not create a snapshot). */
  async currentTree(): Promise<string> {
    return withLock(this.lockPath, () => this.stageTree());
  }

  /**
   * Record a snapshot. Returns null when nothing changed since the previous
   * snapshot and the kind does not need an explicit marker.
   */
  async snapshot(input: SnapshotInput): Promise<Snapshot | null> {
    return withLock(this.lockPath, () => this.snapshotLocked(input));
  }

  private async snapshotLocked(input: SnapshotInput): Promise<Snapshot | null> {
    const tree = await this.stageTree();
    const head = await this.headHash();
    if (head) {
      const headTree = (await this.git(["rev-parse", `${head}^{tree}`])).stdout.trim();
      if (headTree === tree && !input.force && !ALWAYS_RECORD.has(input.kind)) return null;
    }
    const label = oneLine(input.label || input.kind);
    const lines = [label, "", `Snapback-Kind: ${input.kind}`];
    if (input.agent) lines.push(`Snapback-Agent: ${oneLine(input.agent, 60)}`);
    const args = ["commit-tree", tree];
    if (head) args.push("-p", head);
    const hash = (await this.git(args, { input: lines.join("\n") + "\n" })).stdout.trim();
    await this.git(["update-ref", "refs/heads/main", hash]);
    return this.get(hash);
  }

  async get(ref: string): Promise<Snapshot> {
    const list = await this.log([ref, "-n", "1"]);
    if (!list.length) throw new StoreError(`Unknown snapshot: ${ref}`);
    return list[0];
  }

  private async log(extra: string[]): Promise<Snapshot[]> {
    const r = await this.git(["log", "--format=%x1e%H%x1f%T%x1f%ct%x1f%B%x1f", "--shortstat", ...extra, "--"], {
      allowFail: true,
    });
    if (r.code !== 0) return [];
    const out: Snapshot[] = [];
    for (const rec of r.stdout.split("\x1e")) {
      if (!rec.trim()) continue;
      const [hash, tree, ct, body, stat = ""] = rec.split("\x1f");
      const meta = parseMessage(body);
      const m = /(\d+) files? changed/.exec(stat);
      out.push({
        id: hash.slice(0, 8),
        hash,
        tree,
        time: new Date(Number(ct) * 1000),
        kind: meta.kind,
        label: meta.label,
        agent: meta.agent,
        filesChanged: m ? Number(m[1]) : 0,
      });
    }
    return out;
  }

  /** Snapshots, newest first. */
  async list(limit?: number): Promise<Snapshot[]> {
    if (!(await this.headHash())) return [];
    return this.log(limit ? ["-n", String(limit), "HEAD"] : ["HEAD"]);
  }

  /** Resolve a user-supplied id (hash prefix, or `HEAD~n`) to a snapshot. */
  async resolve(ref: string): Promise<Snapshot> {
    if (!/^[0-9a-fA-F]{4,40}$/.test(ref) && !/^HEAD(~\d+)?$/.test(ref)) {
      throw new StoreError(`Not a snapshot id: ${ref}. Run \`snap-back list\` to see ids.`);
    }
    const r = await this.git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowFail: true });
    if (r.code !== 0) throw new StoreError(`Unknown snapshot: ${ref}. Run \`snap-back list\` to see ids.`);
    const hash = r.stdout.trim();
    // Only accept commits that are part of this project's snapshot history.
    const anc = await this.git(["merge-base", "--is-ancestor", hash, "HEAD"], { allowFail: true });
    if (anc.code !== 0) throw new StoreError(`Snapshot ${ref} is not in this project's history.`);
    return this.get(hash);
  }

  /** The snapshot `undo` would roll back to, or null if there is nothing to undo. */
  async undoTarget(): Promise<Snapshot | null> {
    const current = await this.currentTree();
    const all = await this.list();
    const boundary = all.find((s) => BOUNDARY_KINDS.has(s.kind) && s.tree !== current);
    if (boundary) return boundary;
    return all.find((s) => s.tree !== current) ?? null;
  }

  /** Convert user paths (relative to cwd or absolute) into project-relative pathspecs. */
  toProjectPaths(paths: string[], cwd = process.cwd()): string[] {
    return paths.map((p) => {
      const abs = path.resolve(cwd, p);
      let rel = path.relative(this.root, abs);
      if (rel !== "" && path.isAbsolute(rel)) rel = path.relative(this.root, canonical(abs));
      if (rel.startsWith("..") || path.isAbsolute(rel)) throw new StoreError(`Path is outside the project: ${p}`);
      return rel === "" ? "." : rel.split(path.sep).join("/");
    });
  }

  private async treeDiff(fromTree: string, toTree: string, paths?: string[]): Promise<{ write: string[]; remove: string[] }> {
    const args = ["diff-tree", "-r", "-z", "--no-renames", "--name-status", fromTree, toTree];
    if (paths?.length) args.push("--", ...paths);
    const out = (await this.git(args)).stdout.split("\0").filter((x) => x !== "");
    const write: string[] = [];
    const remove: string[] = [];
    for (let i = 0; i + 1 < out.length; i += 2) {
      const status = out[i];
      const file = out[i + 1];
      if (status === "D") remove.push(file);
      else write.push(file);
    }
    return { write, remove };
  }

  /** What restoring `ref` would change, compared with the files right now. */
  async planRestore(ref: string, paths?: string[]): Promise<RestorePlan> {
    const target = await this.resolve(ref);
    const current = await this.currentTree();
    const { write, remove } = await this.treeDiff(current, target.tree, paths);
    return { target, write, remove, paths };
  }

  /**
   * Restore files to a snapshot. Always records a safety snapshot of the
   * current files first, so the restore itself can be undone.
   */
  async restore(ref: string, paths?: string[]): Promise<RestoreResult> {
    const target = await this.resolve(ref);
    return withLock(this.lockPath, async () => {
      const safety = await this.snapshotLocked({
        kind: "safety",
        label: `before restore to ${target.id}${paths?.length ? " (" + paths.join(", ") + ")" : ""}`,
        force: true,
      });
      if (!safety) throw new StoreError("could not record safety snapshot");
      const { write, remove } = await this.treeDiff(safety.tree, target.tree, paths);

      // Deletions first, so a file can be replaced by a directory of the same name.
      for (const rel of remove) this.removeFile(rel);
      for (const group of chunk(write, 200)) {
        await this.git(["checkout", target.hash, "--", ...group]);
      }
      const after = await this.snapshotLocked({
        kind: "restore",
        label: `restored ${paths?.length ? paths.join(", ") + " from " : "to "}${target.id}`,
      });
      return { safety, after, written: write.length, removed: remove.length };
    });
  }

  private removeFile(rel: string): void {
    const abs = path.resolve(this.root, rel);
    const relCheck = path.relative(this.root, abs);
    if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) {
      throw new StoreError(`Refusing to delete a path outside the project: ${rel}`);
    }
    try {
      const st = lstatSync(abs);
      if (st.isDirectory()) return; // a tracked path is always a file or symlink
      rmSync(abs, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    // Remove directories that became empty because of this deletion.
    let dir = path.dirname(abs);
    while (dir !== this.root && dir.startsWith(this.root + path.sep)) {
      try {
        if (readdirSync(dir).length > 0) break;
        rmdirSync(dir);
      } catch {
        break;
      }
      dir = path.dirname(dir);
    }
  }

  /** Unified diff text between two snapshots, or a snapshot and the current files. */
  async diff(opts: { from: string; to?: string; paths?: string[]; stat?: boolean; nameOnly?: boolean; color?: boolean }): Promise<string> {
    const from = (await this.resolve(opts.from)).tree;
    const to = opts.to ? (await this.resolve(opts.to)).tree : await this.currentTree();
    const args = ["diff", "--no-ext-diff", "--no-textconv", opts.color ? "--color=always" : "--no-color"];
    if (opts.stat) args.push("--stat");
    if (opts.nameOnly) args.push("--name-status");
    args.push(from, to);
    if (opts.paths?.length) args.push("--", ...opts.paths);
    return (await this.git(args)).stdout;
  }

  /** Paths that differ between two snapshots. */
  async changedBetween(fromRef: string, toRef: string): Promise<string[]> {
    const a = await this.resolve(fromRef);
    const b = await this.resolve(toRef);
    const { write, remove } = await this.treeDiff(a.tree, b.tree);
    return [...write, ...remove].sort();
  }

  /** Number of files that differ between the latest snapshot and the current files. */
  async pendingChanges(): Promise<number> {
    const head = await this.headHash();
    const current = await this.currentTree();
    const base = head ? (await this.git(["rev-parse", `${head}^{tree}`])).stdout.trim() : EMPTY_TREE;
    const { write, remove } = await this.treeDiff(base, current);
    return write.length + remove.length;
  }

  /**
   * Drop old snapshots. Keeps every snapshot newer than `keepDays` and at least
   * the newest `keep`. History is rewritten, so the ids of kept snapshots change.
   */
  async gc(opts: { keep: number; keepDays: number }): Promise<{ before: number; after: number }> {
    return withLock(this.lockPath, async () => {
      const head = await this.headHash();
      if (!head) return { before: 0, after: 0 };
      const r = await this.git(["log", "--reverse", "--format=%H%x1f%T%x1f%at%x1f%ct%x1f%B%x1e", "HEAD"]);
      const commits = r.stdout
        .split("\x1e")
        .map((x) => x.replace(/^\n/, ""))
        .filter((x) => x.trim())
        .map((x) => {
          const [hash, tree, at, ct, body] = x.split("\x1f");
          return { hash, tree, at: Number(at), ct: Number(ct), body };
        });
      const cutoff = Date.now() / 1000 - opts.keepDays * 86400;
      let start = Math.max(0, commits.length - Math.max(1, opts.keep));
      const firstRecent = commits.findIndex((c) => c.ct >= cutoff);
      if (firstRecent !== -1) start = Math.min(start, firstRecent);
      if (start > 0) {
        let parent: string | null = null;
        for (const c of commits.slice(start)) {
          const args = ["commit-tree", c.tree];
          if (parent) args.push("-p", parent);
          parent = (
            await this.git(args, {
              input: c.body,
              env: { GIT_AUTHOR_DATE: `@${c.at} +0000`, GIT_COMMITTER_DATE: `@${c.ct} +0000` },
            })
          ).stdout.trim();
        }
        await this.git(["update-ref", "refs/heads/main", parent!]);
      }
      await this.git(["reflog", "expire", "--expire=now", "--all"], { allowFail: true });
      await this.git(["gc", "--prune=now", "--quiet"], { allowFail: true });
      return { before: commits.length, after: commits.length - start };
    });
  }

  /** Bytes used by the shadow repository. */
  diskUsage(): number {
    let total = 0;
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else
          try {
            total += statSync(p).size;
          } catch {
            // ignore files removed mid-walk
          }
      }
    };
    walk(this.gitDir);
    return total;
  }
}
