/**
 * check <name> —— guard 报告（人读）；exit 0 过 / 2 不过 / 1 错误（CONTRACT §3）。
 * 检查项内容是 flow.guardCheck（kernel/flow 相位出口全量规则表，BACKLOG #12）的职责，cli 只渲染：
 * deps.guardCtx（main.ts 用 node:fs 落地）注入文件面 → 老 guard 全语义；未注入 = lite 纯字段面。
 * warnings（老 guard yellow 提示面：coverage 豁免/阻塞层明细）渲染为 [WARN] 行，不影响 exit。
 *
 * 双轨（对齐 transition.ts 的 default vs 自定义 workflow 分岔）：读完 state 立刻按 workflow 字段分流。
 * default（含历史遗留空串，故 `|| 'default'` 兜空串，不是 `??`）→ 上面的 guardCheck 路径逐字不变；
 * 非 default → 读该 workflow 当前 step 定义、按 step-guard 评估（evaluateStepGuards）。check 是纯预览：
 * 两条路径都绝不写盘。exit 语义统一：过 0 / guard 不过 2 / 配置错（workflow 缺失·非法、step 不在图）1。
 */
import {
  evaluateDocumentEvidence,
  evaluateSpecMigrationEvidence,
  evaluateWorkflowIrStepGuards,
  evaluateDefaultEventPreconditions,
  classifyTaskPlanProjectionForChange,
  effectiveLifecyclePolicy,
  isDocumentContractPhase,
  isDocumentPolicyStep,
  isRevisionGuard,
  resolveStep,
  resolveWorkflowName,
  stepExitTransitions,
  TASK_PLAN_CURRENT_FILE,
  TASK_PLAN_LIMITS,
  TASK_PLAN_STATE_DIR,
} from '@tenon/kernel'
import type {
  DocumentEvidenceReport,
  DocumentGovernancePolicy,
  EffectiveWorkflowPlan,
  PipelineState,
  BuildRevisionBlocker,
} from '@tenon/kernel'
import type { StepIR } from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { changeDir, isValidChangeName } from '../paths.js'
import { display, str } from '../render.js'
import { effectiveWorkflowForState } from './effective-workflow.js'
import { stepAgentLines } from './check-agents.js'
import { stepTestBlockers } from './check-test-evidence.js'
import { resolveBuildRevisionAssessor } from './buildRevisionAssessor.js'

function renderBuildRevisionBlocker(blocker: BuildRevisionBlocker): string {
  return [
    blocker.code,
    `reason=${blocker.reason}`,
    `remediation=${blocker.remediation}`,
    ...(blocker.stateHash === undefined ? [] : [`stateHash=${blocker.stateHash}`]),
    ...(blocker.revisionHash === undefined ? [] : [`revisionHash=${blocker.revisionHash}`]),
  ].join(' ')
}

export interface CheckOpts {
  /** Exact custom edge to preflight (used by review request). */
  readonly event?: string
}

