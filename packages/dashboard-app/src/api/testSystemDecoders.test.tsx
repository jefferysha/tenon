import { describe, expect, it } from 'vitest'
import { decodePlanBrief, decodePolicyReports } from './testPolicyDecoders'
import {
  decodeBaselinesResponse, decodeCatalogResponse, decodePlanResponse, decodeRecordListResponse, decodeRecordResponse,
} from './testSystemDecoders'
import {
  baselinesResponse, catalogResponse, planBrief, planView, recordDetail, recordList, verifyReport,
} from './testSystemFixtures'

/** 深拷贝后改一处，返回被改的整份（用来证明「哪一处不合形状都被拒」）。 */
function mutate<T>(value: T, edit: (draft: Record<string, unknown>) => void): unknown {
  const draft = JSON.parse(JSON.stringify(value)) as Record<string, unknown>
  edit(draft)
  return draft
}

describe('decodeCatalogResponse', () => {
  it('线上形状原样解出（往返相等）', () => {
    const wire = JSON.parse(JSON.stringify(catalogResponse())) as unknown
    expect(decodeCatalogResponse(wire)).toEqual(catalogResponse())
  })

  it('missing / invalid 目录与已知失败各自成状态', () => {
    expect(decodeCatalogResponse({ catalog: { state: 'missing' }, knownFailures: { state: 'missing' }, latest: [] }))
      .toEqual({ catalog: { state: 'missing' }, knownFailures: { state: 'missing' }, latest: [] })
    const invalid = decodeCatalogResponse({
      catalog: { state: 'invalid', issues: ['catalog.yaml:3: bad'] }, knownFailures: { state: 'invalid', issues: ['x'] }, latest: [],
    })
    expect(invalid?.catalog).toEqual({ state: 'invalid', issues: ['catalog.yaml:3: bad'] })
    expect(invalid?.knownFailures).toEqual({ state: 'invalid', issues: ['x'] })
  })

  it('形状不合一律 null：未知状态、缺键、类型错、计数为负', () => {
    const wire = catalogResponse()
    expect(decodeCatalogResponse(null)).toBeNull()
    expect(decodeCatalogResponse({})).toBeNull()
    expect(decodeCatalogResponse(mutate(wire, (d) => { (d.catalog as Record<string, unknown>).state = 'odd' }))).toBeNull()
    expect(decodeCatalogResponse(mutate(wire, (d) => { delete ((d.catalog as { suites: Array<Record<string, unknown>> }).suites[0] ?? {}).command }))).toBeNull()
    expect(decodeCatalogResponse(mutate(wire, (d) => { ((d.catalog as { suites: Array<Record<string, unknown>> }).suites[0] ?? {}).timeoutS = '900' }))).toBeNull()
    expect(decodeCatalogResponse(mutate(wire, (d) => { ((d.catalog as { suites: Array<Record<string, unknown>> }).suites[1] ?? {}).parallel = 'no' }))).toBeNull()
    expect(decodeCatalogResponse(mutate(wire, (d) => { ((d.latest as Array<Record<string, unknown>>)[0] ?? {}).result = 'flaky' }))).toBeNull()
    expect(decodeCatalogResponse(mutate(wire, (d) => { (((d.latest as Array<Record<string, unknown>>)[0] ?? {}).totals as Record<string, unknown>).fail = -1 }))).toBeNull()
    expect(decodeCatalogResponse(mutate(wire, (d) => { delete ((d.knownFailures as { entries: Array<Record<string, unknown>> }).entries[0] ?? {}).expired }))).toBeNull()
    expect(decodeCatalogResponse(mutate(wire, (d) => { d.latest = 'none' }))).toBeNull()
  })
})

