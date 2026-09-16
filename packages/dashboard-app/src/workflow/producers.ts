import { aliasesForSkill } from '@tenon/kernel/workflow/document-contract-validation'

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
