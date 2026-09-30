/**
 * 测试体系 v2 × 计划与追溯（验收 A9 及命令面）：目录命令、计划 / 登记 / 取消登记 / 豁免 / 对账、场景 → 用例的追溯矩阵
 * 写进验证报告、覆盖率门槛（含 changed_lines）、并发批次、旧步骤测试与新套件同一步骤共存（A11）、读不到 diff 的失败关闭。
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { reportCarriesRuns, TEST_REPORT_BEGIN, TEST_REPORT_END } from '@tenon/kernel'
import { afterEach, describe, expect, test } from 'vitest'
import { freshHarness, type Harness } from './integration-harness.js'
import { VITEST_FILES, commitAll, initGit, linkNodeModules, writeFiles } from './integration-harness-tests.js'

const USER = { TENON_USER: 'a@x.io', TENON_USER_NAME: 'A', TENON_TEST_REAL_DIFF: '1', TENON_TEST_TICKING_CLOCK: '1' }
const SLUG = 'a-at-x.io'
/** 验证报告在 change 目录里（openspec/ 不进候选指纹）：写报告不会让刚跑完的测试记录过期。 */
const REPORT = 'openspec/changes/demo/report.md'

interface Report {
  pass: boolean
  policy?: {
    blockers: Array<{ code: string; blocking: boolean; message: string; fix?: string; subject?: string }>
    trace: Array<{ covers: string; state: string; tests: Array<{ ref: string; status: string }> }>
    suites: Array<{ suite: string; state: string; run_id?: string; coverage?: Record<string, number> | null }>
  }
}

const SPEC = '## ADDED Requirements\n### Requirement: 登录\n#### Scenario: 登录成功\n- WHEN 输入正确\n#### Scenario: 密码错误\n- WHEN 输入错误\n'
const LOGIN_TEST = `import { expect, test, describe } from 'vitest'
describe('login', () => {
  test('登录成功', () => { expect(1).toBe(1) })
  test('密码错误', () => { expect(2).toBe(2) })
})
`

