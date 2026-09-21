/**
 * TransitionApplication —— 唯一转换用例（G1 支点，2026-07-17）。
 *
 * 此前 CLI（cli/commands/transition.ts）与 server（server/transition.ts）各自实现一遍完整的
 * "default/custom 双轨分流 → 前置校验 → flow.transition/planStepTransition → 副作用 →
 * commit → breadcrumb/history 收尾"编排，只在错误分类映射（exit code vs HTTP
 * code）与部署形态相关的少量绑定（TransitionContext 构造、breadcrumb/marker 的单/多项目端口
 * 形状）上有真实差异。这份重复正是 GOAL.md G1 的验收目标要消灭的对象。
 *
 * 这个模块拥有事务边界本身（内部调用 runRepository.transact()），不是一个接收 tx 的纯函数——
 * 如果调用方仍各自持有 runRepo.transact()，它们仍然可能各自遗漏 await、漏写某段收尾、或悄悄
 * 在 callback 里插入自己的逻辑，"唯一"就名不副实（2026-07-17 codex 架构评估明确建议）。
 *
 * 分层：两个 planner 在锁内判定和变换，但不持久化；它们保留 guard
 * 所需的文件/Git 读取，避免编排层复制事件事实映射。
 *     planner 的输入面从类型上收窄：只收 state 与（custom 轨）已加载并编译的 WorkflowIR，不接收
 *     带 commit 能力的 WorkflowRunTransaction——规划途中在结构上就不可能提交。
 *   - execute() —— 编排层：调 runRepository.transact() → 锁内物化 workflow 定义 → 选对应
 *     planner → 命中拒绝就直接返回（不 commit）→ 命中可提交结果就 tx.commit() →
 *     breadcrumb/history 收尾。
 *   - commit() 是唯一不可回退的成功点；收尾两项都是 commit 之后的 best-effort 兼容投影，写入
 *     失败只追加进返回结果的 warnings，绝不让已经成功的转换在返回值层面变成失败（2026-07-17
 *     codex 评估：不用回调式 emitWarning——回调本身若抛错，会把已提交成功的转换伪装成失败；
 *     结构化返回值没有这个风险）。
 *
 * 本模块的范围边界（2026-07-17 codex 架构评估划定，见 GOAL.md 清单 G）：只消灭 CLI/server 两处
 * 复制的转换编排；revision capture/assessment 失败统一是 commit 前 typed blocker，旧
 * `build-sha-missing` warning 仅作为 legacy ABI 类型保留，不再由当前 action 产生；不统一 default 轨
 * （FlowEngine/eventEdge）与 custom 轨（WorkflowIR/planStepTransition）内部本就不同的两套
 * 模型；change 名合法性/server root 信任校验/canonical-or-legacy state 是否存在这些
 * "transition 域拒绝"之外的前置校验留在 adapter 层，不下沉进本模块；不改变项目根
 * review marker 是 `tenon review request` 的根级短时投影；transition 本身只消费 canonical
 * exact-phase-and-event approval receipt。StateStore 已以 canonical current 为真相并把 `.pipeline.yaml`
 * 作为兼容投影，本用例只消费该抽象，不自行读任一格式。
 */
