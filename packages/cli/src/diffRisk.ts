/**
 * 改动风险的读取面（CLI 侧）：自任务起点以来的路径改动 → 风险指标 / 路径类。
 *
 * 纯计数与分类在 kernel（assessDiffRisk、touchedPathClasses）；这里只负责把 git 读出来。读不出来
 * （不是 git 仓、超时）时探针命令直接失败，评审者挂载则失败关闭——全部挂载。
 */
import {
  allPathChangesForState, touchedPathClasses, unattachedReviewers,
  type FrozenAgent, type PathChange, type PathClass, type StepAgentsCapability,
} from '@tenon/kernel'
import type { CliDeps } from './deps.js'
import { msg } from './i18n/messages.js'
import { resolveChangeDir } from './paths.js'

/** 自任务起点以来的全部路径改动；CliDeps.diffChanges 只供测试装配覆写。读不出来抛错。 */
export function diffChangesFor(deps: CliDeps, change: string): () => Promise<readonly PathChange[]> {
  return async () => {
    if (deps.diffChanges !== undefined) return deps.diffChanges(change)
    return allPathChangesForState(deps.cwd, await deps.store.read(resolveChangeDir(deps.cwd, change)))
  }
}

/**
 * 本步骤里本任务的改动没有命中其 `attach_on` 的评审者名单（`StepAgentsInput.unattached`）。
 * 没有任何评审者声明 `attach_on` 时不碰 git；读不出改动时返回空名单（全部挂载）。
 */
export async function unattachedReviewersFor(
  deps: CliDeps,
  change: string,
  step: StepAgentsCapability,
  frozen: ReadonlyMap<string, FrozenAgent>,
): Promise<readonly string[]> {
  const attachOnOf = (agent: string): readonly PathClass[] | undefined => frozen.get(agent)?.definition.attachOn
  if (!step.reviewers.some((ref) => attachOnOf(ref.agent) !== undefined)) return []
  let touched: ReadonlySet<PathClass> | undefined
  try {
    touched = touchedPathClasses(await diffChangesFor(deps, change)())
  } catch {
    touched = undefined
  }
  return unattachedReviewers(step.reviewers, attachOnOf, touched)
}

/** `agent prompt` 对没挂载的评审者的拒绝（exit 2）：说明它为什么不需要运行。 */
export function unattachedRefusal(deps: CliDeps, agent: string, frozen: FrozenAgent): number {
  const scope = (frozen.definition.attachOn ?? []).join('/')
  deps.io.err(`ERROR: ${msg(deps, 'agent.reviewerUnattached', { agent, scope })}`)
  return 2
}
