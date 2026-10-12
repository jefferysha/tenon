import { knownSkillProfiles, type ExtendedManifestData } from '@tenon/kernel'

/**
 * 「这个 skill profile 是否存在」的判定函数（loop 的 `skill_bundle_id` 校验与技能动作授权共用）。
 * 集合口径见 kernel 的 `knownSkillProfiles`；首次提问才派生，多数命令不会走到 profile 校验，不为它付启动成本。
 */
export function skillProfileChecker(
  manifest: Pick<ExtendedManifestData, 'mandatorySkills' | 'recommendedSkills'>,
): (profileId: string) => boolean {
  let known: ReadonlySet<string> | undefined
  return (profileId) => (known ??= knownSkillProfiles(manifest)).has(profileId)
}
