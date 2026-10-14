import type { BenchmarkMetricVerdict, SuiteVerdict, TestPolicyReport, TraceRow } from '@tenon/kernel'
import { describe, expect, it } from 'vitest'
import { renderV2Block, renderV2Sections } from './report-md.js'

function report(overrides: Partial<TestPolicyReport> = {}): TestPolicyReport {
  return {
    stepId: 'verify', pass: true, blockers: [], notices: [], suites: [], trace: [],
    files: { checked: true, unregistered: [], orphans: [], claimed: [] },
    chain: 'empty', notApplicable: [],
    ...overrides,
  }
}

const mappedSpec: TraceRow = {
  covers: 'spec:auth/登录成功', kind: 'spec', title: 'auth · 登录成功', required: true,
  tests: [{ ref: 'src/a.test.ts › works', status: 'pass', suite: 'unit' }], state: 'passing',
}
const uncoveredSpec: TraceRow = {
  covers: 'spec:auth/密码错误', kind: 'spec', title: 'auth · 密码错误', required: true, tests: [], state: 'uncovered',
}
const optionalTask: TraceRow = {
  covers: 'task:5.1', kind: 'task', title: '手工回归', stage: 'verify', required: false, tests: [], state: 'uncovered',
}

describe('追溯矩阵：要求映射时与修改前逐字一致（快照锁住）', () => {
  it('scenarios: required —— 未映射的行逐条写「未覆盖」，不要求的任务写「可选」', () => {
    const text = renderV2Block(report({ scenarios: 'required', trace: [mappedSpec, uncoveredSpec, optionalTask] }), 'zh-CN')
    expect(text).toBe([
      '## 测试体系',
      '',
      '### 追溯矩阵',
      '| 场景 / 任务 | 用例 | 最近结果 | 状态 |',
      '| --- | --- | --- | --- |',
      '| auth · 登录成功 `spec:auth/登录成功` | `src/a.test.ts › works` | 通过（unit） | 通过 |',
      '| auth · 密码错误 `spec:auth/密码错误` | — | — | 未覆盖 |',
      '| 手工回归 `task:5.1` | — | — | 可选 |',
      '',
      '### 仍挡出口的项',
      '- 无',
    ].join('\n'))
  })

  it('scenarios: passing 与没有 scenarios 字段（旧形状的报告）同样照旧', () => {
    const rows = [mappedSpec, uncoveredSpec, optionalTask]
    const required = renderV2Sections(report({ scenarios: 'required', trace: rows }), 'zh-CN')
    expect(renderV2Sections(report({ scenarios: 'passing', trace: rows }), 'zh-CN')).toBe(required)
    expect(renderV2Sections(report({ trace: rows }), 'zh-CN')).toBe(required)
  })

  it('英文同样照旧', () => {
    const text = renderV2Sections(report({ scenarios: 'required', trace: [uncoveredSpec, optionalTask] }), 'en')
    expect(text).toContain('| auth · 密码错误 `spec:auth/密码错误` | — | — | uncovered |')
    expect(text).toContain('| 手工回归 `task:5.1` | — | — | optional |')
  })
})

