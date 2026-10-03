import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { Store, type Snapshot } from "./store.js";

export interface WrapOptions {
  intervalMs?: number;
  log?: (msg: string) => void;
}

export interface WrapResult {
  exitCode: number;
  start: Snapshot;
  end: Snapshot | null;
  changed: string[];
}

/** Windows: find what `cmd` resolves to through PATH and PATHEXT. */
function resolveWindowsCommand(cmd: string): string | null {
  const exts = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const isFile = (p: string) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  const candidates = (base: string) => (path.extname(base) ? [base] : exts.map((e) => base + e.toLowerCase()));
  if (cmd.includes("/") || cmd.includes("\\")) return candidates(path.resolve(cmd)).find(isFile) ?? null;
  for (const dir of (process.env.PATH || process.env.Path || "").split(path.delimiter)) {
    if (!dir) continue;
    const hit = candidates(path.join(dir, cmd)).find(isFile);
    if (hit) return hit;
  }
  return null;
}

function quoteForCmd(arg: string): string {
  return /^[A-Za-z0-9_\-.,:\/\\=@]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`;
}

/** How to spawn argv: directly, or through cmd.exe for .cmd/.bat shims on Windows. */
function spawnSpec(argv: string[]): { file: string; args: string[]; shell: boolean } {
  if (process.platform !== "win32") return { file: argv[0], args: argv.slice(1), shell: false };
  const resolved = resolveWindowsCommand(argv[0]);
  if (resolved && /\.(exe|com)$/i.test(resolved)) return { file: resolved, args: argv.slice(1), shell: false };
  return { file: argv.map(quoteForCmd).join(" "), args: [], shell: true };
}

function agentName(cmd: string): string {
  return path.basename(cmd).replace(/\.(exe|cmd|bat|ps1|js|mjs)$/i, "");
}

/**
 * Checkpoint, run the agent command in the foreground, snapshot periodically
 * while it runs, and checkpoint again when it exits.
 */
export async function wrapCommand(store: Store, argv: string[], opts: WrapOptions = {}): Promise<WrapResult> {
  if (!argv.length) throw new Error("Nothing to run. Usage: snapback wrap -- <agent command>");
  const log = opts.log ?? (() => {});
  const agent = agentName(argv[0]);
  const cmdline = argv.join(" ");
  const start = (await store.snapshot({ kind: "wrap-start", label: `before: ${cmdline}`, agent }))!;
  log(`snapback: checkpoint ${start.id} taken before \`${cmdline}\``);

  let busy: Promise<unknown> = Promise.resolve();
  const timer =
    opts.intervalMs && opts.intervalMs > 0
      ? setInterval(() => {
          busy = busy.then(() =>
            store.snapshot({ kind: "wrap", label: `during: ${cmdline}`, agent }).catch(() => null),
          );
        }, opts.intervalMs)
      : null;

  // The terminal sends Ctrl-C to the whole process group; let the agent handle
  // it and keep this process alive long enough to take the final snapshot.
  const ignore = () => {};
  process.on("SIGINT", ignore);
  process.on("SIGTERM", ignore);

  const exitCode = await new Promise<number>((resolve) => {
    const spec = spawnSpec(argv);
    const child = spawn(spec.file, spec.args, { stdio: "inherit", cwd: process.cwd(), shell: spec.shell });
    child.on("error", (e: NodeJS.ErrnoException) => {
      log(e.code === "ENOENT" ? `snapback: command not found: ${argv[0]}` : `snapback: ${e.message}`);
      resolve(127);
    });
    child.on("exit", (code, signal) => {
      if (signal) resolve(128 + (signal === "SIGINT" ? 2 : signal === "SIGTERM" ? 15 : 1));
      else resolve(code ?? 1);
    });
  });

  if (timer) clearInterval(timer);
  await busy;
  process.off("SIGINT", ignore);
  process.off("SIGTERM", ignore);

  const end = await store.snapshot({ kind: "wrap-end", label: `after: ${cmdline} (exit ${exitCode})`, agent });
  const headId = end?.id ?? (await store.list(1))[0].id;
  const changed = await store.changedBetween(start.hash, headId);
  if (changed.length) {
    log(
      `snapback: ${agent} changed ${changed.length} file${changed.length === 1 ? "" : "s"}. ` +
        `Review with \`snapback diff ${start.id}\`, roll back with \`snapback undo\`.`,
    );
  } else {
    log(`snapback: no file changes since checkpoint ${start.id}.`);
  }
  return { exitCode, start, end, changed };
}
