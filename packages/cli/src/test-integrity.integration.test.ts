/**
 * 测试完整性报告的端到端场景（v0.3 differentiation）：真的 buildProgram、真落盘的运行记录、临时版本库。
 * 项目里的测试"套件"是一小段 node 脚本，按 cases.txt / skips.txt 产出 JUnit 报告，所以不依赖任何测试框架。
 * 覆盖：十种信号里由运行记录给出的两种（用例数下降、跳过数上升）和由 diff 给出的八种；
 * notice（缺省）只提示不挡，integrity: block 把同样的信号变成阻塞，还原之后放行。
 */
import { rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { freshHarness, type Harness } from './integration-harness.js'
import { commitAll, git, writeFiles } from './integration-harness-tests.js'

const USER = { TENON_USER: 'a@x.io', TENON_USER_NAME: 'A', TENON_TEST_REAL_DIFF: '1', TENON_TEST_TICKING_CLOCK: '1' }

function workflow(integrity: string): string {
  return `name: integ
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
${integrity === '' ? '' : `          integrity: ${integrity}\n`}        transitions:
          - event: build-done
            to: verify
      - id: verify
        label: 验证
        gate: null
        skills: []
        inputs: []
        outputs: []
        guards: []
        transitions: []
`
}

const CATALOG = `schema: tenon-test-catalog/v1
suites:
  - id: unit
    kind: unit
    runner: custom
    command: node gen-report.mjs
    files: ["src/**/*.test.js"]
    report: { format: junit, path: test-results/unit.xml }
    artifacts: [test-results/unit.xml]
`

const GEN_REPORT = `import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
const cases = Number(readFileSync('cases.txt', 'utf8'))
const skips = Number(readFileSync('skips.txt', 'utf8'))
mkdirSync('test-results', { recursive: true })
let body = ''
for (let index = 0; index < cases; index++) {
  body += '<testcase name="c' + index + '" classname="t" file="src/a.test.js">' + (index < skips ? '<skipped/>' : '') + '</testcase>'
}
writeFileSync('test-results/unit.xml', '<?xml version="1.0"?><testsuites><testsuite name="t" tests="' + cases + '">' + body + '</testsuite></testsuites>')
`

const A_TEST = `it('one', () => { expect(1).toBe(1) })
it('two', () => { expect(2).toBe(2); expect(3).toBe(3) })
it('three', () => { expect(4).toBe(4) })
`
const B_TEST = `it('b', () => {
  expect(1).toBe(1)
  expect(2).toBe(2)
  expect(3).toBe(3)
})
`

interface IntegrityJson {
  pass: boolean
  mode: 'notice' | 'block'
  state: 'ok' | 'unavailable'
  signals: Array<{ code: string; subject: string; detail: string; suite?: string }>
}
interface StatusJson {
  pass: boolean
  policy?: {
    blockers: Array<{ code: string; blocking: boolean; message: string; fix?: string }>
    notices: Array<{ code: string; message: string; fix?: string }>
    integrity?: { mode: string; signals: Array<{ code: string; subject: string }> }
  }
}

describe('测试完整性报告', () => {
  let h: Harness | undefined
  afterEach(async () => { if (h) await rm(h.cwd, { recursive: true, force: true }); h = undefined })

  /** 基线提交：目录、脚本、测试文件、快照、基线、覆盖率配置；任务在提交之后创建，所以「本任务 diff」起点干净。 */
  async function project(integrity: string): Promise<Harness> {
    const harness = await freshHarness()
    h = harness
    await writeFiles(harness.cwd, {
      'package.json': '{ "name": "fixture", "private": true, "type": "module" }\n',
      '.gitignore': 'test-results\nopenspec\n.tenon/users\n.pipeline-*\n.pipeline/cache\n.pipeline/.gitignore\n.tenon/.gitignore\n',
      'cases.txt': '5\n',
      'skips.txt': '0\n',
      'gen-report.mjs': GEN_REPORT,
      'src/a.test.js': A_TEST,
      'src/b.test.js': B_TEST,
      'src/c.test.js': "it('c', () => { expect(1).toBe(1) })\n",
      'src/__snapshots__/a.test.js.snap': 'exports[`one 1`] = `1`;\n',
      '.tenon/tests/baselines/bench.json': '{"median":10}\n',
      'vitest.config.js': 'export default { coverage: { thresholds: { lines: 80 } } }\n',
      '.tenon/tests/catalog.yaml': CATALOG,
      '.pipeline/workflows/integ.yaml': workflow(integrity),
    })
    git(harness.cwd, ['init', '-q', '-b', 'main'])
    commitAll(harness.cwd, 'base', '2026-01-01T00:00:00Z')
    expect(await harness.run(['init', 'demo', '--track', 'backend', '--workflow', 'integ', '--preset', 'full'], { env: USER }), harness.err.join('\n')).toBe(0)
    return harness
  }

  const tenon = (...args: string[]): Promise<number> => (h as Harness).run(args, { env: USER })
  const out = (): string => (h as Harness).out.join('\n')
  const err = (): string => (h as Harness).err.join('\n')
  const cwd = (): string => (h as Harness).cwd
  const put = (path: string, text: string): Promise<void> => writeFile(join(cwd(), path), text, 'utf8')

  async function integrity(): Promise<{ code: number; json: IntegrityJson }> {
    const code = await tenon('test', 'integrity', 'demo', '--json')
    return { code, json: JSON.parse(out()) as IntegrityJson }
  }
  async function status(): Promise<{ code: number; json: StatusJson }> {
    const code = await tenon('test', 'status', 'demo', '--step', 'build', '--json')
    return { code, json: JSON.parse(out()) as StatusJson }
  }
  const signalKeys = (json: IntegrityJson): string[] => json.signals.map((signal) => `${signal.code}:${signal.subject}`)

  /** 把八种 diff 信号一次做出来：跳过、删用例、删断言、删文件、改写快照、动基线、降门槛、新增已知失败。 */
  async function tamper(): Promise<void> {
    await put('src/a.test.js', "it.skip('one', () => { expect(1).toBe(1) })\nit('two', () => { expect(2).toBe(2) })\n")
    await put('src/b.test.js', "it('b', () => {\n  expect(1).toBe(1)\n})\n")
    await rm(join(cwd(), 'src/c.test.js'))
    await put('src/__snapshots__/a.test.js.snap', 'exports[`one 1`] = `2`;\n')
    await put('.tenon/tests/baselines/bench.json', '{"median":90}\n')
    await put('vitest.config.js', 'export default { coverage: { thresholds: { lines: 60 } } }\n')
    await put('.tenon/tests/known-failures.yaml', 'schema: tenon-known-failures/v1\nentries:\n  - suite: unit\n    test: src/a.test.js › two\n    reason: later\n    expires: 2026-07-20\n    added_by: a@x.io\n')
  }
  const ALL_DIFF_SIGNALS = [
    'test-file-deleted:src/c.test.js',
    'tests-removed:src/a.test.js',
    'test-skipped:src/a.test.js',
    'assertion-weakened:src/b.test.js',
    'snapshot-rewritten:src/__snapshots__/a.test.js.snap',
    'baseline-changed:.tenon/tests/baselines/bench.json',
    'known-failure-added:src/a.test.js › two',
    'coverage-threshold-lowered:vitest.config.js',
  ]

  test('没有改动：没有信号，exit 0', async () => {
    await project('')
    const report = await integrity()
    expect(report.code).toBe(0)
    expect(report.json).toMatchObject({ pass: true, mode: 'notice', state: 'ok', signals: [] })
  })

  test('缺省 notice：八种 diff 信号逐一报出，exit 0；测试门禁照样放行，只多一条提示', async () => {
    await project('')
    expect(await tenon('test', 'register', 'demo', '--suite', 'unit'), err()).toBe(0)
    await tamper()
    expect(await tenon('test', 'run', 'demo', '--stage'), `${out()}\n${err()}`).toBe(0)

    const report = await integrity()
    expect(report.code).toBe(0)
    expect(report.json.mode).toBe('notice')
    expect(signalKeys(report.json)).toEqual(ALL_DIFF_SIGNALS)
    expect(report.json.signals.find((signal) => signal.code === 'tests-removed')).toMatchObject({ detail: '-3 +2', suite: 'unit' })
    expect(report.json.signals.find((signal) => signal.code === 'assertion-weakened')?.detail).toBe('-2 +0')

    const current = await status()
    expect(current.code, JSON.stringify(current.json.policy?.blockers)).toBe(0)
    expect(current.json.policy?.blockers.filter((item) => item.blocking)).toEqual([])
    expect(current.json.policy?.notices).toEqual([expect.objectContaining({ code: 'test-integrity', fix: 'tenon test integrity demo' })])
    expect(current.json.policy?.integrity?.signals.map((signal) => signal.code)).toHaveLength(ALL_DIFF_SIGNALS.length)

    await tenon('test', 'integrity', 'demo')
    expect(out()).toContain('[INTEGRITY] demo step=build mode=notice signals=8')
    expect(out()).toContain('用例被跳过 src/a.test.js +1 [unit]')
  }, 120_000)

  test('运行记录：两次全量运行用例数 5 → 3、跳过数 0 → 2，报用例数下降与跳过数上升', async () => {
    await project('')
    expect(await tenon('test', 'register', 'demo', '--suite', 'unit'), err()).toBe(0)
    expect(await tenon('test', 'run', 'demo', '--stage'), `${out()}\n${err()}`).toBe(0)
    expect((await integrity()).json.signals).toEqual([])

    await put('cases.txt', '3\n')
    await put('skips.txt', '2\n')
    expect(await tenon('test', 'run', 'demo', '--stage'), `${out()}\n${err()}`).toBe(0)
    const report = await integrity()
    expect(report.json.signals).toEqual([
      { code: 'case-count-drop', subject: 'unit', detail: '5 → 3', suite: 'unit' },
      { code: 'skip-count-rise', subject: 'unit', detail: '0 → 2', suite: 'unit' },
    ])
    expect((await status()).code).toBe(0)
  }, 120_000)

  test('integrity: block：同样的信号变成阻塞（status / test integrity 都 exit 2），还原之后放行', async () => {
    await project('block')
    expect(await tenon('test', 'register', 'demo', '--suite', 'unit'), err()).toBe(0)
    await tamper()
    expect(await tenon('test', 'run', 'demo', '--stage'), `${out()}\n${err()}`).toBe(0)

    const blocked = await integrity()
    expect(blocked.code).toBe(2)
    expect(blocked.json).toMatchObject({ pass: false, mode: 'block' })
    expect(signalKeys(blocked.json)).toEqual(ALL_DIFF_SIGNALS)

    const current = await status()
    expect(current.code).toBe(2)
    expect(current.json.policy?.blockers.filter((item) => item.blocking).map((item) => item.code)).toEqual(['test-integrity'])
    expect(current.json.policy?.blockers[0]?.message).toContain('测试完整性未通过')
    expect(await tenon('transition', 'demo', 'build-done')).not.toBe(0)

    // 还原所有被削弱的文件和新增的已知失败清单，重跑：信号消失，门禁放行。
    git(cwd(), ['checkout', '-q', '--', '.'])
    await rm(join(cwd(), '.tenon/tests/known-failures.yaml'), { force: true })
    expect(await tenon('test', 'run', 'demo', '--stage'), `${out()}\n${err()}`).toBe(0)
    expect((await integrity()).json.signals).toEqual([])
    const clean = await status()
    expect(clean.code, JSON.stringify(clean.json.policy?.blockers)).toBe(0)
    expect(await readFile(join(cwd(), 'src/a.test.js'), 'utf8')).toBe(A_TEST)
  }, 120_000)

  test('不是版本库：notice 只提示未检查，block 失败关闭；运行记录类信号照常给出', async () => {
    const harness = await freshHarness()
    h = harness
    await writeFiles(harness.cwd, {
      'package.json': '{ "name": "fixture", "private": true, "type": "module" }\n',
      'cases.txt': '5\n', 'skips.txt': '0\n', 'gen-report.mjs': GEN_REPORT, 'src/a.test.js': A_TEST,
      '.tenon/tests/catalog.yaml': CATALOG, '.pipeline/workflows/integ.yaml': workflow('block'),
    })
    expect(await tenon('init', 'demo', '--track', 'backend', '--workflow', 'integ', '--preset', 'full'), err()).toBe(0)
    const report = await integrity()
    expect(report.code).toBe(2)
    expect(report.json).toMatchObject({ pass: false, state: 'unavailable', signals: [] })
  }, 120_000)
})
