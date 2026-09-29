import { describe, expect, it } from 'vitest'
import { emptyTestPlan, testPlanDigest, type TestPlan } from './plan.js'
import { approveWaivers, pendingWaivers, testPlanApprovalFreeDigest } from './plan-waivers.js'

const PLAN: TestPlan = {
  ...emptyTestPlan('demo'),
  suites: [{ suite: 'unit', scope: 'changed' }],
  waivers: [
    { kind: 'benchmark', reason: '纯文案改动', approved_by: null },
    { kind: 'a11y', reason: '无界面', approved_by: 'boss@x.io' },
    { covers: 'spec:auth/登录成功', reason: '由手工验收覆盖', approved_by: null },
  ],
}

describe('待批准豁免', () => {
  it('只列 approved_by 为空的，键与计划的 waiverKey 同口径', () => {
    expect(pendingWaivers(PLAN)).toEqual([
      { key: 'kind:benchmark', reason: '纯文案改动' },
      { key: 'covers:spec:auth/登录成功', reason: '由手工验收覆盖' },
    ])
    expect(pendingWaivers(emptyTestPlan('demo'))).toEqual([])
  })
})

describe('批准豁免', () => {
  it('只批准列出的那几条，写入批准人；其余原样', () => {
    const selection = [{ key: 'kind:benchmark', reason: '纯文案改动' }]
    const result = approveWaivers(PLAN, selection, 'reviewer@x.io')
    expect(result.approved).toEqual(['kind:benchmark'])
    expect(result.skipped).toEqual([])
    expect(result.plan.waivers.find((item) => item.kind === 'benchmark')?.approved_by).toBe('reviewer@x.io')
    expect(result.plan.waivers.find((item) => item.covers !== undefined)?.approved_by).toBeNull()
    expect(result.plan.waivers.find((item) => item.kind === 'a11y')?.approved_by).toBe('boss@x.io')
  })

  it('请求之后才出现的豁免、被改过理由的豁免、已批准的豁免都不在这次确认里', () => {
    const later: TestPlan = { ...PLAN, waivers: [...PLAN.waivers, { kind: 'visual', reason: '请求后才加', approved_by: null }] }
    const result = approveWaivers(later, [
      { key: 'kind:benchmark', reason: '理由被改成别的了' },
      { key: 'kind:a11y', reason: '无界面' },
      { key: 'kind:gone', reason: 'x' },
    ], 'reviewer@x.io')
    expect(result.approved).toEqual([])
    expect(result.skipped).toEqual([
      { key: 'kind:benchmark', why: 'reason-changed' },
      { key: 'kind:a11y', why: 'already-approved' },
      { key: 'kind:gone', why: 'missing' },
    ])
    expect(result.plan).toBe(later)
    expect(pendingWaivers(result.plan).map((item) => item.key)).toContain('kind:visual')
  })

  it('批准后没有别的变化：去批准位的摘要不变，含批准位的摘要变', () => {
    const before = testPlanApprovalFreeDigest(PLAN)
    const approved = approveWaivers(PLAN, pendingWaivers(PLAN), 'reviewer@x.io').plan
    expect(testPlanApprovalFreeDigest(approved)).toBe(before)
    expect(testPlanDigest(approved)).not.toBe(testPlanDigest(PLAN))
  })
})
