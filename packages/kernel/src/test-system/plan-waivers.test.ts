import { describe, expect, it } from 'vitest'
import { emptyTestPlan, testPlanDigest, type TestPlan } from './plan.js'
import { approveWaivers, pendingWaivers, testPlanApprovalFreeDigest, type StepTestFailures } from './plan-waivers.js'

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

  it('步骤测试豁免按 test:<id> 键列出与批准，同名的种类豁免不受影响', () => {
    const withTest: TestPlan = {
      ...PLAN,
      waivers: [
        ...PLAN.waivers,
        { test: 'code-size', reason: '迁移脚本一次性生成', approved_by: null },
        { kind: 'unit', reason: '无单测', approved_by: null },
        { test: 'unit', reason: '步骤测试同名', approved_by: null },
      ],
    }
    expect(pendingWaivers(withTest).map((item) => item.key)).toEqual([
      'kind:benchmark', 'covers:spec:auth/登录成功', 'test:code-size', 'kind:unit', 'test:unit',
    ])
    const result = approveWaivers(withTest, [{ key: 'test:code-size', reason: '迁移脚本一次性生成' }], 'reviewer@x.io')
    expect(result.approved).toEqual(['test:code-size'])
    expect(result.skipped).toEqual([])
    expect(result.plan.waivers.find((item) => item.test === 'code-size')?.approved_by).toBe('reviewer@x.io')
    expect(result.plan.waivers.find((item) => item.test === 'unit')?.approved_by).toBeNull()
    expect(result.plan.waivers.find((item) => item.kind === 'unit')?.approved_by).toBeNull()
    const changed = approveWaivers(withTest, [{ key: 'test:code-size', reason: '理由被改了' }], 'reviewer@x.io')
    expect(changed.approved).toEqual([])
    expect(changed.skipped).toEqual([{ key: 'test:code-size', why: 'reason-changed' }])
    expect(testPlanApprovalFreeDigest(result.plan)).toBe(testPlanApprovalFreeDigest(withTest))
  })

  it('批准后没有别的变化：去批准位的摘要不变，含批准位的摘要变', () => {
    const before = testPlanApprovalFreeDigest(PLAN)
    const approved = approveWaivers(PLAN, pendingWaivers(PLAN), 'reviewer@x.io').plan
    expect(testPlanApprovalFreeDigest(approved)).toBe(before)
    expect(testPlanDigest(approved)).not.toBe(testPlanDigest(PLAN))
  })
})

