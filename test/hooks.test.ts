import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claudeHookStatus,
  claudeHooksInstalled,
  handleClaudeHook,
  installClaudeHooks,
  isMachineSpecificCommand,
  uninstallClaudeHooks,
} from "../src/hooks.js";
import { Store } from "../src/store.js";
import { cleanup, isolateHome, read, tempDir, write } from "./helpers.js";

let root: string;
const localPath = () => path.join(root, ".claude", "settings.local.json");
const sharedPath = () => path.join(root, ".claude", "settings.json");
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));

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

const legacy = (cmd = "snapback hook claude") => ({
  ...existing,
  hooks: {
    ...existing.hooks,
    UserPromptSubmit: [{ hooks: [{ type: "command", command: cmd, timeout: 30 }] }],
    PreToolUse: [...existing.hooks.PreToolUse, { matcher: "Edit|Write", hooks: [{ type: "command", command: cmd, timeout: 30 }] }],
    PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: cmd, timeout: 30 }] }],
  },
});

function allCommands(file: string): string[] {
  const s = readJson(file);
  return Object.values(s.hooks as Record<string, { hooks: { command: string }[] }[]>)
    .flat()
    .flatMap((g) => g.hooks.map((h) => h.command));
}

describe("Claude Code hooks install defaults", () => {
  it("writes .claude/settings.local.json and leaves settings.json alone", () => {
    write(root, ".claude/settings.json", JSON.stringify(existing, null, 2));
    const before = read(root, ".claude/settings.json");
    const r = installClaudeHooks(root, { command: "snap-back" });
    expect(r.scope).toBe("local");
    expect(r.file).toBe(localPath());
    expect(r.created).toBe(true);
    expect(existsSync(localPath())).toBe(true);
    expect(read(root, ".claude/settings.json")).toBe(before);
    expect(claudeHookStatus(root).map((st) => [st.scope, st.installed])).toEqual([
      ["local", true],
      ["shared", false],
    ]);
  });

  it("writes .claude/settings.json only with shared", () => {
    const r = installClaudeHooks(root, { command: "snap-back", shared: true });
    expect(r.scope).toBe("shared");
    expect(existsSync(sharedPath())).toBe(true);
    expect(existsSync(localPath())).toBe(false);
  });

  it("flags commands that contain a machine-specific path", () => {
    expect(isMachineSpecificCommand("snap-back hook claude")).toBe(false);
    expect(isMachineSpecificCommand('node "/home/me/.npm/_npx/abc/node_modules/snap-back/dist/cli.js" hook claude')).toBe(true);
    expect(isMachineSpecificCommand('node "C:/Users/me/AppData/Local/npm-cache/_npx/abc/cli.js" hook claude')).toBe(true);
    expect(installClaudeHooks(root, { command: "snap-back", shared: true }).machineSpecific).toBe(false);
    const r = installClaudeHooks(root, { command: "node /opt/snap-back/dist/cli.js", shared: true });
    expect(r.machineSpecific).toBe(true);
  });

  it("reports when the other settings file also has the hooks", () => {
    installClaudeHooks(root, { command: "snap-back", shared: true });
    const r = installClaudeHooks(root, { command: "snap-back" });
    expect(r.alsoIn).toBe(sharedPath());
  });

  it("uninstall without a scope cleans both files", () => {
    write(root, ".claude/settings.json", JSON.stringify(existing));
    write(root, ".claude/settings.local.json", JSON.stringify(existing));
    installClaudeHooks(root, { command: "snap-back", shared: true });
    installClaudeHooks(root, { command: "snap-back" });
    const { results, errors } = uninstallClaudeHooks(root);
    expect(errors).toEqual([]);
    expect(results.map((r) => [r.scope, r.removed])).toEqual([
      ["local", 3],
      ["shared", 3],
    ]);
    expect(readJson(sharedPath())).toEqual(existing);
    expect(readJson(localPath())).toEqual(existing);
    expect(claudeHooksInstalled(root)).toBe(false);
  });

  it("uninstall with a scope cleans only that file", () => {
    installClaudeHooks(root, { command: "snap-back", shared: true });
    installClaudeHooks(root, { command: "snap-back" });
    const { results } = uninstallClaudeHooks(root, { scope: "shared" });
    expect(results.map((r) => r.file)).toEqual([sharedPath()]);
    expect(claudeHookStatus(root).map((st) => st.installed)).toEqual([true, false]);
  });

  it("uninstall still cleans one file when the other is not valid JSON", () => {
    write(root, ".claude/settings.json", "{ not json");
    installClaudeHooks(root, { command: "snap-back" });
    const { results, errors } = uninstallClaudeHooks(root);
    expect(results.map((r) => [r.scope, r.removed])).toEqual([["local", 3]]);
    expect(errors.map((e) => e.file)).toEqual([sharedPath()]);
    expect(read(root, ".claude/settings.json")).toBe("{ not json");
    expect(claudeHookStatus(root)[1].error).toMatch(/not valid JSON/);
  });
});

