/**
 * 零豁免默认测试流程（v0.3 test-flow-lite）—— 验收：一个只有 `npm test` 的新 JavaScript 项目（源码在 src/，测试在 test/），
 * 走 default 工作流的后端与前端任务：`tenon init` 自动识别测试目录 → 计划初稿 → build / verify 按策略运行，
 * 到 verify 出口没有一条豁免、没有手工补目录。
 *
 * 零 mock：真临时 git 项目、真 CLI（buildProgram）、真 kernel 落盘，套件命令是 discover 写进目录的 `node --test`，真执行、
 * 报告被解析成用例。审计里量到的缺口都在这里锁住：test/ 下新增的测试文件被套件认领（不再是「没有套件认领」的孤儿）、
 * typecheck / integration / playwright 不再是必需种类、覆盖率门槛不对没声明覆盖率的目录生效。
 */
import { readFile, rm as removeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { freshHarness, rm, type Harness } from './integration-harness.js'
import { commitAll, initGit, writeFiles } from './integration-harness-tests.js'

const USER = { TENON_USER: 'a@x.io', TENON_USER_NAME: 'A', TENON_TEST_REAL_DIFF: '1', TENON_TEST_TICKING_CLOCK: '1' }

/** 只有 `npm test` 的新项目：没有 typecheck / test:integration / playwright，测试在 test/ 下。 */
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

/** 任务过程中新增的一个测试文件（审计里量到的场景：src/ 存在时 test/ 下的新文件「没有套件认领」）。 */
const NEW_FILES: Readonly<Record<string, string>> = {
  'src/sub.js': 'export const sub = (a, b) => a - b\n',
  'test/sub.test.js': [
    "import { test } from 'node:test'",
    "import assert from 'node:assert/strict'",
    "import { sub } from '../src/sub.js'",
    "test('subtracts', () => { assert.equal(sub(3, 1), 2) })",
    '',
  ].join('\n'),
}

const TEST_EXT = '{test,spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}'

interface PolicyBlocker { code: string; blocking: boolean; subject?: string; fix?: string; message: string }
interface Report { pass: boolean; policy?: { blockers: PolicyBlocker[] } }
interface PlanJson {
  state: string
  plan?: { suites: Array<{ suite: string; scope: string }>; files: Array<{ path: string; suite?: string }>; waivers: unknown[] }
}

describe('零豁免默认测试流程：只有 npm test 的新 JavaScript 项目', () => {
  let h: Harness | undefined
  afterEach(async () => { if (h) await rm(h.cwd, { recursive: true, force: true }); h = undefined })

  async function project(files: Readonly<Record<string, string>> = PROJECT): Promise<Harness> {
    const harness = await freshHarness()
    h = harness
    await writeFiles(harness.cwd, files)
    initGit(harness.cwd)
    commitAll(harness.cwd, 'base', '2026-01-01T00:00:00Z')
    return harness
  }

  const tenon = (...args: string[]): Promise<number> => (h as Harness).run(args, { env: USER })
  const out = (): string => (h as Harness).out.join('\n')
  const err = (): string => (h as Harness).err.join('\n')
  const cwd = (): string => (h as Harness).cwd
  const catalogPath = (): string => join(cwd(), '.tenon', 'tests', 'catalog.yaml')

  async function status(change: string, step: string): Promise<Report> {
    await tenon('test', 'status', change, '--step', step, '--json')
    return JSON.parse(out()) as Report
  }
  const blocking = (report: Report): string[] => (report.policy?.blockers ?? []).filter((item) => item.blocking).map((item) => item.code)

  async function plan(change: string): Promise<PlanJson> {
    expect(await tenon('test', 'plan', change, '--json'), err()).toBe(0)
    return JSON.parse(out()) as PlanJson
  }

  async function catalogSuites(): Promise<Array<{ id: string; kind: string; runner: string; files: string[] }>> {
    expect(await tenon('test', 'catalog', 'show', '--json'), err()).toBe(0)
    return (JSON.parse(out()) as { suites: Array<{ id: string; kind: string; runner: string; files: string[] }> }).suites
  }

  /** 走完一个任务的测试流程：init → 计划初稿 → 新增测试文件被认领（不登记）→ build / verify 运行 → 各步出口零阻塞、零豁免。 */
  async function walk(change: string, track: 'backend' | 'frontend'): Promise<void> {
    expect(await tenon('init', change, '--track', track, '--preset', 'full'), err()).toBe(0)
    // init 发现没有目录：自动识别并明说做了什么。
    expect(err()).toContain('[TEST] 项目还没有测试目录：已自动识别 1 个套件并写入 .tenon/tests/catalog.yaml（unit）')
    expect(err()).toContain('请审阅')
    expect(await tenon('test', 'catalog', 'validate'), err()).toBe(0)
    const [unit] = await catalogSuites()
    expect(unit).toMatchObject({ id: 'unit', kind: 'unit', runner: 'node-test' })
    // 单测 glob 认 src/、test/、tests/、__tests__/ 与根目录，不再只认 src/。
    expect(unit?.files).toEqual([
      ...['src', 'test', 'tests', '__tests__'].map((dir) => `${dir}/**/*.${TEST_EXT}`), `*.${TEST_EXT}`,
    ])

    expect(await tenon('test', 'plan', change, '--seed'), err()).toBe(0)
    expect(out()).not.toContain('策略要求')
    const seeded = await plan(change)
    // 档位策略（default 的步骤只记档位名）不往计划里写套件：运行集在求值时由目录与本任务的改动算出，计划只记例外。
    expect(seeded.state).toBe('ok')
    expect(seeded.plan?.suites).toEqual([])
    expect(seeded.plan?.waivers).toEqual([])
    expect(blocking(await status(change, 'spec')), 'spec 出口').toEqual([])

    // 任务过程中新增 test/ 下的测试文件：被 unit 的 glob 认领，不用登记（也不是孤儿），只剩「还没跑」。
    await writeFiles(cwd(), NEW_FILES)
    const claimed = await status(change, 'build')
    expect(blocking(claimed)).toEqual(['test-not-run'])
    expect(claimed.policy?.blockers[0]).toMatchObject({ subject: 'unit', fix: `tenon test run ${change} --suite unit` })

    // build：changed 档，改动碰到了 unit（新增的测试文件被它认领）所以只跑它，范围 changed；typecheck 没有套件就不要求。
    expect(await tenon('test', 'run', change, '--stage', 'build'), `${out()}\n${err()}`).toBe(0)
    expect(out()).toMatch(/\[PASS\] unit .*scope=changed/u)
    expect(blocking(await status(change, 'build')), 'build 出口').toEqual([])
    // verify：full 档，unit 全量运行（即回归）；playwright / integration / regression / benchmark 目录里没有套件就不要求；没有声明覆盖率的目录不受 80% 门槛影响。
    expect(await tenon('test', 'run', change, '--stage', 'verify'), `${out()}\n${err()}`).toBe(0)
    expect(out()).toMatch(/\[PASS\] unit .*scope=full/u)
    expect(await tenon('test', 'run', change, 'code-size'), `${out()}\n${err()}`).toBe(0)
    const verify = await status(change, 'verify')
    expect(blocking(verify), 'verify 出口').toEqual([])
    expect(verify.pass).toBe(true)

    // 零豁免、零逐个登记：认领的测试文件不写进计划。
    const final = await plan(change)
    expect(final.plan?.waivers).toEqual([])
    expect(final.plan?.files).toEqual([])
  }

  test('backend：init 自动识别 → 计划初稿 → test/ 下新增的测试被认领 → build / verify 到出口零豁免', async () => {
    await project()
    await walk('be', 'backend')
  }, 240_000)

  test('frontend：同一项目、同一套流程，没有 Playwright / typecheck / 覆盖率声明也零豁免', async () => {
    await project()
    await walk('fe', 'frontend')
  }, 240_000)

  test('同一项目里第二个任务：目录已经在，init 不再识别也不动它', async () => {
    await project()
    await walk('be', 'backend')
    const before = await readFile(catalogPath(), 'utf8')
    expect(await tenon('init', 'fe', '--track', 'frontend', '--preset', 'full'), err()).toBe(0)
    expect(err()).not.toContain('自动识别')
    expect(await readFile(catalogPath(), 'utf8')).toBe(before)
  }, 240_000)

  test('测试文件在 plan --seed 之前就已在 diff 里：测试文件由 glob 认领（计划里没有套件也没有文件登记），build 的 changed 档只跑它，报告落得了盘', async () => {
    await project()
    expect(await tenon('init', 'be', '--track', 'backend', '--preset', 'full'), err()).toBe(0)
    await writeFiles(cwd(), NEW_FILES)
    expect(await tenon('test', 'plan', 'be', '--seed'), err()).toBe(0)
    const seeded = await plan('be')
    // 旧的计划初稿按「diff 里已有测试文件」把 unit 登记成 changed；档位下运行集由 build 步的 changed 档在求值时算，计划不记。
    expect(seeded.plan?.suites).toEqual([])
    expect(seeded.plan?.files).toEqual([])
    // node:test 的 select.files 模板：reporter 参数在文件之前，否则被当成测试脚本的参数、报告落不了盘（report-missing）。
    expect((await catalogSuites())[0]).toMatchObject({ runner: 'node-test' })
    await tenon('test', 'catalog', 'show', 'unit', '--json')
    expect((JSON.parse(out()) as { select: { files: string } }).select.files).toMatch(/^node --test --test-reporter=.* \{files\}$/u)
    expect(await tenon('test', 'run', 'be', '--stage', 'build'), `${out()}\n${err()}`).toBe(0)
    expect(out()).toMatch(/\[PASS\] unit .*scope=changed/u)
    expect(blocking(await status('be', 'build'))).toEqual([])
  }, 240_000)

  test('catalog not-applicable：声明带原因、未批准；show 标出；换理由批准清零；--rm 撤销；种类与理由校验', async () => {
    await project()
    expect(await tenon('init', 'be', '--track', 'backend', '--preset', 'full'), err()).toBe(0)
    expect(await tenon('test', 'catalog', 'not-applicable', 'nope', '--reason', 'x')).toBe(1)
    expect(err()).toContain("种类 'nope' 不合法")
    expect(await tenon('test', 'catalog', 'not-applicable', 'typecheck')).toBe(1)
    expect(err()).toContain('--reason 必填')
    expect(await tenon('test', 'catalog', 'na', 'typecheck', '--reason', '纯 JavaScript 项目，没有类型检查'), err()).toBe(0)
    expect(out()).toContain('尚未批准')
    expect(await tenon('test', 'catalog', 'validate'), err()).toBe(0)
    expect(await tenon('test', 'catalog', 'show'), err()).toBe(0)
    expect(out()).toContain('typecheck  [未批准]  纯 JavaScript 项目，没有类型检查')
    const catalog = await readFile(catalogPath(), 'utf8')
    expect(catalog).toContain('not_applicable:')
    expect(catalog).toContain('approved_by: null')
    // 同一条再声明一次：不改文件；换理由：仍是未批准的新理由。
    expect(await tenon('test', 'catalog', 'not-applicable', 'typecheck', '--reason', '纯 JavaScript 项目，没有类型检查'), err()).toBe(0)
    expect(await readFile(catalogPath(), 'utf8')).toBe(catalog)
    expect(await tenon('test', 'catalog', 'not-applicable', 'typecheck', '--reason', '另一条理由'), err()).toBe(0)
    expect(await tenon('test', 'catalog', 'show', '--json')).toBe(0)
    expect((JSON.parse(out()) as { not_applicable: unknown[] }).not_applicable).toEqual([{ kind: 'typecheck', reason: '另一条理由', approved_by: null }])
    expect(await tenon('test', 'catalog', 'not-applicable', 'typecheck', '--rm', '--reason', 'x')).toBe(1)
    expect(await tenon('test', 'catalog', 'not-applicable', 'typecheck', '--rm'), err()).toBe(0)
    expect(await tenon('test', 'catalog', 'not-applicable', 'typecheck', '--rm')).toBe(1)
    expect(err()).toContain('没有 typecheck 的不适用声明')
    expect(await readFile(catalogPath(), 'utf8')).not.toContain('not_applicable')
  })

  test('没有识别到测试工具：init 明说并给出下一步，不写空目录', async () => {
    await project({ 'package.json': '{ "name": "bare", "private": true }\n' })
    expect(await tenon('init', 'be', '--track', 'backend', '--preset', 'full'), err()).toBe(0)
    expect(err()).toContain('自动识别没有找到测试工具')
    expect(err()).toContain('tenon test catalog not-applicable unit')
    expect(existsSync(catalogPath())).toBe(false)
  })

  test('已有目录（包括无效的）init 不碰', async () => {
    await project()
    await writeFiles(cwd(), { '.tenon/tests/catalog.yaml': 'schema: nope\n' })
    expect(await tenon('init', 'be', '--track', 'backend', '--preset', 'full'), err()).toBe(0)
    expect(err()).not.toContain('自动识别')
    expect(await readFile(catalogPath(), 'utf8')).toBe('schema: nope\n')
  })

  test('已有的旧目录（单测 glob 只认 src/）：test-file-orphan 的修复命令是 register --auto；--auto 只追加本任务孤儿的精确路径，重复运行幂等', async () => {
    await project()
    expect(await tenon('test', 'discover', '--write'), err()).toBe(0)
    expect(await tenon('test', 'catalog', 'set', 'unit', '--file-glob', 'src/**/*.test.js'), err()).toBe(0)
    expect(await tenon('init', 'be', '--track', 'backend', '--preset', 'full'), err()).toBe(0)
    expect(err()).not.toContain('自动识别')
    await writeFiles(cwd(), NEW_FILES)

    const orphan = await status('be', 'build')
    const orphans = (orphan.policy?.blockers ?? []).filter((item) => item.code === 'test-file-orphan')
    // 门禁只看任务 diff 里的文件（test/add.test.js 在任务之前就提交了）。
    expect(orphans.map((item) => item.subject)).toEqual(['test/sub.test.js'])
    expect(orphans.map((item) => item.fix)).toEqual(['tenon test register be --auto'])

    expect(await tenon('test', 'register', 'be', '--auto'), `${out()}\n${err()}`).toBe(0)
    expect(out()).toContain('套件 unit 的 files 增加 test/sub.test.js（本任务里原先没有套件认领的测试文件 1 个）')
    // 只追加本任务孤儿的精确路径：不放宽成 test/**，任务之前就存在的 test/add.test.js 不被认领。
    expect((await catalogSuites())[0]?.files).toEqual(['src/**/*.test.js', 'test/sub.test.js'])
    const registered = await plan('be')
    // --auto 只追加精确路径（上面的目录断言），不再把套件写进计划；认领在求值时现算，计划里不逐个登记文件。
    expect(registered.plan?.suites).toEqual([])
    expect(registered.plan?.files).toEqual([])
    expect(blocking(await status('be', 'build'))).toEqual(['test-not-run'])
    expect(await tenon('test', 'run', 'be', '--stage', 'build'), `${out()}\n${err()}`).toBe(0)
    expect(blocking(await status('be', 'build'))).toEqual([])

    // 幂等：再来一遍什么都不变。
    const catalogBefore = await readFile(catalogPath(), 'utf8')
    const planBefore = await plan('be')
    expect(await tenon('test', 'register', 'be', '--auto'), err()).toBe(0)
    expect(out()).not.toContain('files 增加')
    expect(await readFile(catalogPath(), 'utf8')).toBe(catalogBefore)
    expect(await plan('be')).toEqual(planBefore)
  }, 240_000)

  test('register --auto：目录不存在先识别写入；不能和 --suite / --file / --case 混用', async () => {
    await project()
    expect(await tenon('init', 'be', '--track', 'backend', '--preset', 'full'), err()).toBe(0)
    await removeFile(catalogPath())
    expect(await tenon('test', 'register', 'be', '--auto', '--suite', 'unit')).toBe(1)
    expect(err()).toContain('--auto 不能和')
    expect(await tenon('test', 'register', 'be', '--auto'), `${out()}\n${err()}`).toBe(0)
    expect(out()).toContain('目录不存在：已自动识别 1 个套件并写入')
    // 写进目录的是识别出的 unit 套件；计划里不再登记套件（档位按目录与改动在求值时算运行集）。
    expect((await catalogSuites()).map((suite) => suite.id)).toEqual(['unit'])
    expect((await plan('be')).plan?.suites).toEqual([])
  })

  test('discover 的单测 glob：四个常见目录 + 根目录测试文件；一个目录都没有时取整个 cwd', async () => {
    await project({ 'package.json': PROJECT['package.json'] ?? '', 'lib/x.test.js': '' })
    expect(await tenon('test', 'discover', '--json'), err()).toBe(0)
    const found = JSON.parse(out()) as { suites: Array<{ id: string; suite: { files: string[] } }> }
    expect(found.suites.find((item) => item.id === 'unit')?.suite.files).toEqual([`**/*.${TEST_EXT}`])
  })
})
