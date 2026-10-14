/**
 * `tenon test register <change> --auto` 与目录写回（真临时 git 项目、真 CLI、真 kernel 落盘）：
 * --auto 只处理本任务改动里的孤儿测试文件，把精确路径追加进套件 files，不放宽 glob、不碰没改动的文件、不认领归档里的证据；
 * 目录里的注释和排版在 --auto 与 `tenon test catalog set` 之后逐字保留。
 */
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { freshHarness, type Harness } from './integration-harness.js'
import { commitAll, git, writeFiles } from './integration-harness-tests.js'

const CHANGE = 'demo'
const ENV = { TENON_USER: 'a@x.io', TENON_USER_NAME: 'A', TENON_TEST_REAL_DIFF: '1', TENON_TEST_TICKING_CLOCK: '1' }
const UNIT_COMMAND = 'command: npx vitest run --reporter=junit --outputFile=test-results/unit.xml'

const CATALOG = `# 项目测试目录：说明写在这里，改动后必须还在
schema: tenon-test-catalog/v1
suites:
  # ── 单测 ──
  - id: unit
    label: 单测
    kind: unit
    runner: vitest
    ${UNIT_COMMAND}
    files:
      - src/**/*.test.ts
    report:
      format: junit
      path: test-results/unit.xml
  # ── 静态检查 ──
  - id: lint
    label: 静态检查
    kind: lint
    runner: custom
    command: npm run lint
    report:
      format: exit-code
`

const LINT_ONLY_CATALOG = `# 只有静态检查
schema: tenon-test-catalog/v1
suites:
  - id: lint
    kind: lint
    runner: custom
    command: npm run lint
    report:
      format: exit-code
`

const BASE_FILES: Readonly<Record<string, string>> = {
  'package.json': '{ "name": "fixture", "private": true, "type": "module" }\n',
  '.gitignore': 'node_modules\ntest-results\n.tenon/users\n.pipeline-*\n.pipeline/cache\n.pipeline/.gitignore\n.tenon/.gitignore\n',
  'src/math.ts': 'export const add = (a: number, b: number): number => a + b\n',
  'src/math.test.ts': 'export {}\n',
  // 任务开始之前就在仓库里、没有任何套件认领、本任务也没改它：--auto 不能碰。
  'old/y.test.js': 'export {}\n',
  // 已提交的归档证据：名字像测试（.spec.），但在控制目录里、扩展名也不是源码。
  'openspec/changes/archive/a/.pipeline-run/review-attempt-reports/r.spec.report': 'report\n',
}

