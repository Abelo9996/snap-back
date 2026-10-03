import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonical, findProjectRoot } from "./paths.js";
import { Store, type SnapshotKind } from "./store.js";

/** Tools whose calls can change files. Matched against Claude Code's tool_name. */
export const CLAUDE_TOOL_MATCHER = "Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell";
const MARKER = /snapback.*\bhook claude\b/;

type HookEntry = { type?: string; command?: string; [k: string]: unknown };
type HookGroup = { matcher?: string; hooks?: HookEntry[]; [k: string]: unknown };
type Settings = { hooks?: Record<string, HookGroup[]>; [k: string]: unknown };

export interface InstallResult {
  file: string;
  backup?: string;
  added: string[];
  command: string;
}

export interface UninstallResult {
  file: string;
  backup?: string;
  removed: number;
}

function findOnPath(name: string): string | null {
  const exts = process.platform === "win32" ? [".cmd", ".exe", ".ps1", ""] : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try {
        if (statSync(p).isFile()) return p;
      } catch {
        // not here
      }
    }
  }
  return null;
}

/** True when this process is running from npx's temporary cache. */
export function runningFromNpxCache(): boolean {
  return /[\\/]_npx[\\/]/.test(process.argv[1] || "");
}

/**
 * The command written into hook settings. Prefers a `snapback` on PATH that is
 * not npx's temporary shim, otherwise the absolute path of this script.
 */
export function defaultHookCommand(): string {
  const onPath = findOnPath("snapback");
  if (onPath && !/[\\/]_npx[\\/]/.test(onPath)) return "snapback hook claude";
  const script = canonical(process.argv[1] || "snapback");
  const q = (s: string) => `"${s.replace(/\\/g, "/")}"`;
  return `${q(process.execPath)} ${q(script)} hook claude`;
}

function settingsFile(root: string, local: boolean): string {
  return path.join(root, ".claude", local ? "settings.local.json" : "settings.json");
}

function readSettings(file: string): Settings {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, "utf8");
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} is not valid JSON, so snapback left it unchanged. Fix it and retry. (${(e as Error).message})`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file} does not contain a JSON object, so snapback left it unchanged.`);
  }
  const s = parsed as Settings;
  if (s.hooks !== undefined && (typeof s.hooks !== "object" || s.hooks === null || Array.isArray(s.hooks))) {
    throw new Error(`"hooks" in ${file} is not an object, so snapback left it unchanged.`);
  }
  return s;
}

function backup(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  let dest = `${file}.snapback-backup-${stamp}`;
  for (let i = 1; existsSync(dest); i++) dest = `${file}.snapback-backup-${stamp}-${i}`;
  copyFileSync(file, dest);
  return dest;
}

function hasSnapbackHook(groups: HookGroup[] | undefined): boolean {
  return !!groups?.some((g) => g.hooks?.some((h) => typeof h.command === "string" && MARKER.test(h.command)));
}

/**
 * Merge snapback's hook entries into .claude/settings.json (or settings.local.json).
 * Existing settings and hooks are preserved; the file is backed up before writing.
 */
export function installClaudeHooks(root: string, opts: { command?: string; local?: boolean } = {}): InstallResult {
  const file = settingsFile(root, !!opts.local);
  const settings = readSettings(file);
  const command = opts.command ? `${opts.command} hook claude` : defaultHookCommand();
  const hooks = (settings.hooks ??= {});
  const wanted: [string, HookGroup][] = [
    ["UserPromptSubmit", { hooks: [{ type: "command", command, timeout: 30 }] }],
    ["PreToolUse", { matcher: CLAUDE_TOOL_MATCHER, hooks: [{ type: "command", command, timeout: 30 }] }],
    ["PostToolUse", { matcher: CLAUDE_TOOL_MATCHER, hooks: [{ type: "command", command, timeout: 30 }] }],
  ];
  const added: string[] = [];
  for (const [event, group] of wanted) {
    const existing = hooks[event];
    if (existing !== undefined && !Array.isArray(existing)) {
      throw new Error(`hooks.${event} in ${file} is not an array, so snapback left the file unchanged.`);
    }
    if (hasSnapbackHook(existing)) continue;
    hooks[event] = [...(existing ?? []), group];
    added.push(event);
  }
  if (!added.length) return { file, added, command };
  const bak = backup(file);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  return { file, backup: bak, added, command };
}

export function uninstallClaudeHooks(root: string, opts: { local?: boolean } = {}): UninstallResult {
  const file = settingsFile(root, !!opts.local);
  const settings = readSettings(file);
  let removed = 0;
  const hooks = settings.hooks;
  if (!hooks) return { file, removed };
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept: HookGroup[] = [];
    for (const g of groups) {
      const before = g.hooks?.length ?? 0;
      const inner = (g.hooks ?? []).filter((h) => !(typeof h.command === "string" && MARKER.test(h.command)));
      removed += before - inner.length;
      if (inner.length || before === 0) kept.push({ ...g, hooks: inner });
    }
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (!removed) return { file, removed };
  if (!Object.keys(hooks).length) delete settings.hooks;
  const bak = backup(file);
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  return { file, backup: bak, removed };
}

export function claudeHooksInstalled(root: string): boolean {
  for (const local of [false, true]) {
    try {
      const s = readSettings(settingsFile(root, local));
      if (Object.values(s.hooks ?? {}).some((g) => Array.isArray(g) && hasSnapbackHook(g))) return true;
    } catch {
      // unreadable settings: report as not installed
    }
  }
  return false;
}

interface ClaudeHookPayload {
  hook_event_name?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  prompt?: string;
  prompt_text?: string;
}

function short(s: string, n = 60): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 3) + "..." : flat;
}

/**
 * Handle one Claude Code hook invocation. Must never write to stdout (for
 * UserPromptSubmit, stdout becomes model context) and must never block the agent.
 */
export async function handleClaudeHook(raw: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  let p: ClaudeHookPayload = {};
  try {
    p = JSON.parse(raw || "{}");
  } catch {
    // treat as empty payload
  }
  const start = env.CLAUDE_PROJECT_DIR || p.cwd || process.cwd();
  const root = findProjectRoot(start);
  const event = p.hook_event_name || "";
  const tool = p.tool_name || "tool";
  const input = p.tool_input || {};
  const target =
    (typeof input.file_path === "string" && input.file_path) ||
    (typeof input.notebook_path === "string" && input.notebook_path) ||
    "";
  const detail = target
    ? path.isAbsolute(target)
      ? path.relative(root, target).split(path.sep).join("/")
      : target
    : typeof input.command === "string"
      ? short(input.command)
      : "";
  let kind: SnapshotKind;
  let label: string;
  if (event === "UserPromptSubmit") {
    kind = "turn-start";
    label = `before prompt: ${short(p.prompt_text ?? p.prompt ?? "")}`;
  } else if (event === "PreToolUse") {
    kind = "pre-tool";
    label = `before ${tool}${detail ? ": " + detail : ""}`;
  } else if (event === "PostToolUse") {
    kind = "post-tool";
    label = `after ${tool}${detail ? ": " + detail : ""}`;
  } else {
    return null;
  }
  const store = await Store.open(root);
  const snap = await store.snapshot({ kind, label, agent: "claude" });
  return snap?.id ?? null;
}
