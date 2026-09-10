/** H11 starter 的纯读 binding/workflow/skill wiring 报告器；准入消费者与 CLI 展示共用。 */
import {
  compileAutomationPolicyTemplate,
  compileEffectiveWorkflowPlan,
  compileWorkflow,
  getAutomationPolicyTemplate,
  loadWorkflow,
  LOOP_RUNNERS,
  PHASES,
  resolveStep,
  resolveEffectiveWorkflowPlan,
  validateAutomationPolicyTemplate,
  type AutomationPolicyTemplate,
  type LoopEntry,
  type WorkflowDef,
  type WorkflowIR,
} from '@tenon/kernel'
import {
  evaluateSkillBundleWiring as evaluateSkillBundleWiringDefault,
  type SkillBundleWiringDeps,
  type SkillBundleWiringResolutionInput,
  type SkillBundleWiringResult,
  type SkillBundleWiringStatus,
} from '../skills/wiring.js'

export type LoopStarterBinding =
  | {
      readonly status: 'valid'
      readonly loopId: string
      readonly workflowId: string | null
      readonly policy: AutomationPolicyTemplate
    }
  | {
      readonly status: 'invalid'
      readonly loopId: string | null
      readonly reason: string
    }

export type WorkflowWiring =
  | { readonly status: 'ready'; readonly workflowId: string; readonly reason: null }
  | { readonly status: 'unwired' | 'invalid'; readonly workflowId: string | null; readonly reason: string }

export type CustomWorkflowRuntimeWiring =
  | { readonly status: 'ready'; readonly reason: null }
  | { readonly status: 'unwired'; readonly reason: string }

export interface LoopStarterWiring {
  readonly status: SkillBundleWiringStatus
  readonly reason: string | null
  readonly workflow: WorkflowWiring
  readonly customWorkflowRuntime: CustomWorkflowRuntimeWiring
  readonly skillBundle: SkillBundleWiringResult | null
}

export interface LoopStarterWiringReport {
  readonly starterId: string
  readonly binding: LoopStarterBinding
  readonly wiring: LoopStarterWiring
  /** active 且 binding/workflow/skill 全 ready 才为 true。 */
  readonly runnable: boolean
}

export interface LoopStarterWiringDeps {
  readonly repoRoot: string
  readonly skillBundleWiring: SkillBundleWiringDeps
  readonly skillBundleWiringForLoop?: (loop: LoopEntry) => SkillBundleWiringDeps
  readonly evaluateSkillBundleWiring?: (
    loop: LoopEntry,
    deps: SkillBundleWiringDeps,
    resolutionInputs?: readonly SkillBundleWiringResolutionInput[],
  ) => Promise<SkillBundleWiringResult>
  /** 仅显式 false 判 custom runtime 未装配；生产 coordinate 已接线。 */
  readonly customWorkflowRuntimeWired?: boolean
  readonly loadWorkflow?: (repoRoot: string, name: string) => WorkflowDef | null
  readonly compileWorkflow?: (definition: WorkflowDef) => WorkflowIR
  readonly resolveStep?: typeof resolveStep
}

function invalidReport(
  starterId: string,
  reason: string,
  loopId: string | null = null,
): LoopStarterWiringReport {
  return {
    starterId,
    binding: { status: 'invalid', loopId, reason },
    wiring: {
      status: 'invalid',
      reason,
      workflow: { status: 'invalid', workflowId: null, reason },
      customWorkflowRuntime: { status: 'unwired', reason: 'binding 无效，未建立 custom workflow runtime 坐标' },
      skillBundle: null,
    },
    runnable: false,
  }
}

