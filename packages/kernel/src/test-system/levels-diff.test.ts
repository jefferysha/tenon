/**
 * 档位定义改动的逐档逐键比较：比较生效值（目录没写的键取内建缺省），不是原文。
 */
import { describe, expect, it } from 'vitest'
import type { CatalogLevels } from './levels.js'
import { describeLevelChanges } from './levels-diff.js'

describe('describeLevelChanges：必需类与碰到才跑的类', () => {
  it('没有 levels → full 档必需类清空：必需类去掉 unit，放宽', () => {
    expect(describeLevelChanges(undefined, { full: { required: [] } })).toEqual(['档位 full：必需类去掉 unit（放宽）'])
  })

  it('必需类加上 e2e 与 static：一行列出，用「、」连接，收紧', () => {
    expect(describeLevelChanges(undefined, { changed: { required: ['unit', 'e2e', 'static'] } })).toEqual([
      '档位 changed：必需类加上 e2e、static（收紧）',
    ])
  })

  it('碰到才跑的类：去掉放宽、加上收紧；plan 档的 touched 恒为空，不产生行', () => {
    expect(describeLevelChanges(undefined, { full: { touched: ['integration', 'static'] } })).toEqual([
      '档位 full：碰到才跑的类去掉 e2e、benchmark（放宽）',
    ])
    expect(describeLevelChanges(undefined, { changed: { touched: ['static', 'integration'] } })).toEqual([
      '档位 changed：碰到才跑的类加上 integration（收紧）',
    ])
    expect(describeLevelChanges(undefined, { plan: { touched: ['e2e'] } })).toEqual([])
  })

  it('同一档既去掉又加上：两行，去掉在前', () => {
    expect(describeLevelChanges(undefined, { full: { required: ['integration'] } })).toEqual([
      '档位 full：必需类去掉 unit（放宽）',
      '档位 full：必需类加上 integration（收紧）',
    ])
  })
})

describe('describeLevelChanges：场景映射', () => {
  it('off → required / passing 收紧；passing → off 放宽', () => {
    expect(describeLevelChanges(undefined, { full: { scenarios: 'required' } })).toEqual(['档位 full：场景映射 off → required（收紧）'])
    expect(describeLevelChanges({ plan: { scenarios: 'required' } }, { plan: { scenarios: 'passing' } })).toEqual([
      '档位 plan：场景映射 required → passing（收紧）',
    ])
    expect(describeLevelChanges({ full: { scenarios: 'passing' } }, undefined)).toEqual(['档位 full：场景映射 passing → off（放宽）'])
  })
})

describe('describeLevelChanges：覆盖率', () => {
  const eighty: CatalogLevels = { full: { coverage: { lines: 80 } } }

  it('80 → 去掉：不设，放宽', () => {
    expect(describeLevelChanges(eighty, undefined)).toEqual(['档位 full：覆盖率 lines 80 → 不设（放宽）'])
  })

  it('新设门槛收紧；70 → 80 收紧；80 → 70 放宽', () => {
    expect(describeLevelChanges(undefined, eighty)).toEqual(['档位 full：覆盖率 lines 不设 → 80（收紧）'])
    expect(describeLevelChanges({ full: { coverage: { lines: 70 } } }, eighty)).toEqual(['档位 full：覆盖率 lines 70 → 80（收紧）'])
    expect(describeLevelChanges(eighty, { full: { coverage: { lines: 70 } } })).toEqual(['档位 full：覆盖率 lines 80 → 70（放宽）'])
  })

  it('多个指标按 lines、branches、functions、statements、changed_lines 的顺序', () => {
    const lines = describeLevelChanges(undefined, {
      changed: { coverage: { changed_lines: 90, branches: 60, lines: 80, statements: 75, functions: 70 } },
    })
    expect(lines).toEqual([
      '档位 changed：覆盖率 lines 不设 → 80（收紧）',
      '档位 changed：覆盖率 branches 不设 → 60（收紧）',
      '档位 changed：覆盖率 functions 不设 → 70（收紧）',
      '档位 changed：覆盖率 statements 不设 → 75（收紧）',
      '档位 changed：覆盖率 changed_lines 不设 → 90（收紧）',
    ])
  })
})

