import { execFile } from "node:child_process";

/** Command names of coding agents we can recognise in the process list. */
export const KNOWN_AGENTS = [
  "codex",
  "claude",
  "opencode",
  "aider",
  "cursor-agent",
  "gemini",
  "goose",
  "amp",
  "qwen",
  "deepseek",
  "crush",
  "kilo",
];

function listProcesses(): Promise<string[]> {
  return new Promise((resolve) => {
    const [cmd, args] =
      process.platform === "win32" ? ["tasklist", ["/fo", "csv", "/nh"]] : ["ps", ["-A", "-o", "args="]];
    execFile(cmd, args as string[], { timeout: 3000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(stdout.split(/\r?\n/).filter(Boolean));
    });
  });
}

/** Pure matcher, exported for tests. Returns agent names found in process command lines. */
export function matchAgents(lines: string[]): string[] {
  const found = new Set<string>();
  for (const line of lines) {
    // Skip our own processes, under the current name and the one from before the rename.
    if (/snap-?back/.test(line)) continue;
    // First two tokens cover both `codex ...` and `node /path/to/codex ...`.
    const tokens = line.replace(/^"|"$/g, "").split(/[\s",]+/).slice(0, 2);
    for (const tok of tokens) {
      const base = tok.split(/[\\/]/).pop()!.toLowerCase().replace(/\.(exe|cmd|js|mjs)$/, "");
      if (KNOWN_AGENTS.includes(base)) found.add(base);
    }
  }
  return [...found].sort();
}

/** Best-effort detection of running coding agents. Never throws. */
export async function detectAgents(): Promise<string[]> {
  try {
    return matchAgents(await listProcesses());
  } catch {
    return [];
  }
}