describe('decodeBaselinesResponse', () => {
  it('每个画像的中位数、p95 与历史', () => {
    const decoded = decodeBaselinesResponse(JSON.parse(JSON.stringify(baselinesResponse())))
    expect(decoded).toEqual(baselinesResponse())
    expect(decoded?.baselines[0]?.history).toHaveLength(2)
  })

  it('缺画像名、指标方向非法、样本数为 0.5 都拒绝', () => {
    const wire = baselinesResponse()
    expect(decodeBaselinesResponse(mutate(wire, (d) => { delete ((d.baselines as Array<Record<string, unknown>>)[0] ?? {}).profile }))).toBeNull()
    expect(decodeBaselinesResponse(mutate(wire, (d) => {
      const metrics = ((d.baselines as Array<Record<string, unknown>>)[0] ?? {}).metrics as Record<string, Record<string, unknown>>
      if (metrics.p95_ms !== undefined) metrics.p95_ms.better = 'sideways'
    }))).toBeNull()
    expect(decodeBaselinesResponse(mutate(wire, (d) => {
      const metrics = ((d.baselines as Array<Record<string, unknown>>)[0] ?? {}).metrics as Record<string, Record<string, unknown>>
      if (metrics.rps !== undefined) metrics.rps.samples = 0.5
    }))).toBeNull()
  })
})

describe('decodePlanResponse', () => {
  it('三种状态', () => {
    expect(decodePlanResponse({ plan: { state: 'missing' } })).toEqual({ state: 'missing' })
    expect(decodePlanResponse({ plan: { state: 'tampered', reason: '摘要不符' } })).toEqual({ state: 'tampered', reason: '摘要不符' })
    expect(decodePlanResponse(JSON.parse(JSON.stringify({ plan: planView() })))).toEqual(planView())
  })

  it('tampered 缺原因、豁免批准人不是字符串或 null 都拒绝', () => {
    expect(decodePlanResponse({ plan: { state: 'tampered' } })).toBeNull()
    expect(decodePlanResponse({ plan: { state: 'nope' } })).toBeNull()
    expect(decodePlanResponse(mutate({ plan: planView() }, (d) => {
      ((((d.plan as Record<string, unknown>).waivers as Array<Record<string, unknown>>)[0]) ?? {}).approvedBy = 7
    }))).toBeNull()
  })
})

describe('decodeRecordListResponse / decodeRecordResponse', () => {
  it('列表与明细往返相等', () => {
    expect(decodeRecordListResponse(JSON.parse(JSON.stringify(recordList())))).toEqual(recordList())
    expect(decodeRecordResponse(JSON.parse(JSON.stringify({ record: recordDetail() })))).toEqual(recordDetail())
  })

  it('明细：未知用例状态、未知产物类型、失败信息缺 message、退出码为字符串都拒绝', () => {
    const wire = { record: recordDetail() }
    const suite = (d: Record<string, unknown>): Record<string, unknown> => ((d.record as { suites: Array<Record<string, unknown>> }).suites[0] ?? {})
    expect(decodeRecordResponse(mutate(wire, (d) => { ((suite(d).cases as Array<Record<string, unknown>>)[0] ?? {}).status = 'broken' }))).toBeNull()
    expect(decodeRecordResponse(mutate(wire, (d) => { ((suite(d).artifacts as Array<Record<string, unknown>>)[0] ?? {}).media = 'pdf' }))).toBeNull()
    expect(decodeRecordResponse(mutate(wire, (d) => { ((((suite(d).cases as Array<Record<string, unknown>>)[0] ?? {}).failure) as Record<string, unknown>).message = 1 }))).toBeNull()
    expect(decodeRecordResponse(mutate(wire, (d) => { suite(d).exitCode = '1' }))).toBeNull()
    expect(decodeRecordResponse(mutate(wire, (d) => { delete (d.record as Record<string, unknown>).trusted }))).toBeNull()
    expect(decodeRecordResponse({})).toBeNull()
  })

  it('列表：用户链状态非法拒绝', () => {
    expect(decodeRecordListResponse(mutate(recordList(), (d) => { ((d.users as Array<Record<string, unknown>>)[0] ?? {}).chain = 'ok' }))).toBeNull()
  })
})

