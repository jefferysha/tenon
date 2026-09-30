/**
 * 工作台的测试投影：把每个步骤的测试证据判定成状态 + 最近一次运行的摘要。
 * 与转换拦截同一份 evaluateTestEvidence，所以工作台显示的通过就是转换会放行的通过。
 * 判定读的是 `user` 的记录（调用方传负责人，见 testEvidenceUser.ts）；损坏的记录文件进 diagnostics，不冒充「未运行」之外的任何结论。
 */
import {
  corruptTestRunFiles, evaluateTestEvidence, userSlug,
  type EffectiveWorkflowPlan,
} from '@tenon/kernel'
import type { TestItemSnapshot, TestStepSnapshot } from './types.js'
import { policyReportDto } from './testPolicyDto.js'
import type { EvidenceUser } from './testEvidenceUser.js'
import type { PlanBriefDto, PolicyReportDto } from './testSystemDtoTypes.js'
import { readPlanBrief } from './testSystemReads.js'

const MAX_DIAGNOSTICS = 20

export async function projectTestEvidence(input: {
  readonly root: string
  readonly changeDir: string
  readonly changeName: string
  readonly plan: EffectiveWorkflowPlan
  /** 按谁的记录判定：见 evidenceUserFor（负责人优先）。 */
  readonly user: EvidenceUser | undefined
  /** 缺省 = 宿主没有工作区指纹能力；返回 undefined = 能力在但这次取不到（判定按未知处理）。 */
  readonly candidate?: () => Promise<string | undefined>
  /** 自任务起点以来的改动文件（与 CLI / 转换同源）；只在策略要求 `files: registered` 时才被调用，读不到时判定以 files-diff-unavailable 阻塞。 */
  readonly changedFiles?: () => Promise<readonly string[]>
}): Promise<{
  readonly tests?: TestStepSnapshot[]
  readonly testPolicy?: PolicyReportDto[]
  readonly testPlan?: PlanBriefDto
  readonly testUser?: string
  readonly diagnostics?: string[]
}> {
  const declared = input.plan.workflow.steps.filter((step) => (step.tests ?? []).length > 0 || step.test_policy !== undefined)
  if (declared.length === 0) return {}
  const user = input.user
  const readCandidate = input.candidate
  const context = user === undefined
    ? undefined
    : {
        user: { id: user.id, name: user.name, slug: userSlug(user.id) },
        ...(readCandidate === undefined ? {} : {
          currentCandidate: async (): Promise<string> => {
            const candidate = await readCandidate()
            if (candidate === undefined) throw new Error('workspace fingerprint unavailable')
            return candidate
          },
        }),
        ...(input.changedFiles === undefined ? {} : { changedFiles: input.changedFiles }),
      }
  const tests: TestStepSnapshot[] = []
  const policies: PolicyReportDto[] = []
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
    if (items.length > 0) tests.push({ stepId: step.id, items })
    if (report.policy !== undefined) policies.push(policyReportDto(report.policy, step.test_policy))
  }
  const hasPolicy = declared.some((step) => step.test_policy !== undefined)
  const corrupt = user === undefined
    ? []
    : await corruptTestRunFiles(input.root, input.changeName, userSlug(user.id))
  return {
    ...(tests.length === 0 ? {} : { tests }),
    ...(policies.length === 0 ? {} : { testPolicy: policies }),
    ...(hasPolicy && user !== undefined
      ? { testPlan: await readPlanBrief(input.root, input.changeDir, input.changeName), testUser: userSlug(user.id) }
      : {}),
    ...(corrupt.length === 0 ? {} : { diagnostics: [...corrupt].slice(0, MAX_DIAGNOSTICS) }),
  }
}
