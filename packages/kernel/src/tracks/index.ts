/**
 * kernel/tracks 子 barrel（GOAL.md 清单 T · T-R1）——动态 Track Registry 的公开面。
 * 根 kernel/src/index.ts 不 re-export 本模块：R1 是纯新增叶子模块（无人引用，bundle 不变），
 * 根 barrel 与校验面的接线属于清单 T 的 R2 阶段（见 GOAL.md）。tracks/ 之外读本模块一律走
 * 本文件。
 */
export { TRACK_ID_RE } from './types.js'
export type {
  TrackId,
  ReviewSeed,
  CoverageProfile,
  TrackWorkflowBinding,
  TrackPolicyProfile,
  TrackDefinition,
  TrackRegistry,
  ProjectTrackConfig,
  ProjectBuiltinOverrideConfig,
  ProjectTrackEntryConfig,
  ProjectWorkflowConfig,
  ProjectPolicyProfileConfig,
  ProjectRoutingConfig,
  ProjectSkillsConfig,
  TrackValidationContext,
  CreateTrackSpec,
  UpdateTrackPatch,
} from './types.js'
export {
  BUILTIN_TRACK_DEFINITIONS,
  BUILTIN_TRACK_IDS,
  BUILTIN_ROUTER_PATTERNS,
  builtinTrack,
  isBuiltinTrackId,
} from './builtins.js'
export type { BuiltinTrackId } from './builtins.js'
export { parseTrackRegistry, TrackConfigParseError } from './parse.js'
export { MAX_CUSTOM_TRACKS, MAX_TRACKS, validateTrackConfigStructure, validateTrackRegistry } from './validate.js'
export { serializeTrackRegistry } from './serialize.js'
export {
  assertWorkflowAllowed,
  loadTrackRegistry,
  mutateTrackRegistry,
  registryRevision,
  RegistryCorruptFileError,
  RegistryRevisionConflictError,
  requireTrack,
  trackRegistryPath,
  withTrackRegistryLock,
  writeTrackRegistry,
} from './registry.js'
export type { MutationOutcome, RegistrySnapshot, WriteTrackRegistryOptions } from './registry.js'
export {
  assertTrackDeletable,
  assertUpdatePreservesReferences,
  BuiltinTrackDeleteError,
  BuiltinTrackPolicyError,
  ChangeScanFailedError,
  createTrack,
  deleteTrack,
  TrackAlreadyExistsError,
  TrackNotFoundError,
  TrackReferencedError,
  TrackReferencesInvalidatedError,
  updateTrack,
} from './crud.js'
export type { ActiveChangeRef, ChangeRefScan, ScanActiveChanges } from './crud.js'
export {
  buildRouterProjection,
  effectiveRouterRevision,
  encodeRouterDataCache,
  routerContractRevision,
} from './router-projection.js'
export type {
  RouterDataCacheInput,
  RouterProjection,
  RouterSkillProjection,
  RouterSkillSource,
  RouterTrackProjection,
} from './router-projection.js'
export { BRANCH_TRACK_DEFAULT_POLICY, resolveTrackForBranch } from './branch-track.js'
export type { BranchTrackWorkflow } from './branch-track.js'
