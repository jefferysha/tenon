import { orderSkillSlots } from './skill-order.js'
import type { SkillRef } from './types.js'

/**
 * 判定 skillId 在当前 step 的 skill DAG 下是否解锁。这是自定义 workflow 消费方（cli
 * transition / internal-skill-gate，Task 8/9）唯一的权威判定入口——调用方不应该在自己那
 * 一层重新实现任何一条这里的语义分支，否则同一份契约会在多处漂移、彼此不一致。
 *
 * 契约（三条）：
 * 1. skills 为空数组（step 完全未声明任何 skill）→ 视为该 step 不使用 DAG 这个能力
 *    （opt-in 语义），不对任何 skillId 设限，一律解锁。这与本 schema 里 `guards: []` /
 *    最后一个 step `transitions: []` 的"空数组=不受约束"惯例保持一致——那两处是空数组
 *    天然不产生任何约束（for 循环体不执行），这里则需要显式短路，因为下面 `!ref → false`
 *    这条分支单独存在时，"未声明"和"声明了但不在允许列表里"会被合并成同一种"锁定"结果，
 *    而空数组场景必须区别对待。
 * 2. skills 非空时，"未声明的 skillId"（不在列表里）与"前置未完成"都判定为锁定——
 *    此时 skills 是一份主动声明的 allowlist，不在表里就是不允许，这条不受上面第 1 条影响。
 * 3. 前置取 skill-order 的唯一口径：写了 depends_on 的按声明；没写的按声明顺序串行（前面的全部）。
 *    `tenon status` 的 step.skills 与 Dashboard 画布读的是同一份排序。
 */
export function isSkillUnlocked(
  skillId: string,
  skills: readonly SkillRef[],
  completedSinceStepEntry: ReadonlySet<string>,
): boolean {
  if (skills.length === 0) return true
  const ordered = orderSkillSlots(
    skills.map((skill) => ({ token: skill.id, alternatives: [skill.id] })),
    skills.map((skill) => ({ id: skill.id, dependsOn: skill.depends_on ?? [], dependsOnDeclared: skill.depends_on !== undefined })),
  )
  const slot = ordered.find((candidate) => candidate.token === skillId)
  if (!slot) return false
  return slot.dependsOn.every((dependency) => completedSinceStepEntry.has(dependency))
}
