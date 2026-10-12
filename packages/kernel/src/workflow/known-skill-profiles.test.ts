import { describe, expect, it } from 'vitest'
import type { ExtendedManifestData } from '../flow/manifest.js'
import { knownSkillProfiles } from './known-skill-profiles.js'
import { listTracks } from './resolve-track.js'
import { templateWorkflowDefinition } from './template-workflows.js'

type SkillTables = Pick<ExtendedManifestData, 'mandatorySkills' | 'recommendedSkills'>

function tables(mandatory: Record<string, Record<string, string[]>>, recommended: Record<string, Record<string, string[]>>): SkillTables {
  return { mandatorySkills: mandatory, recommendedSkills: recommended } as unknown as SkillTables
}

describe('knownSkillProfiles', () => {
  it('随插件发布的 default 工作流的每条轨道 id 都是已知 profile', () => {
    const shipped = templateWorkflowDefinition('default')
    if (shipped === undefined) throw new Error('default 模板缺失')
    const known = knownSkillProfiles(tables({}, {}))
    const trackIds = listTracks(shipped).map((branch) => branch.id)
    expect(trackIds.length).toBeGreaterThan(0)
    for (const id of trackIds) expect(known.has(id)).toBe(true)
  })

  it('并入 manifest 两张技能表里声明的非 _all 键，_all 本身不算 profile', () => {
    const known = knownSkillProfiles(tables(
      { build: { _all: ['a'], 'custom-one': ['b'] } },
      { verify: { 'custom-two': ['c'], _all: ['d'] } },
    ))
    expect(known.has('custom-one')).toBe(true)
    expect(known.has('custom-two')).toBe(true)
    expect(known.has('_all')).toBe(false)
  })

  it('没有登记表可查：manifest 和 default 都没声明的 id 不是已知 profile', () => {
    expect(knownSkillProfiles(tables({}, {})).has('never-declared')).toBe(false)
  })
})
