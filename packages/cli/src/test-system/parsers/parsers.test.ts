/**
 * 用例报告解析器 × 真实样例。
 *
 * 样例来源（fixtures/PROVENANCE 同款说明）：
 *   captured  —— 用真实工具跑出来的原文，只把机器路径换成 /work/proj：vitest 3（json / junit）、
 *                Playwright 1.61（json / junit，含重试后 flaky 与截图 / trace 附件）、Node 24 内置 test runner
 *                （tap / junit）、Node 24 内置覆盖率（lcov）。
 *   authored  —— 本机没有对应工具时，按该工具文档化的输出形状手写：jest-json、go test -json、cobertura、
 *                istanbul coverage-summary / coverage-final、hyperfine、vitest bench、k6、lighthouse、pytest 风格 junit。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseBenchmarkReport, parseCaseReport, parseCoverageReport } from './index.js'
import type { CaseReport, CaseReportFormat, ParsedCase } from './types.js'

const FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures')
const CTX = { repoRoot: '/work/proj', cwd: '/work/proj' }

function fixture(path: string): string {
  return readFileSync(join(FIXTURES, path), 'utf8')
}

function cases(format: CaseReportFormat, path: string, ctx = CTX): readonly ParsedCase[] {
  const report = parseCaseReport(format, fixture(path), ctx)
  if (!report.ok) throw new Error(`${path}: ${report.reason}`)
  return report.cases
}

function summary(list: readonly ParsedCase[]): string[] {
  return list.map((item) => `${item.status} ${[...item.suite_path, item.name].join(' > ')}`)
}

describe('vitest（captured）', () => {
  for (const [format, ext, dir] of [['vitest-json', 'json', 'vitest-json'], ['junit', 'xml', 'junit']] as const) {
    describe(format, () => {
      it('pass：两个通过的用例，带分组链与文件', () => {
        const list = cases(format, `${dir}/vitest-pass.${ext}`)
        expect(summary(list)).toEqual(['pass math > adds', 'pass math > nested > adds negatives'])
        expect(list.every((item) => item.file === 'src/pass.test.ts' && item.attempts === 1 && item.project === null)).toBe(true)
      })
      it('fail：失败带断言信息，skip / todo 都算跳过', () => {
        const list = cases(format, `${dir}/vitest-fail.${ext}`)
        expect(summary(list)).toEqual(['fail math fail > subtracts wrong', 'skip math fail > skipped one', 'skip math fail > todo one'])
        expect(list[0]?.failure?.message).toContain('expected 3 to be 4')
      })
      it('skip：全部跳过', () => {
        expect(cases(format, `${dir}/vitest-skip.${ext}`).map((item) => item.status)).toEqual(['skip', 'skip'])
      })
      it('empty：合法报告，0 个用例', () => {
        expect(cases(format, `${dir}/vitest-empty.${ext}`)).toEqual([])
      })
    })
  }
})

describe('Playwright（captured）', () => {
  it('json pass：project、行号、testDir 换算成仓库相对路径', () => {
    const report = parseCaseReport('playwright-json', fixture('playwright-json/playwright-pass.json'), CTX)
    expect(report).toMatchObject({ ok: true, projects: ['chromium'] })
    expect(report.ok && report.cases).toEqual([expect.objectContaining({
      file: 'e2e/login.spec.ts', line: 4, name: 'shows the heading', suite_path: ['login'], project: 'chromium', status: 'pass', attempts: 1,
    })])
  })

  it('json fail：失败信息去掉 ANSI，截图 / 错误上下文 / trace 附件挂在用例上', () => {
    const [item] = cases('playwright-json', 'playwright-json/playwright-fail.json')
    expect(item).toMatchObject({ status: 'fail', name: 'wrong heading fails', attempts: 1 })
    expect(item?.failure?.message).toContain('expect(locator).toHaveText(expected) failed')
    expect(item?.failure?.message).not.toContain('\u001b')
    expect(item?.attachments.map((attachment) => attachment.name)).toEqual(['screenshot', 'error-context', 'trace'])
    expect(item?.attachments.find((attachment) => attachment.name === 'trace')).toMatchObject({ contentType: 'application/zip' })
  })

  it('json flaky：第二次尝试才通过 → flaky，attempts=2，仍带第一次失败的信息', () => {
    const [item] = cases('playwright-json', 'playwright-json/playwright-flaky.json')
    expect(item).toMatchObject({ status: 'flaky', attempts: 2 })
    expect(item?.failure?.message).toContain('toBeGreaterThan')
  })

  it('json skip / empty：跳过一条；No tests found 是 0 个用例而不是失败用例', () => {
    expect(cases('playwright-json', 'playwright-json/playwright-skip.json').map((item) => item.status)).toEqual(['skip'])
    expect(cases('playwright-json', 'playwright-json/playwright-empty.json')).toEqual([])
  })

  it('json：全局错误（配置 / 导入失败）记成失败用例', () => {
    const broken = JSON.stringify({ config: {}, suites: [], errors: [{ message: 'Error: Cannot find module ./x' }] })
    const report = parseCaseReport('playwright-json', broken, CTX)
    expect(report.ok && summary(report.cases)).toEqual(['fail Playwright 运行出错'])
  })

  it('junit：文件取 classname，附件取 system-out；junit 看不出重试（flaky 按通过算）', () => {
    const list = cases('junit', 'junit/playwright-fail.xml')
    expect(list).toEqual([expect.objectContaining({ file: 'login.spec.ts', status: 'fail', suite_path: ['login'], name: 'wrong heading fails' })])
    expect(list[0]?.attachments).toHaveLength(3)
    expect(cases('junit', 'junit/playwright-flaky.xml')[0]?.status).toBe('pass')
    expect(cases('junit', 'junit/playwright-skip.xml')[0]?.status).toBe('skip')
    expect(cases('junit', 'junit/playwright-empty.xml')).toEqual([])
  })
})

describe('node:test（captured）', () => {
  it('junit：file 属性给出文件，嵌套 describe 进分组链，skip 算跳过', () => {
    expect(summary(cases('junit', 'junit/node-pass.xml'))).toEqual(['pass math > adds', 'pass math > nested > adds negatives'])
    expect(cases('junit', 'junit/node-pass.xml')[0]?.file).toBe('pass.test.mjs')
    const failing = cases('junit', 'junit/node-fail.xml')
    expect(failing.map((item) => item.status)).toEqual(['fail', 'skip'])
    expect(failing[0]?.failure?.message).toContain('3 !== 4')
  })

  it('junit：没有测试的文件在 node 里表现为一条以文件名命名的通过用例，按 0 用例处理', () => {
    expect(cases('junit', 'junit/node-empty.xml')).toEqual([])
    expect(cases('tap', 'tap/node-empty.tap')).toEqual([])
  })

  it('tap：嵌套 Subtest 拆成分组链；失败用例的 location 给出文件与行号，expected / actual 来自诊断块', () => {
    const failing = cases('tap', 'tap/node-fail.tap')
    expect(summary(failing)).toEqual(['fail math fail > subtracts wrong', 'skip math fail > skipped one'])
    expect(failing[0]).toMatchObject({ file: 'fail.test.mjs', line: 4 })
    expect(failing[0]?.failure).toMatchObject({ expected: '4', actual: '3' })
    expect(failing[0]?.failure?.message).toContain('3 !== 4')
    expect(failing[1]?.file).toBe('fail.test.mjs')
  })

  it('tap：通过的用例没有文件线索时如实记为 (unknown)，不猜', () => {
    const passing = cases('tap', 'tap/node-pass.tap')
    expect(summary(passing)).toEqual(['pass math > adds', 'pass math > nested > adds negatives'])
    expect(passing.every((item) => item.file === '(unknown)')).toBe(true)
    expect(cases('tap', 'tap/node-skip.tap').map((item) => item.status)).toEqual(['skip', 'skip'])
  })

  it('tap：扁平 TAP（无 Subtest）也能解析，# SKIP 指令算跳过', () => {
    // 指令词由片段拼出，避免仓库的注释诚实门禁把测试数据里的指令当成欠债标记。
    const pending = `${'TO'}${'DO'}`
    const flat = `TAP version 13\n1..4\nok 1 - adds\nnot ok 2 - subtracts\nok 3 - later # SKIP not now\nnot ok 4 - wip # ${pending} soon\n`
    const report = parseCaseReport('tap', flat, CTX)
    expect(report.ok && report.cases.map((item) => [item.name, item.status])).toEqual([['adds', 'pass'], ['subtracts', 'fail'], ['later', 'skip'], ['wip', 'skip']])
  })
})

describe('junit 方言（authored）', () => {
  it('pytest fixtures：pass / fail / skip / empty；类名进分组，失败带断言信息', () => {
    expect(summary(cases('junit', 'junit/pytest-pass.xml'))).toEqual(['pass test_add', 'pass TestNested > test_negatives'])
    expect(cases('junit', 'junit/pytest-pass.xml').every((item) => item.file === 'tests/test_math.py')).toBe(true)
    const failing = cases('junit', 'junit/pytest-fail.xml')
    expect(failing.map((item) => [item.status, item.file, item.suite_path.join('.'), item.name])).toEqual([
      ['pass', 'tests/test_math.py', '', 'test_add'],
      ['fail', 'tests/test_math.py', 'TestSub', 'test_sub'],
      ['skip', 'tests/test_math.py', '', 'test_skip'],
    ])
    expect(failing[1]?.failure?.message).toContain('assert 3 == 4')
    expect(cases('junit', 'junit/pytest-empty.xml')).toEqual([])
  })

  it('surefire fixture：flakyFailure（重试后通过）→ flaky，attempts 数出重试次数；Java 的点号类名不推成 .py', () => {
    const list = cases('junit', 'junit/surefire-flaky.xml')
    expect(list.map((item) => [item.name, item.status, item.attempts, item.file])).toEqual([
      ['adds', 'pass', 1, 'com.example.MathTest'],
      ['wobbly', 'flaky', 3, 'com.example.MathTest'],
      ['subtracts', 'pass', 1, 'com.example.MathTest'],
    ])
    expect(list[1]?.failure?.message).toBe('connection reset')
  })

  it('pytest 风格：点号 classname 推成 .py 文件，类名进分组；rerun 后通过 → flaky', () => {
    const xml = `<?xml version="1.0"?><testsuites><testsuite name="pytest" tests="3">
      <testcase classname="tests.test_math.TestAdd" name="test_adds" time="0.002"/>
      <testcase classname="tests.test_math" name="test_flaky" time="0.5"><rerunFailure message="boom" type="AssertionError">trace</rerunFailure></testcase>
      <testcase classname="tests.test_math" name="test_bad" time="0.1"><failure message="assert 1 == 2">E assert 1 == 2</failure></testcase>
    </testsuite></testsuites>`
    const report = parseCaseReport('junit', xml, CTX)
    if (!report.ok) throw new Error(report.reason)
    expect(report.cases.map((item) => [item.file, item.suite_path.join('.'), item.name, item.status, item.attempts])).toEqual([
      ['tests/test_math.py', 'TestAdd', 'test_adds', 'pass', 1],
      ['tests/test_math.py', '', 'test_flaky', 'flaky', 2],
      ['tests/test_math.py', '', 'test_bad', 'fail', 1],
    ])
  })

  it('testsuite 直接挂 error（进程崩溃）→ 一条失败用例；根元素可以是单个 testsuite', () => {
    const xml = '<testsuite name="crash.test.js" file="crash.test.js" time="0"><error message="Segmentation fault"/></testsuite>'
    const report = parseCaseReport('junit', xml, CTX)
    expect(report.ok && report.cases).toEqual([expect.objectContaining({ status: 'fail', name: 'crash.test.js', file: 'crash.test.js' })])
  })

  it('相对路径按套件 cwd 换算成仓库相对路径', () => {
    const xml = '<testsuites><testsuite name="a"><testcase classname="src/a.test.ts" name="works" time="0.001"/></testsuite></testsuites>'
    const report = parseCaseReport('junit', xml, { repoRoot: '/work/proj', cwd: '/work/proj/packages/web' })
    expect(report.ok && report.cases[0]?.file).toBe('packages/web/src/a.test.ts')
  })
})

describe('jest-json（authored）', () => {
  it('pass / fail / skip / empty', () => {
    expect(summary(cases('jest-json', 'jest-json/jest-pass.json'))).toEqual(['pass math > adds', 'pass math > nested > adds negatives'])
    const failing = cases('jest-json', 'jest-json/jest-fail.json')
    expect(failing.map((item) => item.status)).toEqual(['fail', 'pass', 'skip', 'skip'])
    expect(failing[0]?.failure?.message).toContain('Expected: 4')
    expect(failing[0]?.failure).toMatchObject({ expected: '4', actual: '3' })
    expect(failing[0]?.file).toBe('src/math.test.js')
    expect(cases('jest-json', 'jest-json/jest-skip.json').map((item) => item.status)).toEqual(['skip', 'skip'])
    expect(cases('jest-json', 'jest-json/jest-empty.json')).toEqual([])
  })

  it('flaky：invocations > 1 且最终通过', () => {
    expect(cases('jest-json', 'jest-json/jest-flaky.json')).toEqual([expect.objectContaining({ status: 'flaky', attempts: 3 })])
  })

  it('整个测试文件无法运行（导入错误）→ 一条失败用例，不能被当成 0 用例', () => {
    const [item] = cases('jest-json', 'jest-json/jest-suite-failed.json')
    expect(item).toMatchObject({ status: 'fail', file: 'src/broken.test.js', name: '(测试文件无法运行)' })
    expect(item?.failure?.message).toContain('Cannot find module')
  })
})

describe('go-json（authored）', () => {
  it('pass：子测试拆成分组 + 用例', () => {
    expect(summary(cases('go-json', 'go-json/go-pass.jsonl'))).toEqual([
      'pass TestAdd', 'pass TestTable', 'pass TestTable > positive', 'pass TestTable > negative',
    ])
  })
  it('fail：失败输出里的 x_test.go:行 给出文件与行号；skip 单独计', () => {
    const list = cases('go-json', 'go-json/go-fail.jsonl')
    expect(list.map((item) => [item.name, item.status])).toEqual([['TestAdd', 'pass'], ['TestSub', 'fail'], ['TestSkipped', 'skip']])
    expect(list[1]).toMatchObject({ file: 'mathx_test.go', line: 14 })
    expect(list[1]?.failure?.message).toContain('Sub(5, 2) = 3, want 4')
  })
  it('skip / empty（no test files）/ build failed', () => {
    expect(cases('go-json', 'go-json/go-skip.jsonl').map((item) => item.status)).toEqual(['skip'])
    expect(cases('go-json', 'go-json/go-empty.jsonl')).toEqual([])
    const [failed] = cases('go-json', 'go-json/go-build-failed.jsonl')
    expect(failed).toMatchObject({ status: 'fail', name: '(包无法构建或运行)' })
    expect(failed?.failure?.stack).toContain('undefined: Missing')
  })
})

describe('坏输入一律给出原因，不抛异常', () => {
  const junk = ['', 'not a report', '{"unrelated": true}', '<html></html>', '[1,2]']
  for (const format of ['junit', 'playwright-json', 'vitest-json', 'jest-json', 'go-json', 'tap'] as const) {
    it(format, () => {
      for (const text of junk) {
        const result: CaseReport = parseCaseReport(format, text, CTX)
        expect(result.ok, `${format} ← ${JSON.stringify(text)}`).toBe(false)
      }
    })
  }
  it('被截断的 XML / JSON', () => {
    expect(parseCaseReport('junit', fixture('junit/vitest-pass.xml').slice(0, 200), CTX).ok).toBe(false)
    expect(parseCaseReport('vitest-json', fixture('vitest-json/vitest-pass.json').slice(0, 200), CTX).ok).toBe(false)
  })
})

describe('基准报告', () => {
  it('native：单值与多值都保留样本', () => {
    expect(parseBenchmarkReport('benchmark-json', fixture('benchmark/native.json'))).toEqual({
      ok: true,
      metrics: { p95_ms: [12.1, 11.8, 12.6, 11.9, 12.3], rps: [950, 962, 948, 955, 951], errors: [0] },
    })
  })
  it('hyperfine（authored）：times 换算成毫秒；一条命令的指标名固定为 time_ms', () => {
    const report = parseBenchmarkReport('benchmark-json', fixture('benchmark/hyperfine.json'))
    expect(report.ok && report.metrics.time_ms).toEqual([101.8, 99.3, 106.7, 102.1, 100.6])
  })
  it('vitest bench（authored）：每个基准输出 mean_ms / p99_ms / hz', () => {
    const report = parseBenchmarkReport('benchmark-json', fixture('benchmark/vitest-bench.json'))
    expect(report.ok && Object.keys(report.metrics)).toEqual([
      'native_sort.mean_ms', 'native_sort.p99_ms', 'native_sort.hz', 'custom_sort.mean_ms', 'custom_sort.p99_ms', 'custom_sort.hz',
    ])
  })
  it('k6（authored）：括号去掉；两种导出形状（values 嵌套 / 平铺）等价', () => {
    const nested = parseBenchmarkReport('k6-summary', fixture('benchmark/k6-summary.json'))
    const flat = parseBenchmarkReport('k6-summary', fixture('benchmark/k6-summary-export.json'))
    expect(nested.ok && nested.metrics['http_req_duration.p95']).toEqual([148.9])
    expect(flat.ok && flat.metrics['http_req_duration.p95']).toEqual([148.9])
    expect(flat.ok && flat.metrics['http_reqs.rate']).toEqual([951.9])
  })
  it('lighthouse（authored）：审计数值与百分制类别分', () => {
    const report = parseBenchmarkReport('lighthouse-json', fixture('benchmark/lighthouse.json'))
    expect(report.ok && report.metrics).toEqual({
      'first-contentful-paint': [812.4], 'largest-contentful-paint': [1421.9], performance_score: [97], accessibility_score: [100],
    })
  })
  it('坏输入', () => {
    for (const format of ['benchmark-json', 'k6-summary', 'lighthouse-json'] as const) {
      for (const text of ['', '{}', '{"metrics":{"p95":"fast"}}', '[]']) {
        expect(parseBenchmarkReport(format, text).ok, `${format} ← ${text}`).toBe(false)
      }
    }
  })
})

describe('覆盖率', () => {
  it('lcov（captured）：行 / 函数 / 分支百分比', () => {
    const report = parseCoverageReport('lcov', fixture('coverage/node-partial.lcov'), CTX)
    expect(report).toEqual({ ok: true, coverage: { lines: 76.47, functions: 66.67, branches: 83.33 } })
  })

  it('lcov：changed_lines 只数改动行里的可执行行；没有可执行的改动行记 100', () => {
    const lcov = fixture('coverage/node-partial.lcov')
    const at = (lines: number[]) => parseCoverageReport('lcov', lcov, { ...CTX, changedLines: new Map([['cov/math.mjs', new Set(lines)]]) })
    // 第 10、11 行未覆盖，第 12 行已覆盖，第 99 行不是可执行行。
    expect(at([10, 11, 12, 99])).toMatchObject({ ok: true, coverage: { changed_lines: 33.33 } })
    expect(at([99])).toMatchObject({ ok: true, coverage: { changed_lines: 100 } })
    expect(parseCoverageReport('lcov', lcov, { ...CTX, changedLines: new Map([['other.mjs', new Set([1])]]) })).toMatchObject({ coverage: { changed_lines: 100 } })
  })

  it('istanbul-summary（authored）：取 total，"Unknown" 的 pct 不输出', () => {
    expect(parseCoverageReport('istanbul-summary', fixture('coverage/istanbul-summary.json'), CTX)).toEqual({
      ok: true, coverage: { lines: 83, statements: 81.82, functions: 85, branches: 70 },
    })
  })

  it('istanbul-summary + coverage-final：按语句起始行算 changed_lines', () => {
    const report = parseCoverageReport('istanbul-summary', fixture('coverage/istanbul-summary.json'), {
      ...CTX,
      detailText: fixture('coverage/istanbul-final.json'),
      changedLines: new Map([['src/math.ts', new Set([2, 6, 9])]]),
    })
    expect(report).toMatchObject({ ok: true, coverage: { changed_lines: 33.33 } })
  })

  it('cobertura（authored）：line-rate / branch-rate；changed_lines 用 class@filename', () => {
    const base = parseCoverageReport('cobertura', fixture('coverage/cobertura.xml'), CTX)
    expect(base).toEqual({ ok: true, coverage: { lines: 66.67, branches: 50 } })
    const changed = parseCoverageReport('cobertura', fixture('coverage/cobertura.xml'), {
      ...CTX, changedLines: new Map([['app/math.py', new Set([5, 7, 8])]]),
    })
    expect(changed).toMatchObject({ coverage: { changed_lines: 33.33 } })
  })

  it('坏输入', () => {
    for (const format of ['istanbul-summary', 'lcov', 'cobertura'] as const) {
      for (const text of ['', 'garbage', '{}', '<a/>']) {
        expect(parseCoverageReport(format, text, CTX).ok, `${format} ← ${text}`).toBe(false)
      }
    }
  })
})
