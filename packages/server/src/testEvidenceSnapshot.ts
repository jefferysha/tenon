/**
 * 工作台的测试投影：把每个步骤的测试证据判定成状态 + 最近一次运行的摘要。
 * 与转换拦截同一份 evaluateTestEvidence，所以工作台显示的通过就是转换会放行的通过。
 * 判定读的是当前用户的记录；损坏的记录文件进 diagnostics，不冒充「未运行」之外的任何结论。
 */
import {
  corruptTestRunFiles, evaluateTestEvidence, userSlug,
  type EffectiveWorkflowPlan, type TenonUser,
} from '@tenon/kernel'
import type { TestItemSnapshot, TestStepSnapshot } from './types.js'

const MAX_DIAGNOSTICS = 20

export async function projectTestEvidence(input: {
  readonly root: string
  readonly changeDir: string
  readonly changeName: string
  readonly plan: EffectiveWorkflowPlan
  readonly user: TenonUser | undefined
  readonly candidate: () => Promise<string | undefined>
}): Promise<{ readonly tests?: TestStepSnapshot[]; readonly diagnostics?: string[] }> {
  const declared = input.plan.workflow.steps.filter((step) => (step.tests ?? []).length > 0)
  if (declared.length === 0) return {}
  const user = input.user
  const context = user === undefined
    ? undefined
    : {
        user: { id: user.id, name: user.name, slug: userSlug(user.id) },
        currentCandidate: async () => (await input.candidate()) ?? '',
      }
  const tests: TestStepSnapshot[] = []
  for (const step of declared) {
    const report = await evaluateTestEvidence({
      repoRoot: input.root,
      changeDir: input.changeDir,
      changeName: input.changeName,
      plan: input.plan,
      stepId: step.id,
      context,
    })
    const items: TestItemSnapshot[] = report.items.map((item) => ({
      id: item.test.id,
      ...(item.test.label === undefined ? {} : { label: item.test.label }),
      direction: item.test.direction,
      required: item.test.required,
      status: item.status,
      ...(item.run === undefined ? {} : {
        run: {
          runId: item.run.run_id,
          user: userSlug(item.run.actor.id),
          actor: { id: item.run.actor.id, name: item.run.actor.name },
          result: item.run.result,
          exitCode: item.run.exit_code,
          durationMs: item.run.duration_ms,
          finishedAt: item.run.finished_at,
          reasons: item.run.reasons.map((reason) => reason.code),
        },
      }),
    }))
    tests.push({ stepId: step.id, items })
  }
  const corrupt = user === undefined
    ? []
    : await corruptTestRunFiles(input.root, input.changeName, userSlug(user.id))
  return {
    tests,
    ...(corrupt.length === 0 ? {} : { diagnostics: [...corrupt].slice(0, MAX_DIAGNOSTICS) }),
  }
}
