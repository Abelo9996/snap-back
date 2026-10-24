export {
  Store,
  StoreError,
  BOUNDARY_KINDS,
  BUILTIN_IGNORES,
  VERSION,
  DEFAULT_MAX_FILE_BYTES,
  resolveMaxFileBytes,
} from "./store.js";
export type { Snapshot, SnapshotKind, RestorePlan, RestoreResult, SkippedEntry } from "./store.js";
export { renderCard, writeCard } from "./card.js";
export type { CardData } from "./card.js";
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