export async function cmdCheck(deps: CliDeps, name: string, opts: CheckOpts = {}): Promise<number> {
  if (!isValidChangeName(name)) {
    deps.io.err(`ERROR: change-name 非法: '${name}' (仅允许 a-z A-Z 0-9 - _)`)
    return 1
  }
  const dir = changeDir(deps.cwd, name)
  let state
  try {
    state = await deps.store.read(dir)
  } catch (e) {
    deps.io.err(`ERROR: ${errMsg(e)}`)
    return 1
  }

  let plan: EffectiveWorkflowPlan | null
  try {
    plan = effectiveWorkflowForState(deps, state)
  } catch (e) {
    deps.io.err(`ERROR: ${errMsg(e)}`)
    return 1
  }
  if (!plan) {
    const workflowName = resolveWorkflowName(state)
    deps.io.err(`ERROR: workflow '${workflowName}' 未找到（期望 .pipeline/workflows/${workflowName}.yaml）`)
    return 1
  }
  if (plan.capabilities.execution.model === 'step-graph') {
    return checkGraphWorkflow(deps, name, dir, state, plan, opts.event)
  }

  // ── default workflow：coverage policy 必须来自当前项目 effective registry。registry 损坏或
  // state.track 已成 orphan 都 fail-loud，不回退按 track id 的旧静态矩阵。
  const coverageProfile = plan.capabilities.track.coverageProfile
  const fileContext = deps.guardCtx?.(name)
  const tasksPath = fileContext?.changeDirRel === undefined
    ? undefined
    : `${fileContext.changeDirRel}/tasks.md`
  const canonicalStatePath = fileContext?.changeDirRel === undefined
    ? undefined
    : `${fileContext.changeDirRel}/${TASK_PLAN_STATE_DIR}/${TASK_PLAN_CURRENT_FILE}`
  const boundedCanonicalState = canonicalStatePath === undefined
    ? undefined
    : fileContext?.readFileBounded === undefined
      ? { kind: 'invalid' as const }
      : fileContext.readFileBounded(canonicalStatePath, TASK_PLAN_LIMITS.maxRevisionBytes)
  const canonicalStatePresent = boundedCanonicalState?.kind === 'ok'
  const tasksByteLimit = canonicalStatePresent
    ? TASK_PLAN_LIMITS.maxRevisionBytes
    : TASK_PLAN_LIMITS.maxLegacyProjectionBytes
  const boundedTasks = tasksPath === undefined
    ? undefined
    : fileContext?.readFileBounded === undefined
      ? { kind: 'invalid' as const }
      : fileContext.readFileBounded(tasksPath, tasksByteLimit)
  const authenticatedTasksSource = boundedTasks?.kind === 'ok' ? boundedTasks.text : undefined
  let canonicalTasksProjectionStatus: 'current' | 'legacy' | 'invalid' =
    boundedCanonicalState?.kind === 'invalid'
    || boundedTasks?.kind === 'invalid'
    || (canonicalStatePresent && boundedTasks?.kind === 'missing')
      ? 'invalid'
      : 'legacy'
  if (authenticatedTasksSource !== undefined) {
    try {
      canonicalTasksProjectionStatus = await classifyTaskPlanProjectionForChange(
        dir,
        authenticatedTasksSource,
      )
      if (
        canonicalTasksProjectionStatus === 'legacy'
        && Buffer.byteLength(authenticatedTasksSource) > TASK_PLAN_LIMITS.maxLegacyProjectionBytes
      ) canonicalTasksProjectionStatus = 'invalid'
    } catch {
      // Corrupt or concurrently replaced canonical state is not legacy. It must block the guard.
      canonicalTasksProjectionStatus = 'invalid'
    }
  }
  // Invalid bounded input stays present as an empty sentinel so every phase reaches the explicit
  // authentication failure instead of treating an oversized legacy file as an absent optional one.
  const guardedTasksSource = canonicalTasksProjectionStatus === 'invalid'
    && authenticatedTasksSource === undefined
    ? ''
    : authenticatedTasksSource
  const guardedFileContext = fileContext === undefined
    ? undefined
    : {
        ...fileContext,
        readFile: (path: string) => path === tasksPath
          ? guardedTasksSource
          : fileContext.readFile?.(path),
      }
  const result = deps.flow.guardCheck(state, {
    ...guardedFileContext,
    coverageProfile,
    ...(guardedTasksSource === undefined
      ? {}
      : {
          canonicalTasksProjectionStatus: ({ changeDirRel, tasksMarkdown }) =>
            changeDirRel === fileContext?.changeDirRel && tasksMarkdown === guardedTasksSource
              ? canonicalTasksProjectionStatus
              : 'invalid',
      }),
  })
  // Verify preview must expose the exact typed revision barrier used by verify-pass transition.
  // Evaluate all guards here so a stale/missing build token cannot be hidden behind an older
  // legacy guard failure; only the revision blocker is rendered below because flow.guardCheck
  // remains the compatibility source for the other checks.
  const workspaceFingerprint = deps.workspaceFingerprint
  const revisionResult = str(state.fields.phase) === 'verify'
    ? await evaluateDefaultEventPreconditions('verify-pass', state, {
        fileExists: fileContext?.fileExists,
        gitHeadSha: deps.gitHeadSha,
        workspaceFingerprint: workspaceFingerprint === undefined
          ? undefined
          : () => workspaceFingerprint(name),
        assessBuildRevision: resolveBuildRevisionAssessor(deps, name, dir),
      }, { stopOnFirstFailure: false })
    : null
  const revisionBlocker = revisionResult?.blockers?.find((candidate) =>
    candidate.code === 'verify-build-revision-untrusted')
  const revisionFailures = revisionBlocker === undefined
    ? []
    : [renderBuildRevisionBlocker(revisionBlocker)]
  const migration = str(state.fields.phase) === 'ship'
    ? await evaluateSpecMigrationEvidence(deps.cwd, dir, name)
    : undefined
  let documents: DocumentEvidenceReport | undefined
  let tests: readonly string[]
  let agents: readonly string[]
  try {
    documents = await governedDocumentEvidence(deps, dir, state, plan.capabilities.documents.policy)
    tests = await stepTestBlockers(deps, name, dir, state, plan)
    agents = await stepAgentLines(deps, name, dir, state, plan, opts.event)
  } catch (e) {
    deps.io.err(`ERROR: ${errMsg(e)}`)
    return 1
  }
  deps.io.out(`[CHECK] ${name} (phase=${display(state.fields.phase)})`)
  for (const warning of result.warnings ?? []) {
    deps.io.out(`  [WARN] ${warning}`)
  }
  if (result.pass && revisionFailures.length === 0 && (documents?.pass ?? true)
    && tests.length === 0 && agents.length === 0 && migration?.kind !== 'invalid') {
    deps.io.out('  [PASS] 所有检查通过')
    return 0
  }
  for (const failure of result.failures) {
    deps.io.out(`  [FAIL] ${failure}`)
  }
  for (const failure of revisionFailures) {
    deps.io.out(`  [FAIL] ${failure}`)
  }
  for (const blocker of documents?.blockers ?? []) {
    deps.io.out(`  [FAIL] document: ${blocker}`)
  }
  for (const blocker of tests) {
    deps.io.out(`  [FAIL] test: ${blocker}`)
  }
  for (const line of agents) {
    deps.io.out(`  [FAIL] agent: ${line}`)
  }
  if (migration?.kind === 'invalid') {
    deps.io.out(`  [FAIL] migration: ${migration.reason}`)
  }
  const total = result.failures.length
    + revisionFailures.length
    + (documents?.blockers.length ?? 0)
    + tests.length
    + agents.length
    + (migration?.kind === 'invalid' ? 1 : 0)
  deps.io.out(`  [FAIL] 共 ${total} 项未通过`)
  return 2
}

