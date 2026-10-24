import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderCard, writeCard, formatBytes } from "../src/card.js";
import { resolveMaxFileBytes, Store } from "../src/store.js";
import { cleanup, isolateHome, read, tempDir, write } from "./helpers.js";

let root: string;
beforeEach(() => {
  isolateHome();
  root = tempDir();
});
afterEach(() => cleanup());

describe("capturing what built-ins miss", () => {
  it("records a file changed by a shell command the agent ran, and undoes it", async () => {
    write(root, "data.txt", "original\n");
    const store = await Store.open(root);
    const start = (await store.snapshot({ kind: "wrap-start" }))!;
    // A shell command rewrites a file and deletes another; snap-back watches files, not the agent.
    execFileSync(process.execPath, ["-e", "require('fs').writeFileSync(process.argv[1],'rewritten by shell\\n')", path.join(root, "data.txt")]);
    write(root, "scratch.tmp", "made by a shell command");
    await store.snapshot({ kind: "wrap-end" });

    const summary = await store.changeSummary(start.hash);
    expect(summary.modified).toContain("data.txt");
    expect(summary.added).toContain("scratch.tmp");

    await store.restore(start.hash, undefined, { undo: true });
    expect(read(root, "data.txt")).toBe("original\n");
    expect(existsSync(path.join(root, "scratch.tmp"))).toBe(false);
  });

  it("groups changes with deletions first across tracked, untracked and gitignored files", async () => {
    write(root, ".gitignore", "*.local\n");
    write(root, "keep.txt", "k");
    write(root, "old.txt", "will be deleted");
    write(root, "config.local", "secret=1");
    const store = await Store.open(root);
    const start = (await store.snapshot({ kind: "wrap-start" }))!;
    rmSync(path.join(root, "old.txt"));
    write(root, "config.local", "secret=2");
    write(root, "new.txt", "added");
    await store.snapshot({ kind: "wrap-end" });

    const g = await store.changeSummary(start.hash);
    expect(g.deleted).toEqual(["old.txt"]);
    expect(g.added).toEqual(["new.txt"]);
    expect(g.modified).toEqual(["config.local"]); // gitignored, still tracked by snap-back
  });

  it("reports a recovered deletion and the restored secret in the result", async () => {
    write(root, ".gitignore", ".env\n");
    write(root, ".env", "TOKEN=abc\n");
    write(root, "gone.txt", "bring me back");
    const store = await Store.open(root);
    const start = (await store.snapshot({ kind: "wrap-start" }))!;
    write(root, ".env", "TOKEN=leaked\n");
    rmSync(path.join(root, "gone.txt"));
    await store.snapshot({ kind: "wrap-end" });

    const res = await store.restore(start.hash, undefined, { undo: true });
    expect(res.recoveredPaths).toContain("gone.txt");
    expect(res.restoredPaths).toContain(".env");
    expect(read(root, ".env")).toBe("TOKEN=abc\n");
    expect(read(root, "gone.txt")).toBe("bring me back");
  });
});

describe("size cap configuration", () => {
  it("reads SNAP_BACK_MAX_FILE_MB from the environment", () => {
    expect(resolveMaxFileBytes(undefined, { SNAP_BACK_MAX_FILE_MB: "2" })).toBe(2 * 1024 * 1024);
    expect(resolveMaxFileBytes(123)).toBe(123);
    expect(resolveMaxFileBytes(undefined, {})).toBeGreaterThan(0);
  });
});

describe("share card", () => {
  it("renders an SVG with the restore facts", () => {
    const svg = renderCard({
      title: "snap-back undo",
      restored: 14,
      recovered: 2,
      highlights: [".env"],
      skipped: [{ path: "node_modules/", bytes: 310 * 1024 * 1024 }],
      agent: "codex",
      project: "demo",
    });
    expect(svg).toContain("<svg");
    expect(svg).toContain("Restored 14 files");
    expect(svg).toContain(".env");
    expect(svg).toContain("310 MB");
    expect(svg).toContain("</svg>");
  });

  it("writes an SVG file (and a PNG when the renderer is available)", async () => {
    const base = path.join(root, "card");
    const written = await writeCard(
      { title: "snap-back undo", restored: 3, recovered: 1, highlights: [], skipped: [] },
      base,
    );
    expect(existsSync(written.svg)).toBe(true);
    expect(readFileSync(written.svg, "utf8")).toContain("<svg");
    if (written.png) expect(existsSync(written.png)).toBe(true);
  });

  it("formats bytes readably", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(310 * 1024 * 1024)).toBe("310 MB");
  });
});
