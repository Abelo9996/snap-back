import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withLock } from "../src/lock.js";
import { findProjectRoot } from "../src/paths.js";
import { Store } from "../src/store.js";
import { cleanup, files, git, isolateHome, read, tempDir, write } from "./helpers.js";

let root: string;

beforeEach(() => {
  isolateHome();
  root = tempDir();
});
afterEach(() => cleanup());

/** What `snap-back undo --yes` does. */
async function undo(store: Store): Promise<boolean> {
  const t = await store.undoTarget();
  if (!t) return false;
  await store.restore(t.hash, undefined, { undo: true });
  return true;
}

describe("repeated undo", () => {
  it("does not re-apply the agent's changes when undo runs a second time", async () => {
    write(root, "a.txt", "before");
    const store = await Store.open(root);
    await store.snapshot({ kind: "wrap-start" });
    write(root, "a.txt", "agent");
    write(root, "agent.txt", "new");
    await store.snapshot({ kind: "wrap-end" });

    expect(await undo(store)).toBe(true);
    expect(files(root)).toEqual(["a.txt"]);
    expect(read(root, "a.txt")).toBe("before");

    expect(await store.undoTarget()).toBeNull();
    expect(read(root, "a.txt")).toBe("before");
    const last = await store.lastUndo();
    expect(last?.safety?.kind).toBe("safety");
  });

  it("walks back one burst per undo and stops at the oldest, without toggling", async () => {
    write(root, "f.txt", "v0");
    const store = await Store.open(root);
    for (const v of ["v1", "v2", "v3"]) {
      await store.snapshot({ kind: "wrap-start" });
      write(root, "f.txt", v);
      await store.snapshot({ kind: "wrap-end" });
    }
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      if (!(await undo(store))) break;
      seen.push(read(root, "f.txt"));
    }
    expect(seen).toEqual(["v2", "v1", "v0"]);
  });

  it("undoes hand edits made after an undo before walking further back", async () => {
    write(root, "f.txt", "v0");
    const store = await Store.open(root);
    await store.snapshot({ kind: "wrap-start" });
    write(root, "f.txt", "v1");
    await store.snapshot({ kind: "wrap-end" });
    await undo(store);
    write(root, "f.txt", "hand edit");
    expect(await undo(store)).toBe(true);
    expect(read(root, "f.txt")).toBe("v0");
  });

  it("still stops at the oldest change after gc rewrites snapshot ids", async () => {
    write(root, "f.txt", "v0");
    const store = await Store.open(root);
    await store.snapshot({ kind: "manual", label: "old" });
    await store.snapshot({ kind: "wrap-start" });
    write(root, "f.txt", "v1");
    await store.snapshot({ kind: "wrap-end" });
    await undo(store);
    const before = (await store.list()).map((s) => s.hash);
    const r = await store.gc({ keep: before.length - 1, keepDays: 0 });
    expect(r.after).toBe(before.length - 1);
    expect((await store.list())[0].hash).not.toBe(before[0]);
    expect(await store.undoTarget()).toBeNull();
    expect(read(root, "f.txt")).toBe("v0");
  });
});

describe("restore never deletes files it never recorded", () => {
  it("keeps files that only became visible because the agent rewrote .gitignore", async () => {
    write(root, ".gitignore", ".env\nlocal-data/\n");
    write(root, ".env", "API_KEY=secret\n");
    write(root, "local-data/db.sqlite", "precious");
    write(root, "app.js", "v1");
    const store = await Store.open(root);
    const start = (await store.snapshot({ kind: "wrap-start" }))!;
    write(root, ".gitignore", "node_modules/\n");
    write(root, "app.js", "v2");
    write(root, "agent-made.js", "x");
    await store.snapshot({ kind: "wrap-end" });

    const plan = await store.planRestore(start.hash);
    expect(plan.remove).toEqual(["agent-made.js"]);
    expect(plan.keep.sort()).toEqual([".env", "local-data/db.sqlite"]);

    const res = await store.restore(start.hash, undefined, { undo: true });
    expect(res.kept).toBe(2);
    expect(read(root, ".env")).toBe("API_KEY=secret\n");
    expect(read(root, "local-data/db.sqlite")).toBe("precious");
    expect(read(root, ".gitignore")).toBe(".env\nlocal-data/\n");
    expect(read(root, "app.js")).toBe("v1");
    expect(existsSync(path.join(root, "agent-made.js"))).toBe(false);

    // Back under the original rules, the ignored files leave the snapshots again.
    const after = (await store.list())[0];
    const tracked = (await store.git(["ls-tree", "-r", "--name-only", after.hash])).stdout.trim().split("\n");
    expect(tracked.sort()).toEqual([".gitignore", "app.js"]);
  });

  it("saves an ignored file in the safety snapshot before overwriting it", async () => {
    write(root, "config.json", "original");
    const store = await Store.open(root);
    const start = (await store.snapshot({ kind: "manual" }))!;
    write(root, ".gitignore", "config.json\n");
    write(root, "config.json", "edited after it became ignored");
    await store.snapshot({ kind: "manual" });

    const res = await store.restore(start.hash);
    expect(read(root, "config.json")).toBe("original");
    const saved = await store.git(["show", `${res.safety.hash}:config.json`]);
    expect(saved.stdout).toBe("edited after it became ignored");
  });
});

