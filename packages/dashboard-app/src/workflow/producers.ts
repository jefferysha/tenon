import { skillsEquivalent } from '@tenon/kernel/workflow/orchestration'

export { skillsEquivalent }

function bareName(skill: string): string {
  const colon = skill.indexOf(':')
  return colon === -1 ? skill : skill.slice(colon + 1)
}

/** 展示：契约候选与阶段技能按裸名匹配，命中则只显命中的；无命中为空，不编造不在阶段里的技能。 */
export function producerSkills(candidates: readonly string[], stageSkills: readonly string[]): string[] {
  return stageSkills.filter((skill) => candidates.some((candidate) => bareName(candidate) === bareName(skill)))
}

/** 展示：互为别名的技能只留第一个（一词一概念），顺序保持。 */
export function distinctSkills(skills: readonly string[]): string[] {
  const kept: string[] = []
  for (const skill of skills) if (!kept.some((known) => skillsEquivalent(known, skill))) kept.push(skill)
  return kept
}
