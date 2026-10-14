/**
 * 测试设置简化（simplify-test-settings）的端到端验收：只有 `npm test` 的新 JavaScript 项目。
 *   1. 轻量轨道全程不登记、不映射：新增的测试文件由套件 glob 认领，调用记录里没有登记 / 映射类命令；
 *   2. 用户级信任跨 worktree：主检出信任一次，新 worktree 里直接运行；
 *   3. 在途的旧 test_policy（files: registered）：登记过的与新增被认领的测试文件一起走完 verify；
 *   4. 指纹：build 冻结后测试输出目录里未跟踪的 .log 不让候选失效，.mjs 或已跟踪源码的改动照旧让它失效。
 * 真临时 git 仓库、真 CLI（buildProgram）、真执行 node:test 套件；用户级信任落在每个用例独立的临时 TENON_RUNTIME_HOME 下。
 */
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { candidateFingerprint, readTestSeal, readTrustStore, resolveProductPaths } from '@tenon/kernel'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { freshHarness, makeHarness, rm, type Harness } from './integration-harness.js'
import { commitAll, git, initGit, writeFiles } from './integration-harness-tests.js'
import { repoTrustIdentity } from './test-system/repo-identity.js'

const USER = { TENON_USER: 'a@x.io', TENON_USER_NAME: 'A', TENON_TEST_REAL_DIFF: '1', TENON_TEST_TICKING_CLOCK: '1' }
/** 关掉测试装配默认的「已信任」：像刚克隆下来的仓库一样，用户还没确认过里面的命令。 */
const UNTRUSTED = { ...USER, TENON_TEST_TRUST: '' }
const SLUG = 'a-at-x.io'

/** 只有 `npm test` 的新项目：没有 typecheck / integration / playwright 脚本，测试在 test/ 下。 */
const PROJECT: Readonly<Record<string, string>> = {
  'package.json': '{ "name": "lite", "private": true, "type": "module", "scripts": { "test": "node --test" } }\n',
  'src/add.js': 'export const add = (a, b) => a + b\n',
  'test/add.test.js': [
    "import { test } from 'node:test'",
    "import assert from 'node:assert/strict'",
    "import { add } from '../src/add.js'",
    "test('adds two numbers', () => { assert.equal(add(1, 2), 3) })",
    '',
  ].join('\n'),
}

/** 一对新增的源码与测试文件：测试文件由 unit 的 glob 认领。 */
function pair(name: string, op: string, expected: number): Readonly<Record<string, string>> {
  return {
    [`src/${name}.js`]: `export const ${name} = (a, b) => a ${op} b\n`,
    [`test/${name}.test.js`]: [
      "import { test } from 'node:test'",
      "import assert from 'node:assert/strict'",
      `import { ${name} } from '../src/${name}.js'`,
      `test('${name} works', () => { assert.equal(${name}(3, 1), ${expected}) })`,
      '',
    ].join('\n'),
  }
}
const SUB = pair('sub', '-', 2)

/** 旧写法的工作流：步骤声明 test_policy，build / verify 都带 `files: registered`。 */
const LEGACY = `name: legacy
tracks:
  backend:
    steps:
      - id: spec
        label: 规格
        gate: null
        skills: []
        guards: []
        test_policy:
          plan: required
          kinds: [unit]
        transitions:
          - event: spec-done
            to: build
      - id: build
        label: 实现
        gate: null
        skills: []
        guards: []
        test_policy:
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
        guards: []
        test_policy:
          run: [unit]
          scope: full
          files: registered
        transitions: []
`

/** build-done 冻结候选（isolation 缺省按 in-place：绑定工作区内容指纹），verify-pass 复验它。 */
const FROZEN = `name: frozen
tracks:
  backend:
    steps:
      - id: build
        label: 实现
        gate: null
        skills: []
        guards: []
        test: changed
        transitions:
          - event: build-done
            to: verify
            actions:
              - type: freeze-build-sha
      - id: verify
        label: 验证
        gate: null
        skills: []
        guards: []
        test: full
        transitions:
          - event: verify-pass
            to: done
            guards:
              - type: build-head-unchanged
                field: build_sha
      - id: done
        label: 完结
        gate: null
        skills: []
        guards: []
        transitions: []
`