describe('追溯矩阵：scenarios: off 时只列已映射的行，其余收成一行统计', () => {
  const unmapped = (count: number): TraceRow[] => Array.from({ length: count }, (_, index): TraceRow => ({
    covers: `spec:big/场景${index}`, kind: 'spec', title: `big · 场景${index}`, required: false, tests: [], state: 'uncovered',
  }))

  it('69 条未映射 + 1 条已映射：表里只有已映射的那行，另有一行统计，没有「未覆盖」', () => {
    const text = renderV2Block(report({ scenarios: 'off', trace: [{ ...mappedSpec, required: false }, ...unmapped(69)] }), 'zh-CN')
    expect(text).toBe([
      '## 测试体系',
      '',
      '### 追溯矩阵',
      '| 场景 / 任务 | 用例 | 最近结果 | 状态 |',
      '| --- | --- | --- | --- |',
      '| auth · 登录成功 `spec:auth/登录成功` | `src/a.test.ts › works` | 通过（unit） | 通过 |',
      '另有 69 条场景 / 任务未映射（本步不要求映射）',
      '',
      '### 仍挡出口的项',
      '- 无',
    ].join('\n'))
    expect(text).not.toContain('未覆盖')
    expect(text).not.toContain('场景0')
  })

  it('一条都没映射：不出空表，只有标题和一行统计', () => {
    const text = renderV2Sections(report({ scenarios: 'off', trace: unmapped(69) }), 'zh-CN')
    expect(text).toContain('### 追溯矩阵\n另有 69 条场景 / 任务未映射（本步不要求映射）\n')
    expect(text).not.toContain('| 场景 / 任务 |')
    expect(text).not.toContain('未覆盖')
  })

  it('全部已映射：没有统计行；已批准豁免的行（没有用例）仍然列出', () => {
    const waived: TraceRow = { ...uncoveredSpec, required: false, state: 'waived', waiver: { approved: true, reason: '沿用旧行为' } }
    const text = renderV2Sections(report({ scenarios: 'off', trace: [{ ...mappedSpec, required: false }, waived] }), 'zh-CN')
    expect(text).not.toContain('本步不要求映射')
    expect(text).toContain('| auth · 密码错误 `spec:auth/密码错误` | — | — | 已豁免 豁免（已批准）：沿用旧行为 |')
  })

  it('没有任何追溯行：不出这一节', () => {
    expect(renderV2Sections(report({ scenarios: 'off', trace: [] }), 'zh-CN')).not.toContain('追溯矩阵')
  })

  it('英文统计行', () => {
    const text = renderV2Sections(report({ scenarios: 'off', trace: unmapped(3) }), 'en')
    expect(text).toContain('### Traceability\n3 more scenarios / tasks are not mapped (this step does not require mapping)\n')
    expect(text).not.toContain('uncovered')
  })
})

