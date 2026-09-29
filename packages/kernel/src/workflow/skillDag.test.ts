import { describe, expect, it } from 'vitest'
import { isSkillUnlocked } from './skillDag.js'
import type { SkillRef } from './types.js'

describe('isSkillUnlocked', () => {
  const skills: SkillRef[] = [
    { id: 'a' },
    { id: 'b', depends_on: [] },
    { id: 'c', depends_on: ['a', 'b'] },
    { id: 'd', depends_on: ['a'] },
  ]

  it('首个技能与声明了 depends_on: [] 的技能没有前置，永远解锁', () => {
    expect(isSkillUnlocked('a', skills, new Set())).toBe(true)
    expect(isSkillUnlocked('b', skills, new Set())).toBe(true)
  })

  it('有依赖但未全部完成 → 锁定', () => {
    expect(isSkillUnlocked('c', skills, new Set(['a']))).toBe(false)
  })

  it('依赖全部完成 → 解锁', () => {
    expect(isSkillUnlocked('c', skills, new Set(['a', 'b']))).toBe(true)
  })

  it('交叉依赖场景：d 只依赖 a，不需要等 b（验证不会被过度串行化）', () => {
    expect(isSkillUnlocked('d', skills, new Set(['a']))).toBe(true)
  })

  it('没写 depends_on 的技能按声明顺序串行：前面的全部完成才解锁', () => {
    const serial: SkillRef[] = [{ id: 'x' }, { id: 'y' }, { id: 'z' }]
    expect(isSkillUnlocked('y', serial, new Set())).toBe(false)
    expect(isSkillUnlocked('z', serial, new Set(['y']))).toBe(false)
    expect(isSkillUnlocked('z', serial, new Set(['x', 'y']))).toBe(true)
  })

  it('不在声明列表里的 skill 锁定', () => {
    expect(isSkillUnlocked('ghost', skills, new Set(['a', 'b', 'c', 'd']))).toBe(false)
  })

  it('skills 为空数组（step 未声明任何 skill）→ 视为不使用 DAG 能力，任意 skillId 都解锁（同 guards: []/transitions: [] 的"空数组=不受约束"惯例）', () => {
    expect(isSkillUnlocked('anything', [], new Set())).toBe(true)
    expect(isSkillUnlocked('anything', [], new Set(['x', 'y']))).toBe(true)
  })
})