describe("nested git repositories", () => {
  it("reports them instead of claiming to restore or delete them", async () => {
    write(root, "a.txt", "a");
    write(root, "vendor/lib/x.txt", "x");
    git(path.join(root, "vendor/lib"), "init", "-q");
    git(path.join(root, "vendor/lib"), "add", ".");
    git(path.join(root, "vendor/lib"), "commit", "-q", "-m", "x");
    const store = await Store.open(root);
    const start = (await store.snapshot({ kind: "wrap-start" }))!;
    write(root, "vendor/lib/x.txt", "changed");
    git(path.join(root, "vendor/lib"), "commit", "-q", "-am", "y");
    write(root, "a.txt", "agent");
    const plan = await store.planRestore(start.hash);
    expect(plan.write).toEqual(["a.txt"]);
    expect(plan.remove).toEqual([]);
    expect(plan.nested).toEqual(["vendor/lib"]);
    const res = await store.restore(start.hash);
    expect(res.nested).toBe(1);
    expect(read(root, "a.txt")).toBe("a");
    expect(read(root, "vendor/lib/x.txt")).toBe("changed");
  });
});

describe("project root", () => {
  it("prefers the nearest git repository over a parent folder that has snapshots", async () => {
    write(root, "notes.txt", "n");
    const parent = await Store.open(root);
    await parent.snapshot({ kind: "manual" });
    const repo = path.join(root, "projA");
    mkdirSync(repo);
    git(repo, "init", "-q");
    expect(findProjectRoot(repo)).toBe(repo);
    mkdirSync(path.join(root, "plain"));
    expect(findProjectRoot(path.join(root, "plain"))).toBe(root);
  });
});

describe("locks", () => {
  it("takes over a lock left by a process that no longer exists", async () => {
    const lock = path.join(tempDir(), "x.lock");
    writeFileSync(lock, "999999999");
    const started = Date.now();
    expect(await withLock(lock, async () => "ok", 5_000)).toBe("ok");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(existsSync(lock)).toBe(false);
  });

  it("recovers from an index.lock left in the shadow repository", async () => {
    write(root, "a.txt", "1");
    const store = await Store.open(root);
    await store.snapshot({ kind: "manual" });
    writeFileSync(path.join(store.gitDir, "index.lock"), "");
    write(root, "a.txt", "2");
    const s = await store.snapshot({ kind: "manual" });
    expect(s?.filesChanged).toBe(1);
  }, 20_000);
});

describe("storage", () => {
  it("packs new file contents instead of writing one loose object per file", async () => {
    for (let i = 0; i < 50; i++) write(root, `src/f${i}.txt`, `content ${i}\n`.repeat(10));
    const store = await Store.open(root);
    await store.snapshot({ kind: "manual" });
    const counts = (await store.git(["count-objects", "-v"])).stdout;
    const loose = Number(/^count: (\d+)/m.exec(counts)![1]);
    const inPack = Number(/^in-pack: (\d+)/m.exec(counts)![1]);
    expect(inPack).toBeGreaterThanOrEqual(50);
    expect(loose).toBeLessThan(10);
    // Bytes round-trip exactly.
    write(root, "src/f0.txt", "changed");
    const first = (await store.list())[0];
    await store.restore(first.hash);
    expect(readFileSync(path.join(root, "src/f0.txt"), "utf8")).toBe("content 0\n".repeat(10));
  });
});
