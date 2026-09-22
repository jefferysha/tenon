/**
 * 「本步还缺哪些必需技能」——transition 拒绝离开本步用的正是这个判定，`tenon check` 与
 * `tenon status` 的每条出边也用它。
 *
 * 为什么必须共用一份：0.1.0 里 transition 有这道门、check 没有，于是同一份状态下 check 说
 * 「[PASS] 所有检查通过」、下一条命令 transition 说「step 'explore' 尚未完成声明的 skill」。
 * 两个命令对同一事实给出相反答案，用户无从判断谁对。判定只此一处，差别只有一个：transition
 * 持锁、可以把宿主回执落成 history 证据；check/status 是预览，只读同样的回执得出同样的结论。
 */
import {
  completedWorkflowSkillsSinceStepEntry, resolveRequiredSkillSlots,
  type EffectiveWorkflowPlan,
} from '@tenon/kernel'
import type { CliDeps } from './deps.js'
import { discoverConfirmedCodexSkillIds, reconcileCodexSkillEvidence } from './codexSkillReceipt.js'

export type SkillCapability = EffectiveWorkflowPlan['capabilities']['skills']

/** Pipeline-owned skills are presented by Codex as `tenon:<id>`; the workflow data uses the bare id. */
export function canonicalPipelineSkillId(skillId: string): string {
  return skillId.startsWith('tenon:') ? skillId.slice('tenon:'.length) : skillId
}

export interface StepSkillGateInput {
  readonly deps: CliDeps
  readonly changeDir: string
  readonly stepId: string
  readonly capability: SkillCapability
  /**
   * `true` 只给持有 Change 锁的 transition 用：把宿主已完成的读取落成 history 证据，
   * 让同一临界区内的判定看到它。`false` 是纯预览，同样的回执只读不写。
   */
  readonly recordEvidence: boolean
  readonly recordedAt?: string
}

/**
 * 本次进入该步骤之后已完成的技能 id：history 里的受理记录，加上宿主已完成、尚未落账的读取。
 * `recordEvidence` 决定后者是被写进 history（transition，持锁）还是只被预览（check / status）。
 */
export async function completedStepSkillIds(input: StepSkillGateInput): Promise<ReadonlySet<string>> {
  const { deps, changeDir: dir, stepId } = input
  const slots = resolveRequiredSkillSlots(deps.resolver, input.capability, stepId)
  const candidateSkillIds = slots.flatMap((slot) => slot.alternatives.map(canonicalPipelineSkillId))
  const hostConfirmed: string[] = []
  if (input.recordEvidence) {
    await reconcileCodexSkillEvidence({
      repoRoot: deps.cwd,
      changeDir: dir,
      candidateSkillIds,
      recordedAt: input.recordedAt ?? deps.clock(),
      history: deps.history,
      evidenceScope: stepId,
    })
  } else if (candidateSkillIds.length > 0) {
    // 预览路径只在真有候选时读回执；没有必需技能时这一步没有任何可判定的事实。
    hostConfirmed.push(...await discoverConfirmedCodexSkillIds({
      repoRoot: deps.cwd,
      changeDir: dir,
      candidateSkillIds,
      evidenceScope: stepId,
    }))
  }
  const completed = new Set(completedWorkflowSkillsSinceStepEntry(
    (await deps.readHistoryRaw?.(dir)) ?? '',
    stepId,
  ))
  for (const skillId of hostConfirmed) completed.add(canonicalPipelineSkillId(skillId))
  return completed
}

/** 未满足的必需技能槽，返回 manifest/step 里逐字的 token（`a|b` 保持原样）。 */
export function missingStepSkillTokensFrom(
  deps: CliDeps,
  capability: SkillCapability,
  stepId: string,
  completed: ReadonlySet<string>,
): readonly string[] {
  return resolveRequiredSkillSlots(deps.resolver, capability, stepId)
    .filter((slot) => !slot.alternatives.some((candidate) => completed.has(canonicalPipelineSkillId(candidate))))
    .map((slot) => slot.token)
}

export async function missingStepSkillTokens(input: StepSkillGateInput): Promise<readonly string[]> {
  return missingStepSkillTokensFrom(
    input.deps,
    input.capability,
    input.stepId,
    await completedStepSkillIds(input),
  )
}
