/**
 * `tenon test sync <change> --prune` —— 把计划里目录不再认领的登记删掉（真临时项目、真 CLI、真 kernel 落盘）。
 * 计划用 kernel 的写入口直接铺成事故现场：一条被套件 glob 认领的登记、一条套件 glob 不再认领的显式套件登记、
 * 一条指向已不在目录的套件、一条没有任何套件认领的无套件登记，外加一条有意登记的资源文件（只有 kind）。
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { emptyTestPlan, readTestPlanState, testPlanLedgerPath, testPlanPath, writeTestPlan, type TestPlan } from '@tenon/kernel'
import { afterEach, describe, expect, test } from 'vitest'
import { freshHarness, type Harness } from './integration-harness.js'
import { commitAll, git, initGit, writeFiles } from './integration-harness-tests.js'

const CHANGE = 'demo'
const OWNER = { TENON_USER: 'a@x.io', TENON_USER_NAME: 'A' }
const OTHER = { TENON_USER: 'b@x.io', TENON_USER_NAME: 'B' }
const ENV = { ...OWNER, TENON_TEST_REAL_DIFF: '1', TENON_TEST_TICKING_CLOCK: '1' }

const WORKFLOW = `name: pruned
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
          scope: changed
          files: registered
        transitions:
          - event: build-done
            to: done
      - id: done
        label: 完结
        gate: null
        skills: []
        inputs: []
        outputs: []
        guards: []
        transitions: []
`

const CATALOG = `schema: tenon-test-catalog/v1
suites:
  - id: unit
    label: 单测
    kind: unit
    runner: vitest
    command: npx vitest run --reporter=junit --outputFile=test-results/unit.xml
    files: ["src/**/*.test.ts"]
    report: { format: junit, path: test-results/unit.xml }
