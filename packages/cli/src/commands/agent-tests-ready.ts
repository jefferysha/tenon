/**
 * 步骤 agent 的测试就绪判定：本步必需的测试是否都已通过（旧步骤测试），以及本步声明了 test_policy 时的策略判定
 * （评审者提示词的 v2 测试摘要读它）。
 */
import { evaluateTestEvidence, testItemSettled, type TestPolicyReport } from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import type { TestCommandContext } from './test-context.js'

/** 必需测试是否就绪；测试证据判定缺席（旧 Change、无身份）时视为就绪，拦截由测试自己的门禁负责。 */
export async function testsReadyFor(
  deps: CliDeps,
  base: TestCommandContext,
  stepId: string,
): Promise<{
  readonly ready: { readonly ready: boolean; readonly pending: readonly string[] }
  readonly policy: TestPolicyReport | undefined
}> {
  const report = await (deps.testEvidence ?? evaluateTestEvidence)({
    repoRoot: deps.cwd,
    changeDir: base.dir,
    changeName: base.name,
    plan: base.plan,
    stepId,
    context: {
      user: { id: base.user.id, name: base.user.name, slug: base.slug },
      ...(deps.workspaceFingerprint === undefined
        ? {}
        : { currentCandidate: async () => (await deps.workspaceFingerprint?.(base.name) ?? '').trim() }),
    },
  })
  const pending = report.items
    .filter((item) => item.test.required && !testItemSettled(item))
    .map((item) => item.test.id)
  return { ready: { ready: pending.length === 0, pending }, policy: report.policy }
}
