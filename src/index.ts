export { Store, StoreError, BOUNDARY_KINDS, BUILTIN_IGNORES, VERSION } from "./store.js";
export type { Snapshot, SnapshotKind, RestorePlan, RestoreResult } from "./store.js";
export { installClaudeHooks, uninstallClaudeHooks, handleClaudeHook, claudeHooksInstalled } from "./hooks.js";
export { watchProject } from "./watch.js";
export { wrapCommand } from "./wrap.js";
export { findProjectRoot, dataDir, shadowDirFor } from "./paths.js";
export { matchAgents, detectAgents } from "./agents.js";
