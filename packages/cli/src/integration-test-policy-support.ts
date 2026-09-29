/**
 * 集成夹具：像 satisfyStepTests 满足旧步骤测试那样，让某一步的 test_policy 在「主题与测试无关」的流程
 * 用例里直接满足——空目录 + 计划里已批准的豁免（kernel seedApprovedTestPolicyWaivers）。计划经 kernel
 * 的 CLI 写入口落盘，摘要台账齐全，门禁看到的是一份合法、已批准的计划，不是被绕过的门禁。
 */
import { join } from 'node:path'
import { seedApprovedTestPolicyWaivers } from '@tenon/kernel/test-system/test-support'
import { actorOf, isTenonUser, resolveTenonUser } from '@tenon/kernel'
import type { CliDeps } from './deps.js'
import { effectiveWorkflowForState } from './commands/effective-workflow.js'

const FALLBACK_ACTOR = { id: 'tester@tenon.test', name: 'Tester', trust: 'declared' as const }

export async function seedStepTestPolicy(
  deps: CliDeps, cwd: string, name: string, stepId: string, recordedAt: string,
): Promise<void> {
  const changeDir = join(cwd, 'openspec', 'changes', name)
  const plan = effectiveWorkflowForState(deps, await deps.store.read(changeDir))
  if (plan === null) return
  const user = resolveTenonUser(cwd, process.env)
  await seedApprovedTestPolicyWaivers({
    repoRoot: cwd,
    changeDir,
    changeName: name,
    plan,
    stepId,
    actor: isTenonUser(user) ? actorOf(user) : FALLBACK_ACTOR,
    recordedAt,
  })
}
