import { describe, expect, it } from 'vitest'
import { DEFAULT_WORKFLOW_SOURCE } from './default-workflow.generated.js'
import { documentGovernancePolicy } from './document-contract.js'
import { documentGovernanceFingerprint } from './effective-plan.js'
import { LEGACY_DOCUMENT_GOVERNANCE_POLICY as LEGACY } from './migrations/openspec-v1-document-policy.js'
import { parseWorkflow } from './parse.js'
import { validateWorkflowForStorage } from './validate.js'

describe('default 按轨道声明 openspec-v1 文档表', () => {
  const def = parseWorkflow(DEFAULT_WORKFLOW_SOURCE)

  it('openspec: true；每条分支的 policy 指纹与迁移表相同，每步 produce / update / reads 顺序与旧表一致', () => {
    expect(def.openspec).toBe(true)
    expect(Object.keys(def.tracks ?? {})).toEqual(['chat', 'pm', 'frontend', 'backend', 'free'])
    for (const track of Object.keys(def.tracks ?? {})) {
      const policy = documentGovernancePolicy('default', def, track)
      if (policy === undefined) throw new Error(`default 分支 ${track} 未受治理`)
      expect(policy.id).toBe('openspec-v1')
      expect(documentGovernanceFingerprint(policy)).toBe(documentGovernanceFingerprint(LEGACY))
      expect(policy.steps).toEqual([...LEGACY.steps])
      for (const step of LEGACY.steps) {
        expect(policy.outputsByStep[step]).toEqual(LEGACY.outputsByStep[step])
        expect(policy.mutableByStep[step]).toEqual(LEGACY.mutableByStep[step])
        expect(policy.readsByStep[step]).toEqual(LEGACY.readsByStep[step])
      }
      expect(policy).not.toHaveProperty('requiresByStep')
    }
  })

  it('同一定义换名即 document-v1；存储键 default 必须保持 openspec: true（E5），最后一步标签是完结', () => {
    expect(documentGovernancePolicy('copy', def, 'frontend')?.id).toBe('document-v1')
    const { openspec: _openspec, ...off } = def
    expect(validateWorkflowForStorage('default', off)).toContain('default 必须保持 openspec: true')
    for (const branch of Object.values(def.tracks ?? {})) {
      expect(branch.steps.at(-1)?.label).toBe('完结')
    }
  })
})
