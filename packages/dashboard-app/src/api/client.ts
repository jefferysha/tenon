/**
 * Dashboard HTTP/SSE public facade.
 *
 * Endpoint behavior lives in bounded-context clients; protocol types and runtime decoders stay
 * beside their owning context. Existing consumers keep importing this stable module.
 */
export { ApiError, getToken } from './transport'
export {
  decodeOrchestrationGraph,
  fetchOrchestrationGraph,
  type OrchestrationEdge,
  type OrchestrationEdgeKind,
  type OrchestrationGraph,
  type OrchestrationNode,
  type OrchestrationNodeKind,
} from './orchestrationGraphClient'

export { fetchSnapshot, postTransition, subscribeSnapshot } from './snapshotClient'

export {
  deleteTrackDefinition,
  deleteWorkflowDef,
  fetchConfig,
  fetchHooksConfig,
  fetchSkillFile,
  fetchSkillFiles,
  fetchSkillsRegistry,
  fetchWorkflow,
  fetchWorkflowIndex,
  fetchWorkflowNames,
  getHistory,
  patchTrackDefinition,
  postCreateChange,
  postHookToggle,
  postPromptRoutingBypass,
  postMandatorySkills,
  postRouterPreview,
  postTrackDefinition,
  postWorkflowDef,
  registerProject,
  unregisterProject,
} from './governanceClient'
export type { WorkflowIndex } from './governanceClient'

export { fetchLoopsSnapshot, postLoopLevel, postLoopUpdate } from './loopsClient'
export { postLoopScopePreview } from './loopScopePreview'
export type {
  LoopScopePreviewItem,
  LoopScopePreviewReason,
  LoopScopePreviewResponse,
} from './loopScopePreview'

export {
  ContextBundlePreviewApiError,
  fetchContextBundlePreview,
} from './contextBundleClient'

export {
  deleteSecret,
  fetchAfkLog,
  fetchAfkReadiness,
  fetchAutomationSettings,
  fetchAutomationStarters,
  fetchCadenceStatus,
  fetchDockerImages,
  fetchSecrets,
  postAfkCommand,
  postAfkDismiss,
  postAfkEnqueue,
  postAfkRetry,
  postArtifactRegister,
  postAutomationSettings,
  postLoopRun,
  postLoopStarterInit,
  postLoopSync,
  postProjectionAction,
  postSecret,
  postTriage,
} from './automationClient'

export {
  fetchRunDetail,
  fetchSessionLink,
  fetchSessionLinks,
  fetchTraceRecords,
  fetchTraceSessions,
  fetchTraceTimeline,
} from './auditClient'

export { searchRelatedSessions } from './memoryClient'
export { fetchDefinitionCatalog, postAdapterInstall, subscribeAdapterInstall, subscribeDefinitionCatalog } from './definitionCatalogClient'
export type { AdapterCapabilityId, AdapterCapabilityStatus, AdapterInstallJob, AdapterInstallState, DefinitionCatalog, DefinitionCatalogAdapter, DefinitionCatalogPipeline, DefinitionCatalogTrack, DefinitionCatalogWorkflow } from './definitionCatalogTypes'
export {
  fetchOrchestrationV2Snapshot,
  postOrchestrationV2Control,
  subscribeOrchestrationV2,
  type OrchestrationV2Envelope,
} from './orchestrationV2Client'
export {
  postVerificationEvidenceCompose,
  VerificationEvidenceApiError,
} from './verificationEvidenceClient'

export type {
  ChangeHistoryEntry,
  ChangeSessionLaunch,
  ChangeSessionStatus,
  CreatedChange,
  WbConfigSnapshot,
  WbHookEvent,
  WbHookMeta,
  WbHooksConfig,
  WbRouterPreview,
  WbRouterPreviewCandidate,
  WbSkillEntry,
  WbTrackDefinition,
} from './governanceTypes'

export type {
  AutomationStarterTemplate,
  OperationResponse,
  WbAfkReadiness,
  WbAutomationSettings,
  WbCadenceLoopState,
  WbCadenceLoopStatus,
  WbCadenceStatus,
  WbCredLight,
  WbDockerImages,
  WbLoopBudgetDecl,
  WbLoopGraduation,
  WbLoopLedgerSnapshot,
  WbLoopRow,
  WbLoopsSnapshot,
  WbSecretLight,
  WbSecretsKeys,
} from './automationTypes'

export type {
  SessionLink,
  TraceRecordsResponse,
  TraceSessionRow,
  TraceSessionsResponse,
  TraceTimelineEntry,
  TraceTimelineIntegrity,
  TraceTimelineOutcome,
  TraceTimelineResponse,
  TraceTimelineSession,
  TraceTimelineSummary,
  TraceTimelineWarning,
  WbAttemptContext,
  WbLedgerRecord,
  WbRunDetail,
  WbRunIdentity,
  WbRunRevision,
  WbTransitionRecord,
} from './auditTypes'

export type {
  RelatedSessionMatch,
  RelatedSessionPlatform,
  RelatedSessionSearchInput,
  RelatedSessionSearchResponse,
} from './memoryTypes'

export type {
  ContextBundleMode,
  ContextBundlePhase,
  ContextBundlePreviewBudget,
  ContextBundlePreviewFailure,
  ContextBundlePreviewInput,
  ContextBundlePreviewRequest,
  ContextBundlePreviewSuccess,
  ContextBundleReasonCode,
  ContextBundleTier,
} from './contextBundleTypes'

export type {
  VerificationEvidenceComposeInput,
  VerificationEvidenceComposeResponse,
  VerificationEvidenceDraftEntry,
  VerificationEvidenceFieldError,
  VerificationEvidenceKind,
  VerificationEvidenceLocale,
  VerificationEvidenceStatus,
} from './verificationEvidenceTypes'