describe('tenon test register --auto：只认领本任务孤儿的精确路径', () => {
  let h: Harness | undefined
  afterEach(async () => { if (h) await rm(h.cwd, { recursive: true, force: true }); h = undefined })

  const cwd = (): string => (h as Harness).cwd
  const out = (): string => (h as Harness).out.join('\n')
  const err = (): string => (h as Harness).err.join('\n')
  const tenon = (...args: string[]): Promise<number> => (h as Harness).run(args, { env: ENV })
  const catalogPath = (): string => join(cwd(), '.tenon', 'tests', 'catalog.yaml')
  const catalogText = (): Promise<string> => readFile(catalogPath(), 'utf8')

  /** 目录与基础文件提交为基线，再 init 任务；之后写入的文件才算本任务的改动。 */
  async function project(catalog: string = CATALOG): Promise<void> {
    const harness = await freshHarness()
    h = harness
    await writeFiles(harness.cwd, { ...BASE_FILES, '.tenon/tests/catalog.yaml': catalog })
    git(harness.cwd, ['init', '-q', '-b', 'main'])
    commitAll(harness.cwd, 'base', '2026-01-01T00:00:00Z')
    expect(await tenon('init', CHANGE, '--track', 'backend', '--preset', 'full'), err()).toBe(0)
  }

  async function planFiles(): Promise<string[]> {
    expect(await tenon('test', 'plan', CHANGE, '--json'), err()).toBe(0)
    const plan = (JSON.parse(out()) as { plan?: { files: Array<{ path: string }> } }).plan
    return (plan?.files ?? []).map((file) => file.path)
  }

  test('不放宽 glob：孤儿 tools/x.test.mjs 之后，unit.files 只多这一项，没有 tools/**，目录里的注释与其余行逐字保留', async () => {
    await project()
    await writeFiles(cwd(), { 'tools/x.test.mjs': 'export {}\n', 'src/new.test.ts': 'export {}\n' })
    expect(await tenon('test', 'register', CHANGE, '--auto'), `${out()}\n${err()}`).toBe(0)
    const text = await catalogText()
    expect(text).toBe(CATALOG.replace('      - src/**/*.test.ts\n', '      - src/**/*.test.ts\n      - tools/x.test.mjs\n'))
    expect(text).not.toContain('tools/**')
    expect(out()).toContain('套件 unit 的 files 增加 tools/x.test.mjs')

    // 幂等：再来一遍目录一个字节都不变。
    expect(await tenon('test', 'register', CHANGE, '--auto'), err()).toBe(0)
    expect(await catalogText()).toBe(text)
  }, 120_000)

  test('不碰没改动的文件：仓库里原有的 old/y.test.js 既不被认领，目录与计划里也不出现它', async () => {
    await project()
    // 本任务只改了一个非测试文件：没有孤儿，目录原样，old/y.test.js 照样没人管。
    await writeFiles(cwd(), { 'src/extra.ts': 'export {}\n' })
    expect(await tenon('test', 'register', CHANGE, '--auto'), `${out()}\n${err()}`).toBe(0)
    expect(await catalogText()).toBe(CATALOG)
    expect(await planFiles()).not.toContain('old/y.test.js')

    // 本任务新增一个孤儿：只认领它，old/y.test.js 仍然不在目录与计划里。
    await writeFiles(cwd(), { 'tools/x.test.mjs': 'export {}\n' })
    expect(await tenon('test', 'register', CHANGE, '--auto'), `${out()}\n${err()}`).toBe(0)
    expect(await catalogText()).toContain('      - tools/x.test.mjs\n')
    expect(await catalogText()).not.toContain('old/y.test.js')
    expect(await planFiles()).not.toContain('old/y.test.js')
  }, 120_000)

  test('不认领归档里的 .spec.report：已提交的、本任务新增的归档证据与非源码的 .spec.json 都不是孤儿', async () => {
    await project()
    await writeFiles(cwd(), {
      'openspec/changes/archive/b/.pipeline-run/review-attempt-reports/s.spec.report': 'report\n',
      'openspec/changes/demo/notes.spec.md': 'notes\n',
      'fixtures/data.spec.json': '{}\n',
      'e2e/fixtures/seed.json': '{}\n',
    })
    expect(await tenon('test', 'register', CHANGE, '--auto'), `${out()}\n${err()}`).toBe(0)
    expect(await catalogText()).toBe(CATALOG)
    expect(out()).not.toContain('增加')
    expect(await planFiles()).toEqual([])
  }, 120_000)

  test('没有合适的套件：报错并给出补套件的命令，目录一个字节都不写（认得出的文件也不单独写）', async () => {
    await project(LINT_ONLY_CATALOG)
    await writeFiles(cwd(), { 'tools/x.test.mjs': 'export {}\n' })
    expect(await tenon('test', 'register', CHANGE, '--auto')).toBe(1)
    expect(err()).toContain('tools/x.test.mjs')
    expect(err()).toContain('tenon test catalog add')
    expect(err()).toContain(`tenon test register ${CHANGE} --auto`)
    expect(await catalogText()).toBe(LINT_ONLY_CATALOG)
  }, 120_000)

  test('没有合适的套件时列出的路径是仓库里的文件名：ESC 与双向覆盖字符去掉，不能改写屏幕；目录照旧不写', async () => {
    await project(LINT_ONLY_CATALOG)
    const esc = String.fromCodePoint(0x1b)
    const rlo = String.fromCodePoint(0x202e)
    await writeFiles(cwd(), { [`tools/x${esc}[2J${rlo}.test.mjs`]: 'export {}\n' })
    expect(await tenon('test', 'register', CHANGE, '--auto')).toBe(1)
    expect(err()).toContain('1 个测试文件没有合适的套件可认领')
    expect(err()).toContain('tools/x[2J.test.mjs')
    expect(err()).not.toContain(esc)
    expect(err()).not.toContain(rlo)
    expect(await catalogText()).toBe(LINT_ONLY_CATALOG)
  }, 120_000)

  test('tenon test catalog set unit --command：只改 command 那一行，目录里全部注释行保留', async () => {
    await project()
    expect(await tenon('test', 'catalog', 'set', 'unit', '--command', 'npm test'), `${out()}\n${err()}`).toBe(0)
    const text = await catalogText()
    expect(text).toBe(CATALOG.replace(UNIT_COMMAND, 'command: npm test'))
    expect(text.split('\n').filter((line) => line.trimStart().startsWith('#'))).toEqual(CATALOG.split('\n').filter((line) => line.trimStart().startsWith('#')))
  }, 120_000)
})