/** 用例 2 的 .gitignore：只忽略 Tenon 的本机状态，`.tenon/tests/catalog.yaml` 能进提交（新 worktree 才有同一份目录）。 */
const TRACKED_CATALOG_IGNORE = 'node_modules\ntest-results\nopenspec\n.tenon/users\n.pipeline-*\n.pipeline/cache\n.pipeline/.gitignore\n.tenon/.gitignore\n'

interface Blocker { code: string; blocking: boolean; subject?: string }
interface Report {
  pass: boolean
  policy?: { blockers: Blocker[]; files: { unregistered: unknown[]; orphans: string[]; claimed: Array<{ path: string; suites: string[] }> } }
}
interface PlanJson { state: string; digest: string; plan?: { suites: unknown[]; files: Array<{ path: string }>; cases: unknown[]; waivers: unknown[] } }
interface RunJson {
  record: { suites: Array<{ suite: string; scope: string; totals: { cases: number; pass: number; fail: number }; cases: Array<{ file: string }> }> }
}

/** 记录 harness 实际执行过的每一条 CLI 调用（argv）。 */
function recordCalls(harness: Harness): string[][] {
  const calls: string[][] = []
  const run = harness.run
  harness.run = async (args, options) => {
    calls.push([...args])
    return run(args, options)
  }
  return calls
}

