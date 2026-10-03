export { Store, StoreError, BOUNDARY_KINDS, BUILTIN_IGNORES, VERSION } from "./store.js";
export type { Snapshot, SnapshotKind, RestorePlan, RestoreResult } from "./store.js";
export {
  installClaudeHooks,
  uninstallClaudeHooks,
  handleClaudeHook,
  claudeHooksInstalled,
  claudeHookStatus,
  claudeSettingsFile,
  isMachineSpecificCommand,
} from "./hooks.js";
export type { HookScope, HookStatus, InstallResult, UninstallResult } from "./hooks.js";
export { watchProject } from "./watch.js";
export { wrapCommand } from "./wrap.js";
export { findProjectRoot, dataDir, shadowDirFor } from "./paths.js";
export { matchAgents, detectAgents } from "./agents.js";
