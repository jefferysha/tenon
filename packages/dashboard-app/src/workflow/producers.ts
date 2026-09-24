import { TENON_PRODUCER, aliasesForSkill } from '@tenon/kernel/workflow/document-contract-validation'
import type { WbIoSlot } from '../api/governanceTypes'

function bareName(skill: string): string {
  const colon = skill.indexOf(':')
  return colon === -1 ? skill : skill.slice(colon + 1)
}

/** 展示：契约候选与阶段技能按裸名匹配，命中则只显命中的；无命中为空，不编造不在阶段里的技能。 */
export function producerSkills(candidates: readonly string[], stageSkills: readonly string[]): string[] {
  return stageSkills.filter((skill) => candidates.some((candidate) => bareName(candidate) === bareName(skill)))
}

/** 校验：与 kernel 同一套技能别名（tenon: / superpowers: 前缀、opsx 别名）。 */
export function skillsEquivalent(left: string, right: string): boolean {
  const aliases = new Set(aliasesForSkill(left))
  return aliasesForSkill(right).some((alias) => aliases.has(alias))
}

/** 展示：互为别名的技能只留第一个（一词一概念），顺序保持。 */
export function distinctSkills(skills: readonly string[]): string[] {
  const kept: string[] = []
  for (const skill of skills) if (!kept.some((known) => skillsEquivalent(known, skill))) kept.push(skill)
  return kept
}

/**
 * OpenSpec 注入的技能：本阶段文档契约里 role produce 槽位点名的产出技能——运行时按同一份契约要求它登记产物
 * （kernel materializeWorkflowIo 的 producers，documentKindsProducedBySkillAtPolicyStep 据此绑定）。每个槽位的
 * 候选互为别名（openspec-propose ≡ opsx:propose），取第一个；阶段已声明其中任一个、或候选只有编排器 `tenon`
 * 时不算注入。
 */
export function openspecSkills(outputs: readonly WbIoSlot[], stageSkills: readonly string[]): string[] {
  const injected: string[] = []
  for (const slot of outputs) {
    if (slot.kind !== 'document' || slot.role !== 'produce') continue
    const candidates = slot.producers.filter((candidate) => !aliasesForSkill(candidate).includes(TENON_PRODUCER))
    const first = candidates[0]
    if (first === undefined) continue
    const known = [...stageSkills, ...injected]
    if (candidates.some((candidate) => known.some((skill) => skillsEquivalent(skill, candidate)))) continue
    injected.push(first)
  }
  return injected
}
