import { describe, expect, it } from 'vitest'
import { legacyPlanTrack } from './legacy-track-policy.js'

describe('legacyPlanTrack · 旧引擎计划的轨道策略位', () => {
  it('内建轨道取登记表删除前的旧值', () => {
    expect(legacyPlanTrack('pm', undefined)).toEqual({ coverageProfile: 'pm', automation: { eligible: true, autoEnqueueOnSpecComplete: true } })
    expect(legacyPlanTrack('frontend', undefined)).toEqual({ coverageProfile: 'frontend', automation: { eligible: true, autoEnqueueOnSpecComplete: false } })
    expect(legacyPlanTrack('backend', undefined)).toEqual({ coverageProfile: 'backend', automation: { eligible: true, autoEnqueueOnSpecComplete: false } })
    expect(legacyPlanTrack('chat', undefined).automation.eligible).toBe(true)
  })

  it('standard / simple / free 无 coverage、不可进 AFK', () => {
    for (const id of ['standard', 'simple', 'free']) {
      expect(legacyPlanTrack(id, undefined)).toEqual({ coverageProfile: 'none', automation: { eligible: false, autoEnqueueOnSpecComplete: false } })
    }
  })

  it('旧表不认识的轨道（只在工作流里声明过）缺省可进 AFK，其余位全关', () => {
    expect(legacyPlanTrack('mine', undefined)).toEqual({ coverageProfile: 'none', automation: { eligible: true, autoEnqueueOnSpecComplete: false } })
  })

  it('分支自己声明的 automation 优先于旧表，没声明的位仍取旧表', () => {
    expect(legacyPlanTrack('pm', { eligible: false, enqueueAfterSpec: false }).automation)
      .toEqual({ eligible: false, autoEnqueueOnSpecComplete: false })
    expect(legacyPlanTrack('backend', { eligible: true, enqueueAfterSpec: true }).automation)
      .toEqual({ eligible: true, autoEnqueueOnSpecComplete: true })
  })

  it('没有轨道语境（undefined / 空串）全关', () => {
    const closed = { coverageProfile: 'none', automation: { eligible: false, autoEnqueueOnSpecComplete: false } }
    expect(legacyPlanTrack(undefined, undefined)).toEqual(closed)
    expect(legacyPlanTrack('', { eligible: true, enqueueAfterSpec: true })).toEqual(closed)
  })

  it('原型链上的名字不会被当成已登记的轨道', () => {
    for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(legacyPlanTrack(id, undefined)).toEqual({ coverageProfile: 'none', automation: { eligible: true, autoEnqueueOnSpecComplete: false } })
    }
  })
})
