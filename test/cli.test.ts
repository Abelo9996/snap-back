import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, isolateHome, read, tempDir, write } from "./helpers.js";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
let root: string;

function run(args: string[], env: Record<string, string> = {}) {
  const base: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  // Windows spells it Path; drop every spelling before overriding.
  if (env.PATH) for (const k of Object.keys(base)) if (k.toUpperCase() === "PATH") delete base[k];
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    env: { ...base, ...env },
    encoding: "utf8",
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

beforeEach(() => {
  isolateHome();
  root = tempDir();
});
afterEach(() => cleanup());

describe("cli (built dist/cli.js)", () => {
  it("has a build to test", () => {
    expect(existsSync(CLI), "run `npm run build` first").toBe(true);
  });

  it("snap, list, diff, undo --yes end to end", () => {
    write(root, "main.py", "print(1)\n");
    expect(run(["snap", "-m", "before agent"]).code).toBe(0);
    write(root, "main.py", "print(2)\n");
    write(root, "added.py", "x = 1\n");

    const list = JSON.parse(run(["list", "--json"]).stdout);
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe("before agent");

    const diff = run(["diff"]);
    expect(diff.stdout).toContain("-print(1)");
    expect(diff.stdout).toContain("+print(2)");

    const dry = run(["undo", "--dry-run"]);
    expect(dry.stdout).toContain("delete   added.py");
    expect(read(root, "main.py")).toBe("print(2)\n");

    const undo = run(["undo", "--yes"]);
    expect(undo.code).toBe(0);
    expect(read(root, "main.py")).toBe("print(1)\n");
    expect(existsSync(path.join(root, "added.py"))).toBe(false);
    expect(undo.stdout).toMatch(/snap-back restore [0-9a-f]{8}/);
  });

  it("refuses to restore without confirmation when not interactive", () => {
    write(root, "a.txt", "1");
    run(["snap"]);
    write(root, "a.txt", "2");
    const r = run(["undo"]);
    expect(r.code).toBe(1);
    expect(read(root, "a.txt")).toBe("2");
  });

  it("restore <id> -- <paths> restores only those paths", () => {
    write(root, "a.txt", "a1");
    write(root, "b.txt", "b1");
    run(["snap"]);
    const id = JSON.parse(run(["list", "--json"]).stdout)[0].id;
    write(root, "a.txt", "a2");
    write(root, "b.txt", "b2");
    const r = run(["restore", id, "--yes", "--", "a.txt"]);
    expect(r.code).toBe(0);
    expect(read(root, "a.txt")).toBe("a1");
    expect(read(root, "b.txt")).toBe("b2");
  });

  it("wrap runs the command and exits with its exit code", () => {
    write(root, "a.txt", "1");
    const r = run(["wrap", "--interval", "0", "--", process.execPath, "-e", "require('fs').writeFileSync('a.txt','2');process.exit(4)"]);
    expect(r.code).toBe(4);
    expect(r.stderr).toContain("changed 1 file");
    expect(read(root, "a.txt")).toBe("2");
  });

  it("the hook command never fails and prints nothing to stdout", () => {
    const r = spawnSync(process.execPath, [CLI, "hook", "claude"], {
      cwd: root,
      input: "this is not json",
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("hooks install writes settings.local.json by default, and status and uninstall cover both files", () => {
    const install = run(["hooks", "install", "--command", "snap-back"]);
    expect(install.code).toBe(0);
    expect(install.stdout).toContain("settings.local.json");
    expect(install.stderr).not.toContain("Warning");
    expect(existsSync(path.join(root, ".claude", "settings.local.json"))).toBe(true);
    expect(existsSync(path.join(root, ".claude", "settings.json"))).toBe(false);

    expect(run(["hooks", "install", "--shared", "--command", "snap-back"]).code).toBe(0);
    const status = run(["hooks", "status"]);
    expect(status.stdout).toContain("Claude Code hooks in .claude/settings.local.json: installed");
    expect(status.stdout).toContain("Claude Code hooks in .claude/settings.json: installed");

    const un = run(["hooks", "uninstall"]);
    expect(un.code).toBe(0);
    expect(un.stdout.match(/Removed 3 snap-back hook\(s\)/g)).toHaveLength(2);
    expect(run(["hooks", "status"]).stdout).not.toMatch(/: installed/);
  });

  it("hooks install --shared warns when the command contains a machine-specific path", () => {
    const r = run(["hooks", "install", "--shared", "--command", `node ${CLI.split(path.sep).join("/")}`]);
    expect(r.code).toBe(0);
    expect(existsSync(path.join(root, ".claude", "settings.json"))).toBe(true);
    expect(r.stderr).toContain("Warning: the hook command contains a path that exists only on this machine");
    expect(r.stderr).toContain("npm install -g github:Abelo9996/snap-back");
  });

  it("hooks install rejects --shared together with --local", () => {
    const r = run(["hooks", "install", "--shared", "--local"]);
    expect(r.code).toBe(1);
    expect(existsSync(path.join(root, ".claude"))).toBe(false);
  });

  it("explains a missing git and exits 2", () => {
    const r = run(["snap"], { PATH: tempDir("empty-path-") });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("needs git");
  });
});