describe.each([
  { scope: "local" as const, shared: false, file: "settings.local.json" },
  { scope: "shared" as const, shared: true, file: "settings.json" },
])("Claude Code hooks in $file", ({ scope, shared, file }) => {
  const settingsPath = () => path.join(root, ".claude", file);
  const readSettings = () => readJson(settingsPath());

  it("merges into existing settings without clobbering them, and backs the file up", () => {
    write(root, `.claude/${file}`, JSON.stringify(existing, null, 2));
    const r = installClaudeHooks(root, { command: "snap-back", shared });
    expect(r.file).toBe(settingsPath());
    expect(r.created).toBe(false);
    expect(r.added).toEqual(["UserPromptSubmit", "PreToolUse", "PostToolUse"]);
    expect(r.backup && existsSync(r.backup)).toBe(true);
    expect(path.basename(r.backup!)).toMatch(new RegExp(`^${file.replace(/\./g, "\\.")}\\.snap-back-backup-\\d{8}-\\d{6}$`));
    expect(JSON.parse(readFileSync(r.backup!, "utf8"))).toEqual(existing);

    const s = readSettings();
    expect(s.model).toBe("some-model");
    expect(s.permissions).toEqual(existing.permissions);
    expect(s.hooks.Stop).toEqual(existing.hooks.Stop);
    expect(s.hooks.PreToolUse[0]).toEqual(existing.hooks.PreToolUse[0]);
    expect(s.hooks.PreToolUse[1].matcher).toContain("Edit");
    expect(s.hooks.PreToolUse[1].matcher).toContain("Bash");
    expect(s.hooks.PreToolUse[1].hooks[0]).toMatchObject({ type: "command", command: "snap-back hook claude" });
    expect(s.hooks.PostToolUse).toHaveLength(1);
    expect(s.hooks.UserPromptSubmit[0].matcher).toBeUndefined();
    expect(claudeHookStatus(root).find((st) => st.scope === scope)!.installed).toBe(true);
  });

  it("is idempotent", () => {
    write(root, `.claude/${file}`, JSON.stringify(existing));
    installClaudeHooks(root, { command: "snap-back", shared });
    const once = readFileSync(settingsPath(), "utf8");
    const filesBefore = readdirSync(path.join(root, ".claude")).length;
    const r = installClaudeHooks(root, { command: "snap-back", shared });
    expect(r.added).toEqual([]);
    expect(r.backup).toBeUndefined();
    expect(readFileSync(settingsPath(), "utf8")).toBe(once);
    expect(readdirSync(path.join(root, ".claude")).length).toBe(filesBefore);
  });

  it("creates the settings file when there is none, without a backup", () => {
    const r = installClaudeHooks(root, { command: "snap-back", shared });
    expect(r.created).toBe(true);
    expect(r.backup).toBeUndefined();
    expect(Object.keys(readSettings().hooks).sort()).toEqual(["PostToolUse", "PreToolUse", "UserPromptSubmit"]);
    expect(readdirSync(path.join(root, ".claude"))).toEqual([file]);
  });

  it("refuses to touch invalid JSON", () => {
    write(root, `.claude/${file}`, "{ not json");
    expect(() => installClaudeHooks(root, { command: "snap-back", shared })).toThrow(/not valid JSON/);
    expect(read(root, `.claude/${file}`)).toBe("{ not json");
  });

  it("uninstall removes only snap-back's entries and backs the file up", () => {
    write(root, `.claude/${file}`, JSON.stringify(existing));
    installClaudeHooks(root, { command: "snap-back", shared });
    const withHooks = readSettings();
    const { results } = uninstallClaudeHooks(root, { scope });
    expect(results).toHaveLength(1);
    expect(results[0].removed).toBe(3);
    expect(JSON.parse(readFileSync(results[0].backup!, "utf8"))).toEqual(withHooks);
    expect(readSettings()).toEqual(existing);
    expect(claudeHooksInstalled(root)).toBe(false);
  });

  it("reinstall replaces hooks written before the rename", () => {
    write(root, `.claude/${file}`, JSON.stringify(legacy()));
    expect(claudeHooksInstalled(root)).toBe(true);
    const r = installClaudeHooks(root, { command: "snap-back", shared });
    expect(r.replaced).toBe(3);
    expect(r.added).toEqual(["UserPromptSubmit", "PreToolUse", "PostToolUse"]);
    const commands = allCommands(settingsPath());
    expect(commands).not.toContain("snapback hook claude");
    expect(commands.filter((c) => c === "snap-back hook claude")).toHaveLength(3);
    const s = readSettings();
    expect(s.hooks.PreToolUse[0]).toEqual(existing.hooks.PreToolUse[0]);
    expect(s.hooks.Stop).toEqual(existing.hooks.Stop);
    expect(installClaudeHooks(root, { command: "snap-back", shared }).added).toEqual([]);
  });

  it("uninstall removes hooks written before the rename", () => {
    write(root, `.claude/${file}`, JSON.stringify(legacy('node "/home/me/.npm/_npx/abc/node_modules/snapback/dist/cli.js" hook claude')));
    const { results } = uninstallClaudeHooks(root);
    expect(results.find((r) => r.scope === scope)!.removed).toBe(3);
    expect(readSettings()).toEqual(existing);
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
