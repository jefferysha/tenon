import { describe, expect, it } from 'vitest'
import { dependencyWaves, directDependencies } from './dag-waves.js'
import {
  effectiveSkillDependencies, minimalSkillDependencies, missingSkillDependencies, orderSkillSlots, skillSlotStatuses,
} from './skill-order.js'

const slot = (token: string) => ({ token, alternatives: token.split('|') })

describe('dependencyWaves / directDependencies', () => {
  it('wave = 1 + 前置最大 wave；图外前置不计；环不死循环', () => {
    const waves = dependencyWaves([
      { id: 'a', dependsOn: [] },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['a', 'b', 'ghost'] },
    ])
    expect([...waves.entries()]).toEqual([['a', 0], ['b', 1], ['c', 2]])
    const cyclic = dependencyWaves([{ id: 'x', dependsOn: ['y'] }, { id: 'y', dependsOn: ['x'] }])
    expect(cyclic.size).toBe(2)
  })
  it('传递约简：A→B→C 里 C 只留 B', () => {
    const direct = directDependencies([
      { id: 'a', dependsOn: [] },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['a', 'b'] },
    ])
    expect(direct.get('c')).toEqual(['b'])
    expect(direct.get('b')).toEqual(['a'])
  })
})

describe('orderSkillSlots', () => {
  it('全部未声明 depends_on → 按声明顺序串行（与 0.1.x runner 一致）', () => {
    const ordered = orderSkillSlots(['a', 'b', 'c', 'd'].map(slot), ['a', 'b', 'c', 'd'].map((id) => ({ id, dependsOn: [], dependsOnDeclared: false })))
    expect(ordered.map((item) => item.wave)).toEqual([0, 1, 2, 3])
    expect(ordered[3]?.dependsOn).toEqual(['a', 'b', 'c'])
    expect(ordered.every((item) => !item.declared)).toBe(true)
  })
  it('声明了 depends_on 的按声明成波：同波并行、跨波串行', () => {
    const ordered = orderSkillSlots(['a', 'b', 'c', 'd'].map(slot), [
      { id: 'a', dependsOn: [], dependsOnDeclared: false },
      { id: 'b', dependsOn: ['a'], dependsOnDeclared: true },
      { id: 'c', dependsOn: ['a'], dependsOnDeclared: true },
      { id: 'd', dependsOn: ['b', 'c'], dependsOnDeclared: true },
    ])
    expect(ordered.map((item) => item.wave)).toEqual([0, 1, 1, 2])
  })
  it('depends_on: [] = 与前面并行；未声明的仍接在前面全部之后', () => {
    const ordered = orderSkillSlots(['a', 'b', 'c'].map(slot), [
      { id: 'a', dependsOn: [], dependsOnDeclared: false },
      { id: 'b', dependsOn: [], dependsOnDeclared: true },
      { id: 'c', dependsOn: [], dependsOnDeclared: false },
    ])
    expect(ordered.map((item) => item.wave)).toEqual([0, 0, 1])
    expect(ordered[2]?.dependsOn).toEqual(['a', 'b'])
  })
  it('老计划对象缺 dependsOnDeclared：非空 = 声明，空 = 串行', () => {
    const ordered = orderSkillSlots(['a', 'b', 'c'].map(slot), [
      { id: 'a', dependsOn: [] },
      { id: 'b', dependsOn: [] },
      { id: 'c', dependsOn: ['a'] },
    ])
    expect(ordered.map((item) => item.wave)).toEqual([0, 1, 1])
  })
  it('不在声明里的槽位（manifest 叠加）串行接在后面；tenon: 前缀与 a|b 备选都能对上', () => {
    const ordered = orderSkillSlots([slot('tenon:a'), slot('b'), slot('x|y')], [
      { id: 'a', dependsOn: [], dependsOnDeclared: false },
      { id: 'b', dependsOn: ['tenon:a'], dependsOnDeclared: true },
    ])
    expect(ordered.map((item) => item.dependsOn)).toEqual([[], ['tenon:a'], ['tenon:a', 'b']])
    expect(ordered.map((item) => item.wave)).toEqual([0, 1, 2])
  })
  it('声明的前向依赖与声明顺序串行混用不成环', () => {
    const ordered = orderSkillSlots(['a', 'b'].map(slot), [
      { id: 'a', dependsOn: ['b'], dependsOnDeclared: true },
      { id: 'b', dependsOn: [], dependsOnDeclared: false },
    ])
    expect(ordered[1]?.dependsOn).toEqual([])
    expect(ordered.map((item) => item.wave)).toEqual([1, 0])
  })
})

describe('技能门与状态投影同一实现', () => {
  const ordered = orderSkillSlots(['a', 'b', 'c'].map(slot), [
    { id: 'a', dependsOn: [], dependsOnDeclared: false },
    { id: 'b', dependsOn: [], dependsOnDeclared: true },
    { id: 'c', dependsOn: ['a'], dependsOnDeclared: true },
  ])
  it('skillSlotStatuses：前置没齐 = waiting；已调用 = invoked；完成 = done；否则 ready', () => {
    expect(skillSlotStatuses(ordered, [
      { done: false, invoked: true },
      { done: false, invoked: false },
      { done: false, invoked: false },
    ])).toEqual(['invoked', 'ready', 'waiting'])
    expect(skillSlotStatuses(ordered, [
      { done: true, invoked: true },
      { done: false, invoked: false },
      { done: false, invoked: false },
    ])).toEqual(['done', 'ready', 'ready'])
  })
  it('missingSkillDependencies：只看本槽位的前置', () => {
    const done = new Set(['a'])
    expect(missingSkillDependencies(ordered, 2, (item) => done.has(item.token))).toEqual([])
    expect(missingSkillDependencies(ordered, 2, () => false)).toEqual(['a'])
    expect(missingSkillDependencies(ordered, 1, () => false)).toEqual([])
    expect(missingSkillDependencies(ordered, 9, () => false)).toEqual([])
  })
})

describe('effectiveSkillDependencies / minimalSkillDependencies', () => {
  it('未声明 = 前面全部，约简到直接前置', () => {
    expect(effectiveSkillDependencies([{ id: 'a' }, { id: 'b' }, { id: 'c' }]))
      .toEqual([{ id: 'a', dependsOn: [], wave: 0 }, { id: 'b', dependsOn: ['a'], wave: 1 }, { id: 'c', dependsOn: ['b'], wave: 2 }])
  })
  it('与「前面全部」等价的省掉 depends_on；并行根写 []；波内第二个写上一波', () => {
    expect(minimalSkillDependencies([
      { id: 'a', dependsOn: [] },
      { id: 'b', dependsOn: [] },
      { id: 'c', dependsOn: ['a', 'b'] },
      { id: 'd', dependsOn: ['a', 'b'] },
      { id: 'e', dependsOn: ['c', 'd'] },
    ])).toEqual([
      { id: 'a' },
      { id: 'b', depends_on: [] },
      { id: 'c' },
      { id: 'd', depends_on: ['a', 'b'] },
      { id: 'e' },
    ])
  })
  it('往返：最小声明再求实际前置，波次不变', () => {
    const explicit = [
      { id: 'a', dependsOn: [] },
      { id: 'b', dependsOn: [] },
      { id: 'c', dependsOn: ['a'] },
    ]
    const minimal = minimalSkillDependencies(explicit)
    expect(effectiveSkillDependencies(minimal).map((item) => item.wave)).toEqual([0, 0, 1])
  })
})
