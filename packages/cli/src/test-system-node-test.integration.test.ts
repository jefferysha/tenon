/**
 * 测试体系 v2 × 真实 node:test 工程：discover 给出的预设命令在 `tenon test run` 下产出带 file 的 JUnit（与运行它的 Node 版本无关），
 * 以及报告里的用例没有文件归属（Node 22 及以前内置 junit reporter 的形状）时，登记的用例引用按名字唯一对、对不上就挡。
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { freshHarness, type Harness } from './integration-harness.js'
import { commitAll, initGit, writeFiles } from './integration-harness-tests.js'

const USER = { TENON_USER: 'a@x.io', TENON_USER_NAME: 'A', TENON_TEST_REAL_DIFF: '1', TENON_TEST_TICKING_CLOCK: '1' }
const SLUG = 'a-at-x.io'

const SPEC = '## ADDED Requirements\n### Requirement: 除法\n#### Scenario: 整除\n- WHEN 6 除以 3\n'
const TASKS = '## 1. Build\n- [ ] 1.1 实现除法\n'

const NODE_PROJECT: Readonly<Record<string, string>> = {
  'package.json': '{ "name": "fixture", "private": true, "type": "module", "scripts": { "test": "node --test" } }\n',
  'lib/math.mjs': 'export const div = (a, b) => a / b\n',
  'tests/math.test.mjs': [
    "import { test, describe, it } from 'node:test'",
    "import assert from 'node:assert/strict'",
    "import { div } from '../lib/math.mjs'",
    "test('adds two numbers', () => { assert.equal(1 + 2, 3) })",
    "describe('division', () => {",
    "  it('divides evenly', () => { assert.equal(div(6, 3), 2) })",
    '})',
    '',
  ].join('\n'),
  'tests/strings.test.mjs': [
    "import { test } from 'node:test'",
    "import assert from 'node:assert/strict'",
    "test('adds two numbers', () => { assert.equal('a' + 'b', 'ab') })",
    '',
  ].join('\n'),
}

/** Node 22 内置 junit reporter 的形状（真实采集见 parsers/fixtures/junit/node22-multi.xml）：没有 file，classname 恒为 test。 */
const LEGACY_REPORT = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<testsuites>',
  '\t<testcase name="adds two numbers" time="0.000405" classname="test"/>',
  '\t<testsuite name="division" time="0.001411" disabled="0" errors="0" tests="1" failures="0" skipped="0" hostname="h">',
  '\t\t<testcase name="divides evenly" time="0.000121" classname="test"/>',
  '\t</testsuite>',
  '\t<testcase name="adds two numbers" time="0.000402" classname="test"/>',
  '</testsuites>',
  '',
].join('\n')

function workflow(): string {
  return `name: traced
tracks:
  backend:
    steps:
      - id: build
        label: 实现
        gate: null
        skills: []
        inputs: []
        outputs: []
        guards: []
        test_policy:
          run: [unit]
          scope: full
          files: registered
        transitions:
          - event: build-done
            to: verify
      - id: verify
        label: 验证
        gate: null
        skills: []
        inputs: []
        outputs: []
        guards: []
        test_policy:
          run: [unit]
          scope: full
          scenarios: passing
        transitions: []
`
}

/** 仓库相对路径列表（不含 .git）。 */
async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.name === '.git') continue
    if (entry.isDirectory()) out.push(...await listFiles(root, path))
    else out.push(path)
  }
  return out
}

interface Report {
  pass: boolean
  policy?: {
    blockers: Array<{ code: string; blocking: boolean; message: string }>
    trace: Array<{ covers: string; state: string; tests: Array<{ ref: string; status: string }> }>
  }
}

interface RecordJson {
  suites: Array<{
    suite: string
    result: string
    command: string
    reasons: Array<{ code: string }>
    cases: Array<{ file: string; name: string; suite_path: string[]; status: string }>
    totals: Record<string, number>
  }>
}