describe('describeLevelChanges：不稳定用例与基线', () => {
  const strict: CatalogLevels = { full: { flaky: { max: 2, fail_on_new: true } } }

  it('门槛整体去掉：上限变「不设」、新失败挡出口 是 → 否，两行都是放宽', () => {
    expect(describeLevelChanges(strict, undefined)).toEqual([
      '档位 full：不稳定用例上限 2 → 不设（放宽）',
      '档位 full：新失败的不稳定用例挡出口 是 → 否（放宽）',
    ])
  })

  it('新设门槛收紧；max 变大放宽、变小收紧；fail_on_new 是 → 否放宽、否 → 是收紧', () => {
    expect(describeLevelChanges(undefined, strict)).toEqual([
      '档位 full：不稳定用例上限 不设 → 2（收紧）',
      '档位 full：新失败的不稳定用例挡出口 否 → 是（收紧）',
    ])
    expect(describeLevelChanges(strict, { full: { flaky: { max: 5, fail_on_new: true } } })).toEqual([
      '档位 full：不稳定用例上限 2 → 5（放宽）',
    ])
    expect(describeLevelChanges(strict, { full: { flaky: { max: 1, fail_on_new: true } } })).toEqual([
      '档位 full：不稳定用例上限 2 → 1（收紧）',
    ])
    expect(describeLevelChanges(strict, { full: { flaky: { max: 2, fail_on_new: false } } })).toEqual([
      '档位 full：新失败的不稳定用例挡出口 是 → 否（放宽）',
    ])
  })

  it('require_baseline 是 → 否放宽、否 → 是收紧', () => {
    expect(describeLevelChanges({ full: { require_baseline: true } }, { full: { require_baseline: false } })).toEqual([
      '档位 full：缺基线挡出口 是 → 否（放宽）',
    ])
    expect(describeLevelChanges(undefined, { full: { require_baseline: true } })).toEqual(['档位 full：缺基线挡出口 否 → 是（收紧）'])
  })
})

describe('describeLevelChanges：比较的是生效值', () => {
  it('显式写出与缺省相同的值：空数组', () => {
    expect(describeLevelChanges(undefined, {
      plan: { required: ['unit'], scenarios: 'off' },
      changed: { required: ['unit'], touched: ['static'], require_baseline: false },
      full: { required: ['unit'], touched: ['integration', 'e2e', 'static', 'benchmark'], scenarios: 'off' },
    })).toEqual([])
  })

  it('删掉整个 levels 等于回到缺省：按与缺省的差异产生行', () => {
    expect(describeLevelChanges({ full: { required: [], require_baseline: true } }, undefined)).toEqual([
      '档位 full：必需类加上 unit（收紧）',
      '档位 full：缺基线挡出口 是 → 否（放宽）',
    ])
  })

  it('before / after 都没有 levels，或两边相同：空数组', () => {
    expect(describeLevelChanges(undefined, undefined)).toEqual([])
    const same: CatalogLevels = { full: { required: ['unit', 'e2e'], coverage: { lines: 80 } } }
    expect(describeLevelChanges(same, { full: { coverage: { lines: 80 }, required: ['unit', 'e2e'] } })).toEqual([])
  })

  it('档序是 plan、changed、full', () => {
    const lines = describeLevelChanges(undefined, {
      full: { scenarios: 'required' }, plan: { scenarios: 'required' }, changed: { scenarios: 'required' },
    })
    expect(lines).toEqual([
      '档位 plan：场景映射 off → required（收紧）',
      '档位 changed：场景映射 off → required（收紧）',
      '档位 full：场景映射 off → required（收紧）',
    ])
  })
})
