/**
 * 用例报告解析器 × 真实样例。
 *
 * 样例来源（fixtures/PROVENANCE 同款说明）：
 *   captured  —— 用真实工具跑出来的原文，只把机器路径换成 /work/proj：vitest 3（json / junit）、
 *                Playwright 1.61（json / junit，含重试后 flaky 与截图 / trace 附件）、Node 24 内置 test runner
 *                （tap / junit）、Node 24 内置覆盖率（lcov）、vitest 5.0.3 的 `vitest bench --reporter=json`
 *                （benchmark/vitest5-bench.json：两个 bench 文件，含 bench.compare 与 bench.from 读回存档）；junit/node{20,22,24}-multi.xml 是 Docker 官方镜像
 *                node:20（20.20.2）/ node:22（22.23.2）/ node:24（24.21.0）在同一个三文件小项目上跑
 *                `node --test --test-reporter=junit` 的内置 reporter 输出（tests/math.test.mjs、tests/strings.test.mjs、
 *                tests/nested/deep.test.mjs，两个文件里各有一条同名的 "adds two numbers"），junit/node{20,22,24}-tenon-reporter.xml
 *                是同一项目在同样三个 Node 上用 Tenon 随附 reporter（node-test-reporter.ts）产出的报告。
 *   authored  —— 本机没有对应工具时，按该工具文档化的输出形状手写：jest-json、go test -json、cobertura、
 *                istanbul coverage-summary / coverage-final、hyperfine、vitest ≤4 bench（`--outputJson`）、k6、lighthouse、pytest 与 surefire 方言的 junit（按两个工具文档化的输出形状手写）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { UNKNOWN_CASE_FILE, casesMatchingRef, parseCaseRef } from '@tenon/kernel'
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

describe('node:test junit × Node 版本（captured）', () => {
  const TESTS = 'tests/math.test.mjs'
  const shape = (list: readonly ParsedCase[]): string[] => list.map((item) => `${item.status} ${[...item.suite_path, item.name].join(' > ')}`)
  const EXPECTED = [
    'pass adds two numbers', 'pass division > divides evenly', 'pass division > rejects zero', 'pass division > rounding > keeps fractions',
    'pass deep case', 'pass adds two numbers', 'pass formatting > trims', 'fail formatting > fails on purpose', 'skip formatting > is skipped',
  ]

  it('Node 24 内置 reporter：testcase@file 给出文件（绝对路径换算成仓库相对路径）', () => {
    const list = cases('junit', 'junit/node24-multi.xml')
    expect(shape(list)).toEqual(EXPECTED)
    expect(list.map((item) => item.file)).toEqual([
      TESTS, TESTS, TESTS, TESTS, 'tests/nested/deep.test.mjs', 'tests/strings.test.mjs', 'tests/strings.test.mjs', 'tests/strings.test.mjs', 'tests/strings.test.mjs',
    ])
    expect(list[7]?.failure?.message).toContain("'A' !== 'B'")
  })

  it.each(['node20-multi', 'node22-multi'])('%s：内置 reporter 不写 file，用例如实记为无文件，不把 classname "test" 当文件，分组与状态照常', (name) => {
    const list = cases('junit', `junit/${name}.xml`)
    expect(shape(list)).toEqual(EXPECTED)
    expect(list.every((item) => item.file === UNKNOWN_CASE_FILE)).toBe(true)
    expect(list[7]?.failure?.message).toContain("'A' !== 'B'")
    expect(list[7]?.failure?.stack).toContain('ERR_TEST_FAILURE')
  })

  it('无文件用例的占位值不被套件 cwd 改写成 <cwd>/(unknown)', () => {
    const report = parseCaseReport('junit', fixture('junit/node22-multi.xml'), { repoRoot: '/work/proj', cwd: '/work/proj/packages/web' })
    expect(report.ok && report.cases.every((item) => item.file === UNKNOWN_CASE_FILE)).toBe(true)
  })

  it.each(['node20-tenon-reporter', 'node22-tenon-reporter', 'node24-tenon-reporter'])('%s：随附 reporter 在每个 Node 上都写 file，与 Node 24 内置 reporter 解析出同样的文件、分组与状态', (name) => {
    const list = cases('junit', `junit/${name}.xml`)
    const builtin = cases('junit', 'junit/node24-multi.xml')
    const identity = (items: readonly ParsedCase[]) => items.map((item) => [item.file, item.suite_path, item.name, item.status])
    expect(identity(list)).toEqual(identity(builtin))
    expect(list[7]?.failure?.message).toContain("'A' !== 'B'")
  })

  it('登记的用例引用 × 报告：Node 22 无文件时按名字唯一才对上；同名（跨文件）对不上；Node 24 有文件则都对得上', () => {
    const identities = (path: string) => cases('junit', path).map((item) => ({ file: item.file, suite_path: item.suite_path, name: item.name }))
    const ref = (text: string) => {
      const parsed = parseCaseRef(text)
      if (parsed === undefined) throw new Error(text)
      return parsed
    }
    const legacy = identities('junit/node22-multi.xml')
    expect(casesMatchingRef(ref('tests/math.test.mjs › division › divides evenly'), legacy)).toHaveLength(1)
    expect(casesMatchingRef(ref('tests/nested/deep.test.mjs › deep case'), legacy)).toHaveLength(1)
    expect(casesMatchingRef(ref('tests/math.test.mjs › adds two numbers'), legacy)).toEqual([])
    expect(casesMatchingRef(ref('tests/math.test.mjs › not there'), legacy)).toEqual([])
    const modern = identities('junit/node24-multi.xml')
    expect(casesMatchingRef(ref('tests/math.test.mjs › adds two numbers'), modern)).toHaveLength(1)
    expect(casesMatchingRef(ref('tests/strings.test.mjs › adds two numbers'), modern)).toHaveLength(1)
    expect(casesMatchingRef(ref('tests/strings.test.mjs › division › divides evenly'), modern)).toEqual([])
  })
})

describe('junit 文件推断（authored）', () => {
  const parse = (xml: string) => {
    const report = parseCaseReport('junit', xml, CTX)
    if (!report.ok) throw new Error(report.reason)
    return report.cases
  }

  it('testcase 没有 file 时取祖先 testsuite@file', () => {
    const list = parse('<testsuites><testsuite name="math" file="/work/proj/tests/math.test.mjs"><testcase name="adds" classname="test"/><testsuite name="nested" file="/work/proj/tests/nested.mjs"><testcase name="deep" classname="test"/></testsuite></testsuite></testsuites>')
    expect(list.map((item) => [item.file, item.suite_path.join('>'), item.name])).toEqual([
      ['tests/math.test.mjs', 'math', 'adds'], ['tests/nested.mjs', 'math>nested', 'deep'],
    ])
  })

  it('describe 标题长得像文件名（utils.js）也不是文件：进分组链，文件仍是无文件', () => {
    const list = parse('<testsuites><testsuite name="utils.js" tests="1"><testcase name="parses" classname="test"/></testsuite></testsuites>')
    expect(list).toEqual([expect.objectContaining({ file: UNKNOWN_CASE_FILE, suite_path: ['utils.js'], name: 'parses' })])
  })

  it('classname 是 runner 泛称 / 分组标题（小写词、带空格）时不当文件；像类名的 classname 仍当文件', () => {
    const list = parse('<testsuites><testsuite name="suite"><testcase name="a" classname="test"/><testcase name="b" classname="should work"/><testcase name="c" classname="division.rounding"/><testcase name="d" classname="com.example.MathTest"/><testcase name="e" classname="MathTest"/></testsuite></testsuites>')
    expect(list.map((item) => item.file)).toEqual([UNKNOWN_CASE_FILE, UNKNOWN_CASE_FILE, UNKNOWN_CASE_FILE, 'com.example.MathTest', 'MathTest'])
  })

  it('testcase 没有 classname 时，像路径的 testsuite@name 仍是文件（每个文件一个 testsuite 的方言）', () => {
    const list = parse('<testsuites><testsuite name="src/a.test.ts"><testcase name="works"/></testsuite></testsuites>')
    expect(list).toEqual([expect.objectContaining({ file: 'src/a.test.ts', suite_path: [] })])
  })

  it('testsuite 自己出错：有 file 用 file；describe 标题不当文件', () => {
    expect(parse('<testsuite name="crash" file="/work/proj/crash.test.js"><error message="boom"/></testsuite>')[0]?.file).toBe('crash.test.js')
    expect(parse('<testsuites><testsuite name="before hook"><failure message="hook failed"/></testsuite></testsuites>')[0]?.file).toBe(UNKNOWN_CASE_FILE)
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

  it('surefire fixtures：pass / fail / empty；failure、error 都算失败，带 <skipped> 算跳过，重试后仍失败的用例记重试次数', () => {
    const passing = cases('junit', 'junit/surefire-pass.xml')
    expect(passing.map((item) => [item.name, item.status, item.file])).toEqual([
      ['adds', 'pass', 'com.example.MathTest'], ['subtracts', 'pass', 'com.example.MathTest'],
    ])
    const failing = cases('junit', 'junit/surefire-fail.xml')
    expect(failing.map((item) => [item.name, item.status, item.attempts])).toEqual([
      ['adds', 'pass', 1], ['subtracts', 'fail', 1], ['divides', 'fail', 1], ['later', 'skip', 1], ['stubborn', 'fail', 3],
    ])
    expect(failing[1]?.failure?.message).toBe('expected: <4> but was: <3>')
    expect(failing[1]?.failure?.stack).toContain('MathTest.java:18')
    expect(failing[2]?.failure?.message).toBe('/ by zero')
    expect(cases('junit', 'junit/surefire-empty.xml')).toEqual([])
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
  it('vitest 5 bench（captured）：json reporter 用例上的 benchmarks.tasks → 与 vitest ≤4 同名的 mean_ms / p99_ms / hz', () => {
    const report = parseBenchmarkReport('benchmark-json', fixture('benchmark/vitest5-bench.json'))
    expect(report.ok && Object.keys(report.metrics)).toEqual([
      'split.mean_ms', 'split.p99_ms', 'split.hz', 'JSON.parse.mean_ms', 'JSON.parse.p99_ms', 'JSON.parse.hz',
      'JSON.parse_again.mean_ms', 'JSON.parse_again.p99_ms', 'JSON.parse_again.hz',
      'native_sort.mean_ms', 'native_sort.p99_ms', 'native_sort.hz', 'reverse_sort.mean_ms', 'reverse_sort.p99_ms', 'reverse_sort.hz',
    ])
  })
  it('vitest 5 bench（captured）：mean / p99 取 latency（毫秒），hz 取 throughput.mean；每个指标一个样本', () => {
    const report = parseBenchmarkReport('benchmark-json', fixture('benchmark/vitest5-bench.json'))
    expect(report.ok && report.metrics['native_sort.mean_ms']).toEqual([0.0011085233727158317])
    expect(report.ok && report.metrics['native_sort.p99_ms']).toEqual([0.0002910000000042601])
    expect(report.ok && report.metrics['native_sort.hz']).toEqual([12469987.146848354])
    expect(report.ok && report.metrics['reverse_sort.mean_ms']).toEqual([0.0006503033775236986])
    expect(report.ok && Object.values(report.metrics).every((samples) => samples.length === 1 && (samples[0] ?? 0) > 0)).toBe(true)
  })
  it('vitest 5 bench（captured）：bench.from() 读回的存档（fromStore）不是这次测的，不进指标', () => {
    const report = parseBenchmarkReport('benchmark-json', fixture('benchmark/vitest5-bench.json'))
    expect(report.ok && Object.keys(report.metrics).some((name) => name.startsWith('stored_parse'))).toBe(false)
  })
  it('vitest 5 的 json reporter 没跑出 benchmarks（普通 vitest run 的报告）→ 明确失败，不当成没有指标的成功', () => {
    const report = parseBenchmarkReport('benchmark-json', fixture('vitest-json/vitest-pass.json'))
    expect(report.ok).toBe(false)
    expect(!report.ok && report.reason).toContain('vitest 5 bench')
  })
  it('vitest 5 bench：缺 latency / throughput 的 task 只丢缺的那项，一项都没有则失败', () => {
    const task = (body: object): string => JSON.stringify({ testResults: [{ assertionResults: [{ benchmarks: [{ name: 'g', tasks: [{ name: 'a b', ...body }] }] }] }] })
    const partial = parseBenchmarkReport('benchmark-json', task({ latency: { mean: 2 }, throughput: { mean: 'x' } }))
    expect(partial.ok && partial.metrics).toEqual({ 'a_b.mean_ms': [2] })
    expect(parseBenchmarkReport('benchmark-json', task({})).ok).toBe(false)
    expect(parseBenchmarkReport('benchmark-json', JSON.stringify({ testResults: [] })).ok).toBe(false)
  })
  describe('重名的基准不能悄悄互相覆盖：判解析失败并点名', () => {
    const task = (name: string, mean = 1, extra: object = {}): object => ({ name, latency: { mean, p99: mean * 2 }, throughput: { mean: 1000 / mean }, ...extra })
    const v5 = (...files: Array<{ file: string; benches: Array<{ name: string; tasks: object[] }> }>): string => JSON.stringify({
      testResults: files.map(({ file, benches }) => ({ name: `/work/proj/${file}`, assertionResults: benches.map((bench) => ({ benchmarks: [bench] })) })),
    })
    const v4 = (...groups: Array<{ file: string; group: string; benchmarks: object[] }>): string => JSON.stringify({
      files: groups.map(({ file, group, benchmarks }) => ({ filepath: `/work/proj/${file}`, groups: [{ fullName: `${file} > ${group}`, benchmarks }] })),
    })

    it('vitest 5：不同测试里的同名基准 → 失败，点名基准名与两处位置', () => {
      const report = parseBenchmarkReport('benchmark-json', v5(
        { file: 'a.bench.ts', benches: [{ name: 'parsing > fast', tasks: [task('parse', 1)] }] },
        { file: 'sub/b.bench.ts', benches: [{ name: 'other > case', tasks: [task('parse', 2)] }] },
      ))
      expect(report.ok).toBe(false)
      const reason = report.ok ? '' : report.reason
      expect(reason).toContain("'parse'（2 处：a.bench.ts > parsing > fast、b.bench.ts > other > case）")
      expect(reason).toContain('重名')
    })

    it('vitest 5：同一个测试里 run 了两次同名基准 → 同样失败', () => {
      const report = parseBenchmarkReport('benchmark-json', v5({ file: 'a.bench.ts', benches: [{ name: 'g', tasks: [task('x')] }, { name: 'g', tasks: [task('x')] }] }))
      expect(report.ok).toBe(false)
      expect(!report.ok && report.reason).toContain("'x'（2 处")
    })

    it('vitest 5：名字只有标点不同（native sort / native_sort）清洗后撞名 → 失败，点名清洗后的指标名', () => {
      const report = parseBenchmarkReport('benchmark-json', v5({ file: 'a.bench.ts', benches: [{ name: 'g', tasks: [task('native sort'), task('native_sort')] }] }))
      expect(report.ok).toBe(false)
      expect(!report.ok && report.reason).toContain("'native_sort'")
    })

    it('vitest 5：同名超过 3 组只列前 3 组并给总数', () => {
      const names = ['a', 'b', 'c', 'd']
      const report = parseBenchmarkReport('benchmark-json', v5({ file: 'a.bench.ts', benches: [{ name: 'g', tasks: [...names, ...names].map((name) => task(name)) }] }))
      expect(report.ok).toBe(false)
      expect(!report.ok && report.reason).toContain('等 4 个')
      expect(!report.ok && report.reason).not.toContain("'d'")
    })

    it('vitest 5：不撞名的照常解析；bench.from() 存档（fromStore）与实测同名不算撞；没有任何统计的 task 不占名字', () => {
      const report = parseBenchmarkReport('benchmark-json', v5({
        file: 'a.bench.ts',
        benches: [
          { name: 'g', tasks: [task('same', 1, { fromStore: true }), task('same', 3), { name: 'empty' }, { name: 'empty' }] },
          { name: 'h', tasks: [task('other', 5)] },
        ],
      }))
      expect(report.ok && Object.keys(report.metrics)).toEqual(['same.mean_ms', 'same.p99_ms', 'same.hz', 'other.mean_ms', 'other.p99_ms', 'other.hz'])
      expect(report.ok && report.metrics['same.mean_ms']).toEqual([3])
    })

    it('vitest ≤4：不同 describe 里的同名基准 → 失败，点名基准名与两个分组', () => {
      const bench = (mean: number): object => ({ name: 'sort', mean, p99: mean * 2, hz: 1000 / mean })
      const report = parseBenchmarkReport('benchmark-json', v4(
        { file: 'a.bench.ts', group: 'ascending', benchmarks: [bench(1)] },
        { file: 'a.bench.ts', group: 'descending', benchmarks: [bench(2)] },
      ))
      expect(report.ok).toBe(false)
      expect(!report.ok && report.reason).toContain("'sort'（2 处：a.bench.ts > ascending、a.bench.ts > descending）")
    })

    it('vitest ≤4：名字唯一时行为不变（authored 夹具仍解析出全部六个指标）', () => {
      const report = parseBenchmarkReport('benchmark-json', fixture('benchmark/vitest-bench.json'))
      expect(report.ok && Object.keys(report.metrics).length).toBe(6)
    })
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
