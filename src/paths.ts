import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Root directory that holds one shadow repository per project. */
export function dataDir(): string {
  if (process.env.SNAPBACK_HOME) return path.resolve(process.env.SNAPBACK_HOME);
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "snapback");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "snapback");
  }
  const xdg = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(xdg, "snapback");
}

export function canonical(p: string): string {
  const abs = path.resolve(p);
  try {
    return realpathSync.native(abs);
  } catch {
    return abs;
  }
}

/** Stable directory name for a project's shadow repository. */
export function projectKey(root: string): string {
  const c = canonical(root);
  const norm = process.platform === "win32" ? c.toLowerCase() : c;
  const hash = createHash("sha256").update(norm).digest("hex").slice(0, 16);
  const base = path.basename(c).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40) || "root";
  return `${base}-${hash}`;
}

export function shadowDirFor(root: string): string {
  return path.join(dataDir(), projectKey(root));
}

/**
 * Pick the project root for a working directory:
 * 1. the nearest ancestor that already has snapback snapshots,
 * 2. else the nearest ancestor containing a .git entry,
 * 3. else the directory itself.
 */
export function findProjectRoot(start: string): string {
  const begin = canonical(start);
  let dir = begin;
  let gitRoot: string | null = null;
  for (;;) {
    if (existsSync(path.join(shadowDirFor(dir), "HEAD"))) return dir;
    if (!gitRoot && existsSync(path.join(dir, ".git"))) gitRoot = dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return gitRoot ?? begin;
}

export class UnsafeRootError extends Error {}

/** Refuse roots that are almost certainly a mistake to snapshot. */
export function assertSafeRoot(root: string): void {
  const c = canonical(root);
  const home = canonical(os.homedir());
  if (c === home) {
    throw new UnsafeRootError(
      `Refusing to snapshot your home directory (${c}). cd into a project directory first, or pass --dir.`,
    );
  }
  if (path.dirname(c) === c) {
    throw new UnsafeRootError(`Refusing to snapshot a filesystem root (${c}). cd into a project directory first.`);
  }
}
