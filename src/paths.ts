import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Name of the storage directory before the project was renamed to snap-back. */
export const LEGACY_DIR_NAME = "snapback";
export const DIR_NAME = "snap-back";

/**
 * The storage directory inside a platform data directory. A `snapback` directory
 * left by an older version keeps being used, so existing snapshots stay reachable.
 */
export function storageDirIn(base: string): string {
  const current = path.join(base, DIR_NAME);
  const legacy = path.join(base, LEGACY_DIR_NAME);
  if (!existsSync(current) && existsSync(legacy)) return legacy;
  return current;
}

/** Root directory that holds one shadow repository per project. */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  // SNAPBACK_HOME is the variable name from before the rename.
  const override = env.SNAP_BACK_HOME || env.SNAPBACK_HOME;
  if (override) return path.resolve(override);
  if (process.platform === "win32") {
    return storageDirIn(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"));
  }
  if (process.platform === "darwin") {
    return storageDirIn(path.join(os.homedir(), "Library", "Application Support"));
  }
  return storageDirIn(env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"));
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
 * Pick the project root for a working directory: the nearest ancestor (or the
 * directory itself) that already has snap-back snapshots or contains a .git
 * entry, else the directory itself.
 *
 * The nearest one wins. A snapshot taken once in a parent folder such as
 * ~/code must not make every git repository below it part of one big project:
 * an undo there would roll back files in unrelated repositories, and changes
 * inside a nested repository would not be recorded at all.
 */
export function findProjectRoot(start: string): string {
  const begin = canonical(start);
  let dir = begin;
  for (;;) {
    if (existsSync(path.join(shadowDirFor(dir), "HEAD"))) return dir;
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return begin;
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
