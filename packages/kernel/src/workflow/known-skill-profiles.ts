/**
 * loop 的 `skill_bundle_id` 存在性校验与技能动作授权认得的 skill profile 集合：随插件发布的 default 工作流的
 * 轨道 id（它们就是 profile 名）∪ manifest 两张技能表已声明的非 `_all` 键。轨道只是工作流分支，没有登记表可查。
 */
import type { ExtendedManifestData } from '../flow/manifest.js'
import { listTracks } from './resolve-track.js'
import { templateWorkflowDefinition } from './template-workflows.js'

export function knownSkillProfiles(
  manifest: Pick<ExtendedManifestData, 'mandatorySkills' | 'recommendedSkills'>,
): ReadonlySet<string> {
  const profiles = new Set<string>()
  const shippedDefault = templateWorkflowDefinition('default')
  for (const branch of shippedDefault === undefined ? [] : listTracks(shippedDefault)) profiles.add(branch.id)
  for (const table of [manifest.mandatorySkills, manifest.recommendedSkills]) {
    for (const row of Object.values(table)) {
      for (const key of Object.keys(row)) if (key !== '_all') profiles.add(key)
    }
  }
  return profiles
}
