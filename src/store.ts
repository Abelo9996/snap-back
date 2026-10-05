import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitAtLeast, requireGit, runGit, type RunOptions, type RunResult } from "./git.js";
import { withLock } from "./lock.js";
import { assertSafeRoot, canonical, shadowDirFor } from "./paths.js";

export const VERSION = "0.1.2";

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
  /** For the snapshot an `undo` records after restoring: the snapshot it restored to. */
  undoOf?: string;
  filesChanged: number;
}

export interface SnapshotInput {
  kind: SnapshotKind;
  label?: string;
  agent?: string;
  undoOf?: string;
  force?: boolean;
}

export interface RestorePlan {
  target: Snapshot;
  /** Paths (relative to the project root, forward slashes) to write from the snapshot. */
  write: string[];
  /** Paths that exist now but not in the snapshot; they will be deleted. */
  remove: string[];
  /**
   * Paths that exist now and are missing from the snapshot only because the
   * snapshot's ignore rules excluded them (for example `.env` when an agent
   * rewrote .gitignore). snap-back never recorded them, so it leaves them alone.
   */
  keep: string[];
  /**
   * Nested git repositories that differ. snap-back records only their commit,
   * not their files, so it cannot restore or remove them.
   */
  nested: string[];
  paths?: string[];
}

export interface RestoreResult {
  safety: Snapshot;
  after: Snapshot | null;
  written: number;
  removed: number;
  kept: number;
  nested: number;
}

interface TreeChange {
  status: string;
  path: string;
  srcMode: string;
  dstMode: string;
}

const GITLINK = "160000";

export class StoreError extends Error {}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function parseMessage(body: string): { label: string; kind: SnapshotKind; agent?: string; undoOf?: string } {
  const lines = body.replace(/\r/g, "").split("\n");
  const label = lines[0] ?? "";
  let kind: SnapshotKind = "manual";
  let agent: string | undefined;
  let undoOf: string | undefined;
  for (const line of lines) {
    // Trailer names predate the rename to snap-back; they are part of the storage format.
    const m = /^Snapback-(Kind|Agent|Undo-Of):\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    if (m[1] === "Kind") kind = m[2].trim() as SnapshotKind;
    else if (m[1] === "Agent") agent = m[2].trim();
    else undoOf = m[2].trim();
  }
  return { label, kind, agent, undoOf };
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

  private get pluginMarker(): string {
    return path.join(this.gitDir, `${STORAGE_PREFIX}-plugin-hook`);
  }

  /** Record that a hook from the Claude Code plugin ran for this project. */
  markPluginHook(now = new Date()): void {
    writeFileSync(this.pluginMarker, now.toISOString() + "\n");
  }

