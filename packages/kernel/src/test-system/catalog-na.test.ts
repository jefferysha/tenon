/**
 * 目录里项目级「不适用」声明：解码 / 规范化写出 / 评审批准 / CLI 用的增删，以及策略里 regression 的等价关系。
 */
import { describe, expect, it } from 'vitest'
import {
  approveNotApplicable, catalogNotApplicable, isNotApplicableKey, notApplicableKey, pendingNotApplicable,
  withNotApplicable, withoutNotApplicable,
} from './catalog-na.js'
import type { TestCatalog } from './catalog-types.js'
import { catalogDigest, catalogSuitesDigest, formatCatalogIssues, parseTestCatalog, serializeTestCatalog } from './catalog.js'
import { planKindsSatisfy, policyRunReason } from './policy.js'

const BASE = 'schema: tenon-test-catalog/v1\nsuites: []\n'

function parse(text: string): TestCatalog {
  const result = parseTestCatalog(text)
  if (!result.ok) throw new Error(formatCatalogIssues(result.issues).join('\n'))
  return result.catalog
}

function problems(text: string): string[] {
  const result = parseTestCatalog(text)
  return result.ok ? [] : formatCatalogIssues(result.issues)
}

describe('not_applicable 解码与写出', () => {
  const TEXT = `${BASE}not_applicable:
  - kind: typecheck
    reason: 纯 JavaScript 项目，没有类型检查
    approved_by: null
  - kind: integration
    reason: 没有集成面
    approved_by: reviewer@x.io
`

  it('读出 kind / reason / approved_by；写出再读回深等（含 null 与批准人）', () => {
    const catalog = parse(TEXT)
    expect(catalog.not_applicable).toEqual([
      { kind: 'typecheck', reason: '纯 JavaScript 项目，没有类型检查', approved_by: null },
      { kind: 'integration', reason: '没有集成面', approved_by: 'reviewer@x.io' },
    ])
    expect(parse(serializeTestCatalog(catalog))).toEqual(catalog)
  })

  it('approved_by 缺省视为未批准；没有声明时该键整体省略（旧目录逐字不变、摘要不变）', () => {
    expect(parse(`${BASE}not_applicable:\n  - { kind: lint, reason: 没有 lint }\n`).not_applicable).toEqual([
      { kind: 'lint', reason: '没有 lint', approved_by: null },
    ])
    const plain = parse(BASE)
    expect(plain.not_applicable).toBeUndefined()
    expect(serializeTestCatalog(plain)).not.toContain('not_applicable')
    expect(catalogDigest(plain)).toBe(catalogDigest(parse(BASE)))
  })

  it('声明不进套件摘要：批准前后已有运行不会因此过期', () => {
    const before = parse(BASE)
    const after = parse(`${BASE}not_applicable:\n  - { kind: lint, reason: x, approved_by: r }\n`)
    expect(catalogSuitesDigest(after, [])).toBe(catalogSuitesDigest(before, []))
  })

  it.each([
    ['未知种类', `${BASE}not_applicable:\n  - { kind: nope, reason: x }\n`, /not_applicable 的 kind 'nope' 不在闭集/],
    ['缺 kind', `${BASE}not_applicable:\n  - { reason: x }\n`, /缺 kind/],
    ['缺 reason', `${BASE}not_applicable:\n  - { kind: lint }\n`, /reason 缺失/],
    ['多余键', `${BASE}not_applicable:\n  - { kind: lint, reason: x, why: y }\n`, /不认识键 'why'/],
    ['approved_by 不是字符串', `${BASE}not_applicable:\n  - { kind: lint, reason: x, approved_by: 3 }\n`, /approved_by 必须是 null 或批准人/],
    ['重复种类', `${BASE}not_applicable:\n  - { kind: lint, reason: x }\n  - { kind: lint, reason: y }\n`, /重复声明种类 'lint'/],
    ['不是列表', `${BASE}not_applicable: lint\n`, /必须是列表/],
  ])('%s → 逐条带行号的问题', (_name, text, expected) => {
    const found = problems(text)
    expect(found.length).toBeGreaterThan(0)
    expect(found.join('\n')).toMatch(expected)
    expect(found[0]).toMatch(/^catalog\.yaml:\d+:/)
  })
})