function wiringFailureReport(
  starterId: string,
  binding: Extract<LoopStarterBinding, { readonly status: 'valid' }>,
  workflow: WorkflowWiring,
  customWorkflowRuntime: CustomWorkflowRuntimeWiring,
): LoopStarterWiringReport {
  return {
    starterId,
    binding,
    wiring: {
      status: workflow.status === 'invalid' ? 'invalid' : 'unwired',
      reason: workflow.reason ?? customWorkflowRuntime.reason,
      workflow,
      customWorkflowRuntime,
      skillBundle: null,
    },
    runnable: false,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function buildLoopStarterWiringReport(
  starterId: string,
  loops: readonly LoopEntry[],
  deps: LoopStarterWiringDeps,
): Promise<LoopStarterWiringReport> {
  let catalogTemplate: AutomationPolicyTemplate
  try {
    catalogTemplate = validateAutomationPolicyTemplate(getAutomationPolicyTemplate(starterId))
  } catch (error) {
    return invalidReport(starterId, errorMessage(error))
  }
  const candidates = loops.filter((entry) => entry.template_id === starterId)
  if (candidates.length !== 1) {
    return invalidReport(
      starterId,
      candidates.length === 0
        ? `starter "${starterId}" 未绑定任何 registry loop`
        : `starter "${starterId}" 同时绑定 ${candidates.length} 个 registry loop，无法确定唯一目标`,
    )
  }
  const target = candidates[0]!
  if (!(LOOP_RUNNERS as readonly string[]).includes(target.runner)) {
    return invalidReport(
      starterId,
      `runner "${target.runner}" 非法；仅允许 ${LOOP_RUNNERS.join(' / ')}，拒绝隐式降级执行`,
      target.id,
    )
  }
  if (target.template_version === undefined) {
    return invalidReport(starterId, 'template_version 缺失，版本化 starter binding 不完整', target.id)
  }
  if (target.template_version !== catalogTemplate.version) {
    return invalidReport(
      starterId,
      `template_version ${String(target.template_version)} 与 catalog version ${catalogTemplate.version} 不一致`,
      target.id,
    )
  }
  if (target.change_prefix !== null && target.change_prefix !== '') {
    const duplicateIds = loops
      .filter((entry) => entry.id !== target.id && entry.change_prefix === target.change_prefix)
      .map((entry) => entry.id)
    if (duplicateIds.length > 0) {
      return invalidReport(
        starterId,
        `change_prefix "${target.change_prefix}" 与 ${duplicateIds.join(', ')} 完全重复，归属存在歧义`,
        target.id,
      )
    }
  }

  try {
    const policy = compileAutomationPolicyTemplate(
      starterId,
      { goal: target.goal, risk: target.risk },
      target.template_version,
    )
    const workflowId = target.workflow_id ?? null
    const binding: LoopStarterBinding = { status: 'valid', loopId: target.id, workflowId, policy }
    if (workflowId === null) {
      const reason = 'workflow_id 未接线；template recommendedWorkflow 只是建议，不能冒充持久 binding'
      return wiringFailureReport(
        starterId,
        binding,
        { status: 'unwired', workflowId: null, reason },
        { status: 'unwired', reason: 'workflow binding 缺失，未建立 runtime 坐标' },
      )
    }
    let skillResolutionInputs: readonly SkillBundleWiringResolutionInput[]
    if (workflowId === 'default') {
      const invalidPhase = target.phases.find((phase) => !(PHASES as readonly string[]).includes(phase))
      if (invalidPhase !== undefined) {
        const reason = `loop phase "${invalidPhase}" 不在 default runtime PHASES 闭集（${PHASES.join(', ')}）`
        return wiringFailureReport(
          starterId,
          binding,
          { status: 'invalid', workflowId, reason },
          { status: 'unwired', reason: 'default workflow phase 无法映射到 runtime 坐标' },
        )
      }
      const capability = compileEffectiveWorkflowPlan('default').capabilities.skills
      skillResolutionInputs = target.phases.map((stepId) => ({ kind: 'default' as const, stepId, capability }))
    } else {
      let definition: WorkflowDef | null
      try {
        definition = (deps.loadWorkflow ?? loadWorkflow)(deps.repoRoot, workflowId)
      } catch (error) {
        const reason = `custom workflow "${workflowId}" 加载/校验/编译失败：${errorMessage(error)}`
        return wiringFailureReport(
          starterId,
          binding,
          { status: 'invalid', workflowId, reason },
          { status: 'unwired', reason: 'workflow 加载失败，未建立 custom runtime 坐标' },
        )
      }
      if (definition === null) {
        const reason = `custom workflow "${workflowId}" 文件不存在或缺失，无法建立执行 wiring`
        return wiringFailureReport(
          starterId,
          binding,
          { status: 'invalid', workflowId, reason },
          { status: 'unwired', reason: 'workflow 定义缺失，未建立 custom runtime 坐标' },
        )
      }
      let compiled: WorkflowIR
      try {
        compiled = (deps.compileWorkflow ?? compileWorkflow)(definition)
      } catch (error) {
        const reason = `custom workflow "${workflowId}" 编译失败：${errorMessage(error)}`
        return wiringFailureReport(
          starterId,
          binding,
          { status: 'invalid', workflowId, reason },
          { status: 'unwired', reason: 'workflow 编译失败，未建立 custom runtime 坐标' },
        )
      }
      const findStep = deps.resolveStep ?? resolveStep
      const customInputs: SkillBundleWiringResolutionInput[] = []
      for (const phase of target.phases) {
        const step = findStep(compiled, phase)
        if (step === null) {
          const reason = `loop phase/step "${phase}" 未在 custom workflow "${workflowId}" 中声明`
          return wiringFailureReport(
            starterId,
            binding,
            { status: 'invalid', workflowId, reason },
            { status: 'unwired', reason: 'loop phase 无法解析，未建立 custom runtime 坐标' },
          )
        }
        customInputs.push({ kind: 'custom', step })
      }
      skillResolutionInputs = customInputs
    }
    const workflow: WorkflowWiring = { status: 'ready', workflowId, reason: null }
    const customWorkflowRuntime: CustomWorkflowRuntimeWiring =
      workflowId === 'default' || deps.customWorkflowRuntimeWired !== false
        ? { status: 'ready', reason: null }
        : { status: 'unwired', reason: `custom workflow "${workflowId}" 的生产 runtime coordinate 未接线` }
    const evaluateSkills = deps.evaluateSkillBundleWiring ?? evaluateSkillBundleWiringDefault
    let skillBundle: SkillBundleWiringResult
    try {
      skillBundle = await evaluateSkills(
        target,
        deps.skillBundleWiringForLoop?.(target) ?? deps.skillBundleWiring,
        skillResolutionInputs,
      )
    } catch (error) {
      const reason = `skill bundle wiring evaluator 失败：${errorMessage(error)}`
      return {
        starterId,
        binding,
        wiring: { status: 'invalid', reason, workflow, customWorkflowRuntime, skillBundle: null },
        runnable: false,
      }
    }
    const status: SkillBundleWiringStatus = skillBundle.status === 'invalid'
      ? 'invalid'
      : skillBundle.status === 'unwired' || customWorkflowRuntime.status === 'unwired'
        ? 'unwired'
        : 'ready'
    const reason = skillBundle.status !== 'ready' ? skillBundle.reason : customWorkflowRuntime.reason
    return {
      starterId,
      binding,
      wiring: { status, reason, workflow, customWorkflowRuntime, skillBundle },
      runnable: target.status === 'active' && status === 'ready',
    }
  } catch (error) {
    return invalidReport(starterId, errorMessage(error), target.id)
  }
}

export type LoopExecutionWiringResult =
  | { readonly status: 'ready'; readonly loopId: string; readonly starter: LoopStarterWiringReport | null }
  | {
      readonly status: 'unwired' | 'invalid'
      readonly loopId: string
      readonly dimension: 'runner' | 'template' | 'workflow' | 'skill-bundle'
      readonly reason: string
      readonly starter: LoopStarterWiringReport | null
    }

/** 所有真实执行入口共用：runner/skill 对全部 loop 生效，template/workflow 对 starter 额外生效。 */
export async function evaluateLoopExecutionWiring(
  loop: LoopEntry,
  loops: readonly LoopEntry[],
  deps: LoopStarterWiringDeps,
): Promise<LoopExecutionWiringResult> {
  if (!(LOOP_RUNNERS as readonly string[]).includes(loop.runner)) {
    return {
      status: 'invalid',
      loopId: loop.id,
      dimension: 'runner',
      reason: `runner "${loop.runner}" 非法；仅允许 ${LOOP_RUNNERS.join(' / ')}`,
      starter: null,
    }
  }
  if (loop.template_id !== undefined) {
    const starter = await buildLoopStarterWiringReport(loop.template_id, loops, deps)
    if (starter.binding.status !== 'valid') {
      return {
        status: 'invalid', loopId: loop.id, dimension: 'template',
        reason: starter.wiring.reason ?? 'starter binding invalid', starter,
      }
    }
    if (starter.wiring.workflow.status !== 'ready' || starter.wiring.customWorkflowRuntime.status !== 'ready') {
      return {
        status: starter.wiring.status === 'unwired' ? 'unwired' : 'invalid',
        loopId: loop.id, dimension: 'workflow',
        reason: starter.wiring.reason ?? 'workflow wiring unavailable', starter,
      }
    }
    if (starter.wiring.skillBundle?.status !== 'ready') {
      return {
        status: starter.wiring.skillBundle?.status === 'unwired' ? 'unwired' : 'invalid',
        loopId: loop.id, dimension: 'skill-bundle',
        reason: starter.wiring.reason ?? 'skill bundle wiring unavailable', starter,
      }
    }
    return { status: 'ready', loopId: loop.id, starter }
  }
  const workflowId = loop.workflow_id ?? 'default'
  let skillResolutionInputs: readonly SkillBundleWiringResolutionInput[]
  let compiledCustom: WorkflowIR | undefined
  let plan: ReturnType<typeof resolveEffectiveWorkflowPlan>
  try {
    plan = resolveEffectiveWorkflowPlan(workflowId, (name) => {
      const definition = (deps.loadWorkflow ?? loadWorkflow)(deps.repoRoot, name)
      if (definition === null) return null
      compiledCustom = (deps.compileWorkflow ?? compileWorkflow)(definition)
      return compiledCustom
    }, undefined, () => (deps.loadWorkflow ?? loadWorkflow)(deps.repoRoot, 'default'))
  } catch (error) {
    return {
      status: 'invalid', loopId: loop.id, dimension: 'workflow',
      reason: `custom workflow "${workflowId}" 加载/校验/编译失败：${errorMessage(error)}`,
      starter: null,
    }
  }
  if (plan === null) {
    return {
      status: 'invalid', loopId: loop.id, dimension: 'workflow',
      reason: `custom workflow "${workflowId}" 文件不存在或缺失，无法建立执行 wiring`,
      starter: null,
    }
  }
  if (plan.executionModel === 'phase-manifest') {
    const capability = plan.capabilities.skills
    skillResolutionInputs = loop.phases.map((stepId) => ({ kind: 'default' as const, stepId, capability }))
  } else {
    const compiled = compiledCustom ?? plan.workflow
    const customInputs: SkillBundleWiringResolutionInput[] = []
    for (const phase of loop.phases) {
      const step = (deps.resolveStep ?? resolveStep)(compiled, phase)
      if (step === null) {
        return {
          status: 'invalid', loopId: loop.id, dimension: 'workflow',
          reason: `loop phase/step "${phase}" 未在 custom workflow "${workflowId}" 中声明`,
          starter: null,
        }
      }
      customInputs.push({ kind: 'custom', step })
    }
    skillResolutionInputs = customInputs
  }
  const skill = await (deps.evaluateSkillBundleWiring ?? evaluateSkillBundleWiringDefault)(
    loop,
    deps.skillBundleWiringForLoop?.(loop) ?? deps.skillBundleWiring,
    skillResolutionInputs,
  )
  if (skill.status !== 'ready') {
    return {
      status: skill.status,
      loopId: loop.id,
      dimension: 'skill-bundle',
      reason: skill.reason ?? 'skill bundle wiring unavailable',
      starter: null,
    }
  }
  return { status: 'ready', loopId: loop.id, starter: null }
}
