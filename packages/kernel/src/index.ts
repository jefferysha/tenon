export * from './types.js'
export * from './task-plan/index.js'
export * from './task-scheduler/index.js'
export * from './skill-invocation/index.js'
export { PRODUCT_IDENTITY } from './product-identity.generated.js'
export type { ProductIdentity } from './product-identity.generated.js'
export * from './state/index.js'
export * from './interaction/index.js'
export * from './documents/index.js'
// 步骤产出：转换时观察实际产出并标注来源，只把直接上游的文档交给下一步，必须产出按路径判定。
// 检查点（workspace/step-checkpoint）与账本读写（state/step-output-ledger）是内部接缝，不在这里导出。
// HandoffInput 与 compress 已导出的同名类型冲突，这里换名导出。
export { isDocumentPath, matchesOutputPattern, validateOutputPattern } from './documents/step-outputs-model.js'
export type { HandoffInput as StepHandoffInput, SkillLoad } from './documents/step-outputs-model.js'
export {
  readStepHandoff, readStepOutputs, recordInputReads, recordStepExit, requiredOutputSatisfied, startStepVisit,
  stepOutputsContextFor, unreadInputs,
} from './documents/step-outputs.js'
export type {
  StepHandoffView, StepInputView, StepIoView, StepOutputsContext, StepOutputsView, StepVisitRef,
} from './documents/step-outputs.js'
// 「没读完不能离开」的阻断判定与文案（转换、status / check 共用）。
export { stepOutputLedgerBlocker, unreadInputBlockers } from './documents/step-input-gate.js'
export type { StepInputBlocker, StepInputBlockerCode } from './documents/step-input-gate.js'
export { STEP_OUTPUT_LEDGER_FILE, StepOutputLedgerError } from './state/step-output-ledger.js'
export type {
  StepInputRead, StepObservation, StepOutputLedger, StepOutputRecord, StepVisitRecord,
} from './state/step-output-ledger.js'
export * from './flow/index.js'
export * from './users/index.js'
// 指令文件（AGENTS.md / CLAUDE.md …）受管块、模板块与宿主表的纯逻辑。
export * from './instructions/index.js'
// 资源目录（组件库 / 图标 / 动画 / DESIGN.md / 状态管理 / 样式）条目的解析、校验与筛选。
export * from './resources/index.js'
// 任务级 agent（工作流步骤的执行者 / 评审者）定义文件的解析与校验。
export * from './agents/index.js'
export type { AgentSeverity, StepAgentsDef, StepExecutorRef, StepReviewerRef } from './workflow/types.js'
// 项目设计体系（根目录 DESIGN.md + design/）的结构检查与变更提案。
export * from './design-system/index.js'
export { createDesignFileReader } from './infrastructure/design-system-fs.js'
// 内建库（模板、agent、资源目录、测试方向）从 payload 同步到全局 config/<kind>/builtin。
export {
  BUILTIN_LIBRARIES, BUILTIN_LIBRARY_MARKER, builtinLibrary, builtinSourceDigest, parseBuiltinLibraryMarker,
  syncBuiltinLibraries, syncBuiltinLibrary,
} from './infrastructure/builtin-library-sync.js'
export type { BuiltinLibrary, BuiltinLibraryMarker, BuiltinSyncResult } from './infrastructure/builtin-library-sync.js'
export {
  ResourceStoreError, copyResource, deleteCustomResource, ensureBuiltinResources, loadResourceCatalog,
  readResourceFile, resourceStoreRoot, writeCustomResource,
} from './infrastructure/resource-store.js'
export type { ResourceCatalog, ResourceFile, ResourceStoreOptions } from './infrastructure/resource-store.js'
export {
  AgentStoreError, agentScope, agentStoreRoot, deleteAgent, deleteCustomAgent, effectiveAgent, ensureBuiltinAgents,
  loadAgentLibrary, prepareAgentFreeze, projectAgentsDir, renameAgentContent, resolveAgent, writeAgent,
  writeCustomAgent,
} from './infrastructure/agent-store.js'
export type { AgentEntry, AgentLibrary, AgentScope, AgentStoreOptions } from './infrastructure/agent-store.js'
export { agentWorkflowReferences, workflowAgentNames } from './infrastructure/agent-references.js'
export type { AgentWorkflowReference } from './infrastructure/agent-references.js'
// 旧版本写进项目里的宿主 agent 文件：init、归档、删除时清理（CLI 与 Dashboard 共用），会话内不再生成。
export { cleanupLegacyHostAgents, renderCurrentFromLibrary } from './infrastructure/host-agent-files.js'
export type { LegacyHostAgentCleanup } from './infrastructure/host-agent-files.js'
// 宿主子代理用户级安装：终端 `tenon agent install|uninstall` 写 <配置目录>/agents（目录跟随 CLAUDE_CONFIG_DIR / CODEX_HOME，默认
// ~/.claude、~/.codex），清单在 <configRoot>/agents/host-owned.json，按子代理目录分组。
export { hostAgentsDir, installHostAgents, uninstallHostAgents, userHostAgentPath } from './infrastructure/host-agent-install.js'
export type { HostInstallOutcome, HostInstallState } from './infrastructure/host-agent-install.js'
// 派发判定（只读）：用户级已装文件与冻结定义一致才下发专属子代理，否则退回通用子代理并给出原因。
export { resolveHostSubagent } from './infrastructure/host-subagent-resolve.js'
export type { HostSubagentChoice } from './infrastructure/host-subagent-resolve.js'
// 每步测试登记：测试方向、运行记录、基准与门禁判定。
export * from './test-evidence/index.js'
// 测试体系 v2：项目测试目录、任务测试计划、步骤测试策略、运行记录 v2 哈希链与策略判定。
export * from './test-system/index.js'
// CI 校验（tenon verify --ci）与证据导出（Agent Trace / OTel / git notes / 尾注）：对已提交内容的纯函数。
export * from './ci-verify/index.js'
export * from './evidence-export/index.js'
export { canonicalMachineStateRoot, machineStateScopeId } from './machine-state-scope.js'
export { sha256Hex } from './sha256.js'
export {
  resolveProductPaths,
  serializeProductRootContract,
} from './product-paths.js'
export type { ProductPathInput, ProductPaths } from './product-paths.js'
// 诊断脱敏：server 日志落盘前去凭证，`tenon support bundle` 出门前再去个人信息。
export {
  addRedactionCounts, MAX_REDACTED_LINE_CHARS, NO_REDACTIONS, redactCredentials, redactForSharing, totalRedactions,
} from './diagnostics/redact.js'
export type { RedactionCounts, RedactionKind, RedactionResult, SharingRedactionOptions } from './diagnostics/redact.js'
// in-place 构建不以未变化的 Git HEAD 冒充验证靶；提供内容寻址的工作区基线给 CLI/server 注入。
export {
  fingerprintWorkspace, fingerprintWorkspaceTwins, HOST_LOCAL_DIRS, HOST_LOCAL_FILES, hasHostLocalFiles, isHostLocalPath, isWorkspaceBaseline,
  isWorkspaceCandidatePath, TEST_OUTPUT_DIR_SEGMENTS, trackedHostLocalPaths, WORKSPACE_BASELINE_PREFIX,
} from './workspace/fingerprint.js'
export type { FingerprintOptions, WorkspaceFingerprints } from './workspace/fingerprint.js'
// 路径类与改动风险指标：standard 通道的风险探针与评审者 attach_on 共用同一份分类。
export { PATH_CLASSES, classifyPath, isPathClass, pathTokens } from './workspace/path-classes.js'
export type { PathClass } from './workspace/path-classes.js'
export { assessDiffRisk, isCodePath, isTestPath, touchedPathClasses } from './workspace/diff-risk.js'
export type { DiffRiskMetrics } from './workspace/diff-risk.js'
// 改动风险分类：探针（实现后）与 `tenon assess`（实现前）共用同一份指标与上下限判定。
export { classifyChange, DIFF_RISK_DIRECTION, protectedTestFileCount, riskThresholdsFor, thresholdBreaches } from './workspace/change-risk.js'
export type { ChangeRiskVerdict, MetricThreshold, ThresholdBound, ThresholdBreach } from './workspace/change-risk.js'
export { probeBuildRevisionIdentity } from './workspace/build-revision-identity.js'
// 「自任务起点以来的改动文件 / 改动行」：全量登记强制、changed 范围与 changed_lines 覆盖率的共同来源。
export {
  CHANGED_FILES_GIT_TIMEOUT_MS, ChangedFilesUnavailableError, UNTRACKED_FILE_LIMIT, allPathChangesForState, changeStartOfFields,
  changedFilesForState, changedFilesResultForState, changedFilesSinceChangeStart, changedLinesSinceChangeStart,
  createChangedFilesSession, fileAtChangeStart, parseAddedLines, pathChangesSinceChangeStart, resolveChangeStart,
} from './workspace/changed-files.js'
// 任务起点 start_sha：建任务时读 HEAD（isGitCommitId 校验后才写进状态）。
export { isGitCommitId, readHeadCommit } from './workspace/change-start.js'
// 新任务建在自己的 git worktree：判定 / 创建 / 回滚；git 执行器由调用方传入。
export {
  TaskWorktreeConflictError, createTaskWorktree, planTaskWorktree, rollbackTaskWorktree,
} from './workspace/task-worktree.js'
export type { GitRunner, TaskWorktreeInPlaceReason, TaskWorktreePlan } from './workspace/task-worktree.js'
// 从主检出找到建在 worktree 里的任务（tenon list / 按名读取的报错 / workflow progress 共用）。
export { listTaskWorktrees } from './workspace/task-worktree-list.js'
export type { TaskWorktreeEntry } from './workspace/task-worktree-list.js'
export type {
  ChangedFilesResult, ChangedFilesSession, ChangedFilesSessionOptions, ChangeStartInput, FileDiffEntry, FileDiffsResult,
  PathChange, PathChangeStatus,
} from './workspace/changed-files.js'
// Native terminal sessions are a dashboard-only liveness projection, never workflow state.
export {
  TERMINAL_ACTIVITY_FILE, TERMINAL_ACTIVITY_PROTOCOL, TERMINAL_ACTIVITY_TTL_MS,
  TERMINAL_SESSION_BINDINGS_DIR, TERMINAL_SESSION_PROTOCOL,
  isTerminalActivityChangeName, isTerminalSessionId, liveTerminalActivity, parseTerminalActivityRecord,
} from './workspace/terminal-activity.js'
export type { LiveTerminalActivity, TerminalActivityRecord } from './workspace/terminal-activity.js'
// `.pipeline/.gitignore` and `openspec/.gitignore` keep local runtime state out of git without touching the root `.gitignore`.
export {
  ensurePipelineGitignore, WORKFLOW_STATE_DIR, WORKFLOW_STATE_GITIGNORE,
  ensureOpenspecGitignore, OPENSPEC_LOCAL_GITIGNORE,
} from './workspace/pipeline-gitignore.js'
// 任务归档（M6）：完结 / 已升级 / 已终止一律把任务目录移进 openspec/changes/archive/，没有「隐藏」。
export {
  archiveTask, ArchiveTaskError, fieldText, isTaskLifecycleName, openspecArchiveRunner, readTaskResult,
  TASK_RESULTS, taskArchiveSpec, taskChangeDir, terminalTaskResult, withArchiveLock,
} from './workspace/archive-task.js'
export type {
  ArchivedTask, ArchiveDeps, ArchiveTaskErrorCode, TaskResult,
} from './workspace/archive-task.js'
export {
  countUncommittedTaskDeletions, gitStatusRunner, isProcessLocalFdPath, probeChangeTracked, probeUncommittedTaskDeletions,
} from './workspace/uncommitted-deletions.js'
export type {
  ChangeTrackingProbe, GitStatusResult, GitStatusRunner, UncommittedDeletionsProbe,
} from './workspace/uncommitted-deletions.js'
// 归档目录名 <日期>-<任务名>[-N] 与任务名的对应：依赖已结束判定（guard 文件面、AFK 队列扫描）共用。
export { archiveDirIsTask } from './workspace/archived-task-name.js'
// 删除 / 终止 的唯一实现：CLI 与 server 共用同一个 application、同一套原因与记录。
export { createTaskLifecycleApplication, taskLifecycleUnlockHint } from './workspace/task-lifecycle.js'
export type {
  TaskFinishCommand, TaskLifecycleAction, TaskLifecycleApplication, TaskLifecycleAssessOutcome,
  TaskLifecycleAssessment, TaskLifecycleAuditRecord, TaskLifecycleChannel, TaskLifecycleCommand, TaskLifecycleDeps,
  TaskLifecycleOutcome, TaskLifecycleReason, TaskLifecycleReasonCode,
} from './workspace/task-lifecycle.js'
export type { PathCommitOutcome } from './workspace/commit-paths.js'
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
export { DEFAULT_WORKFLOW_SOURCE } from './workflow/default-workflow.generated.js'
export {
  canonicalWorkflowSkillId,
  completedWorkflowSkillsSinceStepEntry,
  missingWorkflowStepSkills,
} from './workflow/skill-evidence.js'
export {
  RETIRED_SKILL_IDS, retiredSkillReferences, retiredSkillsChangeMessage, retiredSkillsWorkflowMessage,
} from './workflow/retired-skills.js'
export {
  agentWaves, attachedReviewers, evaluateStepAgents, isForwardExit, nextAgentWave, projectStepAgents, renderAgentBlocker,
} from './workflow/agent-verdict.js'
export { agentOwnedSkills, readAgentOwnedSkills, skillsExemptOnExit } from './workflow/agent-owned-skills.js'
export {
  currentRound, DEFAULT_MAX_ROUNDS, effectiveMaxRounds, isRoundsLimited, isValidMaxRounds, MAX_ROUNDS_MAX, MAX_ROUNDS_MIN,
  parseMaxRoundsText, resolveMaxRounds, stepBackTargets,
} from './workflow/step-rounds.js'
export type {
  MaxRoundsSource, PlanMaxRounds, PlanMaxRoundsSource, ResolvedMaxRounds, RoundsPlan, RoundTransition,
} from './workflow/step-rounds.js'
export { readStepRounds, roundsExhausted } from './workflow/step-rounds-read.js'
export type { StepRounds, StepRoundsReadDeps } from './workflow/step-rounds-read.js'
export { unattachedReviewers } from './workflow/agent-scope.js'
export type {
  AcceptedResidualNote, AcceptedResidualRef, AgentBlocker, AgentRole, AgentRunState, AgentView, AgentWave, StepAgentsInput,
} from './workflow/agent-verdict.js'
export { evaluateStepGuards, evaluateWorkflowIrStepGuards } from './workflow/stepGuard.js'
export {
  effectiveLifecyclePolicy, governedLifecyclePolicy, isRevisionGuard, lifecycleScopeOf,
  mergeLifecycleActions, mergeLifecycleGuards, semanticRevisionLifecyclePolicy,
} from './workflow/governed-lifecycle-policy.js'
export type {
  EffectiveLifecyclePolicy, GovernedLifecyclePolicy, LifecycleScope,
} from './workflow/governed-lifecycle-policy.js'
// step 编排层（Wave 2 下沉）：解析 step/找边/评 guard/算下相位的单一真相源，
// cli transition/check 与 server transition 塌成 adapter（消息模板与错误分类学留 adapter）。
export { applyStepTransition, firstStep, planStepTransition, resolveStep, resolveWorkflowName } from './workflow/engine.js'
export type { StepTransitionPlan } from './workflow/engine.js'
export {
  ABANDON_EVENT, IMPLICIT_COMPLETION_EVENT, implicitCompletionTransition, isAbandonEvent, stepExitTransitions,
} from './workflow/implicit-completion.js'
export type { ImplicitCompletionPlan } from './workflow/implicit-completion.js'
// 步骤的必须产出路径模式（status / 验证报告路径 / 规格校验归属判定共用）。
export { stepRequiredOutputs } from './workflow/required-outputs.js'
// 执行模型接缝：新任务按步骤图、快照里记着旧模型的任务走旧引擎；命令层只经它（CLI 的 execution-cli-seam）区分两者。
export { selectExecution } from './workflow/execution-seam.js'
export type { ExecutionKind } from './workflow/execution-seam.js'
export {
  TEMPLATE_WORKFLOW_NAMES, isDefaultWorkflowName, isTemplateWorkflowName, isValidWorkflowName,
} from './workflow/identifier.js'
export type { TemplateWorkflowName } from './workflow/identifier.js'
export { templateWorkflowDefinition, templateWorkflowSource } from './workflow/template-workflows.js'
export { isSkillUnlocked } from './workflow/skillDag.js'
export { dependencyWaves, directDependencies, type DependencyRef } from './workflow/dag-waves.js'
export {
  bareSkillId, effectiveSkillDependencies, minimalSkillDependencies, missingSkillDependencies,
  orderSkillSlots, skillSlotStatuses,
  type EffectiveSkillDependency, type OrderedSkillSlot, type SkillOrderDeclaration, type SkillOrderSlot,
  type SkillRefLike, type SkillSlotStatus,
} from './workflow/skill-order.js'
export {
  openspecInjectedSkills, orchestrate,
  type OrchestrationEntry, type OrchestrationFlow, type OrchestrationInput, type OrchestrationKind,
  type OrchestrationReturn, type OrchestrationSource, type OrchestrationStage, type OrchestrationStepSource,
  type WorkflowOrchestration,
} from './workflow/orchestration.js'
export { buildOrchestration, manifestSkillOverlay, planEffectiveIo, planStepSources } from './workflow/orchestration-plan.js'
export { classifyInteractionWorkflowIdentity } from './workflow/interaction-effect.js'
export { parseWorkflow } from './workflow/parse.js'
export { serializeWorkflow } from './workflow/serialize.js'
export { WorkflowTrackBranchError, selectTrackBranch, validateWorkflow, validateWorkflowForStorage, workflowBranches } from './workflow/validate.js'
// 轨道解析：轨道只是工作流 YAML 里的 `tracks.<id>` 分支（平铺工作流只有一个隐式分支），不查任何登记表。
export { listTracks, resolveRunTrack, resolveTrack, UnknownTrackError } from './workflow/resolve-track.js'
export type { TrackBranch, TrackResolvable } from './workflow/resolve-track.js'
export { knownSkillProfiles } from './workflow/known-skill-profiles.js'
export {
  compileLoadedWorkflow, listWorkflowTracks, loadCompiledWorkflow, loadTrack, projectWorkflowNames, requiredTrackChoices,
} from './workflow/track-lookup.js'
export type { LoadedTrack, WorkflowTrackEntry, WorkflowTrackListing } from './workflow/track-lookup.js'
// 路由表：所有可用工作流里带 route 的分支 → 打分表 → `router.sh` 读的 router.v6 数据缓存。
export { buildRouterTable, isBuiltinRouterWorkflow, ROUTER_SCHEMA } from './routing/router-table.js'
export type { RouterRow, RouterTable, RouterWorkflowSource } from './routing/router-table.js'
export { encodeRouterCache, routePattern } from './routing/router-cache.js'
export { collectRouterSources, generateRouterCache } from './routing/router-sources.js'
export type { RouterCacheResult, RouterSourceRequest } from './routing/router-sources.js'
export { validateWorkflowTrackReferences } from './workflow/track-reference-validation.js'
export type {
  StepDef, StepTestDef, StepTestPassDef, StepTestPolicyDef, StepTransition, TestInputDef, TestMetricCriterion,
  TestOutputDef, TestOutputKind, WorkflowActionConfig, WorkflowDecompositionAskCondition,
  WorkflowDecompositionAutoCondition, WorkflowDecompositionMode, WorkflowDecompositionPolicyV1,
  WorkflowDecompositionStrategy, WorkflowDecompositionTarget, WorkflowDef, WorkflowDocumentContractV1,
  WorkflowDocumentRead, WorkflowDocumentSlot, WorkflowGuardConfig, WorkflowInteractionMode,
  WorkflowInteractionPolicyV1,
} from './workflow/types.js'
export {
  canUseWorkflowRecommendedDefault,
  compileWorkflowDecompositionPolicy,
  compileWorkflowInteractionPolicy,
  DEFAULT_WORKFLOW_DECOMPOSITION_POLICY,
  DEFAULT_WORKFLOW_INTERACTION_POLICY,
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
  documentGovernancePolicy, documentKindScope, documentKindsProducedBySkillAtPolicyStep, documentOwnerPolicyStep,
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
  effectiveWorkflowPlanFromSnapshot, planAutomationPolicy, requireRunPlan, resolveBoundEffectiveWorkflowPlan,
  resolveEffectiveWorkflowPlan, workflowPlanSnapshot,
} from './workflow/effective-plan.js'
export type {
  AutomationPolicyBits, DocumentMode, EffectiveWorkflowPlan, LegacyWorkflowIR, PersistedDocumentGovernanceBinding, PlanOptions,
  WorkflowPlanSnapshot, WorkflowPlanSnapshotV1, WorkflowPlanSnapshotV2, WorkflowPlanSnapshotV3, WorkflowPlanSnapshotV4,
} from './workflow/effective-plan.js'
export type { StepAgentsCapability } from './workflow/effective-plan-types.js'
export {
  materializeWorkflowIo,
  type MaterializableWorkflow,
  type WorkflowDocumentSlotIo, type WorkflowEffectiveIo, type WorkflowFieldSlotIo, type WorkflowIoSlot, type WorkflowStepIo,
} from './workflow/effective-io.js'
export type {
  ActionInput, CompiledGuardConfig, DependencyState, GuardDecision, GuardInput, StepIR, StepTestIR, StepTestPolicyIR,
  StepTransitionIR, TasksThroughStepResult, UniversalGuardCapabilities, WorkflowIR,
} from './workflow/ir.js'
// 步骤测试档位（`test:`）：四选一闭集；档位含义在求值时读项目测试目录的 levels（test-system/levels.ts）。
export { TEST_LEVELS, isTestLevel, stepDeclaresTests } from './workflow/test-level.js'
export type { TestLevel } from './workflow/test-level.js'
export { universalGuardCapabilities } from './workflow/universal-guard-capabilities.js'
export type { UniversalGuardSource } from './workflow/universal-guard-capabilities.js'
export { readinessByTransition } from './workflow/transition-readiness.js'
export type {
  ReadinessByTransition, TransitionReadiness, TransitionReadinessBlocker,
} from './workflow/transition-readiness.js'
export { evaluateStepExitReport, judgeStepSkillsFromHistory } from './workflow/step-exit-report.js'
export type {
  StepBlocker, StepBlockerDetail, StepBlockerSource, StepExit, StepExitReport, StepExitReportInput, StepSkillJudgement,
} from './workflow/step-exit-report.js'
export { phaseExitGuardContext, unfinishedTaskItems } from './workflow/legacy-phase-manifest/phase-exit-context.js'
export { makeGuardFileContext, readBoundedRegularFileSync } from './infrastructure/guard-file-context.js'
export type {
  BoundedFileRead, PhaseExitFileContext, PhaseExitGuardContext,
} from './workflow/legacy-phase-manifest/phase-exit-context.js'
export {
  assessBuildRevisionTrust, createBuildRevisionToken, expectedBuildRevisionKind, hashBuildRevisionIdentity,
  isBuildRevisionBlocker, makeBuildRevisionBlocker, parseBuildRevisionToken, safeRevisionHash,
  BUILD_REVISION_CODE, BUILD_REVISION_REASONS, BUILD_REVISION_REMEDIATION, BUILD_REVISION_TOKEN_PREFIX,
  BuildRevisionCaptureError,
} from './workflow/build-revision.js'
export type {
  BuildRevisionAssessment, BuildRevisionAssessmentRequest, BuildRevisionBlocker,
  BuildRevisionIdentity, BuildRevisionKind, BuildRevisionObservation, BuildRevisionProvenance,
  BuildRevisionToken,
} from './workflow/build-revision.js'
export type { ArtifactProducerPolicy, WorkflowArtifactConfig } from './workflow/types.js'
// EffectiveSkillResolver（G2 P5）：runtime 三投影接缝（required/available/explicit-profile，都是计划冻结的
// 步骤技能，不叠加 manifest 矩阵；manifest-only default/custom seams retained for compatibility）。
export {
  createEffectiveSkillResolver, resolveAvailableSkillSlots, resolveExplicitProfileSkillSlots, resolveRequiredSkillSlots,
} from './workflow/effective-skill-resolver.js'
export type {
  EffectiveSkillResolver, EffectiveSkillSlot, EffectiveSkillResolverManifest,
} from './workflow/effective-skill-resolver.js'
// OpenSpec tasks.md → ordered workflow stages 的只读 Todo 投影（dashboard/native Todo 共用）。
export {
  DEFAULT_WORKFLOW_TODO_STAGES, incompletePipelineTasksForExit, projectPipelineTodo,
} from './workflow/todo-projection.js'
export type {
  PipelineTodoItem, PipelineTodoProjection, PipelineTodoStage, PipelineTodoStageDefinition, PipelineTodoStageStatus,
} from './workflow/todo-projection.js'
// 终端步骤清单：冻结计划的步骤顺序 → 一行 ✓/●/○（`tenon workflow progress` 与 step-progress hook 共用）。
export { stepProgressLine } from './workflow/step-progress.js'
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
