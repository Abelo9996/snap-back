import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonical, findProjectRoot } from "./paths.js";
import { Store, type SnapshotKind } from "./store.js";

/** Tools whose calls can change files. Matched against Claude Code's tool_name. */
export const CLAUDE_TOOL_MATCHER = "Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell";
/**
 * Matches hook commands written by snap-back, including the `snapback hook claude`
 * form written before the rename, so uninstall and reinstall clean those up too.
 */
const MARKER = /snap-?back.*\bhook claude\b/;

type HookEntry = { type?: string; command?: string; [k: string]: unknown };
type HookGroup = { matcher?: string; hooks?: HookEntry[]; [k: string]: unknown };
type Settings = { hooks?: Record<string, HookGroup[]>; [k: string]: unknown };

/**
 * Which Claude Code settings file to use. `local` is .claude/settings.local.json,
 * which is personal and usually not committed. `shared` is .claude/settings.json,
 * which projects usually commit.
 */
export type HookScope = "local" | "shared";
export const HOOK_SCOPES: readonly HookScope[] = ["local", "shared"];

export interface InstallResult {
  file: string;
  scope: HookScope;
  /** True when the settings file did not exist before this install. */
  created: boolean;
  backup?: string;
  added: string[];
  /** Entries from an earlier install with a different command that were replaced. */
  replaced: number;
  command: string;
  /** True when the command contains a path that exists only on this machine. */
  machineSpecific: boolean;
  /** The other settings file, when it also contains snap-back hooks. */
  alsoIn?: string;
}

export interface UninstallResult {
  file: string;
  scope: HookScope;
  backup?: string;
  removed: number;
}

export interface HookStatus {
  file: string;
  scope: HookScope;
  installed: boolean;
  /** Set when the file exists but could not be read as settings. */
  error?: string;
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
 * The command written into hook settings. Prefers a `snap-back` on PATH that is
 * not npx's temporary shim, otherwise the absolute path of this script.
 */
export function defaultHookCommand(): string {
  const onPath = findOnPath("snap-back");
  if (onPath && !/[\\/]_npx[\\/]/.test(onPath)) return "snap-back hook claude";
  const script = canonical(process.argv[1] || "snap-back");
  const q = (s: string) => `"${s.replace(/\\/g, "/")}"`;
  // Plain `node` survives Node upgrades; versioned install paths do not.
  const node = findOnPath("node") ? "node" : q(process.execPath);
  return `${node} ${q(script)} hook claude`;
}

export function claudeSettingsFile(root: string, scope: HookScope): string {
  return path.join(root, ".claude", scope === "shared" ? "settings.json" : "settings.local.json");
}

/**
 * True when a hook command depends on this machine's file layout (an absolute
 * path to node or to the script), so it would fail for anyone else who uses the
 * same settings file.
 */
export function isMachineSpecificCommand(command: string): boolean {
  return /[\\/]/.test(command);
}

function readSettings(file: string): Settings {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, "utf8");
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} is not valid JSON, so snap-back left it unchanged. Fix it and retry. (${(e as Error).message})`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file} does not contain a JSON object, so snap-back left it unchanged.`);
  }
  const s = parsed as Settings;
  if (s.hooks !== undefined && (typeof s.hooks !== "object" || s.hooks === null || Array.isArray(s.hooks))) {
    throw new Error(`"hooks" in ${file} is not an object, so snap-back left it unchanged.`);
  }
  return s;
}

function backup(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  let dest = `${file}.snap-back-backup-${stamp}`;
  for (let i = 1; existsSync(dest); i++) dest = `${file}.snap-back-backup-${stamp}-${i}`;
  copyFileSync(file, dest);
  return dest;
}

function isOurs(h: HookEntry): boolean {
  return typeof h.command === "string" && MARKER.test(h.command);
}

function hasOurHook(groups: HookGroup[] | undefined): boolean {
  return !!groups?.some((g) => g.hooks?.some(isOurs));
}

/**
 * Remove our entries for which `drop` returns true. Groups left with no hooks are
 * removed; groups that had no hooks to begin with are kept. Returns the count removed.
 */
function stripOurs(groups: HookGroup[], drop: (h: HookEntry) => boolean): { kept: HookGroup[]; removed: number } {
  let removed = 0;
  const kept: HookGroup[] = [];
  for (const g of groups) {
    const before = g.hooks?.length ?? 0;
    const inner = (g.hooks ?? []).filter((h) => !(isOurs(h) && drop(h)));
    removed += before - inner.length;
    if (before === 0) kept.push(g);
    else if (inner.length === before) kept.push(g);
    else if (inner.length) kept.push({ ...g, hooks: inner });
  }
  return { kept, removed };
}