function workflow(verifyPolicy: string, extraBuild = ''): string {
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
${extraBuild}        test_policy:
          run: [unit]
          scope: changed
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
${verifyPolicy}
        transitions: []
`
}

describe('测试体系 v2 · 计划、追溯与命令面', () => {
  let h: Harness | undefined
  afterEach(async () => { if (h) await rm(h.cwd, { recursive: true, force: true }); h = undefined })

  async function project(flow: string, files: Record<string, string> = {}): Promise<Harness> {
    const harness = await freshHarness()
    h = harness
    await writeFiles(harness.cwd, { ...VITEST_FILES, ...files })
    await linkNodeModules(harness.cwd)
    initGit(harness.cwd)
    commitAll(harness.cwd, 'base', '2026-01-01T00:00:00Z')
    await mkdir(join(harness.cwd, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(harness.cwd, '.pipeline', 'workflows', 'traced.yaml'), flow, 'utf8')
    expect(await harness.run(['init', 'demo', '--track', 'backend', '--workflow', 'traced', '--preset', 'full'], { env: USER }), harness.err.join('\n')).toBe(0)
    await writeFiles(harness.cwd, { 'openspec/changes/demo/specs/auth/spec.md': SPEC, 'openspec/changes/demo/tasks.md': '## 1. Build\n- [ ] 1.1 实现登录\n' })
    return harness
  }
  const tenon = (...args: string[]): Promise<number> => (h as Harness).run(args, { env: USER })
  const out = (): string => (h as Harness).out.join('\n')
  const err = (): string => (h as Harness).err.join('\n')
  const cwd = (): string => (h as Harness).cwd
  async function report(step: string): Promise<Report> {
    await tenon('test', 'status', 'demo', '--step', step, '--json')
    return JSON.parse(out()) as Report
  }
  const blocking = (r: Report): string[] => (r.policy?.blockers ?? []).filter((item) => item.blocking).map((item) => item.code)

  test('目录命令：show / validate（带行号）/ add --from 测试方向 / set / rm，写坏的目录进不了盘', async () => {
    await project(workflow('          run: [unit]\n          scope: full'))
    // init 已经自动识别并写入了目录；这条用例要从「项目没有目录」起步，先删掉它。
    await rm(join(cwd(), '.tenon', 'tests', 'catalog.yaml'))
    expect(await tenon('test', 'catalog', 'show')).toBe(1)
    expect(await tenon('test', 'catalog', 'add', '--from', 'unit', '--runner', 'vitest', '--file-glob', 'src/**/*.test.ts'), err()).toBe(0)
    expect(await tenon('test', 'catalog', 'add', 'typecheck', '--kind', 'typecheck', '--command', 'npx tsc --noEmit'), err()).toBe(0)
    expect(await tenon('test', 'catalog', 'show')).toBe(0)
    expect(out()).toContain('unit  unit/vitest')
    expect(out()).toContain('typecheck  typecheck/tsc')
    expect(await tenon('test', 'catalog', 'show', 'unit', '--json')).toBe(0)
    expect(JSON.parse(out())).toMatchObject({ id: 'unit', runner: 'vitest', report: { format: 'vitest-json' } })
    expect(await tenon('test', 'catalog', 'add', 'unit', '--kind', 'unit', '--command', 'x', '--report-format', 'junit', '--report-path', 'test-results/x.xml')).toBe(1)
    expect(err()).toContain('已存在')
    expect(await tenon('test', 'catalog', 'add', 'bad', '--kind', 'unit', '--runner', 'vitest', '--command', 'x', '--report-format', 'junit', '--report-path', 'src/report.xml')).toBe(1)
    expect(err()).toContain('test-results')
    expect(await tenon('test', 'catalog', 'set', 'unit', '--retries', '2', '--timeout', '120'), err()).toBe(0)
    expect(await tenon('test', 'catalog', 'set', 'nope', '--retries', '2')).toBe(1)
    expect(await tenon('test', 'catalog', 'validate')).toBe(0)
    // 目录只校验写法：工作目录不存在的套件不启动进程，如实记 cwd-invalid。
    expect(await tenon('test', 'catalog', 'set', 'unit', '--cwd', 'nowhere'), err()).toBe(0)
    expect(await tenon('test', 'run', 'demo', '--suite', 'unit')).toBe(2)
    expect(out()).toContain('cwd-invalid：nowhere')
    expect(await tenon('test', 'catalog', 'set', 'unit', '--cwd', '.'), err()).toBe(0)

    const path = join(cwd(), '.tenon', 'tests', 'catalog.yaml')
    await writeFile(path, `${await readFile(path, 'utf8')}  - id: broken\n    kind: nope\n`, 'utf8')
    expect(await tenon('test', 'catalog', 'validate')).toBe(2)
    expect(err()).toMatch(/catalog\.yaml:\d+: /)
    expect(await tenon('test', 'catalog', 'set', 'unit', '--retries', '1')).toBe(1)
    expect(err()).toContain('先修好再改')
    await writeFile(path, (await readFile(path, 'utf8')).replace(/ {2}- id: broken\n {4}kind: nope\n/, ''), 'utf8')
    expect(await tenon('test', 'catalog', 'rm', 'typecheck'), err()).toBe(0)
    expect(await tenon('test', 'catalog', 'rm', 'typecheck')).toBe(1)
  }, 120_000)

  test('服务条目：add --service / 被套件引用时不能移除', async () => {
    await project(workflow('          run: [unit]\n          scope: full'))
    expect(await tenon('test', 'catalog', 'add', 'web', '--service', '--start', 'node server.mjs', '--ready-port', '5173'), err()).toBe(0)
    expect(await tenon('test', 'catalog', 'add', 'e2e', '--kind', 'playwright', '--runner', 'playwright', '--command', 'npx playwright test', '--report-format', 'playwright-json', '--report-path', 'test-results/r.json', '--uses', 'web'), err()).toBe(0)
    expect(await tenon('test', 'catalog', 'rm', 'web', '--service')).toBe(1)
    expect(err()).toContain('还被套件 e2e 引用')
    expect(await tenon('test', 'catalog', 'add', 'ghost', '--kind', 'playwright', '--runner', 'playwright', '--command', 'x', '--report-format', 'playwright-json', '--report-path', 'test-results/g.json', '--uses', 'missing')).toBe(1)
    expect(err()).toContain("引用的服务 'missing' 不存在")
  }, 120_000)

  test('A9：追溯矩阵写进验证报告；每个场景至少一个通过用例，否则被挡', async () => {
    await project(workflow('          run: [unit]\n          scope: full\n          scenarios: passing'))
    await tenon('test', 'discover', '--write')
    await writeFile(join(cwd(), 'src', 'login.test.ts'), LOGIN_TEST, 'utf8')
    await writeFile(join(cwd(), REPORT), '# 验证报告\n\n手写的内容。\n', 'utf8')
    expect(await tenon('test', 'plan', 'demo', '--seed'), err()).toBe(0)
    expect(out()).toContain("tenon test register demo --case 'spec:auth/登录成功'")
    expect(out()).toContain('待映射的场景 / 任务（3）')

    expect(await tenon('test', 'register', 'demo', '--case', 'spec:auth/不存在', '--test', 'src/login.test.ts › login › 登录成功')).toBe(1)
    expect(err()).toContain('spec:auth/登录成功')
    expect(await tenon('test', 'register', 'demo', '--case', 'spec:auth/登录成功', '--test', '../x.test.ts › y')).toBe(1)
    expect(await tenon('test', 'register', 'demo', '--case', 'spec:auth/登录成功', '--test', 'src/login.test.ts › login › 登录成功'), err()).toBe(0)
    expect(await tenon('test', 'register', 'demo', '--case', 'task:1.1', '--test', 'src/login.test.ts › login › 登录成功'), err()).toBe(0)
    expect(await tenon('test', 'run', 'demo', '--stage', 'verify'), `${out()}\n${err()}`).toBe(0)

    let current = await report('verify')
    expect(blocking(current)).toEqual(['scenario-uncovered'])
    expect(current.policy?.blockers.find((item) => item.code === 'scenario-uncovered')?.subject).toBe('spec:auth/密码错误')
    expect(current.policy?.trace.map((row) => [row.covers, row.state])).toEqual([
      ['spec:auth/登录成功', 'passing'], ['spec:auth/密码错误', 'uncovered'], ['task:1.1', 'passing'],
    ])

    expect(await tenon('test', 'waive', 'demo', '--covers', 'spec:auth/密码错误', '--reason', '本任务不改错误路径'), err()).toBe(0)
    // 计划变了，之前的运行按「计划已变化」过期；重跑之后只剩豁免未批准这一项。
    expect(blocking(await report('verify'))).toEqual(expect.arrayContaining(['test-stale', 'waiver-unapproved']))
    await tenon('test', 'run', 'demo', '--stage', 'verify')
    expect(blocking(await report('verify'))).toEqual(['waiver-unapproved'])
    expect(await tenon('test', 'unregister', 'demo', '--waiver', 'nope'), err()).toBe(1)
    expect(err()).toContain('不是测试种类')
    expect(await tenon('test', 'unregister', 'demo', '--waiver', 'spec:auth/密码错误'), err()).toBe(0)
    expect(await tenon('test', 'unregister', 'demo', '--waiver', 'spec:auth/密码错误')).toBe(1)
    expect(err()).toContain('没有匹配的条目')
    expect(await tenon('test', 'waive', 'demo', '--kind', 'benchmark', '--reason', '纯文案改动，无性能路径'), err()).toBe(0)
    expect(await tenon('test', 'unregister', 'demo', '--waiver', 'benchmark'), err()).toBe(0)
    expect(await tenon('test', 'plan', 'demo', '--json')).toBe(0)
    expect((JSON.parse(out()) as { plan: { waivers: unknown[] } }).plan.waivers).toEqual([])
    expect(await tenon('test', 'register', 'demo', '--case', 'spec:auth/密码错误', '--test', 'src/login.test.ts › login › 密码错误'), err()).toBe(0)
    await tenon('test', 'run', 'demo', '--stage', 'verify')
    current = await report('verify')
    expect(blocking(current)).toEqual([])

    expect(await tenon('test', 'report', 'demo', '--step', 'verify', '--write', REPORT), err()).toBe(0)
    const text = await readFile(join(cwd(), REPORT), 'utf8')
    expect(text).toContain('手写的内容。')
    expect(text).toContain('### 追溯矩阵')
    expect(text).toMatch(/\| auth · 登录成功 `spec:auth\/登录成功` \| `src\/login\.test\.ts › login › 登录成功` \| 通过（unit） \| 通过 \|/)
    expect(text).toContain('### 套件')
    expect(text).toMatch(/\| 单测 `unit` \| unit \| 通过 \| /)
    expect(text).toContain('- 无')
    // 块里引用每个套件最新运行的 run id（tenon status 的 test-report 动作靠它判断报告是否是最新的）；块外的字节不动。
    const runIds = (r: Report): string[] => (r.policy?.suites ?? []).flatMap((suite) => (suite.state === 'passed' && suite.run_id !== undefined ? [suite.run_id] : []))
    expect(runIds(current)).toHaveLength(1)
    expect(reportCarriesRuns(text, runIds(current))).toBe(true)
    expect(text.split(TEST_REPORT_BEGIN)).toHaveLength(2)
    expect(text.split(TEST_REPORT_END)).toHaveLength(2)
    expect(text).not.toContain('tenon:tests:start')
    expect(text.startsWith('# 验证报告\n\n手写的内容。\n')).toBe(true)
    await tenon('test', 'report', 'demo', '--step', 'verify', '--write', REPORT)
    expect(await readFile(join(cwd(), REPORT), 'utf8')).toBe(text)
    // 重新运行之后报告落后于最新运行，重写后才带上新的 run id。
    await tenon('test', 'run', 'demo', '--stage', 'verify')
    const newer = runIds(await report('verify'))
    expect(newer).toHaveLength(1)
    expect(newer).not.toEqual(runIds(current))
    expect(reportCarriesRuns(await readFile(join(cwd(), REPORT), 'utf8'), newer)).toBe(false)
    expect(await tenon('test', 'report', 'demo', '--step', 'verify', '--write', REPORT), err()).toBe(0)
    const rewritten = await readFile(join(cwd(), REPORT), 'utf8')
    expect(reportCarriesRuns(rewritten, newer)).toBe(true)
    expect(rewritten.split(TEST_REPORT_BEGIN)).toHaveLength(2)
    expect(rewritten.startsWith('# 验证报告\n\n手写的内容。\n')).toBe(true)
    expect(await tenon('test', 'report', 'demo', '--step', 'verify', '--locale', 'en')).toBe(0)
    expect(out()).toContain('### Traceability')
  }, 240_000)

  test('E：只有场景与实现阶段小节的任务要求映射；其余阶段的任务单列为可选，seed / sync 分开显示，门禁不挡', async () => {
    await project(workflow('          run: [unit]\n          scope: full\n          scenarios: passing'))
    await tenon('test', 'discover', '--write')
    await writeFile(join(cwd(), 'src', 'login.test.ts'), LOGIN_TEST, 'utf8')
    await writeFile(join(cwd(), 'openspec', 'changes', 'demo', 'tasks.md'), [
      '# 任务', '', '## 实现', '- [ ] 1.1 实现登录', '- [ ] 将本阶段目标拆成可验证任务。 (build)', '',
      '## 验证', '- [ ] 2.1 手工回归 (verify)',
    ].join('\n'), 'utf8')
    expect(await tenon('test', 'plan', 'demo', '--seed'), err()).toBe(0)
    expect(out()).toContain('待映射的场景 / 任务（3）')
    expect(out()).toContain('tenon test register demo --case task:1.1')
    // 骨架提示词（task:1.2）不是作者写的任务，计划初稿不列它；只剩验证小节里作者写的 task:2.1 是可选。
    expect(out()).toContain('可选的任务（1）')
    expect(out()).not.toContain('将本阶段目标拆成可验证任务')
    expect(out()).toMatch(/task:2\.1 {2}手工回归/u)
    expect(out()).not.toContain('tenon test register demo --case task:2.1')

    expect(await tenon('test', 'sync', 'demo', '--json')).toBe(0)
    const sync = JSON.parse(out()) as { unmapped: string[]; optionalUnmapped: string[] }
    expect(sync.unmapped).toEqual(['spec:auth/登录成功', 'spec:auth/密码错误', 'task:1.1'])
    expect(sync.optionalUnmapped).toEqual(['task:2.1'])
    await tenon('test', 'sync', 'demo')
    expect(out()).toContain('未映射的场景 / 任务 3 个')
    expect(out()).toContain('可选的任务 1 个')

    for (const [covers, name] of [['spec:auth/登录成功', '登录成功'], ['spec:auth/密码错误', '密码错误'], ['task:1.1', '登录成功']] as const) {
      expect(await tenon('test', 'register', 'demo', '--case', covers, '--test', `src/login.test.ts › login › ${name}`), err()).toBe(0)
    }
    expect(await tenon('test', 'run', 'demo', '--stage', 'verify'), `${out()}\n${err()}`).toBe(0)
    const current = await report('verify')
    expect(blocking(current)).toEqual([])
    expect(current.policy?.trace.map((row) => [row.covers, row.state])).toEqual([
      ['spec:auth/登录成功', 'passing'], ['spec:auth/密码错误', 'passing'],
      ['task:1.1', 'passing'], ['task:1.2', 'uncovered'], ['task:2.1', 'uncovered'],
    ])
    await tenon('test', 'plan', 'demo')
    expect(out()).toContain('另有 1 个可选任务没有映射用例（不挡）')
    // 验证报告的追溯矩阵：不要求映射的任务写「可选」，不写「未覆盖」。
    await tenon('test', 'report', 'demo', '--step', 'verify')
    expect(out()).toMatch(/task:1\.2[^\n]*\| 可选 \|/u)
    expect(out()).toMatch(/task:2\.1[^\n]*\| 可选 \|/u)
    expect(out()).not.toContain('未覆盖')
    await tenon('test', 'report', 'demo', '--step', 'verify', '--locale', 'en')
    expect(out()).toMatch(/task:2\.1[^\n]*\| optional \|/u)
  }, 240_000)

  test('登记面：套件 scope 校验、文件登记的认领 / 冲突 / 资源文件、取消登记、对账里已删除的文件', async () => {
    await project(workflow('          run: [unit]\n          scope: full'))
    await tenon('test', 'discover', '--write')
    expect(await tenon('test', 'register', 'demo', '--suite', 'nope')).toBe(1)
    expect(await tenon('test', 'register', 'demo', '--suite', 'unit', '--scope', 'grep')).toBe(1)
    expect(err()).toContain('需要 --pattern')
    expect(await tenon('test', 'register', 'demo', '--suite', 'unit', '--scope', 'files')).toBe(1)
    expect(await tenon('test', 'register', 'demo', '--suite', 'unit', '--scope', 'files', '--select-file', 'src/missing.test.ts')).toBe(1)
    expect(await tenon('test', 'register', 'demo', '--suite', 'unit', '--scope', 'grep', '--pattern', '@login'), err()).toBe(0)
    expect(await tenon('test', 'register', 'demo', '--file', 'a', '--case', 'task:1')).toBe(1)
    expect(await tenon('test', 'register', 'demo')).toBe(1)

    await writeFile(join(cwd(), 'src', 'shots.png'), 'png', 'utf8')
    expect(await tenon('test', 'register', 'demo', '--file', 'src/shots.png'), err()).toBe(1)
    expect(err()).toContain('没有套件认领')
    expect(await tenon('test', 'register', 'demo', '--file', 'src/shots.png', '--kind', 'visual'), err()).toBe(0)
    expect(await tenon('test', 'register', 'demo', '--file', 'src/never.test.ts')).toBe(1)
    expect(err()).toContain('不存在')
    expect(await tenon('test', 'register', 'demo', '--file', 'src/math.test.ts', '--kind', 'integration')).toBe(1)
    expect(err()).toContain('不一致')

    expect(await tenon('test', 'plan', 'demo', '--json')).toBe(0)
    const plan = JSON.parse(out()) as { state: string; plan: { suites: Array<{ suite: string; scope: string; pattern?: string }>; files: Array<{ path: string; kind?: string }> } }
    expect(plan.plan.suites).toEqual([{ suite: 'unit', scope: 'grep', pattern: '@login' }])
    expect(plan.plan.files).toEqual([{ path: 'src/shots.png', kind: 'visual' }])

    // 计划的每次真实写入都留一行审计（与 kernel 的 writeTestPlan 同一条写入路径），带触发写入的子命令。
    const audit = (await readFile(join(cwd(), 'openspec', 'changes', 'demo', '.pipeline-history.jsonl'), 'utf8'))
      .split('\n').filter((line) => line.includes('test:plan-write'))
      .map((line) => (JSON.parse(line) as { raw: string }).raw.replace(/plan=sha256:[0-9a-f]{64}/u, 'plan=<digest>'))
    expect(audit).toEqual(['test:plan-write op=register plan=<digest>', 'test:plan-write op=register plan=<digest>'])

    await rm(join(cwd(), 'src', 'shots.png'))
    expect(await tenon('test', 'sync', 'demo')).toBe(2)
    expect(out()).toContain('文件已不存在  src/shots.png')
    expect(await tenon('test', 'unregister', 'demo', '--file', 'src/shots.png'), err()).toBe(0)
    expect(await tenon('test', 'unregister', 'demo', '--file', 'src/shots.png')).toBe(1)
    expect(await tenon('test', 'unregister', 'demo')).toBe(1)
    expect(await tenon('test', 'sync', 'demo', '--json')).toBe(0)
    expect(await tenon('test', 'waive', 'demo', '--kind', 'a11y')).toBe(1)
    expect(await tenon('test', 'waive', 'demo', '--kind', 'a11y', '--covers', 'task:1', '--reason', 'x')).toBe(1)
    expect(await tenon('test', 'waive', 'demo', '--kind', 'nope', '--reason', 'x')).toBe(1)
  }, 120_000)

  test('读不到 diff（不是 git 仓库）→ files-diff-unavailable 阻塞，不降级成提示；sync 报环境错误', async () => {
    const harness = await freshHarness()
    h = harness
    await writeFiles(harness.cwd, VITEST_FILES)
    await linkNodeModules(harness.cwd)
    await mkdir(join(harness.cwd, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(harness.cwd, '.pipeline', 'workflows', 'traced.yaml'), workflow('          run: [unit]\n          scope: full'), 'utf8')
    expect(await tenon('init', 'demo', '--track', 'backend', '--workflow', 'traced', '--preset', 'full'), err()).toBe(0)
    await tenon('test', 'discover', '--write')
    await tenon('test', 'plan', 'demo', '--seed')
    expect(await tenon('test', 'sync', 'demo')).toBe(1)
    expect(err()).toContain('files-diff-unavailable')
    const current = await report('build')
    expect(blocking(current)).toContain('files-diff-unavailable')
    expect(current.policy?.blockers.find((item) => item.code === 'files-diff-unavailable')?.message).toContain('不是 git 仓库')
  }, 120_000)

  test('覆盖率门槛与 changed_lines：lcov 报告 × 真实 git diff', async () => {
    await project(workflow('          run: [unit]\n          scope: full\n          coverage: { lines: 80, changed_lines: 90 }'))
    // 套件命令就是一段脚本：产出 junit 与 lcov（内容由环境变量决定），不依赖外部覆盖率工具。
    const script = [
      "const fs = require('fs')",
      "fs.mkdirSync('test-results', { recursive: true }); fs.mkdirSync('coverage', { recursive: true })",
      "fs.writeFileSync('test-results/junit.xml', '<testsuites><testsuite name=\"s\"><testcase classname=\"src/math.test.ts\" name=\"adds\"/></testsuite></testsuites>')",
      "fs.writeFileSync('coverage/lcov.info', process.env.LCOV)",
    ].join(';')
    await writeFile(join(cwd(), 'cov.cjs'), script, 'utf8')
    expect(await tenon('test', 'catalog', 'add', 'cov', '--kind', 'unit', '--runner', 'vitest', '--command', 'node cov.cjs', '--report-format', 'junit', '--report-path', 'test-results/junit.xml', '--coverage-format', 'lcov', '--coverage-path', 'coverage/lcov.info', '--file-glob', 'src/**/*.test.ts'), err()).toBe(0)
    await tenon('test', 'plan', 'demo', '--seed')
    expect(await tenon('test', 'register', 'demo', '--suite', 'cov'), err()).toBe(0)
    // 改动：src/math.ts 新增第 3、4 行。
    await writeFile(join(cwd(), 'src', 'math.ts'), `${VITEST_FILES['src/math.ts']}export const mul = (a: number, b: number): number => a * b\nexport const div = (a: number, b: number): number => a / b\n`, 'utf8')
    const lcov = (lines: string): string => `SF:src/math.ts\n${lines}\nLF:4\nLH:${lines.split('\n').filter((line) => !line.endsWith(',0')).length}\nend_of_record\n`

    process.env.LCOV = lcov('DA:1,1\nDA:2,1\nDA:3,1\nDA:4,0')
    expect(await tenon('test', 'run', 'demo', '--suite', 'cov', '--stage', 'verify'), `${out()}\n${err()}`).toBe(2)
    let current = await report('verify')
    const below = current.policy?.blockers.find((item) => item.code === 'coverage-below')
    expect(below?.message).toContain('changed_lines 50% < 90%')
    process.env.LCOV = lcov('DA:1,1\nDA:2,1\nDA:3,1\nDA:4,1')
    expect(await tenon('test', 'run', 'demo', '--suite', 'cov', '--stage', 'verify'), `${out()}\n${err()}`).toBe(0)
    current = await report('verify')
    expect(current.policy?.suites.find((item) => item.suite === 'cov')?.coverage).toMatchObject({ lines: 100, changed_lines: 100 })
    process.env.LCOV = lcov('DA:1,1\nDA:2,0\nDA:3,0\nDA:4,0')
    expect(await tenon('test', 'run', 'demo', '--suite', 'cov', '--stage', 'verify')).toBe(2)
    expect(out()).toContain('覆盖率：')
    delete process.env.LCOV
  }, 180_000)

  test('并发批次：parallel 套件同时运行；--kind / --all / --changed 选择运行集', async () => {
    await project(workflow('          run: [unit]\n          scope: full'))
    const stamp = (id: string): string => [
      "const fs = require('fs')",
      "fs.mkdirSync('test-results', { recursive: true })",
      `fs.appendFileSync('test-results/order.log', 'start ${id} ' + Date.now() + '\\n')`,
      'const done = () => {',
      `  fs.appendFileSync('test-results/order.log', 'end ${id} ' + Date.now() + '\\n')`,
      `  fs.writeFileSync('test-results/${id}.xml', '<testsuites><testsuite name="s"><testcase classname="${id}.test.ts" name="ok"/></testsuite></testsuites>')`,
      '}',
      'setTimeout(done, 1200)',
    ].join(';\n')
    for (const id of ['p1', 'p2']) {
      await writeFile(join(cwd(), `${id}.cjs`), stamp(id), 'utf8')
      expect(await tenon('test', 'catalog', 'add', id, '--kind', 'unit', '--runner', 'vitest', '--command', `node ${id}.cjs`, '--report-format', 'junit', '--report-path', `test-results/${id}.xml`, '--parallel'), err()).toBe(0)
    }
    expect(await tenon('test', 'catalog', 'add', 'reg', '--kind', 'regression', '--runner', 'vitest', '--command', 'node p1.cjs', '--report-format', 'junit', '--report-path', 'test-results/p1.xml'), err()).toBe(0)
    await tenon('test', 'plan', 'demo', '--seed')
    for (const id of ['p1', 'p2', 'reg']) await tenon('test', 'register', 'demo', '--suite', id)
    await rm(join(cwd(), 'test-results', 'order.log'), { force: true })
    expect(await tenon('test', 'run', 'demo', '--suite', 'p1', '--suite', 'p2'), `${out()}\n${err()}`).toBe(0)
    const lines = (await readFile(join(cwd(), 'test-results', 'order.log'), 'utf8')).trim().split('\n').map((line) => line.split(' '))
    const at = (kind: string, id: string): number => Number(lines.find((line) => line[0] === kind && line[1] === id)?.[2])
    expect(at('start', 'p2')).toBeLessThan(at('end', 'p1'))
    expect(at('start', 'p1')).toBeLessThan(at('end', 'p2'))

    expect(await tenon('test', 'run', 'demo', '--kind', 'regression', '--changed'), err()).toBe(0)
    expect(out()).toContain('· reg  regression  scope=changed')
    expect(out()).toContain('scope=full')
    expect(await tenon('test', 'run', 'demo', '--all'), err()).toBe(0)
    expect(out()).toMatch(/[\s\S]*· p1[\s\S]*· p2[\s\S]*· reg/)
    expect(await tenon('test', 'run', 'demo', '--kind', 'benchmark')).toBe(1)
    expect(await tenon('test', 'run', 'demo', '--suite', 'ghost')).toBe(1)
    expect(await tenon('test', 'run', 'demo', 'unit', '--suite', 'p1')).toBe(1)
    expect(err()).toContain('不能和 --suite')
  }, 240_000)

  test('A11：旧的步骤内联测试与新套件同一步骤共存——--stage 只跑目录套件（提醒旧测试），旧形式仍写 v1 记录，v1 不破坏 v2 哈希链', async () => {
    const inline = `        tests:
          - id: legacy
            direction: unit
            command: node -e 'process.exit(0)'
            label: 旧单测
            timeout_s: 60
`
    await project(workflow('          run: [unit]\n          scope: full', inline))
    await tenon('test', 'discover', '--write')
    await tenon('test', 'plan', 'demo', '--seed')
    expect(await tenon('test', 'run', 'demo', '--stage'), `${out()}\n${err()}`).toBe(0)
    expect(out()).not.toContain('[TEST] demo legacy run=')
    expect(out()).toContain('旧的步骤测试不在 --stage 里，逐个执行：tenon test run demo legacy')
    const recordsDir = join(cwd(), '.tenon', 'users', SLUG, 'tests', 'demo')
    const schemasOf = async (): Promise<string[]> => (await Promise.all((await readdir(recordsDir)).map(async (file) =>
      (JSON.parse(await readFile(join(recordsDir, file), 'utf8')) as { schema: string }).schema))).sort()
    expect(await schemasOf()).toEqual(['tenon-test-run-v2'])
    // 旧测试还没跑：步骤出口被它挡着，目录套件的运行不受影响。
    expect(await tenon('test', 'status', 'demo', '--json')).toBe(2)
    expect((JSON.parse(out()) as { items: Array<{ id: string; status: string }> }).items).toEqual([expect.objectContaining({ id: 'legacy', status: 'missing' })])
    // 旧形式 `tenon test run <c> <test-id>` 是旧行为：v1 记录、按用户。
    expect(await tenon('test', 'run', 'demo', 'legacy')).toBe(0)
    expect(out()).toContain('[TEST] demo legacy run=')
    expect(await schemasOf()).toEqual(['tenon-test-run-v1', 'tenon-test-run-v2'])
    expect(await tenon('test', 'status', 'demo', '--json')).toBe(0)
    const status = JSON.parse(out()) as { pass: boolean; items: Array<{ id: string; status: string }>; policy: { chain: string; suites: Array<{ suite: string; state: string }> } }
    expect(status.items).toEqual([expect.objectContaining({ id: 'legacy', status: 'passed' })])
    expect(status.policy.chain).toBe('intact')
    expect(status.policy.suites.map((item) => [item.suite, item.state]).sort()).toEqual([['step:legacy', 'passed'], ['unit', 'passed']])
    expect(await tenon('test', 'run', 'demo', 'legacy', '--all')).toBe(1)
  }, 240_000)
})
