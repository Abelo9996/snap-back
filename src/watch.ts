import path from "node:path";
import chokidar from "chokidar";
import { detectAgents } from "./agents.js";
import { BUILTIN_IGNORES, Store, type Snapshot } from "./store.js";

const IGNORED_DIRS = new Set(
  BUILTIN_IGNORES.filter((p) => p.endsWith("/")).map((p) => p.slice(0, -1)),
);

export interface WatchOptions {
  debounceMs?: number;
  maxWaitMs?: number;
  detectAgent?: boolean;
  onSnapshot?: (s: Snapshot) => void;
  onError?: (e: unknown) => void;
}

export interface WatchHandle {
  ready: Promise<void>;
  close: () => Promise<void>;
  /** Snapshot any pending changes now. */
  flush: () => Promise<void>;
}

/**
 * Watch the project and turn bursts of file changes into snapshots. A burst ends
 * after `debounceMs` of quiet, or after `maxWaitMs` of continuous changes.
 */
export function watchProject(store: Store, opts: WatchOptions = {}): WatchHandle {
  const debounceMs = opts.debounceMs ?? 1500;
  const maxWaitMs = opts.maxWaitMs ?? 30_000;
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  let burstStart = 0;
  let chain: Promise<void> = Promise.resolve();

  const watcher = chokidar.watch(store.root, {
    ignoreInitial: true,
    persistent: true,
    ignored: (p: string) => {
      const rel = path.relative(store.root, p);
      if (!rel) return false;
      return rel.split(path.sep).some((seg) => IGNORED_DIRS.has(seg));
    },
  });

  const flush = (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!pending.size) return chain;
    const files = [...pending].sort();
    pending.clear();
    burstStart = 0;
    chain = chain.then(async () => {
      try {
        const agents = opts.detectAgent === false ? [] : await detectAgents();
        const shown = files.slice(0, 3).join(", ") + (files.length > 3 ? `, +${files.length - 3} more` : "");
        const snap = await store.snapshot({
          kind: "watch",
          label: `watch: ${shown}`,
          agent: agents.length ? agents.join(",") : undefined,
        });
        if (snap) opts.onSnapshot?.(snap);
      } catch (e) {
        opts.onError?.(e);
      }
    });
    return chain;
  };

  watcher.on("all", (_event, p) => {
    pending.add(path.relative(store.root, p).split(path.sep).join("/"));
    const now = Date.now();
    if (!burstStart) burstStart = now;
    if (timer) clearTimeout(timer);
    if (now - burstStart >= maxWaitMs) void flush();
    else timer = setTimeout(() => void flush(), debounceMs);
  });
  watcher.on("error", (e) => opts.onError?.(e));

  const ready = new Promise<void>((resolve) => watcher.once("ready", () => resolve()));

  return {
    ready,
    flush,
    close: async () => {
      await flush();
      await watcher.close();
    },
  };
}