`

const FILES: Readonly<Record<string, string>> = {
  'package.json': '{ "name": "fixture", "private": true, "type": "module" }\n',
  'src/math.test.ts': 'export {}\n',
  'src/also.test.ts': 'export {}\n',
  'src/ghost.test.ts': 'export {}\n',
  'legacy/old.test.ts': 'export {}\n',
  'archive/notes.spec.report': 'report\n',
  'assets/shot.png': 'png\n',
}

const PLAN: TestPlan = {
  ...emptyTestPlan(CHANGE),
  suites: [{ suite: 'unit', scope: 'full' }],
  files: [
    { path: 'src/math.test.ts', suite: 'unit', kind: 'unit' },
    { path: 'src/also.test.ts' },
    { path: 'legacy/old.test.ts', suite: 'unit', kind: 'unit' },
    { path: 'src/ghost.test.ts', suite: 'ghost' },
    { path: 'archive/notes.spec.report' },
    { path: 'assets/shot.png', kind: 'visual' },
  ],
  cases: [{ covers: 'task:1.1', tests: ['legacy/old.test.ts › x', 'src/math.test.ts › y'] }],
  waivers: [{ kind: 'benchmark', reason: '无性能路径', approved_by: null }],
}

const CLAIMED = ['assets/shot.png', 'src/also.test.ts', 'src/math.test.ts']
const UNCLAIMED = [
  { path: 'archive/notes.spec.report', reason: 'no-owner' },
  { path: 'legacy/old.test.ts', suite: 'unit', reason: 'glob-mismatch' },
  { path: 'src/ghost.test.ts', suite: 'ghost', reason: 'suite-missing' },
]

interface PlanJson { state: string; digest?: string; plan?: TestPlan }
interface PruneJson { change: string; digest?: string; pruned: Array<{ path: string; suite?: string; reason: string }> }

describe('tenon test sync --prune', () => {
  let h: Harness | undefined
  afterEach(async () => { if (h) await rm(h.cwd, { recursive: true, force: true }); h = undefined })

  const cwd = (): string => (h as Harness).cwd
  const out = (): string => (h as Harness).out.join('\n')
  const err = (): string => (h as Harness).err.join('\n')
  const tenon = (args: readonly string[], env: Record<string, string> = ENV): Promise<number> => (h as Harness).run([...args], { env })
  const changeDir = (): string => join(cwd(), 'openspec', 'changes', CHANGE)
  const catalogPath = (): string => join(cwd(), '.tenon', 'tests', 'catalog.yaml')

  async function project(): Promise<void> {
    const harness = await freshHarness()
    h = harness
    await writeFiles(harness.cwd, FILES)
    initGit(harness.cwd)
    commitAll(harness.cwd, 'base', '2026-01-01T00:00:00Z')
    await mkdir(join(harness.cwd, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(harness.cwd, '.pipeline', 'workflows', 'pruned.yaml'), WORKFLOW, 'utf8')
    expect(await tenon(['init', CHANGE, '--track', 'backend', '--workflow', 'pruned', '--preset', 'full']), err()).toBe(0)
    await mkdir(join(harness.cwd, '.tenon', 'tests'), { recursive: true })
    await writeFile(catalogPath(), CATALOG, 'utf8')
    await writeTestPlan(changeDir(), PLAN, { actor: { id: OWNER.TENON_USER, name: OWNER.TENON_USER_NAME, trust: 'declared' }, recordedAt: '2026-01-02T00:00:00.000Z' })
  }

  const planBytes = async (): Promise<string> => `${await readFile(testPlanPath(changeDir()), 'utf8')}\n---\n${await readFile(testPlanLedgerPath(changeDir()), 'utf8')}`
  async function planJson(): Promise<PlanJson> {
    expect(await tenon(['test', 'plan', CHANGE, '--json']), err()).toBe(0)
    return JSON.parse(out()) as PlanJson
  }

  test('不带 --prune：列出已登记却无人认领的登记（带原因）并提示 --prune，计划文件与台账一个字节都不动', async () => {
    await project()
    const before = await planBytes()
    expect(await tenon(['test', 'sync', CHANGE])).toBe(2)
    for (const item of UNCLAIMED) expect(out()).toContain(item.path)
    expect(out()).toContain("套件 'unit' 的 files glob 不再认领它")
    expect(out()).toContain("套件 'ghost' 不在目录中")
    expect(out()).toContain('没有套件认领')
    expect(out()).toContain(`tenon test sync ${CHANGE} --prune`)
    for (const path of CLAIMED) expect(out()).not.toContain(path)
    expect(await planBytes()).toBe(before)

    expect(await tenon(['test', 'sync', CHANGE, '--json'])).toBe(2)
    const report = JSON.parse(out()) as { registeredButUnclaimed: unknown }
    expect(report.registeredButUnclaimed).toEqual(UNCLAIMED)
    expect(await planBytes()).toBe(before)
  }, 60_000)

  test('--prune 只删目录不再认领的登记；套件、用例映射、豁免与被认领的登记原样，摘要随之更新、计划照常可读', async () => {
    await project()
    expect(await tenon(['test', 'sync', CHANGE, '--prune'], ENV), err()).toBe(0)
    for (const item of UNCLAIMED) expect(out()).toContain(item.path)
    expect(out()).toContain("套件 'unit' 的 files glob 不再认领它")
    expect(out()).toContain("套件 'ghost' 不在目录中")
    expect(out()).toContain('没有套件认领')

    const state = await readTestPlanState(changeDir(), CHANGE)
    expect(state.state).toBe('ok')
    const listed = await planJson()
    expect(listed.state).toBe('ok')
    expect(listed.plan?.files.map((file) => file.path)).toEqual(CLAIMED)
    expect(listed.plan?.files.find((file) => file.path === 'src/math.test.ts')).toEqual({ path: 'src/math.test.ts', suite: 'unit', kind: 'unit' })
    expect(listed.plan?.suites).toEqual(PLAN.suites)
    expect(listed.plan?.cases).toEqual(PLAN.cases)
    expect(listed.plan?.waivers).toEqual(PLAN.waivers)

    const history = (await readFile(join(changeDir(), '.pipeline-history.jsonl'), 'utf8')).split('\n').filter((line) => line.includes('test:plan-write'))
    // 第一行是夹具自己写计划留下的；删除这一次留 op=prune。
    expect(history.map((line) => (JSON.parse(line) as { raw: string }).raw.replace(/plan=sha256:[0-9a-f]{64}/u, 'plan=<digest>')))
      .toEqual(['test:plan-write plan=<digest>', 'test:plan-write op=prune plan=<digest>'])

    expect(await tenon(['test', 'sync', CHANGE]), `${out()}\n${err()}`).toBe(0)
    expect(out()).not.toContain('--prune')
  }, 60_000)

  test('再跑一次 --prune 什么都不删：明说没有可删的项、exit 0、不写计划', async () => {
    await project()
    expect(await tenon(['test', 'sync', CHANGE, '--prune']), err()).toBe(0)
    const after = await planBytes()
    expect(await tenon(['test', 'sync', CHANGE, '--prune']), err()).toBe(0)
    expect(out()).toContain('没有')
    expect(await planBytes()).toBe(after)
    expect(await tenon(['test', 'sync', CHANGE, '--prune', '--json']), err()).toBe(0)
    expect(JSON.parse(out())).toEqual({ change: CHANGE, pruned: [] })
    expect(await planBytes()).toBe(after)
  }, 60_000)

  test('--prune --json：稳定结构 { change, digest, pruned: [{ path, suite?, reason }] }，摘要就是 plan 命令读到的那份', async () => {
    await project()
    expect(await tenon(['test', 'sync', CHANGE, '--prune', '--json']), err()).toBe(0)
    const result = JSON.parse(out()) as PruneJson
    expect(result.change).toBe(CHANGE)
    expect(result.pruned).toEqual(UNCLAIMED)
    expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/u)
    expect((await planJson()).digest).toBe(result.digest)
  }, 60_000)

  test('套件 glob 改回去之后，同一批登记就被认领、不再被删：认领只看当前目录', async () => {
    await project()
    await writeFile(catalogPath(), CATALOG.replace('files: ["src/**/*.test.ts"]', 'files: ["src/**/*.test.ts", "legacy/**/*.test.ts"]'), 'utf8')
    expect(await tenon(['test', 'sync', CHANGE, '--prune', '--json']), err()).toBe(0)
    expect((JSON.parse(out()) as PruneJson).pruned.map((item) => item.path)).toEqual(['archive/notes.spec.report', 'src/ghost.test.ts'])
    expect((await planJson()).plan?.files.map((file) => file.path)).toEqual(['assets/shot.png', 'legacy/old.test.ts', ...CLAIMED.slice(1)])
  }, 60_000)

  test('拒绝按不可信的输入裁剪：没有目录、目录无效、空目录、计划被手改、非负责人——都 exit 1 且计划不动', async () => {
    await project()
    const before = await planBytes()
    expect(await tenon(['test', 'sync', CHANGE, '--prune'], { ...ENV, ...OTHER })).toBe(1)
    expect(err()).toContain('负责人')
    expect(await planBytes()).toBe(before)
    // 对账（只读）不要求负责人：同一个人照样能看到要删的项。
    expect(await tenon(['test', 'sync', CHANGE], { ...ENV, ...OTHER })).toBe(2)
    expect(out()).toContain('--prune')

    await writeFile(catalogPath(), 'schema: tenon-test-catalog/v1\nsuites: []\n', 'utf8')
    expect(await tenon(['test', 'sync', CHANGE, '--prune'])).toBe(1)
    expect(err()).toContain('没有任何套件')
    expect(await planBytes()).toBe(before)

    await writeFile(catalogPath(), 'schema: nope\n', 'utf8')
    expect(await tenon(['test', 'sync', CHANGE, '--prune'])).toBe(1)
    expect(err()).toContain('catalog.yaml 无效')
    expect(await planBytes()).toBe(before)

    await rm(catalogPath())
    expect(await tenon(['test', 'sync', CHANGE, '--prune'])).toBe(1)
    expect(err()).toContain('还没有测试目录')
    expect(await planBytes()).toBe(before)

    await writeFile(catalogPath(), CATALOG, 'utf8')
    const original = await readFile(testPlanPath(changeDir()), 'utf8')
    await writeFile(testPlanPath(changeDir()), original.replace('legacy/old.test.ts', 'legacy/other.test.ts'), 'utf8')
    const tampered = await planBytes()
    expect(await tenon(['test', 'sync', CHANGE, '--prune'])).toBe(1)
    expect(err()).toContain('不可信')
    expect(await planBytes()).toBe(tampered)
  }, 60_000)

  test('与 register 同一把计划锁：并发的 --prune 与 register --file 互不覆盖，两边的改动都在', async () => {
    await project()
    await writeFiles(cwd(), { 'src/fresh.test.ts': 'export {}\n' })
    const codes = await Promise.all([
      tenon(['test', 'sync', CHANGE, '--prune', '--json']),
      tenon(['test', 'register', CHANGE, '--file', 'src/fresh.test.ts']),
    ])
    expect(codes).toEqual([0, 0])
    const state = await readTestPlanState(changeDir(), CHANGE)
    expect(state.state).toBe('ok')
    expect(state.state === 'ok' ? state.plan.files.map((file) => file.path) : []).toEqual(['assets/shot.png', 'src/also.test.ts', 'src/fresh.test.ts', 'src/math.test.ts'])
  }, 60_000)

  describe('收窄套件 glob 再 --prune 不能绕过评审门', () => {
    /** 评审门步骤 + 目录随基线提交：之后对目录的任何改动都落在本任务的 diff 里，要人在评审里确认。 */
    const GATED_WORKFLOW = WORKFLOW.replace('gate: null', 'gate: review')
    const GITIGNORE = 'test-results\nopenspec\n.tenon/users\n.pipeline-*\n.pipeline/cache\n.pipeline/.gitignore\n.tenon/.gitignore\n'
    const NARROWED = CATALOG.replace('files: ["src/**/*.test.ts"]', 'files: ["src/math.test.ts"]')

    interface StatusJson { policy?: { blockers: Array<{ code: string; blocking: boolean; subject?: string; fix?: string }> } }

    async function gatedProject(): Promise<void> {
      const harness = await freshHarness()
      h = harness
      await writeFiles(harness.cwd, {
        ...FILES,
        '.gitignore': GITIGNORE,
        '.tenon/tests/catalog.yaml': CATALOG,
        '.pipeline/workflows/pruned.yaml': GATED_WORKFLOW,
      })
      git(harness.cwd, ['init', '-q', '-b', 'main'])
      commitAll(harness.cwd, 'base', '2026-01-01T00:00:00Z')
      expect(await tenon(['init', CHANGE, '--track', 'backend', '--workflow', 'pruned', '--preset', 'full']), err()).toBe(0)
      await writeTestPlan(changeDir(), PLAN, { actor: { id: OWNER.TENON_USER, name: OWNER.TENON_USER_NAME, trust: 'declared' }, recordedAt: '2026-01-02T00:00:00.000Z' })
    }

    /** 当前步骤上“目录等受保护配置的改动待人确认”这一类阻塞（code / 对象 / 修复命令）。 */
    async function protectedBlockers(): Promise<Array<{ code: string; subject?: string; fix?: string }>> {
      await tenon(['test', 'status', CHANGE, '--step', 'build', '--json'])
      return ((JSON.parse(out()) as StatusJson).policy?.blockers ?? [])
        .filter((item) => item.blocking && item.code === 'protected-file-unapproved')
        .map(({ code, subject, fix }) => ({ code, subject, fix }))
    }

    test('对照：目录没动时评审门不挡；收窄 glob 后 --prune 确实删掉了被放开的登记，门上随即多出“目录改动待确认”', async () => {
      await gatedProject()
      expect(await protectedBlockers()).toEqual([])

      await writeFile(catalogPath(), NARROWED, 'utf8')
      expect(await tenon(['test', 'sync', CHANGE, '--prune', '--json']), err()).toBe(0)
      expect((JSON.parse(out()) as PruneJson).pruned.map((item) => item.path)).toContain('src/also.test.ts')
      expect((await planJson()).plan?.files.map((file) => file.path)).not.toContain('src/also.test.ts')

      expect(await protectedBlockers()).toEqual([
        { code: 'protected-file-unapproved', subject: '.tenon/tests/catalog.yaml', fix: `tenon review request ${CHANGE} --event build-done` },
      ])
    }, 120_000)

    test('在那之后出口仍被挡：test status 退出 2，transition 被拒并点名目录改动；还原目录后这条阻塞消失', async () => {
      await gatedProject()
      await writeFile(catalogPath(), NARROWED, 'utf8')
      expect(await tenon(['test', 'sync', CHANGE, '--prune']), err()).toBe(0)

      expect(await tenon(['test', 'status', CHANGE, '--step', 'build', '--json'])).toBe(2)
      expect(await tenon(['transition', CHANGE, 'build-done'])).not.toBe(0)
      expect(err()).toContain('测试目录 .tenon/tests/catalog.yaml')

      await writeFile(catalogPath(), CATALOG, 'utf8')
      expect(await protectedBlockers()).toEqual([])
    }, 120_000)
  })

  test('任务还没有测试计划：没有可删的项，exit 0，也不会凭空建出计划', async () => {
    await project()
    await rm(testPlanPath(changeDir()))
    await rm(testPlanLedgerPath(changeDir()))
    expect(await tenon(['test', 'sync', CHANGE, '--prune']), err()).toBe(0)
    expect(out()).toContain('还没有登记')
    expect((await readTestPlanState(changeDir(), CHANGE)).state).toBe('missing')
  }, 60_000)
})
