import { skillActionAuthorityContract, type SkillActionAuthorityResolver } from '@tenon/automation'
import type { ExtendedManifestData } from '@tenon/kernel'

/**
 * Adapts the manifest's explicit closed grants to exact WorkflowRun-bound Skill contracts.
 * 授权不分 profile：只认清单里 `_all` 那一条，对所有已知 skill profile 一视同仁（未知 profile 失败关闭）。
 */
export function createManifestSkillActionAuthorityResolver(
  manifest: Pick<ExtendedManifestData, 'skillActionAuthority'>,
  isKnownProfile: (profile: string) => boolean,
): SkillActionAuthorityResolver {
  return async (query) => {
    const authority = manifest.skillActionAuthority
    const known = query.skillBundleId === '_all' || isKnownProfile(query.skillBundleId)
    if (!authority || !known) return undefined
    const grants = authority.grants._all
    return grants ? skillActionAuthorityContract(query, grants) : undefined
  }
}
