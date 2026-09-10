import { describe, expect, it } from 'vitest'
import type { WbWorkflowDef } from '../api/governanceTypes'
import { insertWaveBefore, placeSkillInWave, skillExecutionWaves, wavesOf, wavesToSkills } from '../workbench/skillWaves'
import { draftEffectiveIo, lintWorkflow } from './lint'
import { backEdgesFrom, linkedToNext, pipelineEdges } from './pipelineModel'
import { applyDrop } from './SkillDag'

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
  it('applyDrop：落列 / 落间隙 / 拖回本机面板移除 / 无目标不变', () => {
    const waves = [['s1'], ['s2']]
    expect(applyDrop(waves, 'pal:s9', 'wave:1')).toEqual([['s1'], ['s2', 's9']])
    expect(applyDrop(waves, 'skill:s2', 'gap:0')).toEqual([['s2'], ['s1']])
    expect(applyDrop(waves, 'skill:s2', 'palette')).toEqual([['s1']])
    expect(applyDrop(waves, 'pal:s9', 'palette')).toBeNull()
    expect(applyDrop(waves, 'skill:s2', null)).toBeNull()
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
})