/**
 * Merge snap-back's hook entries into .claude/settings.local.json, or into
 * .claude/settings.json with `shared: true`. Existing settings and hooks are
 * preserved; the file is backed up before writing. Entries from an earlier
 * install with a different command (for example the `snapback hook claude`
 * form from before the rename) are replaced.
 */
export function installClaudeHooks(root: string, opts: { command?: string; shared?: boolean } = {}): InstallResult {
  const scope: HookScope = opts.shared ? "shared" : "local";
  const file = claudeSettingsFile(root, scope);
  const created = !existsSync(file);
  const settings = readSettings(file);
  const command = opts.command ? `${opts.command} hook claude` : defaultHookCommand();
  const hooks = (settings.hooks ??= {});
  const wanted: [string, HookGroup][] = [
    ["UserPromptSubmit", { hooks: [{ type: "command", command, timeout: 30 }] }],
    ["PreToolUse", { matcher: CLAUDE_TOOL_MATCHER, hooks: [{ type: "command", command, timeout: 30 }] }],
    ["PostToolUse", { matcher: CLAUDE_TOOL_MATCHER, hooks: [{ type: "command", command, timeout: 30 }] }],
  ];
  const added: string[] = [];
  let replaced = 0;
  for (const [event, group] of wanted) {
    const existing = hooks[event];
    if (existing !== undefined && !Array.isArray(existing)) {
      throw new Error(`hooks.${event} in ${file} is not an array, so snap-back left the file unchanged.`);
    }
    const { kept, removed } = stripOurs(existing ?? [], (h) => h.command !== command);
    const current = hasOurHook(kept);
    if (current && !removed) continue;
    replaced += removed;
    hooks[event] = current ? kept : [...kept, group];
    added.push(event);
  }
  const other = claudeHookStatus(root).find((st) => st.scope !== scope && st.installed);
  const base = { file, scope, added, replaced, command, machineSpecific: isMachineSpecificCommand(command), alsoIn: other?.file };
  if (!added.length) return { ...base, created: false };
  const bak = backup(file);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  return { ...base, created, backup: bak };
}

function uninstallFrom(root: string, scope: HookScope): UninstallResult {
  const file = claudeSettingsFile(root, scope);
  const settings = readSettings(file);
  let removed = 0;
  const hooks = settings.hooks;
  if (!hooks) return { file, scope, removed };
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const r = stripOurs(groups, () => true);
    removed += r.removed;
    if (r.kept.length) hooks[event] = r.kept;
    else delete hooks[event];
  }
  if (!removed) return { file, scope, removed };
  if (!Object.keys(hooks).length) delete settings.hooks;
  const bak = backup(file);
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  return { file, scope, backup: bak, removed };
}

/**
 * Remove snap-back's hook entries. Without `scope`, both settings files are
 * cleaned. Files that are not valid JSON are left unchanged and reported in
 * `errors`; the other file is still processed.
 */
export function uninstallClaudeHooks(
  root: string,
  opts: { scope?: HookScope } = {},
): { results: UninstallResult[]; errors: { file: string; message: string }[] } {
  const results: UninstallResult[] = [];
  const errors: { file: string; message: string }[] = [];
  for (const scope of opts.scope ? [opts.scope] : HOOK_SCOPES) {
    try {
      results.push(uninstallFrom(root, scope));
    } catch (e) {
      errors.push({ file: claudeSettingsFile(root, scope), message: (e as Error).message });
    }
  }
  return { results, errors };
}

/** Whether each settings file (local, then shared) contains snap-back hooks. */
export function claudeHookStatus(root: string): HookStatus[] {
  return HOOK_SCOPES.map((scope) => {
    const file = claudeSettingsFile(root, scope);
    try {
      const s = readSettings(file);
      return { file, scope, installed: Object.values(s.hooks ?? {}).some((g) => Array.isArray(g) && hasOurHook(g)) };
    } catch (e) {
      return { file, scope, installed: false, error: (e as Error).message };
    }
  });
}

export function claudeHooksInstalled(root: string): boolean {
  return claudeHookStatus(root).some((st) => st.installed);
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
  // Set by the Claude Code plugin's hook launcher, so `status` can report that the
  // plugin is recording even though no settings file mentions snap-back.
  if (env.SNAP_BACK_VIA_PLUGIN === "1") store.markPluginHook();
  return snap?.id ?? null;
}
