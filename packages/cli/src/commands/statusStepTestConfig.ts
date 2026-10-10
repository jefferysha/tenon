/**
 * `status --json` 步骤块里「必需测试还没配置」的提示：本步与下一步（计划步看之后所有步骤）声明的必需测试里
 * 命令要的 npm 脚本在项目里不存在的那些。从 statusStep.ts 原样迁出（文件行数上限），行为不变。
 */
import { isForwardExit, type EffectiveWorkflowPlan } from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { unconfiguredMessage, unconfiguredNpmScript } from '../test-runner/npmScript.js'
import type { StepTestConfigGap, StepTestView } from './statusStepNext.js'
import type { StepExit } from './stepExitReport.js'

/** 计划步：本步产出计划文档（plan / superpower-plan）。它之后所有步骤的测试配置都在这里提出。 */
export const PLAN_DOCUMENT_KINDS: ReadonlySet<string> = new Set(['plan', 'superpower-plan'])

/** 从 stepId 沿前进边能走到的所有步骤（不含它自己）。 */
function downstreamSteps(plan: EffectiveWorkflowPlan, stepId: string): ReadonlySet<string> {
  const reached = new Set<string>()
  const queue = [stepId]
  while (queue.length > 0) {
    const from = queue.shift() ?? ''
    const step = plan.workflow.steps.find((candidate) => candidate.id === from)
    for (const transition of step?.transitions ?? []) {
      const to = transition.to
      if (to === stepId || reached.has(to) || !isForwardExit(plan, from, to, transition.event)) continue
      reached.add(to)
      queue.push(to)
    }
  }
  return reached
}

/**
 * 本步与下一步（前进边指向的步骤）声明的必需测试里未配置的那些；计划步看之后所有步骤——测试配置
 * 要进计划，而不是到实现步才发现、再改写已登记的计划。本步已通过的不算；后续步骤的测试还没有自己
 * 的证据，只看命令配没配。
 */
export async function testConfigGaps(
  deps: CliDeps,
  plan: EffectiveWorkflowPlan,
  stepId: string,
  tests: readonly StepTestView[],
  exits: readonly StepExit[],
  planning: boolean,
): Promise<readonly StepTestConfigGap[]> {
  // 计划步：测试脚本与测试是这次改动的一部分，要写进本步能改的规格文档（proposal 的变更与影响、
  // design），不能只进计划——真机第四轮：proposal 没列、design 还写着「不改 package.json」，verify 的
  // 规格一致性评审据此判「多做」阻断，verify-fail 之后 build 改不了 proposal，只能回到 spec。
  const scope = planning
    ? '只需在 package.json 补上脚本；这类测试若还没有，把「写这类测试」列进本步的计划与 tasks，在实现步完成。'
      + '新增的测试脚本（以及要写的测试）同步写进本步可改的规格文档：proposal 的 What Changes / Impact 与 design，'
      + '并删掉与之相矛盾的表述（例如「不改 package.json」）——否则之后的规格一致性评审会把它当成规格之外的改动。'
    : '只需补 package.json 的 scripts（以及这条脚本要跑的测试代码），不需要修改已登记的规格文档'
      + '（proposal / design / plan 等）——改了它们就只能回到规格步重新评审。'
  const gaps: StepTestConfigGap[] = tests
    .filter((test) => test.required && test.status === 'unconfigured' && test.hint !== undefined)
    .map((test) => ({ id: test.id, step: stepId, hint: `${test.hint ?? ''}${scope}` }))
  const ahead = planning
    ? downstreamSteps(plan, stepId)
    : new Set(exits.filter((exit) => exit.direction === 'forward' && exit.to !== stepId).map((exit) => exit.to))
  for (const step of plan.workflow.steps) {
    if (!ahead.has(step.id)) continue
    for (const test of step.tests ?? []) {
      if (!test.required || gaps.some((gap) => gap.id === test.id)) continue
      const gap = await unconfiguredNpmScript(deps.cwd, test)
      if (gap !== undefined) {
        const hint = `${unconfiguredMessage(test.id, test.command, gap)}`
          + `（后续步骤 '${step.id}' 的必需测试，先在本步配置好）${scope}`
        gaps.push({ id: test.id, step: step.id, hint })
      }
    }
  }
  return gaps
}
