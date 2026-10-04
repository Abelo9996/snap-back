import { closeSync, openSync, readFileSync, rmSync, statSync, utimesSync, writeSync } from "node:fs";

/** A lock whose holder stopped refreshing it for this long is considered abandoned. */
const STALE_MS = 60_000;
/** How often a holder refreshes the lock file's mtime while it works. */
const HEARTBEAT_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** False only when we are sure no process with this pid exists on this machine. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * True when the lock file was left behind: its owner process is gone (for
 * example after Ctrl-C or a crash), or it has not been refreshed for STALE_MS.
 */
function isStale(lockPath: string): boolean {
  const age = Date.now() - statSync(lockPath).mtimeMs;
  if (age > STALE_MS) return true;
  let pid = NaN;
  try {
    pid = Number(readFileSync(lockPath, "utf8").trim());
  } catch {
    return false;
  }
  // A brand-new lock file may not have its pid written yet.
  if (!pid) return false;
  return !pidAlive(pid);
}

/**
 * Thrown after the locked work finished when Ctrl-C or SIGTERM arrived during
 * it. `value` is what the work returned, so callers can still report it.
 */
export class InterruptedError extends Error {
  constructor(public value: unknown) {
    super("Interrupted. The snapshot or restore that was in progress was completed first.");
    this.name = "InterruptedError";
  }
}

let held = 0;
let interrupted = 0;

/**
 * Ctrl-C or SIGTERM while snap-back holds a lock would leave a half-written
 * snapshot or a half-finished restore. When no command installed its own
 * handler, defer the exit until the locked work is done. A third signal exits
 * immediately.
 */
function onSignal(signal: NodeJS.Signals): void {
  interrupted++;
  if (interrupted === 1) {
    process.stderr.write("\nsnap-back: finishing the current snapshot or restore before exiting. Press Ctrl-C twice more to force.\n");
  }
  if (interrupted >= 3) process.exit(signal === "SIGTERM" ? 143 : 130);
}

function guardSignals(): () => void {
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  // Commands such as `wrap` and `watch` handle signals themselves; leave them alone.
  const ours = signals.filter((s) => process.listenerCount(s) === 0);
  for (const s of ours) process.on(s, onSignal);
  return () => {
    for (const s of ours) process.off(s, onSignal);
  };
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
        if (isStale(lockPath)) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `Another snap-back process has been busy with this project for over ${Math.round(timeoutMs / 1000)}s ` +
            `(lock file ${lockPath}). Wait for it to finish and retry. If no snap-back process is running, delete that file.`,
        );
      }
      await sleep(50 + Math.random() * 50);
    }
  }
  held++;
  const release = held === 1 ? guardSignals() : () => {};
  const beat = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(lockPath, now, now);
    } catch {
      // best effort
    }
  }, HEARTBEAT_MS);
  beat.unref();
  let result: T;
  try {
    result = await fn();
  } finally {
    clearInterval(beat);
    closeSync(fd);
    rmSync(lockPath, { force: true });
    held--;
    if (held === 0) release();
  }
  if (held === 0 && interrupted) {
    interrupted = 0;
    throw new InterruptedError(result);
  }
  return result;
}
