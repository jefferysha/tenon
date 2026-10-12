import { describe, expect, it } from 'vitest'
import { documentGovernancePolicy, documentKindsProducedBySkillAtPolicyStep } from './document-contract.js'
import { UnknownTrackError } from './resolve-track.js'
import type { StepDef, WorkflowDocumentContractV1 } from './types.js'

const step = (id: string): StepDef => ({ id, label: id, gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] })

const CONTRACT: WorkflowDocumentContractV1 = {
  version: 'v1',
  slots: [
    { kind: 'tasks', ownerStep: 'shape', producers: ['openspec-propose'] },
    { kind: 'tasks', ownerStep: 'build', role: 'update', producers: ['tenon'] },
    { kind: 'design-md', ownerStep: 'build', role: 'require', producers: [] },
  ],
  reads: [{ step: 'build', kinds: ['tasks'] }],
}

describe('documentGovernancePolicy', () => {
  it('没有 openspec: true 就不受治理（即便声明了契约）', () => {
    expect(documentGovernancePolicy('custom', { documentContract: CONTRACT, steps: [step('shape'), step('build')] })).toBeUndefined()
  })

  it('role 分表：produce → outputsByStep，update → mutableByStep，require → requiresByStep；每个 step 都有条目', () => {
    const policy = documentGovernancePolicy('custom', { openspec: true, documentContract: CONTRACT, steps: [step('shape'), step('build'), step('done')] })
    expect(policy).toEqual({
      id: 'document-v1',
      steps: ['shape', 'build', 'done'],
      outputsByStep: { shape: [{ kind: 'tasks', producerCandidates: ['openspec-propose'] }], build: [], done: [] },
      mutableByStep: { shape: [], build: [{ kind: 'tasks', producerCandidates: ['tenon'] }], done: [] },
      readsByStep: { shape: [], build: ['tasks'], done: [] },
      requiresByStep: { shape: [], build: ['design-md'], done: [] },
    })
  })

  it('没有 require slot 时省略 requiresByStep；openspec 开启但无契约 = 受治理且无文档', () => {
    const noRequire = { ...CONTRACT, slots: CONTRACT.slots.filter((slot) => slot.role !== 'require') }
    expect(documentGovernancePolicy('custom', { openspec: true, documentContract: noRequire, steps: [step('shape'), step('build')] }))
      .not.toHaveProperty('requiresByStep')
    expect(documentGovernancePolicy('custom', { openspec: true, steps: [step('shape')] })).toEqual({
      id: 'document-v1', steps: ['shape'], outputsByStep: { shape: [] }, mutableByStep: { shape: [] }, readsByStep: { shape: [] },
    })
  })

  it('按轨道选分支契约：给 track 取该分支；不给或没有的分支抛 UnknownTrackError，不取第一条', () => {
    const workflow = {
      openspec: true,
      steps: [],
      tracks: {
        web: { documentContract: CONTRACT, steps: [step('shape'), step('build')] },
        api: { steps: [step('shape'), step('build')] },
      },
    }
    expect(documentGovernancePolicy('custom', workflow, 'web')?.requiresByStep?.build).toEqual(['design-md'])
    expect(documentGovernancePolicy('custom', workflow, 'api')?.outputsByStep).toEqual({ shape: [], build: [] })
    expect(() => documentGovernancePolicy('custom', workflow)).toThrow(UnknownTrackError)
    expect(() => documentGovernancePolicy('custom', workflow, 'mobile')).toThrow(/没有轨道 'mobile'.*web, api/u)
  })

  it('受不受治理读分支的 spec：分支写了 none 就不受治理，写了 openspec 就受治理，没写继承顶层', () => {
    const tracks = {
      lite: { spec: 'none' as const, steps: [step('open'), step('build')] },
      full: { spec: 'openspec' as const, documentContract: CONTRACT, steps: [step('shape'), step('build')] },
      plain: { steps: [step('shape'), step('build')] },
    }
    expect(documentGovernancePolicy('custom', { openspec: true, steps: [], tracks }, 'lite')).toBeUndefined()
    expect(documentGovernancePolicy('custom', { openspec: true, steps: [], tracks }, 'plain')?.id).toBe('document-v1')
    expect(documentGovernancePolicy('custom', { steps: [], tracks }, 'full')?.requiresByStep?.build).toEqual(['design-md'])
    expect(documentGovernancePolicy('custom', { steps: [], tracks }, 'plain')).toBeUndefined()
  })

  it('平铺工作流只有一条隐式分支，任务记着什么轨道都不影响治理', () => {
    const flat = { openspec: true, documentContract: CONTRACT, steps: [step('shape'), step('build')] }
    expect(documentGovernancePolicy('custom', flat, 'free')?.requiresByStep?.build).toEqual(['design-md'])
    expect(documentGovernancePolicy('custom', flat, '')?.requiresByStep?.build).toEqual(['design-md'])
  })
})

describe('documentKindsProducedBySkillAtPolicyStep', () => {
  const BINDING: WorkflowDocumentContractV1 = {
    version: 'v1',
    slots: [
      { kind: 'superpower-design', ownerStep: 'shape', producers: ['brainstorming', 'superpowers:brainstorming'] },
      { kind: 'adr', ownerStep: 'shape', producers: ['brainstorming'] },
      { kind: 'proposal', ownerStep: 'shape', role: 'update', producers: ['brainstorming'] },
      { kind: 'tasks', ownerStep: 'build', role: 'update', producers: ['tenon'] },
      { kind: 'plan', ownerStep: 'build', producers: ['opsx:propose'] },
    ],
    reads: [],
  }
  const policy = documentGovernancePolicy('custom', {
    openspec: true, documentContract: BINDING, steps: [step('shape'), step('build')],
  })!

  it('只取本步 role produce 槽里点名该技能的 kind；update 槽是「可以改」，不绑定', () => {
    expect(documentKindsProducedBySkillAtPolicyStep(policy, 'shape', 'brainstorming')).toEqual(['superpower-design', 'adr'])
    expect(documentKindsProducedBySkillAtPolicyStep(policy, 'build', 'brainstorming')).toEqual([])
  })

  it('技能 id 按别名等价：命名空间前缀与 opsx 别名都认', () => {
    expect(documentKindsProducedBySkillAtPolicyStep(policy, 'shape', 'superpowers:brainstorming')).toEqual(['superpower-design', 'adr'])
    expect(documentKindsProducedBySkillAtPolicyStep(policy, 'shape', 'tenon:brainstorming')).toEqual(['superpower-design', 'adr'])
    expect(documentKindsProducedBySkillAtPolicyStep(policy, 'build', 'openspec-propose')).toEqual(['plan'])
  })

  it('本步没有它的产出槽、或步骤不在契约里 = 空表（仅凭调用即完成）', () => {
    expect(documentKindsProducedBySkillAtPolicyStep(policy, 'shape', 'grilling')).toEqual([])
    expect(documentKindsProducedBySkillAtPolicyStep(policy, 'nowhere', 'brainstorming')).toEqual([])
  })
})
