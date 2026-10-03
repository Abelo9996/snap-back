import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeHooksInstalled, handleClaudeHook, installClaudeHooks, uninstallClaudeHooks } from "../src/hooks.js";
import { Store } from "../src/store.js";
import { cleanup, isolateHome, read, tempDir, write } from "./helpers.js";

let root: string;
const settingsPath = () => path.join(root, ".claude", "settings.json");
const readSettings = () => JSON.parse(readFileSync(settingsPath(), "utf8"));

beforeEach(() => {
  isolateHome();
  root = tempDir();
});
afterEach(() => cleanup());

const existing = {
  model: "some-model",
  permissions: { allow: ["Bash(npm test)"] },
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./lint.sh" }] }],
    Stop: [{ hooks: [{ type: "command", command: "notify-send done" }] }],
  },
};

describe("Claude Code hooks install", () => {
  it("merges into existing settings without clobbering them, and backs the file up", () => {
    write(root, ".claude/settings.json", JSON.stringify(existing, null, 2));
    const r = installClaudeHooks(root, { command: "snapback" });
    expect(r.added).toEqual(["UserPromptSubmit", "PreToolUse", "PostToolUse"]);
    expect(r.backup && existsSync(r.backup)).toBe(true);
    expect(JSON.parse(readFileSync(r.backup!, "utf8"))).toEqual(existing);

    const s = readSettings();
    expect(s.model).toBe("some-model");
    expect(s.permissions).toEqual(existing.permissions);
    expect(s.hooks.Stop).toEqual(existing.hooks.Stop);
    expect(s.hooks.PreToolUse[0]).toEqual(existing.hooks.PreToolUse[0]);
    expect(s.hooks.PreToolUse[1].matcher).toContain("Edit");
    expect(s.hooks.PreToolUse[1].matcher).toContain("Bash");
    expect(s.hooks.PreToolUse[1].hooks[0]).toMatchObject({ type: "command", command: "snapback hook claude" });
    expect(s.hooks.PostToolUse).toHaveLength(1);
    expect(s.hooks.UserPromptSubmit[0].matcher).toBeUndefined();
    expect(claudeHooksInstalled(root)).toBe(true);
  });

  it("is idempotent", () => {
    write(root, ".claude/settings.json", JSON.stringify(existing));
    installClaudeHooks(root, { command: "snapback" });
    const once = readFileSync(settingsPath(), "utf8");
    const backupsBefore = readdirSync(path.join(root, ".claude")).length;
    const r = installClaudeHooks(root, { command: "snapback" });
    expect(r.added).toEqual([]);
    expect(readFileSync(settingsPath(), "utf8")).toBe(once);
    expect(readdirSync(path.join(root, ".claude")).length).toBe(backupsBefore);
  });

  it("creates the settings file when there is none", () => {
    const r = installClaudeHooks(root, { command: "snapback" });
    expect(r.backup).toBeUndefined();
    expect(Object.keys(readSettings().hooks).sort()).toEqual(["PostToolUse", "PreToolUse", "UserPromptSubmit"]);
  });

  it("writes settings.local.json with --local", () => {
    installClaudeHooks(root, { command: "snapback", local: true });
    expect(existsSync(path.join(root, ".claude", "settings.local.json"))).toBe(true);
    expect(existsSync(settingsPath())).toBe(false);
  });

  it("refuses to touch invalid JSON", () => {
    write(root, ".claude/settings.json", "{ not json");
    expect(() => installClaudeHooks(root, { command: "snapback" })).toThrow(/not valid JSON/);
    expect(read(root, ".claude/settings.json")).toBe("{ not json");
  });

  it("uninstall removes only snapback's entries", () => {
    write(root, ".claude/settings.json", JSON.stringify(existing));
    installClaudeHooks(root, { command: "snapback" });
    const r = uninstallClaudeHooks(root);
    expect(r.removed).toBe(3);
    expect(readSettings()).toEqual(existing);
    expect(claudeHooksInstalled(root)).toBe(false);
  });
});

describe("Claude Code hook handler", () => {
  const payload = (o: Record<string, unknown>) => JSON.stringify({ session_id: "s1", cwd: root, ...o });

  it("records turn and tool snapshots that make `undo` revert the last turn", async () => {
    write(root, "app.ts", "v0");
    await handleClaudeHook(payload({ hook_event_name: "UserPromptSubmit", prompt_text: "add a feature" }), {});
    await handleClaudeHook(payload({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: path.join(root, "app.ts") } }), {});
    write(root, "app.ts", "v1");
    await handleClaudeHook(payload({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: path.join(root, "app.ts") } }), {});
    await handleClaudeHook(payload({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm -f app.ts && touch other.ts" } }), {});
    write(root, "other.ts", "");
    await handleClaudeHook(payload({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "rm -f app.ts && touch other.ts" } }), {});

    const store = await Store.open(root, { create: false });
    const list = await store.list();
    expect(list.map((s) => s.kind)).toEqual(["post-tool", "post-tool", "turn-start"]);
    expect(list[0].label).toBe("after Bash: rm -f app.ts && touch other.ts");
    expect(list[1].label).toBe("after Edit: app.ts");
    expect(list[2].label).toBe("before prompt: add a feature");
    expect(list[0].agent).toBe("claude");

    const target = (await store.undoTarget())!;
    expect(target.kind).toBe("turn-start");
    await store.restore(target.id);
    expect(read(root, "app.ts")).toBe("v0");
    expect(existsSync(path.join(root, "other.ts"))).toBe(false);
  });

  it("uses CLAUDE_PROJECT_DIR over the payload cwd", async () => {
    write(root, "a.txt", "x");
    const sub = path.join(root, "sub");
    write(root, "sub/b.txt", "y");
    await handleClaudeHook(JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: sub }), { CLAUDE_PROJECT_DIR: root });
    const store = await Store.open(root, { create: false });
    expect((await store.list()).length).toBe(1);
  });

  it("ignores unknown events", async () => {
    expect(await handleClaudeHook(JSON.stringify({ hook_event_name: "Stop", cwd: root }), {})).toBeNull();
  });
});
