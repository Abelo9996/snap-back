import { spawn, spawnSync } from "node:child_process";

export class GitMissingError extends Error {
  constructor() {
    super(
      [
        "snapback needs git on your PATH, and it could not find it.",
        "snapback stores snapshots in a private git repository outside your project,",
        "so git is required even if your project does not use git.",
        "Install git (https://git-scm.com/downloads), open a new terminal, and run `git --version` to check.",
      ].join("\n"),
    );
    this.name = "GitMissingError";
  }
}

export class GitError extends Error {
  constructor(
    public args: string[],
    public code: number | null,
    public stderr: string,
  ) {
    super(`git ${args.join(" ")} failed (exit ${code}): ${stderr.trim()}`);
    this.name = "GitError";
  }
}

/**
 * Environment for every git child process. Any GIT_* variable inherited from
 * the caller (for example when snapback runs inside a git hook) could redirect
 * git at the user's own repository, so all of them are removed.
 */
export function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.toUpperCase().startsWith("GIT_")) continue;
    env[k] = v;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.LC_ALL = "C";
  return { ...env, ...extra };
}

export interface RunOptions {
  input?: string | Buffer;
  env?: Record<string, string>;
  cwd?: string;
  allowFail?: boolean;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export function runGit(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: opts.cwd,
      env: cleanEnv(opts.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") reject(new GitMissingError());
      else reject(e);
    });
    child.on("close", (code) => {
      const res = {
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        code,
      };
      if (code !== 0 && !opts.allowFail) reject(new GitError(args, code, res.stderr));
      else resolve(res);
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

let gitVersionCache: string | null | undefined;

/** Returns the git version string, or null when git is not installed. */
export function gitVersion(): string | null {
  if (gitVersionCache !== undefined) return gitVersionCache;
  const r = spawnSync("git", ["--version"], { env: cleanEnv(), encoding: "utf8", windowsHide: true });
  gitVersionCache = r.error || r.status !== 0 ? null : r.stdout.trim().replace(/^git version\s*/, "");
  return gitVersionCache;
}

export function requireGit(): string {
  const v = gitVersion();
  if (!v) throw new GitMissingError();
  return v;
}
