/**
 * 测试命令的信任预告：`run-tests` / `run-test` 动作带上 `trust`，宿主在执行之前就能请用户确认，而不是先撞一次
 * `tenon test run` 的「还没有得到你的信任」再来回一趟。
 *
 * 判定与执行前的校验（commands/test-trust.ts ensureTrusted）同一份：目录里的命令、任务冻结工作流里的步骤测试命令，
 * 摘要都记在用户本地的封存里才算信任；环境显式信任（CI）算信任。读不出封存 / 目录时不预告——真正的拦截
 * 仍在 `tenon test run` 那一侧，这里只是少撞一次墙。
 */
import { isTrusted, isTenonUser, readTestSeal, userSlug, type EffectiveWorkflowPlan } from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { readCatalogFile } from '../test-system/project-files.js'
import type { StepAction } from './statusStepAction.js'
import { TRUST_ENV, catalogTrustTarget, stepTestsTrustTarget, type TrustTarget } from './test-trust.js'

export interface TrustNotice {
  /** 请用户在自己的终端运行的命令。 */
  readonly command: string
  /** 将要执行、还没有得到信任的命令（最多 10 条）。 */
  readonly commands: readonly string[]
}

const MAX_LINES = 10

async function pendingTrust(deps: CliDeps, change: string, plan: EffectiveWorkflowPlan): Promise<TrustNotice | null> {
  try {
    if (deps.env?.(TRUST_ENV) === '1') return null
    const user = deps.user()
    if (!isTenonUser(user)) return null
    const targets: TrustTarget[] = []
    const catalogFile = await readCatalogFile(deps.cwd)
    if (catalogFile.state === 'ok' && (catalogFile.catalog.suites.length > 0 || catalogFile.catalog.services.length > 0)) {
      targets.push(catalogTrustTarget(catalogFile.catalog))
    }
    const steps = stepTestsTrustTarget(plan)
    if (steps !== undefined) targets.push(steps)
    const { seal } = await readTestSeal(deps.cwd, userSlug(user.id))
    const pending = targets.filter((target) => !isTrusted(seal, target.digest))
    if (pending.length === 0) return null
    return { command: `tenon test trust ${change}`, commands: pending.flatMap((target) => target.lines).slice(0, MAX_LINES) }
  } catch {
    return null
  }
}

const RUNS_TESTS: ReadonlySet<string> = new Set(['run-tests', 'run-test'])

/** 给会执行测试命令的动作（run-tests / run-test）带上信任预告；其余动作原样。只在真有这类动作时才去读封存与目录。 */
export async function trustAnnotated(
  deps: CliDeps,
  change: string,
  plan: EffectiveWorkflowPlan,
  actions: readonly StepAction[],
): Promise<readonly StepAction[]> {
  if (!actions.some((action) => RUNS_TESTS.has(action.action))) return actions
  const notice = await pendingTrust(deps, change, plan)
  if (notice === null) return actions
  return actions.map((action) => (RUNS_TESTS.has(action.action) ? { ...action, trust: notice } : action))
}
