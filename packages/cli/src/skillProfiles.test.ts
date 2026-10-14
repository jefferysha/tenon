import { describe, expect, it } from 'vitest'
import type { ExtendedManifestData } from '@tenon/kernel'
import { skillProfileChecker } from './skillProfiles.js'

type SkillTables = Pick<ExtendedManifestData, 'mandatorySkills' | 'recommendedSkills'>

describe('skillProfileChecker', () => {
  it('认得 default 工作流的轨道和 manifest 技能表里声明的 profile，其余一律不认', () => {
    const known = skillProfileChecker({
      mandatorySkills: { build: { 'custom-one': ['a'] } },
      recommendedSkills: {},
    } as unknown as SkillTables)
    expect(known('pm')).toBe(true)
    expect(known('custom-one')).toBe(true)
    expect(known('never-declared')).toBe(false)
  })

  it('首次提问才读 manifest 派生集合，之后复用同一份（多数命令不会走到 profile 校验）', () => {
    let reads = 0
    const manifest = {
      get mandatorySkills() { reads += 1; return {} },
      get recommendedSkills() { return {} },
    } as unknown as SkillTables
    const known = skillProfileChecker(manifest)
    expect(reads).toBe(0)
    known('pm')
    known('backend')
    known('never-declared')
    expect(reads).toBe(1)
  })
})
