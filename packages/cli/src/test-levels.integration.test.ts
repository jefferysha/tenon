/**
 * 测试档位（`test: plan | changed | full`）× 真实 vitest 工程：工作流步骤只记档位名，运行集由档位 × 目录 × 本任务改动算，
 * `tenon test run --stage` 与 `tenon status` 求值用同一份运行集，改动过的测试文件由套件 glob 认领（零登记）。
 * 真临时 git 仓库、真 CLI（buildProgram）、真 vitest；提交日期固定，「自任务起点以来」的 diff 可复现。
 */
import { appendFile, readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { FIXED_CLOCK, freshHarness, rm, type Harness } from './integration-harness.js'
import { VITEST_FILES, commitAll, initGit, linkNodeModules, writeFiles } from './integration-harness-tests.js'

const USER = { TENON_USER: 'a@x.io', TENON_USER_NAME: 'A', TENON_TEST_REAL_DIFF: '1', TENON_TEST_TICKING_CLOCK: '1' }
const SLUG = 'a-at-x.io'

const WORKFLOW = `name: leveled
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
        test: plan
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
        test: changed
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
        test: full
        transitions: []
`

/** verify 步在 `test: full` 之外又写了旧的 `test_policy`：同一步两种写法并存，编译必须拒。 */
const CLASH_WORKFLOW = WORKFLOW
  .replace('name: leveled', 'name: clash')
  .replace('        test: full\n', '        test: full\n        test_policy:\n          plan: optional\n')

/** `levels.changed` 里写了档位不认识的键 `scope`（第 11 行）。 */
const BAD_LEVEL_LINE = 11
const CATALOG_HEAD = [
  'schema: tenon-test-catalog/v1',
  'suites:',
  '  - id: unit',
  '    kind: unit',
  '    runner: vitest',
  '    command: npx vitest run',
  '    files: ["src/**/*.test.ts"]',
  '    report: { format: junit, path: test-results/unit.xml }',
  'levels:',
  '  changed:',
]

const PASSING_TEST = (name: string): string => `import { expect, test } from 'vitest'\ntest('${name}', () => { expect(1).toBe(1) })\n`

/** 场景映射用例的目录：unit 套件写了 covers；`levels` 由用例决定写不写。 */
const UNIT_CATALOG = `schema: tenon-test-catalog/v1
suites:
  - id: unit
    kind: unit
    runner: vitest
    command: npx vitest run
    files: ["src/**/*.test.ts"]
    covers: ["src/**"]
    report: { format: junit, path: test-results/unit.xml }
`
const REQUIRE_SCENARIOS = 'levels:\n  changed: { scenarios: required }\n'
const AUTH_SPEC = '## ADDED Requirements\n\n### Requirement: 登录\n\n#### Scenario: 登录成功\n\n- **WHEN** 输入正确的密码\n- **THEN** 登录成功\n'

interface NextAction { readonly action: string; readonly [key: string]: unknown }

/** 只有一个 unit 套件、没写 covers：只改源码碰不到它（只有改到 test/ 下的测试文件才算被碰到）。 */
const NO_COVERS_CATALOG = `schema: tenon-test-catalog/v1
suites:
  - id: unit
    kind: unit
    runner: custom
    command: node gen-report.mjs
    files: ["test/**/*.test.js"]
    report: { format: junit, path: test-results/unit.xml }
    artifacts: [test-results/unit.xml]
`
const NO_COVERS_HINT = '套件 unit 没写 covers：只改源码碰不到它们，本步没有运行；需要源码改动触发时，在 .tenon/tests/catalog.yaml 给它们写上 covers'

interface PolicyJson {
  pass: boolean
  policy?: {
    blockers: Array<{ code: string; blocking: boolean; subject?: string; fix?: string }>
    notices: Array<{ code: string; message: string; fix?: string }>
    suites: Array<{ suite: string; state: string; reason: string }>
    files: { checked: boolean; unregistered: unknown[]; orphans: string[]; claimed: Array<{ path: string; suites: string[] }> }
  }
}

describe('测试档位 × 真实 vitest 工程', () => {
  let h: Harness | undefined
  afterEach(async () => { if (h) await rm(h.cwd, { recursive: true, force: true }); h = undefined })

  const tenon = (...args: string[]): Promise<number> => (h as Harness).run(args, { env: USER })
  const out = (): string => (h as Harness).out.join('\n')
  const err = (): string => (h as Harness).err.join('\n')
  const cwd = (): string => (h as Harness).cwd

  /** `catalog` 缺省时由 discover 识别写入；给了就直接用这份目录（不跑 discover）。 */
  async function project(catalog?: string): Promise<void> {
    const harness = await freshHarness()
    h = harness
    await writeFiles(harness.cwd, VITEST_FILES)
    await linkNodeModules(harness.cwd)
    initGit(harness.cwd)
    commitAll(harness.cwd, 'base', '2026-01-01T00:00:00Z')
    await mkdir(join(harness.cwd, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(harness.cwd, '.pipeline', 'workflows', 'leveled.yaml'), WORKFLOW, 'utf8')
    expect(await harness.run(['init', 'demo', '--track', 'backend', '--workflow', 'leveled', '--preset', 'full'], { env: USER }), harness.err.join('\n')).toBe(0)
    if (catalog === undefined) {
      expect(await tenon('test', 'discover', '--write'), err()).toBe(0)
    } else {
      await mkdir(join(harness.cwd, '.tenon', 'tests'), { recursive: true })
      await writeFile(join(harness.cwd, '.tenon', 'tests', 'catalog.yaml'), catalog, 'utf8')
    }
    expect(await tenon('test', 'plan', 'demo', '--seed'), err()).toBe(0)
  }

  async function status(step: string): Promise<{ code: number; json: PolicyJson }> {
    const code = await tenon('test', 'status', 'demo', '--step', step, '--json')
    return { code, json: JSON.parse(out()) as PolicyJson }
  }
  const codes = (json: PolicyJson): string[] => (json.policy?.blockers ?? []).filter((item) => item.blocking).map((item) => item.code)
  const recordsDir = (): string => join(cwd(), '.tenon', 'users', SLUG, 'tests', 'demo')
  async function recordCount(): Promise<number> {
    return existsSync(recordsDir()) ? (await readdir(recordsDir())).length : 0
  }
  const planBytes = (): Promise<string> => readFile(join(cwd(), 'openspec', 'changes', 'demo', 'test-plan.yaml'), 'utf8')

  /** 宿主加载一个技能：PostToolUse 历史行 + 内部回执命令（hook 触发）。`next` 要在加载之后才会给出测试动作。 */
  let toolUseSeq = 0
  async function loadSkill(skill: string): Promise<void> {
    toolUseSeq += 1
    const history = join(cwd(), 'openspec', 'changes', 'demo', '.pipeline-history.jsonl')
    let last = Date.parse(FIXED_CLOCK)
    for (const line of (await readFile(history, 'utf8').catch(() => '')).split('\n')) {
      if (line.trim() === '') continue
      const ts = Date.parse(String((JSON.parse(line) as { ts?: string }).ts ?? ''))
      if (Number.isFinite(ts)) last = Math.max(last, ts)
    }
    const observedAt = new Date(last + 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    await appendFile(history, `${JSON.stringify({ ts: observedAt, kind: 'tool', raw: `Skill: ${skill}` })}\n`, 'utf8')
    expect(await tenon('internal-native-skill-receipt', 'demo', skill, 'levels-session', `tool-${toolUseSeq}`, observedAt), err()).toBe(0)
  }

  /** `tenon status demo --json` 的 `step.next`。 */
  async function nextActions(): Promise<readonly NextAction[]> {
    expect(await tenon('status', 'demo', '--json'), err()).toBe(0)
    return (JSON.parse(out()) as { step: { next: NextAction[] } }).step.next
  }

  /** 进入实现步（`test: changed`）并加载 tenon：规格里有一个未映射的场景。 */
  async function buildStepWithScenario(catalog: string): Promise<void> {
    await project(catalog)
    await mkdir(join(cwd(), 'openspec', 'changes', 'demo', 'specs', 'auth'), { recursive: true })
    await writeFile(join(cwd(), 'openspec', 'changes', 'demo', 'specs', 'auth', 'spec.md'), AUTH_SPEC, 'utf8')
    expect(await tenon('session', 'activate', 'demo', '--host-session', 'levels-session'), err()).toBe(0)
    expect(await tenon('transition', 'demo', 'spec-done'), err()).toBe(0)
    await loadSkill('tenon')
  }

  test('plan 档：计划存在、必需类有套件即满足；--stage 如实说明没有要运行的套件（exit 0，不写记录）', async () => {
    await project()
    const spec = await status('spec')
    expect(spec.code, out()).toBe(0)
    expect(spec.json.policy?.suites).toEqual([])
    expect(await tenon('test', 'run', 'demo', '--stage'), err()).toBe(0)
    expect(out()).toContain('按档位（plan）没有需要运行的套件')
    expect(await recordCount()).toBe(0)
    expect(await tenon('transition', 'demo', 'spec-done'), err()).toBe(0)
  }, 120_000)

  test('changed 档：改动没碰到任何套件时零运行即满足；改了源码就要跑 unit，--stage 跑出来的与 status 要求的一致', async () => {
    await project()
    expect(await tenon('transition', 'demo', 'spec-done'), err()).toBe(0)
    await writeFile(join(cwd(), 'README.md'), '# fixture\n', 'utf8')
    const docsOnly = await status('build')
    expect(docsOnly.code, out()).toBe(0)
    expect(docsOnly.json.policy?.suites).toEqual([])
    expect(await tenon('test', 'run', 'demo', '--stage'), err()).toBe(0)
    expect(out()).toContain('按档位（changed）没有需要运行的套件')
    expect(await recordCount()).toBe(0)

    await writeFile(join(cwd(), 'src', 'math.ts'), 'export const add = (a: number, b: number): number => a + b + 0\nexport const sub = (a: number, b: number): number => a - b\n', 'utf8')
    const touched = await status('build')
    expect(codes(touched.json)).toEqual(['test-not-run'])
    expect(touched.json.policy?.suites).toEqual([expect.objectContaining({ suite: 'unit', reason: 'run', state: 'missing' })])
    expect(await tenon('test', 'run', 'demo', '--stage'), err()).toBe(0)
    expect(out()).toContain('unit')
    expect((await status('build')).code).toBe(0)
    expect(await tenon('transition', 'demo', 'build-done'), err()).toBe(0)
  }, 180_000)

  test('unit 没写 covers：只改 README.md 不提示；只改源码运行集为空、不阻断，status（文本与 --json）和 --stage 都点名 unit 给出提示', async () => {
    await project(NO_COVERS_CATALOG)
    expect(await tenon('transition', 'demo', 'spec-done'), err()).toBe(0)
    await writeFile(join(cwd(), 'README.md'), '# fixture\n', 'utf8')
    const docsOnly = await status('build')
    expect(docsOnly.code, out()).toBe(0)
    expect(docsOnly.json.policy?.notices).toEqual([])
    expect(await tenon('test', 'run', 'demo', '--stage'), err()).toBe(0)
    expect(out()).toContain('按档位（changed）没有需要运行的套件')
    expect(out()).not.toContain('没写 covers')

    await mkdir(join(cwd(), 'src'), { recursive: true })
    await writeFile(join(cwd(), 'src', 'a.js'), 'export const a = 1\n', 'utf8')
    const sourceOnly = await status('build')
    expect(sourceOnly.code, out()).toBe(0)
    expect(codes(sourceOnly.json)).toEqual([])
    expect(sourceOnly.json.policy?.suites).toEqual([])
    expect(sourceOnly.json.policy?.notices).toEqual([expect.objectContaining({
      code: 'suites-without-covers', message: NO_COVERS_HINT, fix: 'tenon test catalog set unit --cover-glob "<glob>"',
    })])

    expect(await tenon('test', 'status', 'demo', '--step', 'build'), err()).toBe(0)
    expect(out()).toContain(`提示：${NO_COVERS_HINT}`)
    expect(await tenon('test', 'run', 'demo', '--stage'), err()).toBe(0)
    expect(out()).toContain('按档位（changed）没有需要运行的套件')
    expect(out()).toContain(`提示：${NO_COVERS_HINT}`)
    expect(await tenon('test', 'run', 'demo', '--stage', '--json'), err()).toBe(0)
    expect(JSON.parse(out())).toMatchObject({
      result: 'nothing-to-run', notices: [{ code: 'suites-without-covers', message: NO_COVERS_HINT }],
    })
    expect(await recordCount()).toBe(0)
    expect(await tenon('transition', 'demo', 'build-done'), err()).toBe(0)
  }, 180_000)

  test('场景映射要求时照旧：目录写 levels.changed.scenarios: required，规格里有未映射的场景 → status 出 scenario-uncovered，next 下发 test-plan-map 点名该场景', async () => {
    await buildStepWithScenario(UNIT_CATALOG + REQUIRE_SCENARIOS)
    const required = await status('build')
    expect(codes(required.json)).toContain('scenario-uncovered')
    expect(required.json.policy?.blockers.find((item) => item.code === 'scenario-uncovered')?.subject).toBe('spec:auth/登录成功')
    const next = await nextActions()
    expect(next.map((item) => item.action)).toEqual(['test-plan-map'])
    expect(next[0]?.items).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'scenario-uncovered', subject: 'spec:auth/登录成功' })]))
  }, 120_000)

  test('场景映射缺省不要求：同样的规格与步骤，目录不写 levels → 没有场景阻断，next 不下发 test-plan-map', async () => {
    await buildStepWithScenario(UNIT_CATALOG)
    const byDefault = await status('build')
    expect(codes(byDefault.json)).toEqual([])
    const next = await nextActions()
    expect(next.map((item) => item.action)).not.toContain('test-plan-map')
    expect(next.map((item) => item.action)).toEqual(['transition'])
  }, 120_000)

  test('现行 default 工作流（lite）实现步 test: changed：只改文档与 change 目录 → 零运行即满足，next 没有 run-tests 也没有 test-plan-map', async () => {
    const harness = await freshHarness()
    h = harness
    await writeFiles(harness.cwd, VITEST_FILES)
    await linkNodeModules(harness.cwd)
    initGit(harness.cwd)
    commitAll(harness.cwd, 'base', '2026-01-01T00:00:00Z')
    // 不写任何工作流文件：lite 轨道是随插件发布的 default 模板里的分支。
    expect(await tenon('init', 'demo', '--workflow', 'default', '--track', 'lite', '--preset', 'full'), err()).toBe(0)
    expect(await tenon('test', 'discover', '--write'), err()).toBe(0)
    expect(await tenon('session', 'activate', 'demo', '--host-session', 'levels-session'), err()).toBe(0)
    await loadSkill('tenon')
    expect(await tenon('transition', 'demo', 'open-complete'), err()).toBe(0)
    await loadSkill('tenon')
    await loadSkill('test-driven-development')
    expect(await tenon('test', 'plan', 'demo', '--seed'), err()).toBe(0)

    await writeFile(join(cwd(), 'README.md'), '# fixture\n', 'utf8')
    const build = await status('build')
    // 目录套件一个都不在运行集里；挡着出口的只有 default 实现步自带的改动风险探针（内联测试，未运行）。
    expect(build.json.policy?.suites.filter((item) => item.reason !== 'inline')).toEqual([])
    expect(build.json.policy?.blockers.filter((item) => item.blocking).map((item) => [item.code, item.subject])).toEqual([['test-not-run', 'step:diff-risk']])
    expect(build.json.policy?.scenarios).toBe('off')
    // next 越过了登记类动作（目录、计划、映射都不缺），到了测试这一步：没有按档位运行套件，也没有场景映射，只剩那个探针。
    const actions = (await nextActions()).map((item) => item.action)
    expect(actions).not.toContain('run-tests')
    expect(actions).not.toContain('test-plan-map')
    expect(actions).toEqual(['run-test'])
  }, 180_000)

  test('新增测试文件被 unit 的 glob 认领：零登记，--stage 只跑它，计划文件逐字节不变；报告里没有它的用例才算没跑', async () => {
    await project()
    expect(await tenon('transition', 'demo', 'spec-done'), err()).toBe(0)
    const before = await planBytes()
    await writeFile(join(cwd(), 'src', 'extra.test.ts'), PASSING_TEST('extra works'), 'utf8')
    const claimed = await status('build')
    expect(codes(claimed.json)).toEqual(['test-not-run'])
    expect(claimed.json.policy?.files).toMatchObject({ checked: true, unregistered: [], orphans: [], claimed: [{ path: 'src/extra.test.ts', suites: ['unit'] }] })
    expect(await tenon('test', 'sync', 'demo'), out()).toBe(0)

    expect(await tenon('test', 'run', 'demo', '--stage'), `${out()}\n${err()}`).toBe(0)
    const records = await readdir(recordsDir())
    const record = JSON.parse(await readFile(join(recordsDir(), records[0] ?? ''), 'utf8')) as {
      suites: Array<{ suite: string; scope: string; selection: string[]; cases: Array<{ file: string }> }>
    }
    expect(record.suites[0]).toMatchObject({ suite: 'unit', scope: 'changed', selection: ['src/extra.test.ts'] })
    expect(record.suites[0]?.cases.map((item) => item.file)).toEqual(['src/extra.test.ts'])
    expect((await status('build')).code).toBe(0)
    expect(await planBytes()).toBe(before)
  }, 180_000)

  test('没有套件认领的测试文件是孤儿：status 出 test-file-orphan，修复命令是一条 register --auto', async () => {
    await project()
    expect(await tenon('transition', 'demo', 'spec-done'), err()).toBe(0)
    await mkdir(join(cwd(), 'tools'), { recursive: true })
    await writeFile(join(cwd(), 'tools', 'x.test.mjs'), "import { test } from 'node:test'\ntest('x', () => {})\n", 'utf8')
    const orphan = await status('build')
    expect(orphan.json.policy?.blockers.filter((item) => item.blocking).map((item) => [item.code, item.subject, item.fix])).toEqual([
      ['test-file-orphan', 'tools/x.test.mjs', 'tenon test register demo --auto'],
    ])
    expect(orphan.json.policy?.files.orphans).toEqual(['tools/x.test.mjs'])
  }, 120_000)

  test('full 档：必需类全量；只跑了 changed 范围不算数，--stage 全量跑完才放行', async () => {
    await project()
    expect(await tenon('transition', 'demo', 'spec-done'), err()).toBe(0)
    // 改动没碰到任何套件：build 零运行即满足。
    await writeFile(join(cwd(), 'README.md'), '# fixture\n', 'utf8')
    expect(await tenon('transition', 'demo', 'build-done'), err()).toBe(0)
    // 之后新增一个测试文件：--changed 才真的只跑它（没有测试文件的改动时 changed 范围会退回全量）。
    await writeFile(join(cwd(), 'src', 'extra.test.ts'), PASSING_TEST('extra works'), 'utf8')
    const verify = await status('verify')
    expect(verify.json.policy?.suites).toEqual([expect.objectContaining({ suite: 'unit', reason: 'run' })])
    expect(codes(verify.json)).toEqual(['test-not-run'])
    // 只跑了 changed 范围不满足全量要求。
    expect(await tenon('test', 'run', 'demo', '--suite', 'unit', '--changed'), `${out()}\n${err()}`).toBe(0)
    const partial = await status('verify')
    expect(codes(partial.json)).toEqual(['test-not-run'])
    expect(partial.json.policy?.suites[0]).toMatchObject({ suite: 'unit', state: 'missing' })
    expect(await tenon('test', 'run', 'demo', '--stage'), `${out()}\n${err()}`).toBe(0)
    const done = await status('verify')
    expect(done.code, out()).toBe(0)
    expect(done.json.policy?.suites).toEqual([expect.objectContaining({ suite: 'unit', state: 'passed' })])
  }, 180_000)

  test('同一步既写 test: full 又写 test_policy：tenon init 以非零退出码失败，stderr 点名该步并说明只能写一个，不建任务', async () => {
    h = await freshHarness()
    expect(CLASH_WORKFLOW).toContain('test_policy')
    await mkdir(join(cwd(), '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(cwd(), '.pipeline', 'workflows', 'clash.yaml'), CLASH_WORKFLOW, 'utf8')
    const code = await tenon('init', 'clash', '--track', 'backend', '--workflow', 'clash', '--preset', 'full')
    expect(code, out()).not.toBe(0)
    expect(err()).toContain("step 'verify'")
    expect(err()).toContain('test 与 test_policy 只能写一个')
    expect(existsSync(join(cwd(), 'openspec', 'changes', 'clash'))).toBe(false)
  }, 60_000)

  test('档位定义里写了不认识的键（levels.changed.scope: full）：tenon test catalog validate 以非零退出码失败，输出该键所在行号', async () => {
    h = await freshHarness()
    const path = join(cwd(), '.tenon', 'tests', 'catalog.yaml')
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, [...CATALOG_HEAD, '    scope: full', ''].join('\n'), 'utf8')
    expect(await tenon('test', 'catalog', 'validate')).toBe(2)
    expect(err()).toMatch(new RegExp(`catalog\\.yaml:${BAD_LEVEL_LINE}: .*levels\\.changed 不认识键 'scope'`))
    // 同一份目录把那一行换成合法的档位键 → 校验通过，说明上面的失败只来自 scope。
    await writeFile(path, [...CATALOG_HEAD, '    required: [unit]', ''].join('\n'), 'utf8')
    expect(await tenon('test', 'catalog', 'validate'), err()).toBe(0)
  }, 60_000)
})