  /** When a hook from the Claude Code plugin last ran for this project, or null. */
  lastPluginHook(): Date | null {
    try {
      const d = new Date(readFileSync(this.pluginMarker, "utf8").trim());
      return Number.isNaN(d.getTime()) ? null : d;
    } catch {
      return null;
    }
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
    await this.clearStaleIndexLock();
    // A nested git repository without a commit makes `git add` fail outright.
    // Exclude each one we hit (remembered in the shadow repo) and try again.
    for (let attempt = 0; ; attempt++) {
      // core.bigFileThreshold=1 streams new file contents straight into one pack
      // per call instead of one loose object file each. On a 20k-file project the
      // first snapshot drops from about 11 s and 80 MB on disk to about 3 s and
      // 6 MB. The stored bytes are identical; maybePack() keeps the pack count low.
      const r = await this.git(["-c", "core.bigFileThreshold=1", "add", "-A", "--ignore-errors", "."], { allowFail: true });
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
    // `git add -A` keeps files in the index once they are tracked, even after a
    // .gitignore change makes them ignored. Drop those, so a snapshot is always
    // exactly the files the current ignore rules allow.
    const ignored = (await this.git(["ls-files", "-z", "-c", "-i", "--exclude-standard"], { allowFail: true })).stdout
      .split("\0")
      .filter(Boolean);
    if (ignored.length) {
      await this.git(["update-index", "--force-remove", "-z", "--stdin"], { input: ignored.join("\0") + "\0" });
    }
    return (await this.git(["write-tree"])).stdout.trim();
  }

  /**
   * A git process killed at the wrong moment leaves index.lock behind, and every
   * later `git add` would fail. Only snap-back writes this index and the caller
   * holds snap-back's lock, so the only other writer can be a git process that
   * outlived a killed snap-back. Give it a few seconds to finish, then treat the
   * lock file as abandoned.
   */
  private async clearStaleIndexLock(): Promise<void> {
    const lock = path.join(this.gitDir, "index.lock");
    for (let waited = 0; existsSync(lock); waited += 100) {
      if (waited >= 5_000) {
        rmSync(lock, { force: true });
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Keep the number of pack files small; each snapshot that adds content writes one. */
  private async maybePack(): Promise<void> {
    let packs = 0;
    try {
      packs = readdirSync(path.join(this.gitDir, "objects", "pack")).filter((f) => f.endsWith(".pack")).length;
    } catch {
      return;
    }
    if (packs < 40) return;
    const args = gitAtLeast(2, 33) ? ["repack", "-d", "-q", "--geometric=2"] : ["repack", "-a", "-d", "-q"];
    await this.git(args, { allowFail: true });
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

  private async snapshotLocked(input: SnapshotInput, staged?: string): Promise<Snapshot | null> {
    const tree = staged ?? (await this.stageTree());
    const head = await this.headHash();
    if (head) {
      const headTree = (await this.git(["rev-parse", `${head}^{tree}`])).stdout.trim();
      if (headTree === tree && !input.force && !ALWAYS_RECORD.has(input.kind)) return null;
    }
    const label = oneLine(input.label || input.kind);
    const lines = [label, "", `Snapback-Kind: ${input.kind}`];
    if (input.agent) lines.push(`Snapback-Agent: ${oneLine(input.agent, 60)}`);
    if (input.undoOf) lines.push(`Snapback-Undo-Of: ${input.undoOf}`);
    const args = ["commit-tree", tree];
    if (head) args.push("-p", head);
    const hash = (await this.git(args, { input: lines.join("\n") + "\n" })).stdout.trim();
    await this.git(["update-ref", "refs/heads/main", hash]);
    await this.maybePack();
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
        undoOf: meta.undoOf,
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

  /**
   * The snapshot `undo` would roll back to, or null if there is nothing to undo.
   *
   * Snapshots recorded by an earlier undo are stepped over: when the files still
   * match what that undo restored, the search continues below the snapshot it
   * restored to. So a second undo walks one burst further back instead of
   * re-applying the changes the first undo removed.
   */
  async undoTarget(): Promise<Snapshot | null> {
    const current = await this.currentTree();
    const all = await this.list();
    const index = new Map(all.map((s, i) => [s.hash, i]));
    let fallback: Snapshot | null = null;
    for (let i = 0; i < all.length; i++) {
      const s = all[i];
      if (s.undoOf && s.tree === current) {
        const j = index.get(s.undoOf);
        if (j !== undefined && j > i) {
          i = j;
          continue;
        }
      }
      if (s.tree === current) continue;
      if (BOUNDARY_KINDS.has(s.kind)) return s;
      // A safety snapshot holds what an undo or restore replaced; going back to
      // it would redo that change, so it is never picked implicitly.
      if (!fallback && s.kind !== "safety") fallback = s;
    }
    return fallback;
  }

  /** The newest snapshot recorded by `undo`, and the safety snapshot taken just before it. */
  async lastUndo(): Promise<{ undo: Snapshot; safety: Snapshot | null } | null> {
    const all = await this.list();
    const i = all.findIndex((s) => s.undoOf);
    if (i === -1) return null;
    const safety = all[i + 1]?.kind === "safety" ? all[i + 1] : null;
    return { undo: all[i], safety };
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

  private async treeChanges(fromTree: string, toTree: string, paths?: string[]): Promise<TreeChange[]> {
    const args = ["diff-tree", "-r", "-z", "--no-renames", "--raw", fromTree, toTree];
    if (paths?.length) args.push("--", ...paths);
    const out = (await this.git(args)).stdout.split("\0");
    const changes: TreeChange[] = [];
    for (let i = 0; i + 1 < out.length; i += 2) {
      const m = /^:(\d+) (\d+) \S+ \S+ (\S+)/.exec(out[i]);
      if (!m) continue;
      changes.push({ srcMode: m[1], dstMode: m[2], status: m[3], path: out[i + 1] });
    }
    return changes;
  }

  private async treeDiff(fromTree: string, toTree: string, paths?: string[]): Promise<{ write: string[]; remove: string[] }> {
    const write: string[] = [];
    const remove: string[] = [];
    for (const c of await this.treeChanges(fromTree, toTree, paths)) {
      if (c.status === "D") remove.push(c.path);
      else write.push(c.path);
    }
    return { write, remove };
  }

  /**
   * Of `candidates` (files that exist now but not in `targetTree`), the ones the
   * target snapshot's .gitignore files exclude. Checked against a scratch
   * directory holding only those .gitignore files, plus the built-in ignores.
   */
  private async ignoredByTarget(targetTree: string, candidates: string[]): Promise<Set<string>> {
    if (!candidates.length) return new Set();
    const listed = (await this.git(["ls-tree", "-r", "-z", "--name-only", targetTree])).stdout.split("\0");
    const ignoreFiles = listed.filter((p) => p === ".gitignore" || p.endsWith("/.gitignore"));
    const scratch = mkdtempSync(path.join(os.tmpdir(), "snap-back-rules-"));
    try {
      for (const rel of ignoreFiles) {
        const blob = await this.git(["cat-file", "blob", `${targetTree}:${rel}`], { allowFail: true });
        if (blob.code !== 0) continue;
        const dest = path.join(scratch, ...rel.split("/"));
        mkdirSync(path.dirname(dest), { recursive: true });
        writeFileSync(dest, blob.stdout);
      }
      const r = await runGit(
        ["--git-dir", this.gitDir, "--work-tree", scratch, "check-ignore", "--no-index", "-z", "--stdin"],
        { cwd: scratch, input: candidates.join("\0") + "\0", allowFail: true },
      );
      return new Set(r.stdout.split("\0").filter(Boolean));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  private async computePlan(currentTree: string, target: Snapshot, paths?: string[]): Promise<RestorePlan & { added: string[] }> {
    const write: string[] = [];
    const candidates: string[] = [];
    const nested: string[] = [];
    const added: string[] = [];
    for (const c of await this.treeChanges(currentTree, target.tree, paths)) {
      if (c.srcMode === GITLINK || c.dstMode === GITLINK) nested.push(c.path);
      else if (c.status === "D") candidates.push(c.path);
      else {
        write.push(c.path);
        if (c.status === "A") added.push(c.path);
      }
    }
    const ignored = await this.ignoredByTarget(target.tree, candidates);
    const remove = candidates.filter((p) => !ignored.has(p));
    const keep = candidates.filter((p) => ignored.has(p));
    return { target, write, remove, keep, nested, paths, added };
  }

  /** What restoring `ref` would change, compared with the files right now. */
  async planRestore(ref: string, paths?: string[]): Promise<RestorePlan> {
    const target = await this.resolve(ref);
    const current = await this.currentTree();
    const { added: _added, ...plan } = await this.computePlan(current, target, paths);
    return plan;
  }

  /**
   * Restore files to a snapshot. Always records a safety snapshot of the
   * current files first, so the restore itself can be undone. With `undo`,
   * the snapshot recorded afterwards remembers its target so the next undo
   * continues further back.
   */
  async restore(ref: string, paths?: string[], opts: { undo?: boolean } = {}): Promise<RestoreResult> {
    const target = await this.resolve(ref);
    return withLock(this.lockPath, async () => {
      let tree = await this.stageTree();
      const plan = await this.computePlan(tree, target, paths);
      // Files the restore will overwrite but that are ignored right now were not
      // staged. Add them to the safety snapshot so their current bytes survive.
      const unsaved = plan.added.filter((rel) => {
        try {
          const st = lstatSync(path.join(this.root, rel));
          return st.isFile() || st.isSymbolicLink();
        } catch {
          return false;
        }
      });
      if (unsaved.length) {
        for (const group of chunk(unsaved, 200)) await this.git(["add", "-f", "--", ...group]);
        tree = (await this.git(["write-tree"])).stdout.trim();
      }
      const safety = await this.snapshotLocked(
        {
          kind: "safety",
          label: `before restore to ${target.id}${paths?.length ? " (" + paths.join(", ") + ")" : ""}`,
          force: true,
        },
        tree,
      );
      if (!safety) throw new StoreError("could not record safety snapshot");

      try {
        // Deletions first, so a file can be replaced by a directory of the same name.
        for (const rel of plan.remove) this.removeFile(rel);
        for (const group of chunk(plan.write, 200)) {
          await this.git(["checkout", target.hash, "--", ...group]);
        }
      } catch (e) {
        throw new StoreError(
          `The restore stopped partway: ${(e as Error).message.trim()}\n` +
            `Your files as they were just before the restore are saved in snapshot ${safety.id}. ` +
            `To put them back: snap-back restore ${safety.id}`,
        );
      }
      const after = await this.snapshotLocked({
        kind: "restore",
        label: `${opts.undo ? "undo: " : ""}restored ${paths?.length ? paths.join(", ") + " from " : "to "}${target.id}`,
        undoOf: opts.undo ? target.hash : undefined,
      });
      return {
        safety,
        after,
        written: plan.write.length,
        removed: plan.remove.length,
        kept: plan.keep.length,
        nested: plan.nested.length,
      };
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
        const renamed = new Map<string, string>();
        for (const c of commits.slice(start)) {
          const args = ["commit-tree", c.tree];
          if (parent) args.push("-p", parent);
          // Keep undo records pointing at the rewritten ids of the snapshots they restored.
          const body = c.body.replace(/^(Snapback-Undo-Of:\s*)([0-9a-f]{40})\s*$/m, (line, pre: string, old: string) =>
            renamed.has(old) ? pre + renamed.get(old) : line,
          );
          parent = (
            await this.git(args, {
              input: body,
              env: { GIT_AUTHOR_DATE: `@${c.at} +0000`, GIT_COMMITTER_DATE: `@${c.ct} +0000` },
            })
          ).stdout.trim();
          renamed.set(c.hash, parent);
        }
        await this.git(["update-ref", "refs/heads/main", parent!]);
      }
      await this.git(["reflog", "expire", "--expire=now", "--all"], { allowFail: true });
      await this.git(["gc", "--prune=now", "--quiet"], { allowFail: true });
      return { before: commits.length, after: commits.length - start };
    });
  }

  /** Bytes the shadow repository occupies on disk (allocated blocks where the platform reports them). */
  diskUsage(): number {
    let total = 0;
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else
          try {
            const st = statSync(p);
            total += st.blocks ? Math.max(st.size, st.blocks * 512) : st.size;
          } catch {
            // ignore files removed mid-walk
          }
      }
    };
    walk(this.gitDir);
    return total;
  }
}
