import { closeSync, openSync, rmSync, statSync, writeSync } from "node:fs";

const STALE_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * A small cross-process lock file. Hooks, `watch` and manual commands can fire
 * at the same moment; they must not interleave writes to the shadow index.
 */
export async function withLock<T>(lockPath: string, fn: () => Promise<T>, timeoutMs = 30_000): Promise<T> {
  const start = Date.now();
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = openSync(lockPath, "wx");
      writeSync(fd, String(process.pid));
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") throw err;
      try {
        const age = Date.now() - statSync(lockPath).mtimeMs;
        if (age > STALE_MS) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out waiting for lock ${lockPath}. If no snapback process is running, delete that file.`);
      }
      await sleep(50 + Math.random() * 50);
    }
  }
  try {
    return await fn();
  } finally {
    closeSync(fd);
    rmSync(lockPath, { force: true });
  }
}
