/**
 * 测试体系 v2 × 真实 vitest 工程（验收 A1 / A2 / A3 / A6 / A7 / A8 的 CLI 侧）。
 * 临时项目里真跑本仓安装的 vitest，经真的 buildProgram 走 discover → plan → register → run → 门禁 → transition。
 * 每个用例都有独立的临时 git 仓库；提交日期固定，「自任务起点以来」的 diff 才可复现。
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { freshHarness, type Harness } from './integration-harness.js'
import { VITEST_FILES, commitAll, initGit, linkNodeModules, writeFiles } from './integration-harness-tests.js'

const USER = { TENON_USER: 'a@x.io', TENON_USER_NAME: 'A', TENON_TEST_REAL_DIFF: '1', TENON_TEST_TICKING_CLOCK: '1' }
const SLUG = 'a-at-x.io'

interface PolicyJson {
  pass: boolean
  blockers: string[]
  policy?: {
    chain: string
    blockers: Array<{ code: string; blocking: boolean; message: string; fix?: string; subject?: string }>
    notices: Array<{ code: string; message: string; fix?: string }>
    suites: Array<{ suite: string; state: string; totals?: { cases: number; pass: number; fail: number; flaky: number; known_fail: number } }>
    files: { checked: boolean; unregistered: Array<{ path: string }>; orphans: string[] }
    trace: Array<{ covers: string; state: string }>
  }
}

function workflow(options: { specKinds?: string; flakyMax?: number; scenarios?: string } = {}): string {
  return `name: tested
tracks:
  backend:
    steps:
      - id: spec
        label: 规格
        gate: null
        skills: []
        inputs: []
        outputs: []
        guards: []
        test_policy:
          plan: required
          kinds: [${options.specKinds ?? 'unit'}]
        transitions:
          - event: spec-done
            to: build
      - id: build
        label: 实现
        gate: null
        skills: []
        inputs: []
        outputs: []
        guards: []
        test_policy:
          run: [unit]
          scope: changed
          files: registered
          flaky: { max: ${options.flakyMax ?? 1}, fail_on_new: false }
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
          files: registered
          scenarios: ${options.scenarios ?? 'off'}
        transitions: []
`
}

const FLAKY_TEST = `import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { expect, test } from 'vitest'
test('flaky once', () => {
  mkdirSync('test-results', { recursive: true })
  if (!existsSync('test-results/.flaky-marker')) {
    writeFileSync('test-results/.flaky-marker', '1')
    throw new Error('first attempt fails')
  }
  expect(true).toBe(true)
})
`

const FAILING_TEST = (name: string): string => `import { expect, test } from 'vitest'\ntest('${name}', () => { expect(1).toBe(2) })\n`
const PASSING_TEST = (name: string): string => `import { expect, test } from 'vitest'\ntest('${name}', () => { expect(1).toBe(1) })\n`

describe('测试体系 v2 · vitest 工程', () => {
  let h: Harness | undefined
  afterEach(async () => { if (h) await rm(h.cwd, { recursive: true, force: true }); h = undefined })

  async function project(options: Parameters<typeof workflow>[0] = {}): Promise<Harness> {
    const harness = await freshHarness()
    h = harness
    await writeFiles(harness.cwd, VITEST_FILES)
    await linkNodeModules(harness.cwd)
    initGit(harness.cwd)
    commitAll(harness.cwd, 'base', '2026-01-01T00:00:00Z')
    await mkdir(join(harness.cwd, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(harness.cwd, '.pipeline', 'workflows', 'tested.yaml'), workflow(options), 'utf8')
    expect(await harness.run(['init', 'demo', '--track', 'backend', '--workflow', 'tested', '--preset', 'full'], { env: USER }), harness.err.join('\n')).toBe(0)
    return harness
  }

  const tenon = (...args: string[]): Promise<number> => (h as Harness).run(args, { env: USER })
  const out = (): string => (h as Harness).out.join('\n')
  const err = (): string => (h as Harness).err.join('\n')
  const cwd = (): string => (h as Harness).cwd
  async function status(step: string): Promise<{ code: number; json: PolicyJson }> {
    const code = await tenon('test', 'status', 'demo', '--step', step, '--json')
    return { code, json: JSON.parse(out()) as PolicyJson }
  }
  const codes = (json: PolicyJson): string[] => (json.policy?.blockers ?? []).filter((item) => item.blocking).map((item) => item.code)
  async function recordFiles(): Promise<string[]> {
    return (await readdir(join(cwd(), '.tenon', 'users', SLUG, 'tests', 'demo'))).sort()
  }
  async function lastRecord(): Promise<{ result: string; suites: Array<{ suite: string; result: string; reasons: Array<{ code: string; detail?: string }>; scope: string; totals: Record<string, number>; cases: Array<{ file: string; name: string; status: string; attempts: number }>; selection: string[] }> }> {
    const files = await recordFiles()
    const records = await Promise.all(files.map(async (file) => JSON.parse(await readFile(join(cwd(), '.tenon', 'users', SLUG, 'tests', 'demo', file), 'utf8')) as { finished_at: string }))
    const newest = [...records].sort((left, right) => (left.finished_at < right.finished_at ? -1 : 1)).at(-1)
    return newest as unknown as Awaited<ReturnType<typeof lastRecord>>
  }

  test('A1：缺目录 → 缺计划 → 缺种类，spec 出口被挡且原因可读；补齐后放行', async () => {
    await project({ specKinds: 'unit, playwright' })
    let current = await status('spec')
    expect(current.code).toBe(2)
    expect(codes(current.json)).toEqual(['test-catalog-missing', 'test-plan-missing'])
    expect(current.json.blockers[0]).toContain('tenon test discover --write')
    expect(await tenon('transition', 'demo', 'spec-done')).not.toBe(0)
    expect(err()).toContain('tenon test discover --write')

    expect(await tenon('test', 'discover', '--write'), err()).toBe(0)
    expect(out()).toContain('unit  unit/vitest')
    current = await status('spec')
    expect(codes(current.json)).toContain('test-plan-missing')
    expect(current.json.policy?.blockers.find((item) => item.code === 'test-plan-missing')?.fix).toBe('tenon test plan demo --seed')

    expect(await tenon('test', 'plan', 'demo', '--seed'), err()).toBe(0)
    expect(out()).toContain('策略要求 playwright 测试')
    current = await status('spec')
    expect(codes(current.json)).toEqual(['test-kind-missing'])
    expect(current.json.policy?.blockers[0]).toMatchObject({ subject: 'playwright', fix: expect.stringContaining('tenon test waive demo --kind playwright') })

    expect(await tenon('test', 'waive', 'demo', '--kind', 'playwright', '--reason', '本任务没有浏览器界面'), err()).toBe(0)
    current = await status('spec')
    expect(codes(current.json)).toEqual(['waiver-unapproved'])
  }, 120_000)

  test('A1：策略只要求 unit 时，discover + plan --seed 之后 spec 放行并能 transition', async () => {
    await project()
    expect(await tenon('test', 'discover', '--write'), err()).toBe(0)
    expect(await tenon('test', 'plan', 'demo', '--seed'), err()).toBe(0)
    expect((await status('spec')).code).toBe(0)
    expect(await tenon('transition', 'demo', 'spec-done'), err()).toBe(0)
  }, 120_000)

  test('A2：build 新增测试文件不登记 → 挡；登记并运行、报告里出现该文件的用例才放行', async () => {
    await project()
    await tenon('test', 'discover', '--write')
    await tenon('test', 'plan', 'demo', '--seed')
    await tenon('transition', 'demo', 'spec-done')
    await writeFile(join(cwd(), 'src', 'extra.test.ts'), PASSING_TEST('extra works'), 'utf8')

    expect(await tenon('test', 'sync', 'demo')).toBe(2)
    expect(out()).toContain('未登记  src/extra.test.ts')
    expect(out()).toContain('tenon test register demo --file src/extra.test.ts --suite unit')
    expect(await tenon('test', 'run', 'demo', '--suite', 'unit')).toBe(0)
    let current = await status('build')
    expect(codes(current.json)).toEqual(['test-file-unregistered'])
    expect(current.json.policy?.files.unregistered.map((item) => item.path)).toEqual(['src/extra.test.ts'])
    expect(await tenon('transition', 'demo', 'build-done')).not.toBe(0)

    expect(await tenon('test', 'register', 'demo', '--file', 'src/extra.test.ts'), err()).toBe(0)
    current = await status('build')
    expect(codes(current.json)).toEqual(['test-stale'])
    expect(await tenon('test', 'run', 'demo', '--stage', '--changed'), err()).toBe(0)
    const record = await lastRecord()
    expect(record.suites[0]).toMatchObject({ suite: 'unit', scope: 'changed', result: 'pass', selection: ['src/extra.test.ts'] })
    expect(record.suites[0]?.cases.map((item) => item.file)).toEqual(['src/extra.test.ts'])
    expect((await status('build')).code).toBe(0)
    expect(await tenon('test', 'sync', 'demo')).toBe(0)
    expect(await tenon('transition', 'demo', 'build-done'), err()).toBe(0)
  }, 180_000)

  test('A2：登记的文件没有出现在报告里 → registered-test-not-executed', async () => {
    await project()
    await tenon('test', 'discover', '--write')
    await tenon('test', 'plan', 'demo', '--seed')
    await tenon('transition', 'demo', 'spec-done')
    // vitest 只收 *.test.ts；这个文件被显式登记进 unit 套件却不会被执行。
    await writeFile(join(cwd(), 'src', 'ghost.spec.ts'), PASSING_TEST('ghost'), 'utf8')
    expect(await tenon('test', 'register', 'demo', '--file', 'src/ghost.spec.ts'), err()).not.toBe(0)
    expect(err()).toContain('没有套件认领')
    expect(await tenon('test', 'register', 'demo', '--file', 'src/ghost.spec.ts', '--suite', 'unit'), err()).toBe(0)
    // 运行当场就判失败：登记的文件没有出现在报告里。
    expect(await tenon('test', 'run', 'demo', '--suite', 'unit')).toBe(2)
    expect((await lastRecord()).suites[0]?.reasons.map((reason) => reason.code)).toContain('registered-test-not-executed')
    const current = await status('build')
    expect(codes(current.json)).toContain('registered-test-not-executed')
    expect(current.json.policy?.blockers.find((item) => item.code === 'registered-test-not-executed')?.message).toContain('src/ghost.spec.ts')
  }, 180_000)

  test('A3：0 用例、报告缺失、退出码与报告不符，一律判失败', async () => {
    await project()
    const write = "require('fs').mkdirSync('test-results',{recursive:true});require('fs').writeFileSync('test-results/junit.xml',"
    const suites: Array<[string, string, string]> = [
      ['empty', `node -e "${write}'<testsuites></testsuites>')"`, 'no-tests-ran'],
      ['nothing', 'node -e "0"', 'report-missing'],
      ['liar', `node -e "${write}'<testsuites><testsuite name=\\"a\\"><testcase classname=\\"a.test.ts\\" name=\\"x\\"><failure message=\\"boom\\"/></testcase></testsuite></testsuites>')"`, 'exit-report-mismatch'],
      ['exit-only', `node -e "${write}'<testsuites><testsuite name=\\"a\\"><testcase classname=\\"a.test.ts\\" name=\\"x\\"/></testsuite></testsuites>');process.exit(3)"`, 'exit-report-mismatch'],
    ]
    for (const [id, command, code] of suites) {
      expect(await tenon('test', 'catalog', 'add', id, '--kind', 'unit', '--runner', 'vitest', '--command', command, '--report-format', 'junit', '--report-path', 'test-results/junit.xml'), err()).toBe(0)
      expect(await tenon('test', 'run', 'demo', '--suite', id), `${id}\n${out()}\n${err()}`).toBe(2)
      const record = await lastRecord()
      expect(record.suites[0]?.reasons.map((reason) => reason.code), id).toContain(code)
      expect(record.suites[0]?.result, id).toBe('fail')
    }
    // npm test 式的「exit 0」：既没有报告也没有用例。
    expect(await tenon('test', 'catalog', 'add', 'truthy', '--kind', 'unit', '--runner', 'vitest', '--command', 'exit 0', '--report-format', 'junit', '--report-path', 'test-results/junit.xml')).toBe(0)
    expect(await tenon('test', 'run', 'demo', '--suite', 'truthy')).toBe(2)
    expect((await lastRecord()).suites[0]?.reasons.map((reason) => reason.code)).toContain('report-missing')
  }, 240_000)

  test('A6：已知失败清单里的用例失败不挡；新失败挡；已修好提示移出；过期按普通失败', async () => {
    await project()
    await tenon('test', 'discover', '--write')
    await writeFile(join(cwd(), 'src', 'broken.test.ts'), FAILING_TEST('known bug'), 'utf8')
    expect(await tenon('test', 'run', 'demo', '--suite', 'unit')).toBe(2)
    expect(out()).toContain('src/broken.test.ts › known bug')

    expect(await tenon('test', 'known', 'add', '--suite', 'unit', '--test', 'src/broken.test.ts › known bug', '--reason', '等上游修复', '--expires', '2026-07-20', '--link', 'https://example.com/issues/12'), err()).toBe(0)
    expect(await tenon('test', 'run', 'demo', '--suite', 'unit'), `${out()}\n${err()}`).toBe(0)
    let record = await lastRecord()
    expect(record.suites[0]?.totals).toMatchObject({ fail: 0, known_fail: 1 })
    expect(record.suites[0]?.cases.find((item) => item.name === 'known bug')?.status).toBe('known-fail')

    await writeFile(join(cwd(), 'src', 'newbug.test.ts'), FAILING_TEST('brand new bug'), 'utf8')
    expect(await tenon('test', 'run', 'demo', '--suite', 'unit')).toBe(2)
    record = await lastRecord()
    expect(record.suites[0]?.cases.filter((item) => item.status === 'fail').map((item) => item.name)).toEqual(['brand new bug'])
    await rm(join(cwd(), 'src', 'newbug.test.ts'))

    await writeFile(join(cwd(), 'src', 'broken.test.ts'), PASSING_TEST('known bug'), 'utf8')
    expect(await tenon('test', 'run', 'demo', '--suite', 'unit')).toBe(0)
    expect(out()).toContain('已通过，移出清单')
    expect(out()).toContain("tenon test known rm --suite unit --test 'src/broken.test.ts › known bug'")

    await writeFile(join(cwd(), 'src', 'broken.test.ts'), FAILING_TEST('known bug'), 'utf8')
    await writeFile(join(cwd(), '.tenon', 'tests', 'known-failures.yaml'), [
      'schema: tenon-known-failures/v1', 'entries:', '  - suite: unit', '    test: "src/broken.test.ts › known bug"',
      '    reason: 等上游修复', '    expires: 2026-01-01', '    added_by: a@x.io', '',
    ].join('\n'), 'utf8')
    expect(await tenon('test', 'run', 'demo', '--suite', 'unit')).toBe(2)
    expect(out()).toContain('过期，按普通失败处理')
    expect(await tenon('test', 'known', 'list')).toBe(0)
    expect(out()).toContain('[已过期]')
    expect(await tenon('test', 'known', 'rm', '--suite', 'unit', '--test', 'src/broken.test.ts › known bug')).toBe(0)
  }, 240_000)

  test('A7：重试后通过的用例标 flaky 并计数；超过策略上限被挡', async () => {
    await project({ flakyMax: 0 })
    await tenon('test', 'discover', '--write')
    await tenon('test', 'plan', 'demo', '--seed')
    await tenon('transition', 'demo', 'spec-done')
    expect(await tenon('test', 'catalog', 'set', 'unit', '--retries', '1'), err()).toBe(0)
    await writeFile(join(cwd(), 'src', 'flaky.test.ts'), FLAKY_TEST, 'utf8')
    await tenon('test', 'register', 'demo', '--file', 'src/flaky.test.ts')
    await rm(join(cwd(), 'test-results', '.flaky-marker'), { force: true })
    expect(await tenon('test', 'run', 'demo', '--stage'), `${out()}\n${err()}`).toBe(2)
    const record = await lastRecord()
    const flaky = record.suites[0]?.cases.find((item) => item.name === 'flaky once')
    expect(flaky).toMatchObject({ status: 'flaky', attempts: 2 })
    expect(record.suites[0]?.totals).toMatchObject({ flaky: 1, fail: 0 })
    expect(record.suites[0]?.reasons.map((reason) => reason.code)).toContain('flaky-over-limit')
    const current = await status('build')
    expect(codes(current.json)).toContain('flaky-over-limit')
    expect(out()).toContain('flaky')
  }, 240_000)

  test('A7：flaky 在上限内不挡', async () => {
    await project({ flakyMax: 2 })
    await tenon('test', 'discover', '--write')
    await tenon('test', 'plan', 'demo', '--seed')
    await tenon('transition', 'demo', 'spec-done')
    await tenon('test', 'catalog', 'set', 'unit', '--retries', '1')
    await writeFile(join(cwd(), 'src', 'flaky.test.ts'), FLAKY_TEST, 'utf8')
    await tenon('test', 'register', 'demo', '--file', 'src/flaky.test.ts')
    await rm(join(cwd(), 'test-results', '.flaky-marker'), { force: true })
    expect(await tenon('test', 'run', 'demo', '--stage'), `${out()}\n${err()}`).toBe(0)
    expect((await lastRecord()).suites[0]?.totals).toMatchObject({ flaky: 1 })
    expect((await status('build')).code).toBe(0)
  }, 240_000)

  test('A8：手工改动记录 → 链断，视为未运行；重跑另起新链。手改计划 → test-plan-tampered', async () => {
    await project()
    await tenon('test', 'discover', '--write')
    await tenon('test', 'plan', 'demo', '--seed')
    await tenon('transition', 'demo', 'spec-done')
    expect(await tenon('test', 'run', 'demo', '--stage'), `${out()}\n${err()}`).toBe(0)
    expect((await status('build')).code).toBe(0)

    const file = join(cwd(), '.tenon', 'users', SLUG, 'tests', 'demo', (await recordFiles())[0] ?? '')
    const record = JSON.parse(await readFile(file, 'utf8')) as { suites: Array<{ totals: { pass: number } }> }
    record.suites[0]!.totals.pass = 99
    await writeFile(file, JSON.stringify(record, null, 2), 'utf8')
    const broken = await status('build')
    expect(codes(broken.json)).toContain('record-chain-broken')
    expect(broken.json.policy?.suites[0]?.state).toBe('missing')

    expect(await tenon('test', 'run', 'demo', '--stage'), `${out()}\n${err()}`).toBe(0)
    expect(out()).toContain('已另起新链')
    expect((await status('build')).code).toBe(0)

    const planFile = join(cwd(), 'openspec', 'changes', 'demo', 'test-plan.yaml')
    await writeFile(planFile, `${await readFile(planFile, 'utf8')}# 手改\n`, 'utf8')
    expect(codes((await status('build')).json)).toContain('test-plan-tampered')
    expect(await tenon('test', 'register', 'demo', '--suite', 'unit')).toBe(1)
    expect(err()).toContain('tenon test plan demo --seed')
    expect(await tenon('test', 'plan', 'demo', '--seed')).toBe(0)
    expect(out()).toContain('旧计划文件被手工改动过')
  }, 240_000)
})