describe('评审批准（纯函数）', () => {
  const catalog = parse(`${BASE}not_applicable:
  - { kind: typecheck, reason: 纯 JavaScript 项目, approved_by: null }
  - { kind: integration, reason: 没有集成面, approved_by: null }
  - { kind: lint, reason: 没有 lint, approved_by: someone@x.io }
`)

  it('键是 not-applicable:<kind>；只有未批准的进待批准清单，按键排序', () => {
    expect(notApplicableKey('typecheck')).toBe('not-applicable:typecheck')
    expect(isNotApplicableKey('not-applicable:lint')).toBe(true)
    expect(isNotApplicableKey('kind:lint')).toBe(false)
    expect(pendingNotApplicable(catalog)).toEqual([
      { key: 'not-applicable:integration', reason: '没有集成面' },
      { key: 'not-applicable:typecheck', reason: '纯 JavaScript 项目' },
    ])
  })

  it('只批准清单里键与理由都原样存在、当前未批准的；其余说明原因，非本类的键忽略', () => {
    const result = approveNotApplicable(catalog, [
      { key: 'not-applicable:typecheck', reason: '纯 JavaScript 项目' },
      { key: 'not-applicable:integration', reason: '请求之后改过的理由' },
      { key: 'not-applicable:lint', reason: '没有 lint' },
      { key: 'not-applicable:benchmark', reason: 'x' },
      { key: 'kind:unit', reason: '计划豁免不归这里' },
    ], 'me@x.io')
    expect(result.approved).toEqual(['not-applicable:typecheck'])
    expect(result.skipped).toEqual([
      { key: 'not-applicable:integration', why: 'reason-changed' },
      { key: 'not-applicable:lint', why: 'already-approved' },
      { key: 'not-applicable:benchmark', why: 'missing' },
    ])
    expect(result.catalog.not_applicable?.map((entry) => [entry.kind, entry.approved_by])).toEqual([
      ['typecheck', 'me@x.io'], ['integration', null], ['lint', 'someone@x.io'],
    ])
  })

  it('什么都没批准时目录对象原样返回（调用方据此不重写文件）', () => {
    expect(approveNotApplicable(catalog, [], 'me@x.io').catalog).toBe(catalog)
    expect(approveNotApplicable(catalog, [{ key: 'not-applicable:lint', reason: '没有 lint' }], 'me@x.io').catalog).toBe(catalog)
  })
})

describe('声明与撤销（CLI 用）', () => {
  it('新声明未批准，按种类排序；同种类同理由原样保留（已批准不丢），换理由批准清零', () => {
    const empty = parse(BASE)
    const one = withNotApplicable(withNotApplicable(empty, 'typecheck', '纯 JS'), 'unit', '没有单测')
    expect(one.not_applicable?.map((entry) => entry.kind)).toEqual(['unit', 'typecheck'])
    const approved = approveNotApplicable(one, [{ key: 'not-applicable:typecheck', reason: '纯 JS' }], 'r').catalog
    expect(withNotApplicable(approved, 'typecheck', '纯 JS')).toBe(approved)
    expect(catalogNotApplicable(withNotApplicable(approved, 'typecheck', '换了理由'), 'typecheck')).toEqual({
      kind: 'typecheck', reason: '换了理由', approved_by: null,
    })
  })

  it('撤销：没有声明报 removed=false；撤完最后一个整个键省略', () => {
    const catalog = withNotApplicable(parse(BASE), 'lint', 'x')
    expect(withoutNotApplicable(catalog, 'unit')).toEqual({ catalog, removed: false })
    const removed = withoutNotApplicable(catalog, 'lint')
    expect(removed.removed).toBe(true)
    expect(removed.catalog.not_applicable).toBeUndefined()
    expect(serializeTestCatalog(removed.catalog)).not.toContain('not_applicable')
  })
})

describe('策略里 regression 就是全量跑单测', () => {
  it('policyRunReason：必跑 / 有则跑；run 要求 regression 且 scope: full 时 unit 套件也是必跑', () => {
    const base = { run: ['unit'] as const, run_if_registered: ['typecheck', 'regression'] as const, scope: 'full' as const }
    expect(policyRunReason(base, 'unit')).toBe('run')
    expect(policyRunReason(base, 'typecheck')).toBe('if-registered')
    expect(policyRunReason(base, 'regression')).toBe('if-registered')
    expect(policyRunReason(base, 'e2e')).toBeUndefined()
    const needs = { run: ['regression'] as const, run_if_registered: [] as const, scope: 'full' as const }
    expect(policyRunReason(needs, 'unit')).toBe('run')
    expect(policyRunReason({ ...needs, scope: 'changed' }, 'unit')).toBeUndefined()
  })

  it('planKindsSatisfy：同种类；regression 由 unit 顶上（run 里要求时另需 scope: full）', () => {
    expect(planKindsSatisfy({ run: [], scope: 'changed' }, ['unit'], 'unit')).toBe(true)
    expect(planKindsSatisfy({ run: [], scope: 'changed' }, ['unit'], 'regression')).toBe(true)
    expect(planKindsSatisfy({ run: ['regression'], scope: 'full' }, ['unit'], 'regression')).toBe(true)
    expect(planKindsSatisfy({ run: ['regression'], scope: 'changed' }, ['unit'], 'regression')).toBe(false)
    expect(planKindsSatisfy({ run: [], scope: 'changed' }, ['typecheck'], 'regression')).toBe(false)
    expect(planKindsSatisfy({ run: [], scope: 'changed' }, ['unit'], 'integration')).toBe(false)
  })
})