/**
 * The same evidence predicate used by transition execution.  Keeping it in `check` makes a missing
 * record visible before a user attempts a gated transition instead of turning the transition error
 * into the first explanation of the problem.
 */
async function governedDocumentEvidence(
  deps: CliDeps,
  dir: string,
  state: PipelineState,
  policy: DocumentGovernancePolicy | undefined,
): Promise<DocumentEvidenceReport | undefined> {
  if (!policy) return undefined
  const phase = str(state.fields.phase)
  if (!isDocumentPolicyStep(policy, phase)) {
    throw new Error(`受 document contract 治理的 workflow 当前 step 非法（当前 '${phase || '空'}'）`)
  }
  if (policy.id === 'openspec-v1' && deps.documentEvidence) {
    if (!isDocumentContractPhase(phase)) throw new Error(`legacy document contract step 非法: '${phase}'`)
    return deps.documentEvidence(deps.cwd, dir, phase)
  }
  return evaluateDocumentEvidence(deps.cwd, dir, phase, {}, policy)
}

/**
 * 非 default workflow 的 check：加载该 workflow、定位当前 step、按其 step-guard 预览评估
 * （evaluateStepGuards——同 transition.ts 求值「正在退出的」当前 step 的 guard，单一真相源）。
 * 纯预览、零写盘。exit：guard 全过 0 / guard 不过 2（与 default 不过同码）/ 配置错 1。
 */