describe('测试体系 v2 · node:test 工程', () => {
  let h: Harness | undefined
  afterEach(async () => { if (h) await rm(h.cwd, { recursive: true, force: true }); h = undefined })

  async function project(files: Record<string, string> = {}): Promise<Harness> {
    const harness = await freshHarness()
    h = harness
    await writeFiles(harness.cwd, { ...NODE_PROJECT, ...files })
    initGit(harness.cwd)
    commitAll(harness.cwd, 'base', '2026-01-01T00:00:00Z')
    await mkdir(join(harness.cwd, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(harness.cwd, '.pipeline', 'workflows', 'traced.yaml'), workflow(), 'utf8')
    expect(await harness.run(['init', 'demo', '--track', 'backend', '--workflow', 'traced', '--preset', 'full'], { env: USER }), harness.err.join('\n')).toBe(0)
    await writeFiles(harness.cwd, { 'openspec/changes/demo/specs/math/spec.md': SPEC, 'openspec/changes/demo/tasks.md': TASKS })
    return harness
  }

  const tenon = (...args: string[]): Promise<number> => (h as Harness).run(args, { env: USER })
  const out = (): string => (h as Harness).out.join('\n')
  const err = (): string => (h as Harness).err.join('\n')
  const cwd = (): string => (h as Harness).cwd
  async function status(step: string): Promise<Report> {
    await tenon('test', 'status', 'demo', '--step', step, '--json')
    return JSON.parse(out()) as Report
  }
  const blocking = (report: Report): string[] => (report.policy?.blockers ?? []).filter((item) => item.blocking).map((item) => item.code)
  async function lastRecord(): Promise<RecordJson> {
    const dir = join(cwd(), '.tenon', 'users', SLUG, 'tests', 'demo')
    const records = await Promise.all((await readdir(dir)).map(async (file) => JSON.parse(await readFile(join(dir, file), 'utf8')) as RecordJson & { finished_at: string }))
    return [...records].sort((left, right) => (left.finished_at < right.finished_at ? -1 : 1)).at(-1) as RecordJson
  }

  test('discover 的预设命令：tenon test run 提供带 file 的 reporter，用例落在真实文件上，登记的文件与用例按文件对上', async () => {
    await project()
    expect(await tenon('test', 'discover', '--write'), err()).toBe(0)
    expect(out()).toContain('unit  unit/node-test')
    const catalog = await readFile(join(cwd(), '.tenon', 'tests', 'catalog.yaml'), 'utf8')
    expect(catalog).toContain('TENON_NODE_TEST_REPORTER')
    for (const args of [
      ['--file', 'tests/math.test.mjs'], ['--file', 'tests/strings.test.mjs'],
      ['--case', 'spec:math/整除', '--test', 'tests/math.test.mjs › division › divides evenly'],
      ['--case', 'task:1.1', '--test', 'tests/strings.test.mjs › adds two numbers'],
    ]) expect(await tenon('test', 'register', 'demo', ...args), err()).toBe(0)

    expect(await tenon('test', 'run', 'demo', '--stage', 'verify'), `${out()}\n${err()}`).toBe(0)
    const suite = (await lastRecord()).suites[0]
    expect(suite?.result).toBe('pass')
    expect(suite?.reasons.map((reason) => reason.code) ?? []).not.toContain('registered-test-not-executed')
    // 两个文件里各有一条 "adds two numbers"：只有按文件才分得清。
    expect(suite?.cases.map((item) => [item.file, item.suite_path.join('>'), item.name]).sort()).toEqual([
      ['tests/math.test.mjs', '', 'adds two numbers'],
      ['tests/math.test.mjs', 'division', 'divides evenly'],
      ['tests/strings.test.mjs', '', 'adds two numbers'],
    ])
    // reporter 只落在本次运行自己的产物目录里（.tenon/users/<用户>/local/artifacts，Tenon 的按用户本地状态），项目其余位置一个文件都没多。
    const placed = (await listFiles(cwd())).filter((path) => path.endsWith('node-test-junit.mjs'))
    expect(placed).toHaveLength(1)
    expect(placed[0]).toMatch(new RegExp(`^\\.tenon/users/${SLUG}/local/artifacts/demo/.+/reporters/node-test-junit\\.mjs$`))
    const verify = await status('verify')
    expect(blocking(verify)).toEqual([])
    expect(verify.policy?.trace.map((row) => [row.covers, row.state])).toEqual([['spec:math/整除', 'passing'], ['task:1.1', 'passing']])
  }, 180_000)

  test('报告里的用例没有文件（Node 22 内置 reporter 的形状）：名字唯一的引用按名字对上；同名的挡下并指向随附 reporter', async () => {
    await project({ 'legacy/report.xml': LEGACY_REPORT })
    const command = 'mkdir -p test-results && cp legacy/report.xml test-results/legacy.xml'
    expect(await tenon(
      'test', 'catalog', 'add', 'unit', '--kind', 'unit', '--runner', 'node-test', '--command', command,
      '--report-format', 'junit', '--report-path', 'test-results/legacy.xml', '--file-glob', 'tests/**/*.test.mjs',
    ), err()).toBe(0)
    for (const args of [
      ['--file', 'tests/math.test.mjs', '--suite', 'unit'],
      ['--case', 'spec:math/整除', '--test', 'tests/math.test.mjs › division › divides evenly'],
    ]) expect(await tenon('test', 'register', 'demo', ...args), err()).toBe(0)

    expect(await tenon('test', 'run', 'demo', '--stage', 'verify'), `${out()}\n${err()}`).toBe(0)
    const suite = (await lastRecord()).suites[0]
    expect(suite?.result).toBe('pass')
    expect(suite?.totals).toMatchObject({ cases: 3, pass: 3 })
    // 名字对得上登记引用的无文件用例留在记录里（连同同名的），其余只进 totals。
    expect(suite?.cases.map((item) => [item.file, item.name])).toEqual([['(unknown)', 'divides evenly']])
    const verify = await status('verify')
    expect(verify.policy?.trace.find((row) => row.covers === 'spec:math/整除')).toMatchObject({ state: 'passing' })

    expect(await tenon('test', 'register', 'demo', '--case', 'task:1.1', '--test', 'tests/math.test.mjs › adds two numbers'), err()).toBe(0)
    expect(await tenon('test', 'run', 'demo', '--stage', 'verify')).toBe(2)
    const twin = (await lastRecord()).suites[0]
    expect(twin?.reasons.map((reason) => reason.code)).toContain('registered-test-not-executed')
    expect(twin?.cases.filter((item) => item.name === 'adds two numbers').map((item) => item.file)).toEqual(['(unknown)', '(unknown)'])
    const blocked = await status('verify')
    const message = (blocked.policy?.blockers ?? []).find((item) => item.code === 'registered-test-not-executed')?.message ?? ''
    expect(message).toContain('tests/math.test.mjs › adds two numbers')
    expect(message).toContain('TENON_NODE_TEST_REPORTER')
  }, 180_000)
})
