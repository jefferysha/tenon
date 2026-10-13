import { describe, expect, it } from 'vitest'
import { DEFAULT_WORKFLOW_SOURCE } from './default-workflow.generated.js'
import { documentGovernancePolicy } from './document-contract.js'
import { documentGovernanceFingerprint } from './effective-plan.js'
import { LEGACY_DOCUMENT_GOVERNANCE_POLICY as LEGACY } from './migrations/openspec-v1-document-policy.js'
import { parseWorkflow } from './parse.js'
import { legacyContractDefaultDefinition } from './test-support.js'
import { validateWorkflowForStorage } from './validate.js'

/**
 * 测旧契约本身：升级前创建的在途任务冻结的是带 `document_contract` 的 default，它们靠冻结快照继续走。
 * 当前模板已删掉契约，所以这里读升级前的原文夹具（tools/fixtures/legacy-default-workflow.yaml，`parseWorkflow` 不校验）。
 */
describe('升级前的 default 按轨道声明 openspec-v1 文档表（供在途任务使用）', () => {
  const def = legacyContractDefaultDefinition()

  it('openspec: true；前端以外的分支指纹与迁移表相同，每步 produce / update / reads 顺序与旧表一致', () => {
    expect(def.openspec).toBe(true)
    expect(Object.keys(def.tracks ?? {})).toEqual(['lite', 'pm', 'frontend', 'backend'])
    // lite 是 spec: none 的分支，没有文档表。
    expect(documentGovernancePolicy('default', def, 'lite')).toBeUndefined()
    // 前端分支加了 DESIGN.md 槽位（立项要求 + 实现/验证必读 + 交付可更新），因此它的表与旧表有意不同；
    // 其余两条重型分支仍逐字节复刻迁移表，冻结的老快照照常绑定。
    for (const track of ['pm', 'backend']) {
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

  it('前端分支：立项 / 实现 / 验证要求项目 DESIGN.md，交付可更新它，其余与旧表一致', () => {
    const policy = documentGovernancePolicy('default', def, 'frontend')
    if (policy === undefined) throw new Error('default 前端分支未受治理')
    expect(policy.requiresByStep).toEqual({
      open: ['design-md'], explore: [], spec: [], build: ['design-md'], verify: ['design-md'], ship: [], archive: [],
    })
    expect(policy.mutableByStep.ship).toEqual([
      ...(LEGACY.mutableByStep.ship ?? []),
      { kind: 'design-md', producerCandidates: ['hue'] },
    ])
    for (const step of LEGACY.steps) {
      expect(policy.outputsByStep[step]).toEqual(LEGACY.outputsByStep[step])
      expect(policy.readsByStep[step]).toEqual(LEGACY.readsByStep[step])
      if (step !== 'ship') expect(policy.mutableByStep[step]).toEqual(LEGACY.mutableByStep[step])
    }
  })

  it('同一定义换名即 document-v1；最后一步标签是完结', () => {
    expect(documentGovernancePolicy('copy', def, 'frontend')?.id).toBe('document-v1')
    for (const track of ['pm', 'frontend', 'backend']) {
      expect(def.tracks?.[track]?.steps.at(-1)?.label).toBe('完结')
    }
  })
})

describe('当前 default 不带文档契约', () => {
  const current = parseWorkflow(DEFAULT_WORKFLOW_SOURCE)

  it('任何分支都没有策略：新任务走观察模式', () => {
    for (const track of ['lite', 'pm', 'frontend', 'backend']) {
      expect(documentGovernancePolicy('default', current, track), track).toBeUndefined()
    }
  })

  it('存储键 default 必须保持 openspec: true（E5）', () => {
    expect(current.openspec).toBe(true)
    const { openspec: _openspec, ...off } = current
    expect(validateWorkflowForStorage('default', off)).toContain('default 必须保持 openspec: true')
  })
})
