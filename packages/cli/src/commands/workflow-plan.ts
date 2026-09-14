import { implicitCompletionTransition } from '@tenon/kernel'
import type { EffectiveWorkflowPlan, PipelineState } from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { changeDir, isValidChangeName } from '../paths.js'
import { effectiveWorkflowForState } from './effective-workflow.js'

export interface WorkflowPlanOpts {
  json?: boolean
}

function scalar(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(',') : (value ?? '')
}

function renderHuman(deps: CliDeps, name: string, state: PipelineState, plan: EffectiveWorkflowPlan): void {
  const source = state.runMetadata?.workflowPlanSnapshot === undefined
    ? 'current-definition'
    : 'frozen-snapshot'
  deps.io.out(`change   ${name}`)
  deps.io.out(`workflow ${plan.id}`)
  deps.io.out(`source   ${source}`)
  deps.io.out(`current  ${scalar(state.fields.phase)}`)
  for (const [index, step] of plan.workflow.steps.entries()) {
    const skills = step.skills.map((skill) => skill.id).join(', ') || '-'
    const completion = implicitCompletionTransition(plan, step.id, state)
    deps.io.out(
      `${String(index + 1).padStart(2, '0')} ${step.id} | ${step.label} | skills: ${skills}` +
      (completion === undefined ? '' : ` | completion: ${completion.event}`),
    )
  }
}

/**
 * A step without a forward exit finishes the run through an implicit event that the frozen plan
 * does not declare. Expose it per step as `completion_event` so agents never read such a step as
 * already complete.
 */
function planWithCompletionEvents(plan: EffectiveWorkflowPlan, state: PipelineState): EffectiveWorkflowPlan {
  const steps = plan.workflow.steps.map((step) => {
    const completion = implicitCompletionTransition(plan, step.id, state)
    return completion === undefined ? step : { ...step, completion_event: completion.event }
  })
  return { ...plan, workflow: { ...plan.workflow, steps } }
}

/**
 * Agent 编排在途 Change 的单一真相源。解析器优先采用 WorkflowRun 不可变快照，使项目
 * workflow 的当前定义与该运行已固定的 Todo、Skill DAG、门禁和转换保持明确分离。
 */
export async function cmdWorkflowPlan(
  deps: CliDeps,
  name: string,
  opts: WorkflowPlanOpts,
): Promise<number> {
  if (!isValidChangeName(name)) {
    deps.io.err(`ERROR: change-name 非法: '${name}' (仅允许 a-z A-Z 0-9 - _)`)
    return 1
  }
  let state: PipelineState
  try {
    state = await deps.store.read(changeDir(deps.cwd, name))
  } catch (error) {
    deps.io.err(`ERROR: ${errMsg(error)}`)
    return 1
  }
  let plan: EffectiveWorkflowPlan | null
  try {
    plan = effectiveWorkflowForState(deps, state)
  } catch (error) {
    deps.io.err(`ERROR: ${errMsg(error)}`)
    return 1
  }
  if (plan === null) {
    deps.io.err(`ERROR: workflow '${scalar(state.fields.workflow)}' 未找到`)
    return 1
  }
  const source = state.runMetadata?.workflowPlanSnapshot === undefined
    ? 'current-definition'
    : 'frozen-snapshot'
  if (opts.json) {
    deps.io.out(JSON.stringify({
      change: name,
      source,
      current_step: scalar(state.fields.phase),
      plan: planWithCompletionEvents(plan, state),
    }))
  } else {
    renderHuman(deps, name, state, plan)
  }
  return 0
}
