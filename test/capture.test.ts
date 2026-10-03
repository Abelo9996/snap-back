import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { matchAgents } from "../src/agents.js";
import { Store } from "../src/store.js";
import { watchProject } from "../src/watch.js";
import { wrapCommand } from "../src/wrap.js";
import { cleanup, isolateHome, read, tempDir, write } from "./helpers.js";

let root: string;
beforeEach(() => {
  isolateHome();
  root = tempDir();
});
afterEach(() => cleanup());

async function waitFor(cond: () => Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timed out");
}

describe("wrap", () => {
  it("checkpoints before and after the command and reports what changed", async () => {
    write(root, "keep.txt", "before");
    const store = await Store.open(root);
    const script = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(path.join(root, "made-by-agent.txt"))},'hi');fs.writeFileSync(${JSON.stringify(path.join(root, "keep.txt"))},'after');process.exit(3)`;
    const res = await wrapCommand(store, [process.execPath, "-e", script], { intervalMs: 0 });
    expect(res.exitCode).toBe(3);
    expect(res.start.kind).toBe("wrap-start");
    expect(res.end?.kind).toBe("wrap-end");
    expect(res.changed).toEqual(["keep.txt", "made-by-agent.txt"]);

    const target = (await store.undoTarget())!;
    expect(target.hash).toBe(res.start.hash);
    await store.restore(target.id);
    expect(read(root, "keep.txt")).toBe("before");
    expect(existsSync(path.join(root, "made-by-agent.txt"))).toBe(false);
  });

  it("returns 127 when the command does not exist", async () => {
    const store = await Store.open(root);
    const res = await wrapCommand(store, ["definitely-not-a-real-command-xyz"], { intervalMs: 0 });
    expect(res.exitCode).not.toBe(0);
  });
});

describe("watch", () => {
  it("turns a burst of changes into one snapshot", async () => {
    write(root, "a.txt", "0");
    const store = await Store.open(root);
    await store.snapshot({ kind: "watch-start" });
    const h = watchProject(store, { debounceMs: 300, detectAgent: false });
    await h.ready;
    try {
      writeFileSync(path.join(root, "a.txt"), "1");
      writeFileSync(path.join(root, "b.txt"), "1");
      await waitFor(async () => (await store.list()).some((s) => s.kind === "watch"));
    } finally {
      await h.close();
    }
    const watchSnaps = (await store.list()).filter((s) => s.kind === "watch");
    expect(watchSnaps.length).toBeGreaterThanOrEqual(1);
    const changed = await store.changedBetween((await store.list()).at(-1)!.hash, "HEAD");
    expect(changed).toEqual(["a.txt", "b.txt"]);
  });
});

describe("agent detection", () => {
  it("recognises agent processes from command lines", () => {
    expect(
      matchAgents([
        "/usr/local/bin/codex --full-auto",
        "node /Users/me/.npm/bin/claude",
        "/bin/zsh -l",
        "node /tmp/snapback/dist/cli.js watch",
        '"opencode.exe","1234","Console","1","50,000 K"',
      ]),
    ).toEqual(["claude", "codex", "opencode"]);
  });
});
