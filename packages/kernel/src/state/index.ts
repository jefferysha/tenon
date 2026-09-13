/**
 * kernel/state 公共出口 —— StateStore 工厂 + 供 oracle/cli 复用的解析/锁原语。
 * 本 barrel 由根 src/index.ts re-export（见 CONTRACT §4）。
 */
export { atomicWriteFile, createStateStore, StateProjectionDriftError, STATE_FILE_NAME } from './store.js'
export {
  appendInteractionEventUnderLock,
  createInteractionEventRecorder,
  createInteractionEventStore,
  interactionProjectionPath,
  readInteractionProjection,
  InteractionProjectionError,
  INTERACTION_MAX_BYTES,
  INTERACTION_MAX_EVENTS,
  INTERACTION_MAX_LINE_BYTES,
} from './interaction-event-store.js'
export type { InteractionEventStore, InteractionProjectionReadResult } from './interaction-event-store.js'
export {
  createReviewAttemptBudgetStore,
  ReviewAttemptBudgetError,
} from './review-attempt-budget.js'
export type {
  ReviewAttemptBeginInput,
  ReviewAttemptBeginResult,
  ReviewAttemptBudgetSnapshot,
  ReviewAttemptBudgetStore,
  ReviewAttemptCompleteInput,
  ReviewAttemptCompletion,
  ReviewAttemptIdentity,
  ReviewAttemptLaneInput,
  ReviewAttemptResult,
  ReviewBudgetOverrideInput,
  ReviewLaneEvidence,
} from './review-attempt-budget.js'
export { readPipelineStateFromSync } from './sync-reader.js'
export { atomicLinkPublish, atomicReplaceFile } from './atomic-publish.js'
export { ensureTrustedProjectDirectory } from './trusted-project-path.js'
export type { StateStoreOptions } from './store.js'
export { defaultOpenSpecScaffoldFiles } from './default-openspec-scaffold.js'
export type { DefaultOpenSpecScaffoldFile } from './default-openspec-scaffold.js'
export {
  DOCUMENT_LOCALE_FILE, ensureDocumentLocalePin, readDocumentLocalePin,
} from './document-locale.js'
export type { DocumentLocalePin } from './document-locale.js'
export {
  WORKFLOW_GOVERNANCE_BINDING_FILE, attachWorkflowGovernanceBinding,
  ensureWorkflowGovernanceBinding, parseWorkflowGovernanceBinding, readWorkflowGovernanceBinding,
  withoutWorkflowGovernanceBinding,
} from './workflow-governance-binding.js'
export type { WorkflowGovernanceBinding } from './workflow-governance-binding.js'
export {
  WORKFLOW_PLAN_SNAPSHOT_FILE, attachWorkflowPlanSnapshot, ensureWorkflowPlanSnapshot,
  parseWorkflowPlanSnapshot, readWorkflowPlanSnapshot, workflowPlanSnapshotContent,
} from './workflow-plan-snapshot.js'
export {
  DOCUMENT_LEDGER_FILE, DocumentLedgerError, ensureDocumentLedger, initialDocumentLedgerContent,
  migrateLegacyDeltaDocument, parseDocumentLedger, readDocumentLedger, recordDocumentReads,
} from './document-ledger.js'
export type {
  DocumentLedger, DocumentReadReceipt, DocumentRecord, MigrateLegacyDeltaDocumentInput, ReadDocumentsInput,
} from './document-ledger.js'
export { currentDocumentStepVisitId } from './document-step-visit.js'
export { evaluateDocumentEvidence } from './document-evidence.js'
export { decodeUtf8Text, readBoundedRegularFile, readBoundedFileHandle } from './document-path.js'
export type {
  DocumentEvidenceItem, DocumentEvidenceItemStatus, DocumentEvidenceReport, DocumentEvidenceScope,
} from './document-evidence.js'
export { evaluateSpecMigrationEvidence } from './spec-migration-evidence.js'
export { parsePipeline, serializePipeline, quoteGate, unquoteScalar, emptyFields } from './parse.js'
export { withLock, LOCK_DIR_NAME, STALE_LOCK_MS } from './lock.js'
export {
  classifyTaskPlanProjectionForChange,
  isCurrentTaskPlanProjectionForChange,
  taskPlanTasksThroughPhaseForChange,
  readTaskPlanForChange,
  TASK_PLAN_CURRENT_FILE,
  TASK_PLAN_REVISIONS_DIR,
  TASK_PLAN_STATE_DIR,
  TaskPlanRevisionConflictError,
  TaskPlanStateCorruptError,
} from './task-plan-store.js'
export { publishTaskPlanRevision } from '../task-plan/publication.js'
export type { PublishTaskPlanOptions } from '../task-plan/publication.js'
export { createHistoryWriter, HISTORY_FILE, transitionRecordToHistoryEntry } from './history.js'
export {
  createBreadcrumbWriter, formatReviewMarker, parseReviewMarker, reviewHint,
  BREADCRUMB_FILE, REVIEW_MARKER_FILE, REVIEW_MARKER_PROTOCOL,
} from './markers.js'
export type { BreadcrumbWriter, ReviewMarkerReceipt } from './markers.js'
export {
  clearReviewGatePatch, reviewGateApprovedFor, reviewGateApprovalPatch, reviewGateEvent, reviewGateMatches,
  reviewGatePendingFor, reviewGateRequestPatch, reviewGateStatus, REVIEW_GATE_APPROVED, REVIEW_GATE_PENDING,
} from './review-gate.js'
export type { ReviewGateStatus, ReviewAcknowledgedVia } from './review-gate.js'
export {
  REVIEW_GATE_BINDING_FILE,
  readReviewGateBinding,
  reviewGateBindingForState,
  reviewGateBindingMatches,
  reviewGateDecisionStateDigest,
  writeReviewGateBindingUnderLock,
} from './review-gate-binding.js'
export type { ReviewGateBinding } from './review-gate-binding.js'
export { applyBreadcrumbTail } from './transitionTail.js'
export type { BreadcrumbTailArgs, TailWriteOutcome } from './transitionTail.js'
// WorkflowRun 持久化提交接缝（W1 第二增量，2026-07-16 codex 范围评估）
export { diffFieldsToEffects, parseRunMetadataLines, serializeRunMetadataLines } from './run-metadata.js'
export {
  createTransitionRecordStore, InvalidRecordIdentityError, RecordAlreadyExistsError, TRANSITION_RECORDS_DIR,
} from './transition-record-store.js'
export type { TransitionRecordStore } from './transition-record-store.js'
export { createWorkflowRunRepository } from './workflow-run-repository.js'
export type { WorkflowRunRepositoryDeps } from './workflow-run-repository.js'
export {
  createWorkflowActionAuthoritySnapshot,
  parseWorkflowActionAuthoritySnapshot,
  sameWorkflowActionAuthoritySnapshot,
  workflowActionAuthoritySnapshotContent,
} from './workflow-action-authority-snapshot.js'
export {
  ensureWorkflowActionAuthorityRecord,
  readWorkflowActionAuthorityRecord,
  workflowActionAuthorityRecordPath,
  WORKFLOW_ACTION_AUTHORITY_RECORD_PREFIX,
} from './workflow-action-authority-record.js'
export {
  projectionMetadataFor, publishRunRevision, readCurrentRunRevision, readCurrentRunRevisionFromSync,
  readCurrentRunRevisionSync, readImmutableRunRevision,
  RUN_STATE_SCHEMA_VERSION, RunStateCorruptError, UnsupportedRunStateVersionError,
  RUN_CURRENT_FILE, RUN_REVISIONS_DIR, RUN_STATE_DIR,
  stateStorageExistsSync, stateStorageSourcePathSync, validateCanonicalRevisionHistory,
} from './run-revision-store.js'
export {
  readValidatedTransitionHead, readValidatedTransitionHeadFromSync,
} from './run-revision-head-reader.js'
export type { RunHookState, RunRevision, RunRevisionTextReader, RunStateMutation } from './run-revision-store.js'
// 机器级项目注册表（v5 T2 决策 D）——init 自动登记 + server 项目发现同源
export {
  readProjectRegistry,
  registerProjectRoot,
  unregisterProjectRoot,
  writeProjectRegistry,
} from './projectRegistry.js'
// 机器级凭证存储（v6 T1，proposal C 节）——CLAUDE_CODE_OAUTH_TOKEN/OPENAI_API_KEY 白名单，0600+原子写
export { readSecrets, writeSecretKey, deleteSecretKey, SECRET_KEYS } from './secrets.js'
export type { SecretKey, SecretsStore } from './secrets.js'
export { parseLegacyHistory, stripLegacyHistory } from './legacy.js'
export {
  FIELD_SUBJECTS_CONTRACT,
  FIELD_SUBJECTS_FILE,
  FIELD_SUBJECTS_VERSION,
  MAX_FIELD_SUBJECT_RECORDS,
  MAX_FIELD_SUBJECTS_BYTES,
  initialFieldSubjectLedgerContent,
  parseFieldSubjectLedger,
  readFieldSubjectLedger,
  recordFieldSubject,
} from './field-subjects.js'
export type {
  FieldSubjectLedger,
  FieldSubjectMigrationReceipt,
  FieldSubjectPathStatus,
  FieldSubjectRecord,
  RecordFieldSubjectInput,
} from './field-subjects.js'
// task lifecycle（BACKLOG #15）——依赖图 / children / cascade / canonical
export {
  normalizeDeps, addDependency, removeDependency, taskNameMatches, directChildren,
  cascadeDependents, projectCanonical, loadTaskTree, resolveChangeDir,
  canonicalChildNames, stateSubtasks, stateRelatedFiles,
} from './tasks.js'
export type { AddDepResult, ChangeNode, ChildRef, CanonicalTask, CanonicalInput } from './tasks.js'
// living-spec（BACKLOG #16）——specs / set-spec-scope / inject-jsonl
export {
  listSpecEntries, injectJsonl, jsonlRelPath, resolveSpecsDir, specScopeWriteValue, parseJsonlLine,
} from './spec.js'
export type { SpecEntry, SpecListing, JsonlEntry, InjectOutcome, InjectChunk, InjectKind } from './spec.js'
// session（BACKLOG #17）——activate / route-context
export {
  validateChangeName, relatedFilesFromField, parseProjectPackages, normalizeRelPath,
  pathInSubtree, packageForPath, routeContext, routeBucketsToObject, renderRouteContextText,
} from './session.js'
export type { ValidName, InvalidName, PackageDecl, RouteBucket } from './session.js'
// 所有权 hash 追踪 + sync/uninstall 决策（BACKLOG #24）
export * from './ownership.js'