describe('快照里的策略判定', () => {
  it('往返相等；同一步骤重复出现拒绝', () => {
    const reports = [verifyReport()]
    expect(decodePolicyReports(JSON.parse(JSON.stringify(reports)))).toEqual(reports)
    expect(decodePolicyReports([verifyReport(), verifyReport()])).toBeNull()
  })

  it('策略取值、套件状态、追溯状态、阻塞字段任一不合都拒绝', () => {
    const one = (edit: (draft: Record<string, unknown>) => void): unknown => [mutate(verifyReport(), edit)]
    expect(decodePolicyReports(one((d) => { (d.policy as Record<string, unknown>).scope = 'known' }))).toBeNull()
    expect(decodePolicyReports(one((d) => { ((d.suites as Array<Record<string, unknown>>)[0] ?? {}).state = 'green' }))).toBeNull()
    expect(decodePolicyReports(one((d) => { ((d.suites as Array<Record<string, unknown>>)[1] ?? {}).staleBecause = ['mood'] }))).toBeNull()
    expect(decodePolicyReports(one((d) => { ((d.trace as Array<Record<string, unknown>>)[0] ?? {}).state = 'maybe' }))).toBeNull()
    expect(decodePolicyReports(one((d) => { delete ((d.blockers as Array<Record<string, unknown>>)[0] ?? {}).blocking }))).toBeNull()
    expect(decodePolicyReports(one((d) => { d.chain = 'gone' }))).toBeNull()
    expect(decodePolicyReports(one((d) => { delete (d.files as Record<string, unknown>).orphans }))).toBeNull()
    expect(decodePolicyReports('x')).toBeNull()
  })

  it('步骤测试豁免：套件状态 waived / waiver-pending 与计划里的 test 豁免都能解码', () => {
    for (const state of ['waived', 'waiver-pending']) {
      const reports = [mutate(verifyReport(), (d) => { ((d.suites as Array<Record<string, unknown>>)[0] ?? {}).state = state })]
      expect(decodePolicyReports(JSON.parse(JSON.stringify(reports)))?.[0]?.suites[0]?.state).toBe(state)
    }
    const brief = { state: 'ok', suites: [], waivers: [{ test: 'code-size', approved: false }], files: 0, cases: 0 }
    expect(decodePlanBrief(brief)).toEqual(brief)
    const plan = planView()
    const withTest = { ...plan, waivers: [{ test: 'code-size', reason: '迁移脚本一次性生成', approvedBy: null }] }
    expect(decodePlanResponse(JSON.parse(JSON.stringify({ plan: withTest })))).toEqual(withTest)
  })

  it('目录的不适用声明：往返相等；缺省 = 没有声明；每一项字段类型不合都拒绝', () => {
    const declared = [{ kind: 'a11y', reason: '本项目没有界面', approved: true }, { kind: 'visual', reason: '同上', approved: false }]
    const reports = [verifyReport({ notApplicable: declared })]
    expect(decodePolicyReports(JSON.parse(JSON.stringify(reports)))).toEqual(reports)
    expect(decodePolicyReports([mutate(verifyReport(), (d) => { delete d.notApplicable })])?.[0]?.notApplicable).toEqual([])
    const one = (edit: (draft: Record<string, unknown>) => void): unknown => [mutate(verifyReport({ notApplicable: declared }), edit)]
    const first = (d: Record<string, unknown>): Record<string, unknown> => (d.notApplicable as Array<Record<string, unknown>>)[0] ?? {}
    expect(decodePolicyReports(one((d) => { first(d).approved = 'yes' }))).toBeNull()
    expect(decodePolicyReports(one((d) => { delete first(d).reason }))).toBeNull()
    expect(decodePolicyReports(one((d) => { first(d).kind = 1 }))).toBeNull()
    expect(decodePolicyReports(one((d) => { d.notApplicable = 'a11y' }))).toBeNull()
  })

  it('测试完整性：往返相等；缺省 = 没有这段；策略里缺省 notice；任一字段不合都拒绝', () => {
    const integrity = {
      mode: 'block' as const,
      state: 'unavailable' as const,
      reason: '不是 git 仓库',
      signals: [{ code: 'test-skipped', subject: 'src/a.test.ts', detail: '+1', suite: 'unit' }, { code: 'case-count-drop', subject: 'unit', detail: '5 → 3' }],
      truncated: { found: 500, limit: 400 },
    }
    const reports = [verifyReport({ integrity })]
    expect(decodePolicyReports(JSON.parse(JSON.stringify(reports)))).toEqual(reports)
    expect(decodePolicyReports(JSON.parse(JSON.stringify([verifyReport()])))?.[0]).not.toHaveProperty('integrity')
    expect(decodePolicyReports([mutate(verifyReport(), (d) => { delete (d.policy as Record<string, unknown>).integrity })])?.[0]?.policy?.integrity).toBe('notice')
    expect(decodePolicyReports([mutate(verifyReport(), (d) => { (d.policy as Record<string, unknown>).integrity = 'block' })])?.[0]?.policy?.integrity).toBe('block')
    const one = (edit: (draft: Record<string, unknown>) => void): unknown => [mutate(verifyReport({ integrity }), edit)]
    const section = (d: Record<string, unknown>): Record<string, unknown> => d.integrity as Record<string, unknown>
    expect(decodePolicyReports(one((d) => { section(d).mode = 'warn' }))).toBeNull()
    expect(decodePolicyReports(one((d) => { section(d).state = 'maybe' }))).toBeNull()
    expect(decodePolicyReports(one((d) => { delete section(d).signals }))).toBeNull()
    expect(decodePolicyReports(one((d) => { ((section(d).signals as Array<Record<string, unknown>>)[0] ?? {}).detail = 1 }))).toBeNull()
    expect(decodePolicyReports(one((d) => { delete ((section(d).signals as Array<Record<string, unknown>>)[0] ?? {}).subject }))).toBeNull()
    expect(decodePolicyReports(one((d) => { (section(d).truncated as Record<string, unknown>).found = -1 }))).toBeNull()
    expect(decodePolicyReports([mutate(verifyReport(), (d) => { (d.policy as Record<string, unknown>).integrity = 'off' })])).toBeNull()
  })

  it('解码不把提示并进阻塞：完整性提示留在 notices，blockers 的 blocking 标志原样保留', () => {
    const wire = mutate(verifyReport(), (d) => {
      d.blockers = [{ code: 'baseline-missing', blocking: false, message: 'm', subject: 'api-bench' }]
      d.notices = [{ code: 'test-integrity', message: '测试完整性提示：覆盖率门槛降低 1', fix: 'tenon test integrity add-login' }]
    })
    const decoded = decodePolicyReports([wire])?.[0]
    expect(decoded?.notices.map((item) => item.code)).toEqual(['test-integrity'])
    expect(decoded?.blockers.map((item) => [item.code, item.blocking])).toEqual([['baseline-missing', false]])
  })

  it('没有策略（只有旧步骤测试）时 policy 为 null', () => {
    const decoded = decodePolicyReports([mutate(verifyReport(), (d) => { d.policy = null })])
    expect(decoded?.[0]?.policy).toBeNull()
  })

  it('计划概要三种状态', () => {
    expect(decodePlanBrief({ state: 'missing' })).toEqual({ state: 'missing' })
    expect(decodePlanBrief({ state: 'tampered', reason: 'x' })).toEqual({ state: 'tampered', reason: 'x' })
    expect(decodePlanBrief(JSON.parse(JSON.stringify(planBrief())))).toEqual(planBrief())
    expect(decodePlanBrief({ state: 'ok', suites: [], waivers: [], files: -1, cases: 0 })).toBeNull()
    expect(decodePlanBrief({ state: 'weird' })).toBeNull()
  })
})
