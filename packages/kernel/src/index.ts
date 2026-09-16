export * from './types.js'
export * from './task-plan/index.js'
export * from './task-scheduler/index.js'
export * from './skill-invocation/index.js'
export { PRODUCT_IDENTITY } from './product-identity.generated.js'
export type { ProductIdentity } from './product-identity.generated.js'
export * from './state/index.js'
export * from './interaction/index.js'
export * from './documents/index.js'
export * from './flow/index.js'
export * from './users/index.js'
// 指令文件（AGENTS.md / CLAUDE.md …）受管块、模板块与宿主表的纯逻辑。
export * from './instructions/index.js'
// 内建库（模板、agent、资源目录、测试方向）从 payload 同步到全局 config/<kind>/builtin。
export {
  BUILTIN_LIBRARIES, BUILTIN_LIBRARY_MARKER, builtinSourceDigest, parseBuiltinLibraryMarker,
  syncBuiltinLibraries, syncBuiltinLibrary,
} from './infrastructure/builtin-library-sync.js'
export type { BuiltinLibrary, BuiltinLibraryMarker, BuiltinSyncResult } from './infrastructure/builtin-library-sync.js'
export { canonicalMachineStateRoot, machineStateScopeId } from './machine-state-scope.js'
export {
  resolveProductPaths,
  serializeProductRootContract,
} from './product-paths.js'
export type { ProductPathInput, ProductPaths } from './product-paths.js'
// in-place 构建不以未变化的 Git HEAD 冒充验证靶；提供内容寻址的工作区基线给 CLI/server 注入。
export {
  fingerprintWorkspace, isWorkspaceBaseline, TEST_OUTPUT_DIR_SEGMENTS, WORKSPACE_BASELINE_PREFIX,
} from './workspace/fingerprint.js'
export { probeBuildRevisionIdentity } from './workspace/build-revision-identity.js'
// Native terminal sessions are a dashboard-only liveness projection, never workflow state.
export {
  TERMINAL_ACTIVITY_FILE, TERMINAL_ACTIVITY_PROTOCOL, TERMINAL_ACTIVITY_TTL_MS,
  TERMINAL_SESSION_BINDINGS_DIR, TERMINAL_SESSION_PROTOCOL,
  isTerminalActivityChangeName, isTerminalSessionId, liveTerminalActivity, parseTerminalActivityRecord,
} from './workspace/terminal-activity.js'
export type { LiveTerminalActivity, TerminalActivityRecord } from './workspace/terminal-activity.js'
// 动态 Track Registry 公开面（GOAL.md 清单 T · R2 校验面切换）——tracks/ 是 R1 落地的叶子 barrel，
// 本行把它接进根 barrel，使 cli/server 的 track 校验面从 types.ts 的写死 TRACKS 常量切到 registry
// 驱动（requireTrack/assertWorkflowAllowed/loadTrackRegistry）。tracks/index.ts 已自做具名导出，
// 与其它子 barrel（state/flow/…）无名字冲突，故整体 re-export。
export * from './tracks/index.js'
// mem 跨 runtime 会话检索（BACKLOG #28）
export * from './mem/index.js'
// loop 治理子系统（BACKLOG #35，loop-engineering 内建）
export * from './loops/index.js'
// 上下文压缩（BACKLOG #30，对标 Tenon runtime CONTEXT-COMPRESSION）
export * from './compress/index.js'
// Tenon contract parity 收尾：spec-scaffold / workflow-resolution / allowlist（BACKLOG #33）
export * from './scaffold/index.js'
// H7 verifier（GOAL 清单 H）：结构化 verification 结果契约 + 手写窄校验 + merge 授权谓词。
// verification/ 子 barrel 自做具名导出，符号与其它子 barrel 无碰撞，故整体 re-export。
export * from './verification/index.js'
export * from './triage/index.js'
// Autonomous development loop v1: pure orchestration contracts, capability routing and board reducer.
export * from './orchestration/index.js'
export * from './catalog/index.js'
export * from './artifacts/index.js'
export * from './decision/index.js'
// skill source registry 是 CLI setup/doctor 与 Dashboard machine readiness 的共享安装契约。
export * from './skills/index.js'
// workflow 自定义引擎（GOAL 清单 E）——loadWorkflow（Task 5）+ evaluateStepGuards（Task 7）+
// isSkillUnlocked（Task 6）供 cli transition / internal-skill-gate 消费自定义 workflow 的真实
// step 间转换与 skill DAG 解锁判定（Task 8/9）。仅具名导出这三个函数，不整体 re-export
// ./workflow/types.js（其 GateKind 会与既有 barrel 导出撞名）。
export { loadWorkflow } from './workflow/loadWorkflow.js'
export { globalWorkflowRoot, workflowFileCandidates, workflowsDirUnder } from './workflow/global-store.js'
export { workflowNamesUnder } from './infrastructure/workflow-global-store.js'
export type { WorkflowDirectoryReader } from './workflow/global-store.js'
export { BUILTIN_WORKFLOW_IDS, builtinWorkflow } from './workflow/builtin-workflows.js'
export type { BuiltinWorkflowId } from './workflow/builtin-workflows.js'
export { DEFAULT_WORKFLOW_SOURCE } from './workflow/default-workflow.generated.js'
export {
  canonicalWorkflowSkillId,
  completedWorkflowSkillsSinceStepEntry,
  missingWorkflowStepSkills,
} from './workflow/skill-evidence.js'
export { evaluateStepGuards, evaluateWorkflowIrStepGuards } from './workflow/stepGuard.js'
export {
  effectiveLifecyclePolicy, governedLifecyclePolicy, isRevisionGuard,
  mergeLifecycleActions, mergeLifecycleGuards, semanticRevisionLifecyclePolicy,
} from './workflow/governed-lifecycle-policy.js'
export type {
  EffectiveLifecyclePolicy, GovernedLifecyclePolicy,
} from './workflow/governed-lifecycle-policy.js'
// step 编排层（Wave 2 下沉）：解析 step/找边/评 guard/算下相位的单一真相源，
// cli transition/check 与 server transition 塌成 adapter（消息模板与错误分类学留 adapter）。
export { applyStepTransition, firstStep, planStepTransition, resolveStep, resolveWorkflowName } from './workflow/engine.js'
export type { StepTransitionPlan } from './workflow/engine.js'
export {
  IMPLICIT_COMPLETION_EVENT, implicitCompletionTransition, stepExitTransitions,
} from './workflow/implicit-completion.js'
export type { ImplicitCompletionPlan } from './workflow/implicit-completion.js'
export { isDefaultWorkflowName, isValidWorkflowName } from './workflow/identifier.js'
export { isSkillUnlocked } from './workflow/skillDag.js'
export { classifyInteractionWorkflowIdentity } from './workflow/interaction-effect.js'
export { parseWorkflow } from './workflow/parse.js'
export { serializeWorkflow } from './workflow/serialize.js'
export { WorkflowTrackBranchError, selectTrackBranch, validateWorkflow, validateWorkflowForStorage, workflowBranches } from './workflow/validate.js'
// track 分支：registry 未登记但工作流 YAML 里有同名分支的 track 也可用（合成缺省策略定义）。
export { projectWorkflowNames, requireTrackForRoot } from './workflow/branch-track-lookup.js'
export { validateWorkflowTrackReferences } from './workflow/track-reference-validation.js'
export type {
  StepDef, StepTransition, WorkflowActionConfig, WorkflowDecompositionAskCondition,
  WorkflowDecompositionAutoCondition, WorkflowDecompositionMode, WorkflowDecompositionPolicyV1,
  WorkflowDecompositionStrategy, WorkflowDecompositionTarget, WorkflowDef, WorkflowDocumentContractV1,
  WorkflowDocumentRead, WorkflowDocumentSlot, WorkflowGuardConfig, WorkflowInteractionMode,
  WorkflowInteractionPolicyV1,
  WorkflowReviewBudgetPolicyV1,
} from './workflow/types.js'
export {
  canUseWorkflowRecommendedDefault,
  compileWorkflowDecompositionPolicy,
  compileWorkflowInteractionPolicy,
  compileWorkflowReviewBudgetPolicy,
  DEFAULT_WORKFLOW_DECOMPOSITION_POLICY,
  DEFAULT_WORKFLOW_INTERACTION_POLICY,
  DEFAULT_WORKFLOW_REVIEW_BUDGET_POLICY,
  evaluateWorkflowAction,
  WORKFLOW_ACTIONS,
  WORKFLOW_DECOMPOSITION_ASK_CONDITIONS,
  WORKFLOW_DECOMPOSITION_AUTO_CONDITIONS,
  WORKFLOW_DECOMPOSITION_MODES,
  WORKFLOW_DECOMPOSITION_STRATEGIES,
  WORKFLOW_DECOMPOSITION_TARGETS,
  WORKFLOW_INTERACTION_MODES,
  workflowPolicyPermissionLayer,
} from './workflow/policy.js'
export {
  evaluateWorkflowDecompositionMaterialization,
  workflowDecompositionCandidateFingerprint,
} from './workflow/decomposition-policy-evaluator.js'
export type {
  EvaluateWorkflowDecompositionMaterializationInput,
  WorkflowDecompositionCandidate,
  WorkflowDecompositionReviewReceipt,
} from './workflow/decomposition-policy-evaluator.js'
export type {
  EvaluateWorkflowActionInput,
  RecommendedDefaultDecision,
  RecommendedDefaultQuestion,
  WorkflowAction,
  WorkflowActionClassification,
  WorkflowActionEvaluation,
  WorkflowAuthorityBinding,
  WorkflowHardConfirmation,
  WorkflowPermissionContribution,
  WorkflowPermissionDenial,
  WorkflowPermissionLayer,
  WorkflowPermissionLayerInput,
  WorkflowPermissionLayers,
  WorkflowPermissionLayerStatus,
  WorkflowPermissionRemediationCode,
} from './workflow/policy.js'
export {
  DOCUMENT_CHAIN_PAIRS, DOCUMENT_CONTRACT_PHASES, DOCUMENT_KIND_CATALOG, DOCUMENT_KINDS,
  documentGovernancePolicy, documentKindScope, documentOwnerPolicyStep,
  isDocumentContractPhase, isDocumentKind, isDocumentPolicyStep, isDocumentProducerAllowedInPolicyStep,
  isDocumentRecordAllowedInPolicyStep, outputsRequiredForPolicyStep, readsRequiredForPolicyStep,
  recordProducerCandidatesForPolicyStep, recordsRequiredForPolicyStep, requiresForPolicyStep,
  shouldEnforceDocumentPolicyOnTransition,
  aliasesForSkill,
  validateDocumentContract,
} from './workflow/document-contract.js'
export type {
  DocumentContractPhase, DocumentGovernancePolicy, DocumentKind, DocumentKindInfo, DocumentOutputRequirement,
  DocumentScope, DocumentSlotRole,
} from './workflow/document-contract.js'
// Workflow IR 编译（G2）：v1 WorkflowDef → 归一化 WorkflowIR（含默认值/深冻结/字段闭集校验）。
// custom 轨 transition adapter 在 loadWorkflow 后柯里化调用它拿运行层 IR；类型供 adapter/测试引用。
// compileWorkflow=custom 契约（拒 effective-phase-skills，A 契约）；compileDefaultWorkflow=default 生成
// 校验专用（允许 phase policy）——见 workflow/compile.ts。
export { compileWorkflow, compileDefaultWorkflow, decodeWorkflowDef } from './workflow/compile.js'
export {
  compileEffectiveWorkflowPlan, effectiveWorkflowPlanFromIr, loadEffectiveWorkflowPlan,
  documentGovernanceFingerprint, DocumentGovernanceBindingError, effectiveWorkflowPlanBinding,
  effectiveWorkflowPlanFromSnapshot, resolveBoundEffectiveWorkflowPlan, resolveEffectiveWorkflowPlan,
  workflowPlanSnapshot,
} from './workflow/effective-plan.js'
export type {
  EffectiveWorkflowPlan, LegacyWorkflowIR, PersistedDocumentGovernanceBinding, WorkflowPlanSnapshot,
  WorkflowPlanSnapshotV1, WorkflowPlanSnapshotV2, WorkflowPlanSnapshotV3,
} from './workflow/effective-plan.js'
export {
  materializeWorkflowIo,
  type WorkflowDocumentSlotIo, type WorkflowEffectiveIo, type WorkflowFieldSlotIo, type WorkflowIoSlot, type WorkflowStepIo,
} from './workflow/effective-io.js'
export type {
  ActionInput, CompiledGuardConfig, GuardDecision, GuardInput, StepIR, StepTransitionIR, WorkflowIR,
} from './workflow/ir.js'
export { readinessByTransition } from './workflow/transition-readiness.js'
export type {
  ReadinessByTransition, TransitionReadiness, TransitionReadinessBlocker,
} from './workflow/transition-readiness.js'
export {
  assessBuildRevisionTrust, createBuildRevisionToken, hashBuildRevisionIdentity,
  isBuildRevisionBlocker, makeBuildRevisionBlocker, parseBuildRevisionToken, safeRevisionHash,
  BUILD_REVISION_CODE, BUILD_REVISION_REASONS, BUILD_REVISION_REMEDIATION, BUILD_REVISION_TOKEN_PREFIX,
  BuildRevisionCaptureError,
} from './workflow/build-revision.js'
export type {
  BuildRevisionAssessment, BuildRevisionAssessmentRequest, BuildRevisionBlocker,
  BuildRevisionIdentity, BuildRevisionKind, BuildRevisionObservation, BuildRevisionProvenance,
  BuildRevisionToken,
} from './workflow/build-revision.js'
// default workflow artifact declaration 查询层（G2 P4/P5）：只读生成表 default-workflow.generated.ts 的
// track-aware 查询接缝——P5 artifact register 经本 API 取 default declaration，不再读 YAML/复制字段表。
export { defaultArtifactForField, defaultArtifactsForStep, defaultArtifactDeclaredForField } from './workflow/default-artifacts.js'
export type { DefaultArtifactDeclaration } from './workflow/default-artifacts.js'
export type { ArtifactProducerPolicy, WorkflowArtifactConfig } from './workflow/types.js'
// EffectiveSkillResolver（G2 P5）：runtime 三投影接缝（phase-first required/available/explicit-profile；
// legacy manifest-only default/custom seams retained for compatibility）。artifact command 只依赖本接口。
export {
  createEffectiveSkillResolver, resolveAvailableSkillSlots, resolveExplicitProfileSkillSlots, resolveRequiredSkillSlots,
} from './workflow/effective-skill-resolver.js'
export type {
  EffectiveSkillResolver, EffectiveSkillSlot, EffectiveSkillResolverManifest, EffectiveSkillResolverOptions,
} from './workflow/effective-skill-resolver.js'
// OpenSpec tasks.md → ordered workflow stages 的只读 Todo 投影（dashboard/native Todo 共用）。
export {
  DEFAULT_WORKFLOW_TODO_STAGES, incompletePipelineTasksForExit, projectPipelineTodo,
} from './workflow/todo-projection.js'
export type {
  PipelineTodoItem, PipelineTodoProjection, PipelineTodoStage, PipelineTodoStageDefinition, PipelineTodoStageStatus,
} from './workflow/todo-projection.js'
// SkillBundleResolver（H10 任务 2，G2 适配层）：把 workflow kind/step/profile ID 翻译成对
// EffectiveSkillResolver 的一次具体调用，产出现有 EffectiveSkillSlot 集与 resolution source
// （default/custom）；H10 任务 5 的 prepareSkillBundle、任务 4 的 snapshot manifest 消费本接口。
export { resolveSkillBundle } from './workflow/skill-bundle-resolver.js'
export type {
  SkillBundleCustomInput, SkillBundleDefaultInput, SkillBundleResolution,
  SkillBundleResolutionInput, SkillBundleResolutionSource,
} from './workflow/skill-bundle-resolver.js'
// track 谓词判定（P0 原语）——P5 artifact register 评估 custom artifact 的 requiredWhen 对当前 track 是否
// 适用。predicates.ts 本身零 import（无环险），故经根 barrel 对外具名导出安全（内部消费点仍走直连路径）。
export { matchesTrackPredicate } from './workflow/predicates.js'
export type { TrackPredicate } from './workflow/predicates.js'
// WorkflowRun 持久化提交接缝（W1 第二增量）——具名导出，不整体 re-export ./workflow/run-types.js
// 避免与上面 ./workflow/types.js 的既有具名导出策略不一致。
export type {
  CommitResult, StateFieldEffect, TransitionDraft, TransitionRecord, WorkflowRun,
  WorkflowRunRepository, WorkflowRunTransaction,
} from './workflow/run-types.js'
export {
  createWorkflowActionAuthoritySnapshot,
  parseWorkflowActionAuthoritySnapshot,
  sameWorkflowActionAuthoritySnapshot,
  workflowActionAuthoritySnapshotContent,
} from './state/workflow-action-authority-snapshot.js'
export type {
  CreateWorkflowActionAuthoritySnapshotInput,
  WorkflowActionAuthorityLayerSnapshotV1,
  WorkflowActionAuthorityProvenanceKind,
  WorkflowActionAuthorityProvenanceV1,
  WorkflowActionAuthoritySnapshotV1,
} from './workflow/action-authority-types.js'
// 唯一 TransitionApplication 用例（G1 支点，2026-07-17）：CLI 与 server 共用同一份转换编排，
// 消灭此前 cli/commands/transition.ts 与 server/transition.ts 两处复制。
export { createTransitionApplication } from './workflow/transition-application.js'
export type {
  TransitionApplication, TransitionApplicationDeps, TransitionApplicationResult,
  TransitionApplicationWarning, TransitionCommand,
} from './workflow/transition-application.js'