import type { FieldName, FlowEngine, Phase, PipelineState } from '../types.js'
import { IllegalTransitionError } from '../types.js'
import { applyBreadcrumbTail, clearReviewGatePatch, readCurrentRunRevision, reviewGateApprovedFor, transitionRecordToHistoryEntry } from '../state/index.js'
import { evaluateDocumentEvidence } from '../state/document-evidence.js'
import { rejectOnTestEvidence } from '../test-evidence/transition-gate.js'
import { ownerDecision } from '../users/owner.js'
import { formatUserRef } from '../users/user.js'
import type { DocumentEvidenceReport } from '../state/document-evidence.js'
import { builtinTrack, isBuiltinTrackId } from '../tracks/builtins.js'
import { eventEdge } from '../flow/index.js'
import type { EventName, TransitionContext } from '../flow/index.js'
import { evaluateDefaultEventPreconditions, DEFAULT_EVENT_POLICY } from '../flow/default-event-policy.js'
import { applyStepTransition, planStepTransition, resolveStep } from './engine.js'
import { implicitCompletionTransition } from './implicit-completion.js'
import { rejectOnStepGates } from './transition-step-gates.js'
import { applyActions } from './action-handlers.js'
import { evaluateConstraintPolicy, type ConstraintDecision } from '../loops/automation-policy.js'
import type { ActionOutcome, WorkflowIR } from './ir.js'
import { effectiveLifecyclePolicy } from './governed-lifecycle-policy.js'
import {
  isDocumentContractPhase, isDocumentPolicyStep, shouldEnforceDocumentPolicyOnTransition,
} from './document-contract.js'
import type { DocumentGovernancePolicy } from './document-contract.js'
import { DocumentGovernanceBindingError, resolveBoundEffectiveWorkflowPlan } from './effective-plan.js'
import type { EffectiveWorkflowPlan } from './effective-plan.js'
import type {
  PreparedTransition, TransitionApplication, TransitionApplicationDeps, TransitionApplicationResult,
  TransitionApplicationWarning, TransitionCommand, TransitionRejection,
} from './transition-application-types.js'
import { BuildRevisionCaptureError, safeRevisionHash } from './build-revision.js'
import { emitInteractionEffectUnderLock } from './interaction-effect.js'
import { INTERACTION_PROJECTION_WRITE_FAILED } from '../interaction/contract.js'
export type {
  TransitionApplication, TransitionApplicationDeps, TransitionApplicationResult,
  TransitionApplicationWarning, TransitionCommand,
} from './transition-application-types.js'
function isRejection(x: PreparedTransition | TransitionRejection): x is TransitionRejection {
  return 'kind' in x
}
function fieldStr(v: string | string[] | undefined): string {
  return Array.isArray(v) ? v.join(',') : (v ?? '')
}
// planner 只收 flow+clock，不收完整 TransitionApplicationDeps——deps 里有 runRepository 与两个
// projection writer，收整包等于 planner 在类型上仍可间接提交/写盘（第 2 轮 review 抓到：从
// "直接持有 tx" 变成 "间接可达" 不算收窄）。
async function planDefaultTransition(
  state: PipelineState,
  command: TransitionCommand,
  flow: FlowEngine,
  clock: () => string,
  effectivePlan: EffectiveWorkflowPlan,
): Promise<PreparedTransition | TransitionRejection> {
  const edge = eventEdge(command.event)
  if (!edge) return { kind: 'unknown-event', event: command.event }
  const current = fieldStr(state.fields.phase)
  if (current !== edge.from) {
    return { kind: 'event-source-mismatch', event: command.event, current, expected: edge.from, to: edge.to }
  }
  // eventEdge 命中 → command.event ∈ TRANSITION_EVENTS 键 = EventName（DEFAULT_EVENT_POLICY 同键
  // 空间，查表恒命中）。
  const event = command.event as EventName
  const policy = DEFAULT_EVENT_POLICY[event]

  // ① 前置 guard：typed guard handler 判定（首错优先）+ renderer 逐字 ERROR 文案——default 轨
  // 政策从老 checkTransitionPreconditions switch 迁到 DefaultEventPolicy + guard-handlers（G2 P3）。
  const preconditions = await evaluateDefaultEventPreconditions(event, state, command.context)
  if (preconditions) {
    const blocker = preconditions.blockers?.[0]
    if (blocker !== undefined) return { kind: 'revision-untrusted', blocker }
    return { kind: 'precondition-violated', lines: [...preconditions.lines] }
  }
  if (policy.enforceTaskExit) {
    const tasks = await command.context.tasksThroughPhase?.(edge.from)
    if (tasks && !tasks.pass) {
      return { kind: 'precondition-violated', lines: [tasks.failure ?? `${edge.from} 出口：tasks.md 未通过`] }
    }
  }

  // ② FlowEngine 推进：合法边检查 + phase/phase_status/updated_at 变换（转换结构不迁——保守分叉，
  // 边选择与相位推进继续由 eventEdge + FlowEngine 承担）。
  let result: ReturnType<FlowEngine['transition']>
  try {
    result = flow.transition(state, edge.to, clock)
  } catch (e) {
    if (e instanceof IllegalTransitionError) return { kind: 'illegal-transition', from: e.from, to: e.to }
    throw e
  }

  // ③ 状态副作用：typed action handler → patch，commit 前一次合并进 nextFields——default 轨从老
  // applyTransitionEffects switch 迁到 DefaultEventPolicy.actions + applyActions（G2 P3），与
  // custom 轨（planCustomTransition）共用同一 applyActions 引擎、同一「推进后 action、commit 前
  // 合并」时序。单次 planner 路径只跑 typed action、绝不再调 legacy switch（防双执行：两条都跑
  // 会让 clock()/gitHeadSha 各调两次 = 真实行为差异）。freeze-build-sha 统一由 capture capability
  // 生成 typed token；能力缺失或异常在 commit 前转为 revision-untrusted。
  const warnings: TransitionApplicationWarning[] = []
  let nextFields = result.state.fields
  if (policy.actions.length > 0) {
    let outcome: ActionOutcome
    try {
      outcome = await applyActions(policy.actions, {
        fields: result.state.fields,
        clock,
        gitHeadSha: command.context.gitHeadSha,
        workspaceFingerprint: command.context.workspaceFingerprint,
        captureBuildRevision: command.context.captureBuildRevision,
      })
    } catch (error) {
      if (error instanceof BuildRevisionCaptureError) {
        return {
          kind: 'revision-untrusted',
          blocker: {
            ...error.blocker,
            // Capture ran against the prospective target fields, but a rejected transition never
            // commits that state. Always report the locked canonical pre-state digest.
            stateHash: safeRevisionHash(state.fields),
          },
        }
      }
      throw error
    }
    nextFields = { ...result.state.fields, ...outcome.patch }
    for (const signal of outcome.signals) warnings.push({ kind: signal.kind })
  }
  return {
    governedDocumentContract: effectivePlan.capabilities.documents.governed,
    ...(effectivePlan.capabilities.documents.policy === undefined
      ? {}
      : { documentPolicy: effectivePlan.capabilities.documents.policy }),
    requiresReviewApproval: effectivePlan.capabilities.review.steps.includes(result.from),
    from: result.from, to: result.to, nextFields, warnings,
  }
}
async function planCustomTransition(
  state: PipelineState,
  effectivePlan: EffectiveWorkflowPlan,
  command: TransitionCommand,
  clock: () => string,
): Promise<PreparedTransition | TransitionRejection> {
  const ir = effectivePlan.workflow
  const workflowName = effectivePlan.id
  const currentBeforePlan = resolveStep(ir, fieldStr(state.fields.phase))
  // A step without a forward exit completes the run through the derived `archived` self-edge.
  // It is added to a planning copy only, so the frozen IR and its fingerprint stay untouched, and
  // it flows through the same guards, skills, documents and review receipt as a declared exit.
  const completion = currentBeforePlan === null
    ? undefined
    : implicitCompletionTransition(effectivePlan, currentBeforePlan.id, state)
  const planningIr: WorkflowIR = completion === undefined
    ? ir
    : {
        ...ir,
        steps: ir.steps.map((step) => step.id === completion.to
          ? { ...step, transitions: [...step.transitions, completion] }
          : step),
      }
  const edgeBeforePlan = resolveStep(planningIr, fieldStr(state.fields.phase))
    ?.transitions.find((candidate) => candidate.event === command.event)
  const documentPolicy = effectivePlan.capabilities.documents.policy
  const governed = documentPolicy !== undefined
  const targetStep = edgeBeforePlan === undefined
    ? undefined
    : resolveStep(planningIr, edgeBeforePlan.to)
  const lifecycle = currentBeforePlan && edgeBeforePlan
    ? effectiveLifecyclePolicy(governed, currentBeforePlan, edgeBeforePlan, targetStep ?? undefined)
    : undefined
  const plan = await planStepTransition(planningIr, state, command.event, {
    changeDirAbs: command.changeDir,
    fileExists: command.context.fileExists,
    gitHeadSha: command.context.gitHeadSha,
    workspaceFingerprint: command.context.workspaceFingerprint,
    specMigrationStatus: command.context.specMigrationStatus,
    assessBuildRevision: command.context.assessBuildRevision,
    currentStep: fieldStr(state.fields.phase),
  }, lifecycle)
  if (!plan.ok) {
    if (plan.kind === 'step-not-in-graph') return { kind: 'step-not-in-graph', workflowName, stepId: plan.stepId }
    if (plan.kind === 'event-unsupported') {
      return {
        kind: 'event-unsupported', workflowName, stepId: plan.stepId, event: command.event, available: plan.available,
      }
    }
    const blocker = plan.blockers?.[0]
    if (blocker !== undefined) return { kind: 'revision-untrusted', blocker }
    return { kind: 'step-guard-failed', workflowName, stepId: plan.stepId, failures: plan.failures, blockers: plan.blockers }
  }
  const currentStep = resolveStep(planningIr, plan.from)
  if (!currentStep) throw new Error(`workflow '${workflowName}' 在已规划 step '${plan.from}' 后无法重取当前 step`)
  // 计划通过：先算 phase 推进（applyStepTransition），再跑该边 edge actions——patch 合并进
  // nextFields **在 commit 之前**（对照 default 轨 typed action（applyActions）在 commit 前改 fields
  // 的同一时序）。actions 是 async，其真异常（如 freeze-build-sha 的 gitHeadSha 抛错）原样上抛 → 出
  // transact 回调 → 事务中止不 commit（state 不推进）。旧 YAML 无 edge action → 零 patch 零 signal，
  // 行为逐字不变。actions 直接取自 plan（planStepTransition 选边时携带同一条 edge 的
  // effective lifecycle actions），不二次按 from+event 查表——规划即选边的单一真相，无
  // 「选一条边、执行另查一条」的语义漂移面。
  const nextState = applyStepTransition(state, plan.to, clock)
  const actions = plan.actions
  const closesRun = actions.some((action) => action.type === 'archive-run')
  const warnings: TransitionApplicationWarning[] = []
  let nextFields = closesRun
    ? { ...nextState.fields, phase_status: 'done' as const }
    : nextState.fields
  if (actions.length > 0) {
    let outcome: ActionOutcome
    try {
      outcome = await applyActions(actions, {
        fields: nextState.fields,
        clock,
        gitHeadSha: command.context.gitHeadSha,
        workspaceFingerprint: command.context.workspaceFingerprint,
        captureBuildRevision: command.context.captureBuildRevision,
      })
    } catch (error) {
      if (error instanceof BuildRevisionCaptureError) {
        return {
          kind: 'revision-untrusted',
          blocker: {
            ...error.blocker,
            // Capture ran against the prospective target fields, but a rejected transition never
            // commits that state. Always report the locked canonical pre-state digest.
            stateHash: safeRevisionHash(state.fields),
          },
        }
      }
      throw error
    }
    nextFields = { ...nextFields, ...outcome.patch }
    for (const signal of outcome.signals) warnings.push({ kind: signal.kind })
  }
  return {
    governedDocumentContract: governed,
    ...(documentPolicy ? { documentPolicy } : {}),
    requiresReviewApproval: effectivePlan.capabilities.review.steps.includes(currentStep.id),
    from: plan.from, to: plan.to, nextFields, warnings,
  }
}
export function createTransitionApplication(deps: TransitionApplicationDeps): TransitionApplication {
  return {
    async execute(command: TransitionCommand): Promise<TransitionApplicationResult> {
      return deps.runRepository.transact(command.changeDir, async (tx): Promise<TransitionApplicationResult> => {
        const owner = ownerDecision(tx.state.fields, command.actor)
        if (!owner.allowed) return { kind: 'owner-required', owner: owner.owner }
        const beforeInteractionRevision = deps.interaction === undefined
          ? undefined
          : await readCurrentRunRevision(command.changeDir)
        // 事实物化在这里、锁内完成（workflow 定义加载），planner 只收规划所需的输入——state 与
        // 已加载并编译的 WorkflowIR，不把带 commit 能力的整个 tx 交给 planner（第 1 轮 review：
        // planner 拿到 tx 就有能力在规划途中提交，类型上就不该给这个权力）。
        const workflowName = tx.run.workflowId
        let effectivePlan: EffectiveWorkflowPlan | null
        try {
          const trackId = fieldStr(tx.state.fields.track)
          // 技能的轨道条件按当前轨道求值；宿主没接 resolveTrack 时至少认内建轨道，避免把全部轨道的
          // 条件技能都当成本轨必需。
          const track = trackId === '' ? undefined : deps.resolveTrack?.(trackId) ?? (isBuiltinTrackId(trackId) ? builtinTrack(trackId) : undefined)
          effectivePlan = resolveBoundEffectiveWorkflowPlan(workflowName, {
            documentProfile: tx.run.documentProfile,
            documentGovernanceFingerprint: tx.run.documentGovernanceFingerprint,
            workflowPlanFingerprint: tx.run.workflowPlanFingerprint,
          }, command.loadWorkflow, track, tx.run.workflowPlanSnapshot)
        } catch (error) {
          if (error instanceof DocumentGovernanceBindingError) {
            return { kind: 'document-governance-invalid', workflowName, reason: error.message }
          }
          throw error
        }
        if (!effectivePlan) return { kind: 'workflow-not-found', workflowName }
        let prepared: PreparedTransition | TransitionRejection
        if (effectivePlan.capabilities.execution.model === 'phase-manifest') {
          prepared = await planDefaultTransition(tx.state, command, deps.flow, deps.clock, effectivePlan)
        } else {
          prepared = await planCustomTransition(tx.state, effectivePlan, command, deps.clock)
        }
        if (isRejection(prepared)) return prepared
        const gated = await rejectOnStepGates({
          deps,
          changeDir: command.changeDir,
          workflowName,
          plan: effectivePlan,
          state: tx.state,
          from: prepared.from,
          to: prepared.to,
          event: command.event,
        })
        if (gated !== undefined) return gated
        const policy = tx.run.automationPolicy
        if (policy !== undefined) {
          const facts = deps.resolveConstraintContext === undefined
            ? { active: false, humanGateSatisfied: false }
            : await deps.resolveConstraintContext({ policy, command, target: prepared.to })
          const decision = evaluateConstraintPolicy(policy.constraints, {
            operation: 'transition', active: facts.active, humanGateSatisfied: facts.humanGateSatisfied,
            transitionTarget: prepared.to, matches: () => false,
          })
          if (!decision.allowed) return { kind: 'constraint-denied', reason: decision.reason }
        }
        if (
          prepared.documentPolicy
          && shouldEnforceDocumentPolicyOnTransition(prepared.documentPolicy, prepared.from, prepared.to)
        ) {
          if (!isDocumentPolicyStep(prepared.documentPolicy, prepared.from)) {
            return {
              kind: 'document-evidence-failed',
              phase: prepared.from,
              blockers: [`受 document contract 治理的 workflow 使用了非法 step '${prepared.from}'`],
            }
          }
          let evidence: DocumentEvidenceReport
          if (prepared.documentPolicy.id === 'openspec-v1' && deps.documentEvidence) {
            if (!isDocumentContractPhase(prepared.from)) {
              return {
                kind: 'document-evidence-failed',
                phase: prepared.from,
                blockers: [`legacy document contract 使用了非法 phase '${prepared.from}'`],
              }
            }
            evidence = await deps.documentEvidence(command.root, command.changeDir, prepared.from)
          } else {
            evidence = await evaluateDocumentEvidence(
              command.root,
              command.changeDir,
              prepared.from,
              {},
              prepared.documentPolicy,
            )
          }
          if (!evidence.pass) {
            return { kind: 'document-evidence-failed', phase: prepared.from, blockers: evidence.blockers }
          }
        }
        const testRejection = await rejectOnTestEvidence({
          repoRoot: command.root, changeDir: command.changeDir, changeName: command.changeName,
          plan: effectivePlan, from: prepared.from, to: prepared.to, context: deps.testEvidence,
          ...(deps.testEvidenceReader === undefined ? {} : { evaluate: deps.testEvidenceReader }),
        })
        if (testRejection !== undefined) return testRejection
        // Review 的判定点是“离开当前 review phase”，不是“刚进入就锁住”。所有自动 guards
        // / 文档证据先通过，才允许 request/ack receipt 成为下一步的人类复核证据。所有 caller
        // 都必须提供与当前状态绑定的 verifier；receipt 本身不能作为未绑定的放行凭证。
        const receiptApproved = reviewGateApprovedFor(tx.state, prepared.from, command.event)
        // Non-review transitions must not consult the review sidecar at all. A malformed or
        // unreadable verifier projection is a fail-closed review rejection only when this exact
        // transition leaves a governed review phase; otherwise it must not block unrelated edges.
        let bindingApproved = false
        if (prepared.requiresReviewApproval && receiptApproved) {
          bindingApproved = await deps.reviewGateBinding({
            changeDir: command.changeDir,
            state: tx.state,
            phase: prepared.from,
            event: command.event,
          })
        }
        if (prepared.requiresReviewApproval && !bindingApproved) {
          return { kind: 'review-approval-required', phase: prepared.from, event: command.event }
        }
        // Receipt 在任一成功 transition 后立即消费，避免一次旧批准在回退/重入同一 phase 后被复用。
        const { record, projection } = await tx.commit({ ...prepared.nextFields, ...clearReviewGatePatch() }, {
          event: command.event, from: prepared.from, to: prepared.to, actor: formatUserRef(command.actor),
        })
        const warnings = [...prepared.warnings]
        if (projection.status === 'pending') {
          warnings.push({
            kind: 'projection-write-failed', projection: 'state-yaml', cause: projection.error,
          })
        }
        if (deps.interaction !== undefined && receiptApproved && bindingApproved) {
          try {
            await emitInteractionEffectUnderLock({
              recorder: deps.interaction,
              changeDir: command.changeDir,
              changeName: command.changeName,
              reviewEvent: command.event,
              from: prepared.from,
              to: prepared.to,
              track: fieldStr(tx.state.fields.track),
              workflowRun: tx.run,
              before: beforeInteractionRevision,
              readAfter: () => readCurrentRunRevision(command.changeDir),
            })
          } catch (error) {
            warnings.push({
              kind: 'projection-write-failed', projection: 'interaction',
              code: INTERACTION_PROJECTION_WRITE_FAILED, cause: error,
            })
          }
        }
        // 收尾顺序 breadcrumb → history：breadcrumb 是 hook 热路径的当前相位缓存，history 是
        // durable transition audit。review marker 已移到 `tenon review request`，不能在进入
        // review phase 时写，否则会把该 phase 的实现/验证工作本身锁死。
        // （history 延迟/中断时先落 breadcrumb，缩短 hook 热路径读到的相位缓存过期窗口——此前
        // 一次 REFACTOR 曾把这个顺序悄悄改乱，顺序本身是可观测行为，不是实现细节）。custom 轨
        // 普通 custom 保留原有 history-only 行为；显式 governed custom 复用 default 的 breadcrumb。
        if (prepared.governedDocumentContract) {
          const breadcrumbTail = await applyBreadcrumbTail(
            deps.breadcrumb, { changeDir: command.changeDir, name: command.changeName, to: prepared.to },
          )
          if (!breadcrumbTail.ok) {
            warnings.push({ kind: 'projection-write-failed', projection: 'breadcrumb', cause: breadcrumbTail.error })
          }
        }
        if (deps.history) {
          try {
            await deps.history.append(command.changeDir, transitionRecordToHistoryEntry(record))
          } catch (e) {
            warnings.push({ kind: 'projection-write-failed', projection: 'history', cause: e })
          }
        }
        return { kind: 'applied', from: prepared.from, to: prepared.to, record, warnings }
      })
    },
  }
}