describe('simplify-test-settings 端到端', () => {
  const extraRoots: string[] = []
  let h: Harness | undefined
  let calls: string[][] = []
  let savedRuntimeHome: string | undefined
  // 每个用例一个空的产品 home：用户级信任存储不在用例之间累积。
  beforeEach(async () => {
    savedRuntimeHome = process.env.TENON_RUNTIME_HOME
    process.env.TENON_RUNTIME_HOME = await mkdtemp(join(tmpdir(), 'tenon-settings-home-'))
  })
  afterEach(async () => {
    if (h) await rm(h.cwd, { recursive: true, force: true })
    h = undefined
    await Promise.all(extraRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
    await rm(process.env.TENON_RUNTIME_HOME ?? '', { recursive: true, force: true })
    if (savedRuntimeHome === undefined) delete process.env.TENON_RUNTIME_HOME
    else process.env.TENON_RUNTIME_HOME = savedRuntimeHome
  })

  /** 临时 git 仓库，PROJECT 提交为 base；`ignore` 给了就用它做 .gitignore，否则忽略整个 .tenon（initGit 的做法）。 */
  async function project(options: { readonly ignore?: string } = {}): Promise<Harness> {
    const harness = await freshHarness()
    h = harness
    await writeFiles(harness.cwd, PROJECT)
    if (options.ignore === undefined) {
      initGit(harness.cwd)
    } else {
      await writeFile(join(harness.cwd, '.gitignore'), options.ignore, 'utf8')
      git(harness.cwd, ['init', '-q', '-b', 'main'])
    }
    commitAll(harness.cwd, 'base', '2026-01-01T00:00:00Z')
    calls = recordCalls(harness)
    return harness
  }

  async function workflowFile(name: string, text: string): Promise<void> {
    await mkdir(join(cwd(), '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(cwd(), '.pipeline', 'workflows', `${name}.yaml`), text, 'utf8')
  }

  const tenon = (...args: string[]): Promise<number> => (h as Harness).run(args, { env: USER })
  const out = (): string => (h as Harness).out.join('\n')
  const err = (): string => (h as Harness).err.join('\n')
  const cwd = (): string => (h as Harness).cwd
  const changeDir = (change: string): string => join(cwd(), 'openspec', 'changes', change)

  async function status(change: string, step: string): Promise<Report> {
    await tenon('test', 'status', change, '--step', step, '--json')
    return JSON.parse(out()) as Report
  }
  const blocking = (report: Report): string[] => (report.policy?.blockers ?? []).filter((item) => item.blocking).map((item) => item.code)

  async function plan(change: string): Promise<PlanJson> {
    expect(await tenon('test', 'plan', change, '--json'), err()).toBe(0)
    return JSON.parse(out()) as PlanJson
  }

  /** `tenon status` 给出的下一步动作名。 */
  async function nextActions(change: string): Promise<string[]> {
    expect(await tenon('status', change, '--json'), err()).toBe(0)
    return (JSON.parse(out()) as { step: { next: Array<{ action: string }> } }).step.next.map((item) => item.action)
  }

  /** 宿主加载一个技能：历史里一行 Skill 工具记录 + 内部回执（时间取历史里最晚一条之后一秒）。 */
  let toolUse = 0
  async function loadSkill(change: string, skill: string): Promise<void> {
    const history = join(changeDir(change), '.pipeline-history.jsonl')
    let last = Date.parse('2026-06-01T00:00:00Z')
    for (const line of (await readFile(history, 'utf8').catch(() => '')).split('\n')) {
      const ts = line.trim() === '' ? Number.NaN : Date.parse(String((JSON.parse(line) as { ts?: string }).ts ?? ''))
      if (Number.isFinite(ts)) last = Math.max(last, ts)
    }
    const observedAt = new Date(last + 1000).toISOString().replace(/\.\d{3}Z$/u, 'Z')
    await appendFile(history, `${JSON.stringify({ ts: observedAt, kind: 'tool', raw: `Skill: ${skill}` })}\n`, 'utf8')
    toolUse += 1
    expect(await tenon('internal-native-skill-receipt', change, skill, 'lite-session', `tool-${toolUse}`, observedAt), err()).toBe(0)
  }

  test('lite 全程不登记、不映射：新增的测试文件由 glob 认领，build / verify 的 --stage 都以 0 退出，各步测试证据无阻断', async () => {
    await project()
    const change = 'lite1'
    expect(await tenon('init', change, '--workflow', 'default', '--track', 'lite', '--preset', 'full'), err()).toBe(0)
    expect(err()).toContain('已自动识别 1 个套件')
    expect(await tenon('session', 'activate', change, '--host-session', 'lite-session'), err()).toBe(0)
    await loadSkill(change, 'tenon')
    expect(await tenon('transition', change, 'open-complete'), err()).toBe(0)
    await loadSkill(change, 'tenon')
    await loadSkill(change, 'test-driven-development')
    expect(blocking(await status(change, 'open'))).toEqual([])

    // 实现步新增源码与测试文件；计划初稿不登记任何套件、文件、映射。
    await writeFiles(cwd(), SUB)
    expect(await tenon('test', 'plan', change, '--seed'), err()).toBe(0)
    expect(out()).toContain('新增套件 0 个（改动过的测试文件由套件 glob 自动认领，不用登记）')
    const seeded = await plan(change)
    expect(seeded.state).toBe('ok')
    expect(seeded.plan).toMatchObject({ suites: [], files: [], cases: [], waivers: [] })

    // build 出口：新增的测试文件是「被认领」，不是孤儿也不是未登记；只差运行（unit 与风险探针）。
    const before = await status(change, 'build')
    expect(blocking(before)).toEqual(['test-not-run', 'test-not-run'])
    expect(before.policy?.blockers.map((item) => item.subject)).toEqual(['unit', 'step:diff-risk'])
    expect(before.policy?.files).toMatchObject({ unregistered: [], orphans: [], claimed: [{ path: 'test/sub.test.js', suites: ['unit'] }] })
    const planned = await nextActions(change)
    expect(planned.filter((action) => action.startsWith('test-')), `next 里不该再有登记 / 映射类动作：${planned.join(',')}`).toEqual([])

    expect(await tenon('test', 'run', change, '--stage'), `${out()}\n${err()}`).toBe(0)
    expect(out()).toMatch(/\[PASS\] unit .*scope=changed/u)
    expect(await tenon('test', 'run', change, 'diff-risk'), `${out()}\n${err()}`).toBe(0)
    const build = await status(change, 'build')
    expect(blocking(build), 'build 出口').toEqual([])
    expect(build.pass).toBe(true)

    // verify 出口：full 档全量运行 unit（含新增的测试文件），无阻断。
    expect(await tenon('transition', change, 'build-complete'), `${out()}\n${err()}`).toBe(0)
    await loadSkill(change, 'tenon')
    expect(await tenon('test', 'run', change, '--stage'), `${out()}\n${err()}`).toBe(0)
    expect(out()).toMatch(/\[PASS\] unit .*scope=full/u)
    const verify = await status(change, 'verify')
    expect(blocking(verify), 'verify 出口').toEqual([])
    expect(verify.pass).toBe(true)

    // 零登记：计划逐字不变，files 为空。
    const final = await plan(change)
    expect(final.digest).toBe(seeded.digest)
    expect(final.plan).toMatchObject({ suites: [], files: [], cases: [], waivers: [] })

    // 调用记录：整个过程里执行过的 `tenon test` 子命令只有 plan / run / status；plan 只有 --seed 与只读的 --json；没有 --case。
    const testCalls = calls.filter((argv) => argv[0] === 'test')
    expect([...new Set(testCalls.map((argv) => argv[1]))].sort()).toEqual(['plan', 'run', 'status'])
    expect(testCalls.filter((argv) => argv[1] === 'plan').every((argv) => argv.includes('--seed') || argv.includes('--json'))).toBe(true)
    expect(testCalls.filter((argv) => argv[1] === 'register')).toEqual([])
    expect(calls.filter((argv) => argv.includes('--case'))).toEqual([])
  }, 240_000)

  test('第二个 worktree 不重新信任：主检出以用户身份信任一次，git worktree add 出的新检出里直接运行', async () => {
    const main = await project({ ignore: TRACKED_CATALOG_IGNORE })
    // 目录由 init 自动识别并写入；提交它，新 worktree 才有同一份目录。
    expect(await tenon('init', 'lite2', '--workflow', 'default', '--track', 'lite', '--preset', 'full'), err()).toBe(0)
    commitAll(main.cwd, 'catalog', '2026-01-02T00:00:00Z')
    await writeFiles(main.cwd, SUB)
    expect(await tenon('test', 'plan', 'lite2', '--seed'), err()).toBe(0)

    // 对照：还没信任时，主检出的运行被拒，什么都不执行。
    expect(await main.run(['test', 'run', 'lite2', '--stage', 'build'], { env: UNTRUSTED })).toBe(1)
    expect(main.err.join('\n')).toContain('还没有得到你的信任')
    expect(main.err.join('\n')).toContain('node --test')

    // 用户在自己的终端里信任（测试代码直接调用 CLI，不经 agent hook）。
    expect(await main.run(['test', 'trust', '--yes'], { env: UNTRUSTED }), main.err.join('\n')).toBe(0)
    expect(main.out.join('\n')).toContain('node --test')
    const identity = await repoTrustIdentity(main.cwd)
    if (identity.kind !== 'repo') throw new Error(`主检出没有仓库身份：${identity.kind}`)

    // 新 worktree：同一仓库，另一个检出目录。
    const linkedPath = `${main.cwd}-wt`
    extraRoots.push(linkedPath)
    git(main.cwd, ['worktree', 'add', '-q', '-b', 'feature', linkedPath])
    const linked = makeHarness(linkedPath)
    expect(await repoTrustIdentity(linkedPath)).toEqual(identity)
    expect(await linked.run(['init', 'lite2', '--workflow', 'default', '--track', 'lite', '--preset', 'full'], { env: USER }), linked.err.join('\n')).toBe(0)
    await writeFiles(linkedPath, SUB)
    expect(await linked.run(['test', 'plan', 'lite2', '--seed'], { env: USER }), linked.err.join('\n')).toBe(0)
    expect(await linked.run(['test', 'run', 'lite2', '--stage', 'build'], { env: UNTRUSTED }), `${linked.out.join('\n')}\n${linked.err.join('\n')}`).toBe(0)
    expect(linked.out.join('\n')).toMatch(/\[PASS\] unit .*scope=changed/u)
    expect(linked.err.join('\n')).not.toContain('信任')

    // 信任记在用户级目录（按仓库身份），不写进任何一个检出的封存；状态根在测试的临时目录下，不碰真实用户目录。
    const stateRoot = resolveProductPaths({ env: process.env }).stateRoot
    expect(stateRoot.startsWith(tmpdir())).toBe(true)
    const stored = await readTrustStore(stateRoot, SLUG)
    expect(stored.length).toBeGreaterThan(0)
    expect(stored.every((entry) => entry.repo === identity.repo)).toBe(true)
    expect((await readTestSeal(main.cwd, SLUG)).seal.trusted).toEqual([])
    expect((await readTestSeal(linkedPath, SLUG)).seal.trusted).toEqual([])
  }, 240_000)

  test('在途的旧 test_policy 能走完：登记过 2 个测试文件、再新增 1 个被认领的未登记测试文件，verify 出口没有测试阻断', async () => {
    await project()
    await workflowFile('legacy', LEGACY)
    const change = 'legacy1'
    expect(await tenon('init', change, '--track', 'backend', '--workflow', 'legacy', '--preset', 'full'), err()).toBe(0)
    expect(await tenon('test', 'plan', change, '--seed'), err()).toBe(0)
    expect(await tenon('transition', change, 'spec-done'), err()).toBe(0)

    // 旧做法：新增的测试文件逐个登记进计划。
    await writeFiles(cwd(), { ...pair('mul', '*', 3), ...pair('div', '/', 3) })
    expect(await tenon('test', 'register', change, '--file', 'test/mul.test.js'), err()).toBe(0)
    expect(await tenon('test', 'register', change, '--file', 'test/div.test.js'), err()).toBe(0)
    expect((await plan(change)).plan?.files.map((file) => file.path)).toEqual(['test/div.test.js', 'test/mul.test.js'])

    // 再新增一个被 unit 的 glob 认领、没有登记的测试文件：不是 test-file-unregistered，也不是孤儿。
    await writeFiles(cwd(), pair('mod', '%', 0))
    const build = await status(change, 'build')
    expect(blocking(build)).toEqual(['test-not-run'])
    expect(build.policy?.files.unregistered).toEqual([])
    expect(build.policy?.files.orphans).toEqual([])
    // 本任务改动里的三个测试文件都被 unit 认领（登记过的两个和没登记的 mod）。
    expect(build.policy?.files.claimed.map((item) => [item.path, item.suites])).toEqual([
      ['test/div.test.js', ['unit']], ['test/mod.test.js', ['unit']], ['test/mul.test.js', ['unit']],
    ])

    expect(await tenon('test', 'run', change, '--stage'), `${out()}\n${err()}`).toBe(0)
    const built = await status(change, 'build')
    expect(blocking(built), 'build 出口').toEqual([])
    expect(built.pass).toBe(true)
    expect(await tenon('transition', change, 'build-done'), `${out()}\n${err()}`).toBe(0)

    // verify：full 档；三个新增的测试文件（含没登记的那个）都真的在报告里出现。
    expect(await tenon('test', 'run', change, '--stage', '--json'), `${out()}\n${err()}`).toBe(0)
    const run = JSON.parse(out()) as RunJson
    expect(run.record.suites[0]).toMatchObject({ suite: 'unit', scope: 'full' })
    expect(run.record.suites[0]?.totals).toMatchObject({ cases: 4, pass: 4, fail: 0 })
    expect(run.record.suites[0]?.cases.map((item) => item.file).sort()).toEqual(['test/div.test.js', 'test/mod.test.js', 'test/mul.test.js'])
    const verify = await status(change, 'verify')
    expect(blocking(verify), 'verify 出口').toEqual([])
    expect(verify.pass).toBe(true)
    expect(verify.policy?.blockers.map((item) => item.code)).not.toContain('test-file-unregistered')
    // 认领不写计划：计划里仍只有登记过的那 2 个文件。
    expect((await plan(change)).plan?.files.map((file) => file.path)).toEqual(['test/div.test.js', 'test/mul.test.js'])
  }, 240_000)

  test('未跟踪的 .log 不让候选失效：build 冻结后测试输出目录里写日志，tenon check 不报 revision-stale；.mjs 或已跟踪源码的改动照旧报', async () => {
    await project()
    await workflowFile('frozen', FROZEN)
    const change = 'frozen1'
    expect(await tenon('init', change, '--track', 'backend', '--workflow', 'frozen', '--preset', 'full'), err()).toBe(0)
    // 自动识别的目录把整个 test-results 声明成了产物；这里只声明报告文件，日志目录就是「没有声明」的情形。
    const catalogPath = join(cwd(), '.tenon', 'tests', 'catalog.yaml')
    const catalog = await readFile(catalogPath, 'utf8')
    const narrowed = catalog.replace('    artifacts:\n      - test-results\n', '    artifacts:\n      - test-results/junit.xml\n')
    expect(narrowed).not.toBe(catalog)
    await writeFile(catalogPath, narrowed, 'utf8')

    await writeFiles(cwd(), SUB)
    expect(await tenon('test', 'plan', change, '--seed'), err()).toBe(0)
    expect(await tenon('test', 'run', change, '--stage'), `${out()}\n${err()}`).toBe(0)
    expect(await tenon('transition', change, 'build-done'), `${out()}\n${err()}`).toBe(0)
    expect(await readFile(join(changeDir(change), '.pipeline.yaml'), 'utf8')).toMatch(/^build_sha: build:v1:workspace:/mu)
    // 验证步运行测试：报告重写，不动候选。
    expect(await tenon('test', 'run', change, '--stage'), `${out()}\n${err()}`).toBe(0)
    const frozen = await candidateFingerprint(cwd())
    const stale = async (): Promise<boolean> => {
      await tenon('check', change)
      return `${out()}\n${err()}`.includes('reason=revision-stale')
    }
    expect(await stale(), '基线').toBe(false)

    // e2e 被测服务写出的日志（未跟踪、证据扩展名、目录没有声明）：指纹与冻结时相同。
    await writeFiles(cwd(), {
      'test-results/run.log': 'one\n',
      'test-results/dashboard-e2e-server/serve.log': 'listening\n',
      'test-results/dashboard-e2e-server/dashboard.log': 'ready\n',
    })
    expect(git(cwd(), ['ls-files', '--', 'test-results']).trim()).toBe('')
    expect(await candidateFingerprint(cwd())).toBe(frozen)
    expect(await stale(), '未跟踪的日志').toBe(false)

    // 对照：同一位置的脚本扩展名文件照旧计入，候选失效；删掉后恢复。
    await writeFiles(cwd(), { 'test-results/payload.mjs': 'export const smuggled = true\n' })
    expect(await candidateFingerprint(cwd())).not.toBe(frozen)
    expect(await stale(), '未跟踪的 .mjs').toBe(true)
    expect(out()).toContain('verify-build-revision-untrusted reason=revision-stale')
    await rm(join(cwd(), 'test-results', 'payload.mjs'))
    expect(await stale(), '删掉 .mjs 之后').toBe(false)

    // 对照：改一个已跟踪的源码文件也让候选失效。
    await writeFiles(cwd(), { 'src/add.js': 'export const add = (a, b) => b + a\n' })
    expect(await stale(), '已跟踪源码被改').toBe(true)
  }, 240_000)
})
