import { existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/store.js";
import { cleanup, files, git, hashTree, isolateHome, read, tempDir, write } from "./helpers.js";

let root: string;

beforeEach(() => {
  isolateHome();
  root = tempDir();
});
afterEach(() => cleanup());

describe("snapshot and restore", () => {
  it("round-trips file contents", async () => {
    write(root, "a.txt", "one\n");
    write(root, "src/b.ts", "export const b = 1;\n");
    const store = await Store.open(root);
    const s1 = (await store.snapshot({ kind: "manual", label: "start" }))!;
    write(root, "a.txt", "two\n");
    write(root, "src/b.ts", "export const b = 2;\n");
    await store.snapshot({ kind: "manual", label: "edited" });

    const res = await store.restore(s1.id);
    expect(res.written).toBe(2);
    expect(read(root, "a.txt")).toBe("one\n");
    expect(read(root, "src/b.ts")).toBe("export const b = 1;\n");
  });

  it("skips snapshots when nothing changed, except for boundary kinds", async () => {
    write(root, "a.txt", "x");
    const store = await Store.open(root);
    await store.snapshot({ kind: "manual" });
    expect(await store.snapshot({ kind: "post-tool" })).toBeNull();
    expect(await store.snapshot({ kind: "watch" })).toBeNull();
    expect(await store.snapshot({ kind: "turn-start" })).not.toBeNull();
    expect((await store.list()).length).toBe(2);
  });

  it("brings back deleted files", async () => {
    write(root, "keep.txt", "keep");
    write(root, "docs/deep/gone.md", "important");
    const store = await Store.open(root);
    const s1 = (await store.snapshot({ kind: "manual" }))!;
    rmDir(path.join(root, "docs"));
    expect(existsSync(path.join(root, "docs/deep/gone.md"))).toBe(false);

    await store.restore(s1.id);
    expect(read(root, "docs/deep/gone.md")).toBe("important");
  });

  it("removes files the agent created, and the directories that held only them", async () => {
    write(root, "a.txt", "a");
    write(root, "src/existing.ts", "x");
    const store = await Store.open(root);
    const s1 = (await store.snapshot({ kind: "manual" }))!;
    write(root, "new.txt", "agent");
    write(root, "generated/nested/file.ts", "agent");
    write(root, "src/extra.ts", "agent");

    const plan = await store.planRestore(s1.id);
    expect(plan.remove.sort()).toEqual(["generated/nested/file.ts", "new.txt", "src/extra.ts"]);
    await store.restore(s1.id);
    expect(files(root)).toEqual(["a.txt", "src/existing.ts"]);
    expect(existsSync(path.join(root, "generated"))).toBe(false);
    expect(existsSync(path.join(root, "src"))).toBe(true);
  });

  it("handles a file replaced by a directory of the same name", async () => {
    write(root, "thing", "file");
    const store = await Store.open(root);
    const s1 = (await store.snapshot({ kind: "manual" }))!;
    rmDir(path.join(root, "thing"));
    write(root, "thing/inner.txt", "dir now");
    await store.restore(s1.id);
    expect(read(root, "thing")).toBe("file");
  });

  it("makes every restore undoable through its safety snapshot", async () => {
    write(root, "a.txt", "original");
    const store = await Store.open(root);
    const s1 = (await store.snapshot({ kind: "manual" }))!;
    write(root, "a.txt", "agent version");
    write(root, "b.txt", "agent file");

    const res = await store.restore(s1.id);
    expect(res.safety.kind).toBe("safety");
    expect(files(root)).toEqual(["a.txt"]);

    await store.restore(res.safety.id);
    expect(read(root, "a.txt")).toBe("agent version");
    expect(read(root, "b.txt")).toBe("agent file");
  });

  it("restores only the requested paths", async () => {
    write(root, "src/a.ts", "a1");
    write(root, "src/sub/b.ts", "b1");
    write(root, "other.txt", "o1");
    const store = await Store.open(root);
    const s1 = (await store.snapshot({ kind: "manual" }))!;
    write(root, "src/a.ts", "a2");
    rmDir(path.join(root, "src/sub"));
    write(root, "src/created.ts", "new");
    write(root, "other.txt", "o2");
    write(root, "other-new.txt", "keep me");

    await store.restore(s1.id, store.toProjectPaths(["src"], root));
    expect(read(root, "src/a.ts")).toBe("a1");
    expect(read(root, "src/sub/b.ts")).toBe("b1");
    expect(existsSync(path.join(root, "src/created.ts"))).toBe(false);
    expect(read(root, "other.txt")).toBe("o2");
    expect(read(root, "other-new.txt")).toBe("keep me");

    // A single file, given relative to a subdirectory cwd.
    write(root, "src/a.ts", "a3");
    await store.restore(s1.id, store.toProjectPaths(["a.ts"], path.join(root, "src")));
    expect(read(root, "src/a.ts")).toBe("a1");
  });

  it("rejects paths outside the project", async () => {
    write(root, "a.txt", "a");
    const store = await Store.open(root);
    expect(() => store.toProjectPaths(["../escape"], root)).toThrow(/outside the project/);
  });

  it("works in a directory that is not a git repository", async () => {
    write(root, "notes.md", "v1");
    const store = await Store.open(root);
    const s1 = (await store.snapshot({ kind: "manual" }))!;
    write(root, "notes.md", "v2");
    await store.restore(s1.id);
    expect(read(root, "notes.md")).toBe("v1");
    expect(existsSync(path.join(root, ".git"))).toBe(false);
  });

  it("refuses to snapshot the home directory", async () => {
    await expect(Store.open(os.homedir())).rejects.toThrow(/home directory/);
  });
});

describe("ignores", () => {
  it("respects .gitignore, built-in ignores and .snapbackignore", async () => {
    write(root, ".gitignore", "*.log\nsecrets/\n");
    write(root, ".snapbackignore", "scratch/\n");
    write(root, "app.js", "v1");
    write(root, "debug.log", "log v1");
    write(root, "secrets/key.pem", "k");
    write(root, "node_modules/dep/index.js", "dep");
    write(root, ".venv/lib/x.py", "py");
    write(root, "scratch/tmp.txt", "t");
    const store = await Store.open(root);
    const s1 = (await store.snapshot({ kind: "manual" }))!;
    const tracked = (await store.git(["ls-tree", "-r", "--name-only", s1.hash])).stdout.trim().split("\n").sort();
    expect(tracked).toEqual([".gitignore", ".snapbackignore", "app.js"]);

    // Ignored files are never deleted or rewritten by a restore.
    write(root, "app.js", "v2");
    write(root, "debug.log", "log v2");
    write(root, "node_modules/dep/added.js", "new dep file");
    await store.restore(s1.id);
    expect(read(root, "app.js")).toBe("v1");
    expect(read(root, "debug.log")).toBe("log v2");
    expect(read(root, "node_modules/dep/added.js")).toBe("new dep file");
    expect(read(root, "secrets/key.pem")).toBe("k");
  });
});

describe("robustness", () => {
  it("skips nested git repositories that have no commit instead of failing", async () => {
    write(root, "a.txt", "a");
    write(root, "vendor/lib/x.txt", "x");
    git(path.join(root, "vendor/lib"), "init", "-q");
    const store = await Store.open(root);
    const s1 = (await store.snapshot({ kind: "manual" }))!;
    const tracked = (await store.git(["ls-tree", "-r", "--name-only", s1.hash])).stdout.trim().split("\n");
    expect(tracked).toEqual(["a.txt"]);
  });

  it("restores exact bytes even when .gitattributes asks for line-ending conversion", async () => {
    write(root, ".gitattributes", "* text eol=crlf\n");
    write(root, "lf.txt", "line1\nline2\n");
    write(root, "crlf.txt", "a\r\nb\r\n");
    const store = await Store.open(root);
    const s1 = (await store.snapshot({ kind: "manual" }))!;
    write(root, "lf.txt", "changed");
    write(root, "crlf.txt", "changed");
    await store.restore(s1.id);
    expect(read(root, "lf.txt")).toBe("line1\nline2\n");
    expect(read(root, "crlf.txt")).toBe("a\r\nb\r\n");
  });

  it("serialises concurrent snapshots from several callers", async () => {
    write(root, "a.txt", "a");
    const store = await Store.open(root);
    await Promise.all(
      [1, 2, 3, 4, 5].map(async (i) => {
        write(root, `f${i}.txt`, String(i));
        return store.snapshot({ kind: "manual", label: `c${i}` });
      }),
    );
    expect((await store.list()).length).toBe(5);
    expect(await store.pendingChanges()).toBe(0);
  });
});

describe("the user's own git repository", () => {
  it("is never modified: HEAD, index, stash, refs and objects stay identical", async () => {
    git(root, "init", "-q");
    write(root, "tracked.txt", "v1\n");
    write(root, "staged.txt", "s1\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "initial");
    write(root, "tracked.txt", "stash me\n");
    git(root, "stash", "push", "-q", "-m", "user stash");
    write(root, "staged.txt", "s2\n");
    git(root, "add", "staged.txt");
    write(root, "tracked.txt", "unstaged edit\n");

    const before = {
      head: git(root, "rev-parse", "HEAD"),
      index: git(root, "ls-files", "-s"),
      staged: git(root, "diff", "--cached", "--name-only"),
      stash: git(root, "stash", "list"),
      branches: git(root, "branch", "-a"),
      dotgit: hashTree(path.join(root, ".git")),
    };

    const store = await Store.open(root);
    const s1 = (await store.snapshot({ kind: "manual" }))!;
    write(root, "tracked.txt", "agent edit\n");
    write(root, "agent-new.txt", "x");
    await store.snapshot({ kind: "post-tool" });
    await store.restore(s1.id);
    const target = await store.undoTarget();
    if (target) await store.restore(target.id);
    await store.gc({ keep: 1, keepDays: 0 });

    expect(hashTree(path.join(root, ".git"))).toBe(before.dotgit);
    expect(git(root, "rev-parse", "HEAD")).toBe(before.head);
    expect(git(root, "ls-files", "-s")).toBe(before.index);
    expect(git(root, "diff", "--cached", "--name-only")).toBe(before.staged);
    expect(git(root, "stash", "list")).toBe(before.stash);
    expect(git(root, "branch", "-a")).toBe(before.branches);
    expect(store.gitDir.startsWith(root)).toBe(false);
  });

  it("ignores GIT_DIR and friends inherited from the environment", async () => {
    git(root, "init", "-q");
    write(root, "a.txt", "a");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "initial");
    const dotgit = hashTree(path.join(root, ".git"));
    process.env.GIT_DIR = path.join(root, ".git");
    process.env.GIT_INDEX_FILE = path.join(root, ".git", "index");
    try {
      const store = await Store.open(root);
      write(root, "a.txt", "b");
      await store.snapshot({ kind: "manual" });
    } finally {
      delete process.env.GIT_DIR;
      delete process.env.GIT_INDEX_FILE;
    }
    expect(hashTree(path.join(root, ".git"))).toBe(dotgit);
  });
});

describe("undo target", () => {
  it("goes back to the start of the last burst that changed files", async () => {
    write(root, "a.txt", "0");
    const store = await Store.open(root);
    const t1 = (await store.snapshot({ kind: "turn-start", label: "turn 1" }))!;
    write(root, "a.txt", "1");
    await store.snapshot({ kind: "post-tool" });
    const t2 = (await store.snapshot({ kind: "turn-start", label: "turn 2" }))!;
    write(root, "a.txt", "2");
    await store.snapshot({ kind: "pre-tool" });
    write(root, "b.txt", "2");
    await store.snapshot({ kind: "post-tool" });

    expect((await store.undoTarget())!.hash).toBe(t2.hash);
    await store.restore(t2.id);
    expect(read(root, "a.txt")).toBe("1");

    // Undo again walks one burst further back.
    expect((await store.undoTarget())!.hash).toBe(t1.hash);
  });

  it("skips a later turn that changed nothing", async () => {
    write(root, "a.txt", "0");
    const store = await Store.open(root);
    const t1 = (await store.snapshot({ kind: "turn-start" }))!;
    write(root, "a.txt", "1");
    await store.snapshot({ kind: "post-tool" });
    await store.snapshot({ kind: "turn-start" }); // turn 2: no edits
    expect((await store.undoTarget())!.hash).toBe(t1.hash);
  });

  it("returns null when there is nothing to undo", async () => {
    write(root, "a.txt", "0");
    const store = await Store.open(root);
    await store.snapshot({ kind: "manual" });
    expect(await store.undoTarget()).toBeNull();
  });
});

describe("gc", () => {
  it("keeps the newest snapshots and their contents", async () => {
    write(root, "a.txt", "0");
    const store = await Store.open(root);
    for (let i = 1; i <= 5; i++) {
      write(root, "a.txt", String(i));
      await store.snapshot({ kind: "manual", label: `snap ${i}` });
    }
    const r = await store.gc({ keep: 2, keepDays: 0 });
    expect(r).toEqual({ before: 5, after: 2 });
    const list = await store.list();
    expect(list.map((s) => s.label)).toEqual(["snap 5", "snap 4"]);
    write(root, "a.txt", "changed");
    await store.restore(list[1].id);
    expect(read(root, "a.txt")).toBe("4");
  });
});

function rmDir(p: string): void {
  rmSync(p, { recursive: true, force: true });
}