describe('步骤测试豁免的批准绑定被批准的代码候选', () => {
  const A = `workspace:sha256:${'a'.repeat(64)}`
  const B = `workspace:sha256:${'b'.repeat(64)}`
  const REASON = '迁移脚本一次性生成，规模超限属实'
  const planOf = (waiver: Partial<TestPlan['waivers'][number]> & { reason?: string }): TestPlan => ({
    ...emptyTestPlan('demo'),
    waivers: [{ test: 'size', reason: REASON, approved_by: null, ...waiver } as TestPlan['waivers'][number]],
  })
  const failure = (state: 'waived' | 'waiver-pending', candidate?: string): StepTestFailures => new Map([
    ['size', { state, ...(candidate === undefined ? {} : { candidate }) }],
  ])

  it('未批准的 test 豁免：待批准清单带上当前新鲜失败记录的候选；没有失败事实就不带', () => {
    expect(pendingWaivers(planOf({}), failure('waiver-pending', A))).toEqual([{ key: 'test:size', reason: REASON, candidate: A }])
    expect(pendingWaivers(planOf({}), failure('waiver-pending'))).toEqual([{ key: 'test:size', reason: REASON }])
    expect(pendingWaivers(planOf({}))).toEqual([{ key: 'test:size', reason: REASON }])
  })

  it('已批准但批准的候选不是当前失败的候选（waiver-pending）：再次列出并带上当前候选', () => {
    const stale = planOf({ approved_by: 'boss@x.io', approved_candidate: A })
    expect(pendingWaivers(stale, failure('waiver-pending', B))).toEqual([{ key: 'test:size', reason: REASON, candidate: B }])
  })

  it('旧版本留下、只有 approved_by 没有候选的批准：同样再次列出', () => {
    const legacy = planOf({ approved_by: 'boss@x.io' })
    expect(pendingWaivers(legacy, failure('waiver-pending', A))).toEqual([{ key: 'test:size', reason: REASON, candidate: A }])
  })

  it('批准的候选就是当前失败的候选（waived）、或当前没有这条失败：不再列出', () => {
    const approved = planOf({ approved_by: 'boss@x.io', approved_candidate: A })
    expect(pendingWaivers(approved, failure('waived', A))).toEqual([])
    expect(pendingWaivers(approved)).toEqual([])
    expect(pendingWaivers(planOf({ approved_by: 'boss@x.io' }))).toEqual([])
  })

  it('失败事实只对 test: 豁免有意义：同名的 kind 豁免、别的测试 id 的事实都不影响', () => {
    const mixed: TestPlan = { ...PLAN, waivers: [...PLAN.waivers, { test: 'other', reason: 'x', approved_by: null }] }
    expect(pendingWaivers(mixed, new Map([['size', { state: 'waiver-pending' as const, candidate: A }]]))).toEqual(pendingWaivers(mixed))
  })

  it('批准未批准的 test 豁免：approved_by 与冻结清单里的候选一起写入', () => {
    const result = approveWaivers(planOf({}), [{ key: 'test:size', reason: REASON, candidate: A }], 'reviewer@x.io')
    expect(result.approved).toEqual(['test:size'])
    expect(result.plan.waivers).toEqual([{ test: 'size', reason: REASON, approved_by: 'reviewer@x.io', approved_candidate: A }])
  })

  it('重新批准：批准的候选与清单里的不同、或旧批准没有候选，写入新批准人和新候选，不当作 already-approved', () => {
    for (const waiver of [{ approved_by: 'boss@x.io', approved_candidate: A }, { approved_by: 'boss@x.io' }]) {
      const result = approveWaivers(planOf(waiver), [{ key: 'test:size', reason: REASON, candidate: B }], 'reviewer@x.io')
      expect(result.approved, JSON.stringify(waiver)).toEqual(['test:size'])
      expect(result.skipped).toEqual([])
      expect(result.plan.waivers).toEqual([{ test: 'size', reason: REASON, approved_by: 'reviewer@x.io', approved_candidate: B }])
    }
  })

  it('已经批准过同一份候选、或清单没带候选的已批准豁免：already-approved，计划原样', () => {
    const approved = planOf({ approved_by: 'boss@x.io', approved_candidate: A })
    for (const selection of [{ key: 'test:size', reason: REASON, candidate: A }, { key: 'test:size', reason: REASON }]) {
      const result = approveWaivers(approved, [selection], 'reviewer@x.io')
      expect(result.approved).toEqual([])
      expect(result.skipped).toEqual([{ key: 'test:size', why: 'already-approved' }])
      expect(result.plan).toBe(approved)
    }
  })

  it('重新批准同样要求理由逐字相同', () => {
    const stale = planOf({ approved_by: 'boss@x.io', approved_candidate: A })
    const result = approveWaivers(stale, [{ key: 'test:size', reason: '理由被改了', candidate: B }], 'reviewer@x.io')
    expect(result.approved).toEqual([])
    expect(result.skipped).toEqual([{ key: 'test:size', why: 'reason-changed' }])
    expect(result.plan).toBe(stale)
  })

  it('候选只写给 test: 豁免：种类豁免的清单项带了候选也不写进计划', () => {
    const result = approveWaivers(PLAN, [{ key: 'kind:benchmark', reason: '纯文案改动', candidate: A }], 'reviewer@x.io')
    expect(result.approved).toEqual(['kind:benchmark'])
    const written = result.plan.waivers.find((item) => item.kind === 'benchmark')
    expect(written).toEqual({ kind: 'benchmark', reason: '纯文案改动', approved_by: 'reviewer@x.io' })
    expect(written).not.toHaveProperty('approved_candidate')
  })

  it('去批准位的摘要把 approved_by 与被批准的候选都视为空：批准（含重新批准）不让之前的运行过期', () => {
    const unapproved = planOf({})
    const approved = approveWaivers(unapproved, [{ key: 'test:size', reason: REASON, candidate: A }], 'reviewer@x.io').plan
    expect(testPlanDigest(approved)).not.toBe(testPlanDigest(unapproved))
    expect(testPlanApprovalFreeDigest(approved)).toBe(testPlanApprovalFreeDigest(unapproved))
    const again = approveWaivers(approved, [{ key: 'test:size', reason: REASON, candidate: B }], 'reviewer@x.io').plan
    expect(testPlanApprovalFreeDigest(again)).toBe(testPlanApprovalFreeDigest(unapproved))
  })
})
