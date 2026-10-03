import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { realpathSync } from "node:fs";

const made: string[] = [];

/** A fresh temp directory; removed by cleanup(). */
export function tempDir(prefix = "snap-back-test-"): string {
  const d = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(d);
  return d;
}

export function cleanup(): void {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true, maxRetries: 3 });
}

/** Point snap-back's storage at a temp dir for this test. */
export function isolateHome(): string {
  const home = tempDir("snap-back-home-");
  process.env.SNAP_BACK_HOME = home;
  return home;
}

export function write(root: string, rel: string, content: string): void {
  const p = path.join(root, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
}

export function read(root: string, rel: string): string {
  return readFileSync(path.join(root, rel), "utf8");
}

export function git(cwd: string, ...args: string[]): string {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args], {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** sha256 over every file path and its bytes under a directory. */
export function hashTree(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      // git can create and remove *.lock files in the background; they are not repository state.
      if (e.name.endsWith(".lock")) continue;
      h.update(path.relative(dir, p) + "\0");
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) h.update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest("hex");
}

/** Every file under root except .git, as a sorted list of relative posix paths. */
export function files(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(root, p).split(path.sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}
