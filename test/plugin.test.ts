import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLAUDE_TOOL_MATCHER, handleClaudeHook } from "../src/hooks.js";
import { Store } from "../src/store.js";
import { cleanup, isolateHome, tempDir, write } from "./helpers.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO, "dist", "cli.js");
const LAUNCHER = path.join(REPO, "hooks", "run.mjs");
const WIN = process.platform === "win32";
const json = (rel: string) => JSON.parse(readFileSync(path.join(REPO, rel), "utf8"));

beforeEach(() => {
  isolateHome();
});
afterEach(() => cleanup());

describe("Claude Code plugin files", () => {
  it("plugin.json matches package.json", () => {
    const manifest = json(".claude-plugin/plugin.json");
    const pkg = json("package.json");
    expect(manifest.name).toBe("snap-back");
    expect(manifest.version, "bump the version in .claude-plugin/plugin.json together with package.json").toBe(pkg.version);
    expect(manifest.license).toBe(pkg.license);
  });

  it("hooks.json registers the same events and matcher as `snap-back hooks install`", () => {
    const { hooks } = json("hooks/hooks.json");
    expect(Object.keys(hooks).sort()).toEqual(["PostToolUse", "PreToolUse", "UserPromptSubmit"]);
    expect(hooks.PreToolUse[0].matcher).toBe(CLAUDE_TOOL_MATCHER);
    expect(hooks.PostToolUse[0].matcher).toBe(CLAUDE_TOOL_MATCHER);
    for (const event of Object.keys(hooks)) {
      for (const h of hooks[event][0].hooks) {
        expect(h.type).toBe("command");
        expect(h.command).toBe("node");
        expect(h.args).toEqual(["${CLAUDE_PLUGIN_ROOT}/hooks/run.mjs", "hook", "claude"]);
      }
    }
    // The snapshot after a tool call is informational and must not slow the agent down.
    expect(hooks.PostToolUse[0].hooks[0].async).toBe(true);
    expect(hooks.PreToolUse[0].hooks[0].async).toBeUndefined();
  });

  it("the Codex manifest matches package.json, declares no hooks and points at the icon", () => {
    const manifest = json(".codex-plugin/plugin.json");
    expect(manifest.name).toBe("snap-back");
    expect(manifest.version, "bump the version in .codex-plugin/plugin.json together with package.json").toBe(json("package.json").version);
    expect(manifest.skills).toBe("./skills/");
    // Without an explicit value Codex would load hooks/hooks.json, which is written for Claude Code.
    expect(manifest.hooks).toEqual({});
    expect(manifest.interface.composerIcon).toBe("./assets/icon.svg");
    const svg = readFileSync(path.join(REPO, "assets", "icon.svg"), "utf8");
    expect(svg).toContain('viewBox="0 0 512 512"');
    expect(Buffer.byteLength(svg)).toBeLessThan(50_000);
    expect(existsSync(path.join(REPO, manifest.interface.screenshots[0]))).toBe(true);
  });

  it("every slash command has a description, runs only when the user asks, and can run the CLI", () => {
    const files = readdirSync(path.join(REPO, "commands")).filter((f) => f.endsWith(".md"));
    expect(files.sort()).toEqual(["list.md", "status.md", "undo.md"]);
    for (const f of files) {
      const text = readFileSync(path.join(REPO, "commands", f), "utf8");
      const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
      expect(front, f).toMatch(/^description: \S/m);
      expect(front, f).toMatch(/^disable-model-invocation: true$/m);
      expect(front, f).toContain("Bash(npx -y @abelo9996/snap-back *)");
    }
  });
});

/** A fake executable named `name` in `dir` that reports how it was called, then exits 3. */
function fakeTool(dir: string, name: string): void {
  const js =
    "const c=[];process.stdin.on('data',d=>c.push(d)).on('end',()=>{" +
    "process.stdout.write(JSON.stringify({args:process.argv.slice(2),stdin:Buffer.concat(c).toString(),via:process.env.SNAP_BACK_VIA_PLUGIN}));" +
    "process.exit(3)});";
  if (name === "snap-back" && WIN) {
    write(dir, "snap-back.cmd", "@echo off\r\n");
    write(dir, "node_modules/@abelo9996/snap-back/dist/cli.js", js);
  } else if (WIN) {
    write(dir, "fake.js", js);
    write(dir, `${name}.cmd`, `@"${process.execPath}" "%~dp0fake.js" %*\r\n`);
  } else {
    write(dir, name, `#!${process.execPath}\n${js}\n`);
    chmodSync(path.join(dir, name), 0o755);
  }
}

function launch(pathDirs: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.toUpperCase() === "PATH") delete env[k];
  env.PATH = pathDirs.join(path.delimiter);
  const r = spawnSync(process.execPath, [LAUNCHER, "hook", "claude"], { input: '{"hook_event_name":"Stop"}', env, encoding: "utf8" });
  return { code: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, stderr: r.stderr };
}

describe("hook launcher (hooks/run.mjs)", () => {
  it("prefers a global install on PATH and passes stdin, stdout and the exit code through", () => {
    const global = tempDir();
    const npx = tempDir();
    fakeTool(global, "snap-back");
    fakeTool(npx, "npx");
    const r = launch([global, npx]);
    expect(r.code).toBe(3);
    expect(r.out).toEqual({ args: ["hook", "claude"], stdin: '{"hook_event_name":"Stop"}', via: "1" });
  });

  it("falls back to npx when snap-back is not installed", () => {
    const npx = tempDir();
    fakeTool(npx, "npx");
    const r = launch([npx]);
    expect(r.code).toBe(3);
    expect(r.out.args).toEqual(["-y", "@abelo9996/snap-back", "hook", "claude"]);
    expect(r.out.stdin).toBe('{"hook_event_name":"Stop"}');
    expect(r.out.via).toBe("1");
  });

  it("skips npx's temporary shim directories", () => {
    const cache = tempDir();
    const shim = path.join(cache, "_npx", "abc", "node_modules", ".bin");
    fakeTool(shim, "snap-back");
    const npx = tempDir();
    fakeTool(npx, "npx");
    expect(launch([shim, npx]).out.args[0]).toBe("-y");
  });
});

describe("plugin hook marker", () => {
  it("records plugin hook runs and status reports them", async () => {
    const root = tempDir();
    write(root, "a.txt", "1\n");
    const payload = JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: root, prompt: "hi" });
    await handleClaudeHook(payload, { CLAUDE_PROJECT_DIR: root });
    expect((await Store.open(root)).lastPluginHook()).toBeNull();

    await handleClaudeHook(payload, { CLAUDE_PROJECT_DIR: root, SNAP_BACK_VIA_PLUGIN: "1" });
    const last = (await Store.open(root)).lastPluginHook();
    expect(last).not.toBeNull();
    expect(Date.now() - last!.getTime()).toBeLessThan(60_000);

    expect(existsSync(CLI)).toBe(true);
    const st = spawnSync(process.execPath, [CLI, "status"], { cwd: root, env: { ...process.env, NO_COLOR: "1" }, encoding: "utf8" });
    expect(st.stdout).toMatch(/hooks: +Claude Code plugin \(last ran \d+s ago\); settings hooks not in \.claude settings/);
  });
});
