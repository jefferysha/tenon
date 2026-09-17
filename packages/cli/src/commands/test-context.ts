/**
 * `tenon test *` 的共同前置：change 名、state、冻结计划、身份、负责人，以及按 id 找到测试项。
 * 归档拦截是这里唯一的调用点（父设计 §7）。
 */
import {
  assertOwner, isTenonUser, resolveWorkflowName, userSlug, OwnerRequiredError,
  type EffectiveWorkflowPlan, type PipelineState, type RecordActor, type StepIR, type StepTestIR, type TenonUser,
} from '@tenon/kernel'
import { actorOf } from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { changeDir, isValidChangeName } from '../paths.js'
import { refuseArchived } from '../archivedGuard.js'
import { requireUser } from '../userIdentity.js'
import { effectiveWorkflowForState } from './effective-workflow.js'

export interface TestCommandContext {
  readonly name: string
  readonly dir: string
  readonly state: PipelineState
  readonly plan: EffectiveWorkflowPlan
  readonly user: TenonUser
  readonly actor: RecordActor
  readonly slug: string
}

export async function resolveTestCommand(
  deps: CliDeps,
  name: string,
  options: { readonly requireOwner: boolean },
): Promise<TestCommandContext | number> {
  if (!isValidChangeName(name)) {
    deps.io.err(`ERROR: change-name 非法: '${name}' (仅允许 a-z A-Z 0-9 - _)`)
    return 1
  }
  const dir = changeDir(deps.cwd, name)
  let state: PipelineState
  try {
    state = await deps.store.read(dir)
  } catch (e) {
    deps.io.err(`ERROR: ${errMsg(e)}`)
    return 1
  }
  const user = requireUser(deps)
  if (user === null) return 1
  if (!isTenonUser(user)) return 1
  const slug = userSlug(user.id)
  // 归档（每用户「隐藏这个任务」）的任务不接受测试命令（父设计 §7）；判定与文案由共享守卫给出。
  if (await refuseArchived(deps, name)) return 1
  let plan: EffectiveWorkflowPlan | null
  try {
    plan = effectiveWorkflowForState(deps, state)
  } catch (e) {
    deps.io.err(`ERROR: ${errMsg(e)}`)
    return 1
  }
  if (plan === null) {
    const workflowName = resolveWorkflowName(state)
    deps.io.err(`ERROR: workflow '${workflowName}' 未找到（期望 .pipeline/workflows/${workflowName}.yaml）`)
    return 1
  }
  const actor = actorOf(user)
  if (options.requireOwner) {
    try {
      assertOwner(name, state.fields, actor)
    } catch (e) {
      deps.io.err(`ERROR: ${e instanceof OwnerRequiredError ? e.message : errMsg(e)}`)
      return 1
    }
  }
  return { name, dir, state, plan, user, actor, slug }
}

/** agent 命令与 test 命令的前置完全相同（同一套归档、身份、负责人与冻结计划），共用一个实现。 */
export { resolveTestCommand as resolveChangeCommand }

export interface LocatedTest {
  readonly step: StepIR
  readonly test: StepTestIR
}

export function locateTest(plan: EffectiveWorkflowPlan, testId: string): LocatedTest | undefined {
  for (const step of plan.workflow.steps) {
    const test = step.tests?.find((candidate) => candidate.id === testId)
    if (test !== undefined) return { step, test }
  }
  return undefined
}

export function declaredTestIds(plan: EffectiveWorkflowPlan): readonly string[] {
  return plan.workflow.steps.flatMap((step) => (step.tests ?? []).map((test) => test.id))
}