describe('步骤测试豁免：理由下方另起一行写最新运行的实测值', () => {
  const waivedSuite = (overrides: Partial<SuiteVerdict>): SuiteVerdict => ({
    suite: 'step:code-size', origin: 'step', kind: 'static', reason: 'inline', state: 'waiver-pending',
    waiverReason: '新增 2100 行', failedMetrics: [{ name: 'lines_added', value: 2810, max: 2000 }],
    ...overrides,
  })

  it('待批准：理由标注为登记者自述，下一行是实测值（理由写 2100，最新运行是 2810）', () => {
    const text = renderV2Sections(report({ suites: [waivedSuite({})] }), 'zh-CN')
    expect(text).toContain([
      '### 步骤测试豁免',
      '- `code-size`：待评审批准（理由为登记者自述、未经核实）：新增 2100 行',
      '  最新运行：lines_added=2810（上限 2000）',
    ].join('\n'))
  })

  it('已批准；英文', () => {
    const zh = renderV2Sections(report({ suites: [waivedSuite({ state: 'waived' })] }), 'zh-CN')
    expect(zh).toContain('- `code-size`：已批准（理由为登记者自述、未经核实）：新增 2100 行')
    const en = renderV2Sections(report({ suites: [waivedSuite({ state: 'waived' })] }), 'en')
    expect(en).toContain([
      '### Step-test waivers',
      '- `code-size`: approved (the reason is self-reported by the registrant, unverified): 新增 2100 行',
      '  Latest run: lines_added=2810 (limit 2000)',
    ].join('\n'))
  })

  it('失败记录里没有指标：写明，不冒充「没有失败记录」', () => {
    const text = renderV2Sections(report({ suites: [waivedSuite({ failedMetrics: [] })] }), 'zh-CN')
    expect(text).toContain('  最新运行：没有记录到指标')
  })

  it('没有豁免的步骤测试、目录套件不出这一节', () => {
    const plain = waivedSuite({ state: 'failed' })
    const { waiverReason: _reason, failedMetrics: _metrics, ...rest } = plain
    expect(renderV2Sections(report({ suites: [rest] }), 'zh-CN')).not.toContain('步骤测试豁免')
    expect(renderV2Sections(report({ suites: [waivedSuite({ origin: 'catalog' })] }), 'zh-CN')).not.toContain('步骤测试豁免')
  })

  it('理由是不可信文本：链接与图片语法被转义，渲染后只剩字面文字（中英文都一样）', () => {
    const waiverReason = '见 [点我](https://x) 与 ![](https://x/t.png) 以及 [ref][1]'
    const zh = renderV2Sections(report({ suites: [waivedSuite({ waiverReason })] }), 'zh-CN')
    expect(zh).toContain(
      '- `code-size`：待评审批准（理由为登记者自述、未经核实）：见 \\[点我\\]\\(https://x\\) 与 \\!\\[\\]\\(https://x/t.png\\) 以及 \\[ref\\]\\[1\\]',
    )
    const en = renderV2Sections(report({ suites: [waivedSuite({ state: 'waived', waiverReason })] }), 'en')
    expect(en).toContain('): 见 \\[点我\\]\\(https://x\\) 与 \\!\\[\\]\\(https://x/t.png\\) 以及 \\[ref\\]\\[1\\]')
    for (const text of [zh, en]) {
      expect(text).not.toMatch(/(?<!\\)\[/u)
      expect(text).not.toMatch(/(?<!\\)\]/u)
      expect(text).not.toMatch(/(?<!\\)\(https/u)
    }
  })

  it('反斜杠本身也转义：理由末尾的反斜杠吃不掉后面的内容；竖线、星号同样', () => {
    const text = renderV2Sections(report({ suites: [waivedSuite({ waiverReason: 'a\\ b | *c*' })] }), 'zh-CN')
    expect(text).toContain('：a\\\\ b \\| \\*c\\*\n')
  })

  it('测试 id 是不可信文本：反引号换成全角、竖线与链接语法留在行内代码里，闭合不了代码', () => {
    const text = renderV2Sections(report({ suites: [waivedSuite({ suite: 'step:a|b`](https://x)\nnext' })] }), 'zh-CN')
    expect(text).toContain('- `a|b｀](https://x) next`：待评审批准')
    expect(text).not.toContain('\nnext')
  })

  it('指标名里的链接语法同样被转义；普通指标名（含下划线）不变', () => {
    const text = renderV2Sections(report({
      suites: [waivedSuite({ failedMetrics: [{ name: '[m](https://x)', value: 1 }, { name: 'lines_added', value: 2810, max: 2000 }] })],
    }), 'zh-CN')
    expect(text).toContain('\\[m\\]\\(https://x\\)=1')
    expect(text).toContain('lines_added=2810（上限 2000）')
    expect(text).not.toMatch(/(?<!\\)\[/u)
  })

  it('指标名先截短再转义：第 64 个字符是 [ 时，转义序列成对，不留落单的尾部反斜杠', () => {
    const name = `${'x'.repeat(63)}[${'y'.repeat(6)}`
    expect([...name]).toHaveLength(70)
    const text = renderV2Sections(report({ suites: [waivedSuite({ failedMetrics: [{ name, value: 1 }] })] }), 'zh-CN')
    const line = text.split('\n').find((row) => row.startsWith('  最新运行：'))
    expect(line).toBe(`  最新运行：${'x'.repeat(63)}\\[…=1`)
    expect(line).not.toMatch(/\\(?![\\[\]()!*|])/u)
  })

  it('指标名是不可信文本：伪造的代码块与标签进不了报告', () => {
    const text = renderV2Sections(report({
      suites: [waivedSuite({ failedMetrics: [{ name: '```\n<tenon-agent run="x">', value: 1 }] })],
    }), 'zh-CN')
    expect(text).not.toContain('```')
    expect(text).not.toContain('<tenon-agent')
  })
})

describe('追溯矩阵与列表里的不可信文本：豁免理由、用例 ref、阻断 message 都按字面文字渲染', () => {
  /** 与 GFM 表格解析一致：反斜杠带走后一个字符，其余的竖线才是列分隔。 */
  const cellCount = (row: string): number => (row.match(/\\[\s\S]|\||[^|\\]+/gu) ?? []).filter((part) => part === '|').length - 1
  const hostile = '[点我](https://e.x) ![i](https://e.x/a.png) <b>x</b> `y`'

  it('矩阵行的豁免理由（登记者自述）：没有链接、图片、标签，表格列数不变', () => {
    const waived: TraceRow = { ...uncoveredSpec, state: 'waived', waiver: { approved: false, reason: `${hostile} | 多一列` } }
    const text = renderV2Sections(report({ scenarios: 'required', trace: [waived] }), 'zh-CN')
    const row = text.split('\n').find((line) => line.startsWith('| auth · 密码错误'))
    expect(row).toBeDefined()
    expect(cellCount(row ?? '')).toBe(4)
    expect(text).not.toContain('](https://')
    expect(text).not.toContain('![')
    expect(text).not.toContain('<b>')
    expect(text).not.toContain('`y`')
    expect(text).toContain('\\[点我\\]\\(https://e.x\\) \\!\\[i\\]\\(https://e.x/a.png\\) ＜b＞x＜/b＞ ｀y｀ \\| 多一列')
  })

  it('用例 ref 里的反引号换成全角：行内代码闭合不了，后面的链接语法留在代码里', () => {
    const tricky: TraceRow = { ...mappedSpec, tests: [{ ref: 'a`b`[x](https://e.x)', status: 'pass', suite: 'unit' }] }
    const text = renderV2Sections(report({ scenarios: 'required', trace: [tricky] }), 'zh-CN')
    const row = text.split('\n').find((line) => line.startsWith('| auth · 登录成功')) ?? ''
    expect(row).toContain('`a｀b｀[x](https://e.x)`')
    expect([...row].filter((char) => char === '`').length % 2).toBe(0)
    expect(cellCount(row)).toBe(4)
  })

  it('flaky / 失败的 ref 与仍挡出口的 message 按字面文字渲染，修复命令里的反引号换成全角', () => {
    const suite: SuiteVerdict = {
      suite: 'unit', origin: 'catalog', kind: 'unit', reason: 'run', state: 'failed',
      flaky: ['[x](https://e.x) flaky'], failing: ['![y](https://e.x/a.png) failing'],
    }
    const text = renderV2Sections(report({
      suites: [suite],
      blockers: [{ code: 'test-failed', blocking: true, message: '见 [x](https://e.x) 与 <b>y</b>', fix: 'tenon test run `a` demo' }],
    }), 'en')
    expect(text).toContain('- flaky（unit）：\\[x\\]\\(https://e.x\\) flaky')
    expect(text).toContain('- failing（unit）：\\!\\[y\\]\\(https://e.x/a.png\\) failing')
    expect(text).toContain('- [test-failed] 见 \\[x\\]\\(https://e.x\\) 与 ＜b＞y＜/b＞ → `tenon test run ｀a｀ demo`')
    expect(text).not.toContain('](https://')
    expect(text).not.toContain('<b>')
  })

  it('普通文字不受影响：没有元字符的理由、message、修复命令逐字相同', () => {
    const waived: TraceRow = { ...uncoveredSpec, state: 'waived', waiver: { approved: true, reason: '沿用旧行为' } }
    const text = renderV2Sections(report({
      scenarios: 'required', trace: [waived],
      blockers: [{ code: 'test-failed', blocking: true, message: '测试 unit 未通过', fix: 'tenon test run demo --suite unit' }],
    }), 'zh-CN')
    expect(text).toContain('已豁免 豁免（已批准）：沿用旧行为 |')
    expect(text).toContain('- [test-failed] 测试 unit 未通过 → `tenon test run demo --suite unit`')
  })

  const rowOf = (text: string, prefix: string): string => text.split('\n').find((line) => line.startsWith(prefix)) ?? ''

  it('规格标题与用例所在套件名是登记者写的：链接 / 图片语法被转义，竖线不撑出多余的列', () => {
    const tricky: TraceRow = {
      ...mappedSpec, title: 'auth · [x](https://e.x) 登录 | 多一列',
      tests: [{ ref: 'src/a.test.ts › works', status: 'pass', suite: '![i](https://e.x/a.png)' }],
    }
    const text = renderV2Sections(report({ scenarios: 'required', trace: [tricky] }), 'zh-CN')
    const row = rowOf(text, '| auth · ')
    expect(text).not.toContain('](https://')
    expect(text).not.toContain('![')
    expect(cellCount(row)).toBe(4)
    expect(row).toContain('auth · \\[x\\]\\(https://e.x\\) 登录 \\| 多一列 `spec:auth/登录成功`')
    expect(row).toContain('通过（\\!\\[i\\]\\(https://e.x/a.png\\)）')
  })

  it('长标题不被截短（追溯矩阵要完整标题）；套件名里的换行折成空格', () => {
    const longTitle = '长'.repeat(260)
    const long: TraceRow = { ...mappedSpec, title: longTitle, tests: [{ ref: 'src/a.test.ts › works', status: 'pass', suite: 'u\nnit' }] }
    const text = renderV2Sections(report({ scenarios: 'required', trace: [long] }), 'zh-CN')
    const row = rowOf(text, `| ${'长'.repeat(10)}`)
    expect(row).toContain(`| ${longTitle} \`spec:auth/登录成功\` |`)
    expect(row).not.toContain('…')
    expect(row).toContain('通过（u nit）')
  })

  it('用例 ref 里的双向覆盖字符与换行：去掉、折成空格，行内代码不被换行拆开', () => {
    const rlo = String.fromCodePoint(0x202e)
    const tricky: TraceRow = { ...mappedSpec, tests: [{ ref: `src/a.test.ts\n› ${rlo}works`, status: 'pass', suite: 'unit' }] }
    const text = renderV2Sections(report({ scenarios: 'required', trace: [tricky] }), 'zh-CN')
    const row = rowOf(text, '| auth · 登录成功')
    expect(text).not.toContain(rlo)
    expect(row).toContain('| `src/a.test.ts › works` | 通过（unit） | 通过 |')
    expect(cellCount(row)).toBe(4)
  })

  it('修复命令里的换行折成同一行；<占位> 与引号照旧，反引号仍换成全角', () => {
    const text = renderV2Sections(report({
      blockers: [{ code: 'test-failed', blocking: true, message: '未通过', fix: 'tenon test known add\n--expires <YYYY-MM-DD>\t--reason `x`' }],
    }), 'zh-CN')
    expect(text).toContain('- [test-failed] 未通过 → `tenon test known add --expires <YYYY-MM-DD> --reason ｀x｀`')
  })

  it('同一行里的另两处登记者文字：任务 / 场景标识 covers（行内代码）与目录套件的 label 也不能造出链接或闭合代码', () => {
    const tricky: TraceRow = { ...mappedSpec, covers: 'spec:auth/a`b\nc' }
    const suite: SuiteVerdict = { suite: 'unit', origin: 'catalog', kind: 'unit', reason: 'run', state: 'passed', label: '[x](https://e.x) 单测' }
    const text = renderV2Sections(report({ scenarios: 'required', trace: [tricky], suites: [suite] }), 'zh-CN')
    expect(rowOf(text, '| auth · 登录成功')).toContain('`spec:auth/a｀b c`')
    expect(rowOf(text, '| \\[x\\]')).toContain('| \\[x\\]\\(https://e.x\\) 单测 `unit` |')
    expect(text).not.toContain('](https://')
  })

  const benchmarkMetric = (overrides: Partial<BenchmarkMetricVerdict>): BenchmarkMetricVerdict => ({
    name: 'p95', better: 'lower', summary: null, baseline: null, delta_pct: null,
    failed: false, baselineMissing: false, noisy: false, details: [], ...overrides,
  })
  const benchmarkSuite = (suite: string, metric: BenchmarkMetricVerdict): SuiteVerdict => ({
    suite, origin: 'catalog', kind: 'benchmark', reason: 'run', state: 'failed', benchmark: [metric],
  })

  /** 基准表的数据行（不含表头与分隔行）；同一个套件也会出现在套件表里，所以按小节标题取。 */
  const benchmarkRows = (text: string, heading: string): string[] =>
    (text.split(`${heading}\n`)[1] ?? '').split('\n\n')[0]?.split('\n').slice(2) ?? []

  it('基准行的指标名与 details 是探针输出：链接 / 图片 / 标签被转义，竖线不撑出多余的列', () => {
    const metric = benchmarkMetric({
      name: '[x](https://e.x) p95 | 多一列', failed: true, details: ['退化 [y](https://e.x/a.png) <b>z</b>', '![i](https://e.x/i.png)'],
    })
    const text = renderV2Sections(report({ suites: [benchmarkSuite('bench', metric)] }), 'zh-CN')
    const rows = benchmarkRows(text, '### 基准')
    expect(rows).toHaveLength(1)
    const row = rows[0] ?? ''
    expect(cellCount(row)).toBe(6)
    expect(row).toContain('| \\[x\\]\\(https://e.x\\) p95 \\| 多一列 |')
    expect(row).toContain('退化 \\[y\\]\\(https://e.x/a.png\\) ＜b＞z＜/b＞；\\!\\[i\\]\\(https://e.x/i.png\\)')
    expect(text).not.toContain('](https://')
    expect(text).not.toContain('<b>')
  })

  it('基准行：普通指标名（含下划线）、details 与合法套件 id 逐字不变；没有 details 的失败写 fail', () => {
    const ok = benchmarkMetric({ name: 'lines_added', failed: true, details: ['比基线慢 12.5%'] })
    const bare = benchmarkMetric({ name: 'p50', failed: true })
    const text = renderV2Sections(report({ suites: [benchmarkSuite('api-bench', ok), benchmarkSuite('db_bench.v2', bare)] }), 'en')
    expect(benchmarkRows(text, '### Benchmarks')).toEqual([
      '| api-bench | lines_added | — | no baseline for this machine | — | 比基线慢 12.5% |',
      '| db_bench.v2 | p50 | — | no baseline for this machine | — | fail |',
    ])
  })

  it('套件 id 走同一转义：基准行、flaky 与失败行里混进链接语法的值只剩字面文字', () => {
    const hostile = '[s](https://e.x)'
    const flakySuite: SuiteVerdict = {
      suite: hostile, origin: 'catalog', kind: 'unit', reason: 'run', state: 'failed', flaky: ['a flaky'], failing: ['b failing'],
    }
    const text = renderV2Sections(report({ suites: [benchmarkSuite(hostile, benchmarkMetric({})), flakySuite] }), 'zh-CN')
    // 套件表里的 id 不在本项范围：它受目录校验约束，这里只看基准行与 flaky / 失败行。
    const rows = benchmarkRows(text, '### 基准')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain('| \\[s\\]\\(https://e.x\\) | p95 |')
    expect(text).toContain('- flaky（\\[s\\]\\(https://e.x\\)）：a flaky')
    expect(text).toContain('- 失败（\\[s\\]\\(https://e.x\\)）：b failing')
    const lines = [...rows, ...text.split('\n').filter((line) => line.startsWith('- flaky') || line.startsWith('- 失败'))]
    expect(lines).toHaveLength(3)
    expect(lines.join('\n')).not.toContain('](https://')
  })
})
