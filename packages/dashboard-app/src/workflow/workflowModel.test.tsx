import { describe, expect, it } from 'vitest'
import type { WbWorkflowDef } from '../api/governanceTypes'
import { insertWaveBefore, placeSkillInWave, skillExecutionWaves, wavesOf, wavesToSkills } from '../workbench/skillWaves'
import { draftEffectiveIo, lintWorkflow } from './lint'
import { backEdgesFrom, linkedToNext, pipelineEdges } from './pipelineModel'

const DEF: WbWorkflowDef = {
  name: 'flow',
  steps: [
    { id: 'a', label: 'A', gate: null, skills: [], inputs: [], outputs: [{ field: 'design_doc', type: 'file_path' }], guards: [], transitions: [{ event: 'a-done', to: 'b' }] },
    { id: 'b', label: 'B', gate: 'review', skills: [], inputs: [{ field: 'design_doc', type: 'file_path' }], outputs: [{ field: 'build_sha', type: 'string' }], guards: [], transitions: [{ event: 'b-done', to: 'c' }, { event: 'b-back', to: 'a' }] },
    { id: 'c', label: 'C', gate: null, skills: [], inputs: [{ field: 'plan', type: 'file_path' }], outputs: [], guards: [], transitions: [] },
  ],
}

describe('skillWaves · 列模型往返', () => {
  it('wavesToSkills 与 wavesOf 互逆', () => {
    const waves = [['s1', 's2'], ['s3'], ['s4', 's5']]
    const skills = wavesToSkills(waves, [{ id: 's3', kind: 'review', review_lane: 'e2e' }])
    expect(skills.find((skill) => skill.id === 's3')).toEqual({ id: 's3', kind: 'review', review_lane: 'e2e', depends_on: ['s1', 's2'] })
    expect(wavesOf(skills)).toEqual(waves)
    expect(skillExecutionWaves(['x'], {})).toEqual([['x']])
  })
  it('placeSkillInWave 移入某列 / 新首列 / 新末列；insertWaveBefore 插新列；空列被清掉', () => {
    const waves = [['s1'], ['s2', 's3']]
    expect(placeSkillInWave(waves, 's1', 1)).toEqual([['s2', 's3', 's1']])
    expect(placeSkillInWave(waves, 's3', -1)).toEqual([['s3'], ['s1'], ['s2']])
    expect(placeSkillInWave(waves, 'new', 2)).toEqual([['s1'], ['s2', 's3'], ['new']])
    expect(insertWaveBefore(waves, 's3', 1)).toEqual([['s1'], ['s3'], ['s2']])
  })
})

describe('pipelineModel', () => {
  it('前向边连线、回流边单列', () => {
    const edges = pipelineEdges(DEF.steps)
    expect(edges.forward.map((edge) => `${edge.from}>${edge.to}`)).toEqual(['a>b', 'b>c'])
    expect(backEdgesFrom(edges, 'b')).toEqual([{ from: 'b', to: 'a', event: 'b-back' }])
    expect(linkedToNext(edges, 'a', 'b')).toBe(true)
    expect(linkedToNext(edges, 'c', undefined)).toBe(false)
  })
})

describe('lint / draftEffectiveIo / slotCatalog', () => {
  const io = draftEffectiveIo(DEF, undefined)
  it('草稿物化 IO：字段生产者 / 消费者按阶段序推导', () => {
    expect(io.a?.outputs).toEqual([{ kind: 'field', id: 'design_doc', type: 'file_path', producer: null, consumers: ['b'] }])
    expect(io.b?.inputs).toEqual([{ kind: 'field', id: 'design_doc', type: 'file_path', producer: 'a', consumers: [] }])
  })
  it('lint：无输出阶段 + 无上游的输入', () => {
    expect(lintWorkflow(DEF, io)).toEqual([
      { kind: 'step-no-output', stepId: 'c' },
      { kind: 'input-not-upstream', stepId: 'c', field: 'plan' },
    ])
  })
  it('lint 转移：事件名为空 / 本阶段内重名', () => {
    const def: WbWorkflowDef = {
      ...DEF,
      steps: DEF.steps.map((step) => step.id !== 'a' ? step : {
        ...step,
        transitions: [{ event: '', to: 'b' }, { event: 'dup', to: 'b' }, { event: 'dup', to: 'c' }],
      }),
    }
    const issues = lintWorkflow(def, draftEffectiveIo(def, undefined))
    expect(issues).toContainEqual({ kind: 'transition-empty-event', stepId: 'a' })
    expect(issues).toContainEqual({ kind: 'transition-duplicate-event', stepId: 'a', event: 'dup' })
  })
  it('lint 转移：受治理工作流缺必需去向才报，未受治理不报', () => {
    const steps = ['open', 'explore', 'spec', 'build', 'verify', 'ship', 'archive'].map((id, index, all) => ({
      id, label: id, gate: null, skills: [], inputs: [], outputs: [{ field: `${id}_out`, type: 'string' as const }], guards: [],
      transitions: all[index + 1] ? [{ event: `${id}-done`, to: all[index + 1]! }] : [],
    }))
    // 线性七阶段：缺两条回流 build→spec 与 verify→build。
    const governed: WbWorkflowDef = { name: 'default', steps }
    const issues = lintWorkflow(governed, draftEffectiveIo(governed, undefined))
    expect(issues).toContainEqual({ kind: 'transition-contract-required', stepId: 'build', to: 'spec' })
    expect(issues).toContainEqual({ kind: 'transition-contract-required', stepId: 'verify', to: 'build' })
    // 同样的形状换个名字、不带契约 → 不管
    const free: WbWorkflowDef = { name: 'mine', steps }
    expect(lintWorkflow(free, draftEffectiveIo(free, undefined)).filter((issue) => issue.kind === 'transition-contract-required')).toEqual([])
  })
})