async function checkGraphWorkflow(
  deps: CliDeps,
  name: string,
  dir: string,
  state: PipelineState,
  plan: EffectiveWorkflowPlan,
  event: string | undefined,
): Promise<number> {
  const currentStepId = str(state.fields.phase)
  const step = resolveStep(plan.workflow, currentStepId)
  if (!step) {
    deps.io.err(`ERROR: step '${currentStepId}' 不在 workflow '${plan.id}' 里`)
    return 1
  }
  // Declared exits plus the implicit `archived` completion edge of a step without a forward exit.
  const exits = stepExitTransitions(plan, step.id, state)
  let guards: StepIR['guards']
  if (event === undefined) {
    guards = plainGraphCheckGuards(plan, step, exits)
  } else {
    const selectedEdge = exits.find((transition) => transition.event === event)
    if (selectedEdge === undefined) {
      deps.io.err(
        `ERROR: step '${currentStepId}' 不支持 event '${event}'；可选：${exits.map((transition) => transition.event).join(', ') || '(无)'}`,
      )
      return 1
    }
    guards = effectiveLifecyclePolicy(
      plan.capabilities.documents.governed,
      step,
      selectedEdge,
      plan.workflow.steps.find((candidate) => candidate.id === selectedEdge.to),
    ).guards
  }
  // 能力注入让 file-exists/build-head-unchanged 类 guard 在预览里忠实评估；revision assessor
  // 缺失时显式 fail-closed，不把 Verify 信任面降级为 skipped。tasks-at-least/nonempty-output
  // 只用 readText/字段面，不受此影响。
  const result = await evaluateWorkflowIrStepGuards(state, { ...step, guards }, {
    changeDirAbs: dir,
    fileExists: deps.guardCtx?.(name)?.fileExists,
    gitHeadSha: deps.gitHeadSha,
    workspaceFingerprint: deps.workspaceFingerprint
      ? (() => {
          const fingerprint = deps.workspaceFingerprint
          return fingerprint ? fingerprint(name) : Promise.reject(new Error('workspace fingerprint capability unavailable'))
        })
      : undefined,
    specMigrationStatus: () => evaluateSpecMigrationEvidence(deps.cwd, dir, name),
    assessBuildRevision: resolveBuildRevisionAssessor(deps, name, dir),
  })
  const migration = str(state.fields.phase) === 'ship'
    && plan.capabilities.documents.governed
    ? await evaluateSpecMigrationEvidence(deps.cwd, dir, name)
    : undefined
  let documents: DocumentEvidenceReport | undefined
  let tests: readonly string[]
  let agents: readonly string[]
  try {
    documents = await governedDocumentEvidence(deps, dir, state, plan.capabilities.documents.policy)
    tests = await stepTestBlockers(deps, name, dir, state, plan)
    agents = await stepAgentLines(deps, name, dir, state, plan, event)
  } catch (e) {
    deps.io.err(`ERROR: ${errMsg(e)}`)
    return 1
  }
  deps.io.out(`[CHECK] ${name} (phase=${display(state.fields.phase)})`)
  if (result.pass && (documents?.pass ?? true) && tests.length === 0 && agents.length === 0
    && migration?.kind !== 'invalid') {
    deps.io.out('  [PASS] 所有检查通过')
    return 0
  }
  for (const failure of result.failures) {
    deps.io.out(`  [FAIL] ${failure}`)
  }
  for (const blocker of documents?.blockers ?? []) {
    deps.io.out(`  [FAIL] document: ${blocker}`)
  }
  for (const blocker of tests) {
    deps.io.out(`  [FAIL] test: ${blocker}`)
  }
  for (const line of agents) {
    deps.io.out(`  [FAIL] agent: ${line}`)
  }
  if (migration?.kind === 'invalid') {
    deps.io.out(`  [FAIL] migration: ${migration.reason}`)
  }
  const total = result.failures.length
    + (documents?.blockers.length ?? 0)
    + tests.length
    + agents.length
    + (migration?.kind === 'invalid' ? 1 : 0)
  deps.io.out(`  [FAIL] 共 ${total} 项未通过`)
  return 2
}

/**
 * Plain custom check keeps its historical step-guard preview and only supplements the
 * revision invariant.  Edge-specific non-revision guards are intentionally not previewed
 * without an exact event.  A single revision guard is retained for all non-rollback exits,
 * while rollback-only steps do not require a forward proof.
 */
function plainGraphCheckGuards(
  plan: EffectiveWorkflowPlan,
  step: StepIR,
  exits: readonly StepIR['transitions'][number][],
): StepIR['guards'] {
  const policies = exits.map((transition) => effectiveLifecyclePolicy(
    plan.capabilities.documents.governed,
    step,
    transition,
    plan.workflow.steps.find((candidate) => candidate.id === transition.to),
  ))
  const revisionGuard = policies
    .filter((policy) => !policy.rollback)
    .flatMap((policy) => policy.guards)
    .find(isRevisionGuard)
  const nonRevision = step.guards.filter((guard) => !isRevisionGuard(guard))
  if (revisionGuard === undefined) return nonRevision
  const firstRevisionIndex = step.guards.findIndex(isRevisionGuard)
  const insertionIndex = firstRevisionIndex < 0
    ? nonRevision.length
    : Math.min(firstRevisionIndex, nonRevision.length)
  return [
    ...nonRevision.slice(0, insertionIndex),
    revisionGuard,
    ...nonRevision.slice(insertionIndex),
  ]
}
