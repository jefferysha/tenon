/**
 * 随附的 node:test JUnit reporter：真的用当前 Node 跑一个三文件小项目，报告交给 JUnit 解析器——
 * 每条用例落在它真实的文件上（与 Node 版本无关），失败 / 跳过 / 嵌套 describe / 特殊字符 / 文件级失败都如实。
 */
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  NODE_TEST_JUNIT_REPORTER_SOURCE, NODE_TEST_REPORTER_ENV, NODE_TEST_REPORTER_FILE, usesNodeTestReporter, writeNodeTestReporter,
} from './node-test-reporter.js'
import { parseJunit, type ParsedCase } from './parsers/index.js'
import { RUNNER_PRESETS } from './runner-presets.js'

const FILES: Readonly<Record<string, string>> = {
  'tests/math.test.mjs': [
    "import { test, describe, it } from 'node:test'",
    "import assert from 'node:assert/strict'",
    "test('adds two numbers', () => { assert.equal(1 + 2, 3) })",
    "describe('division', () => {",
    "  it('divides evenly', () => { assert.equal(6 / 3, 2) })",
    "  describe('rounding', () => { it('keeps fractions', () => { assert.equal(1 / 4, 0.25) }) })",
    '})',
    '',
  ].join('\n'),
  'tests/strings.test.mjs': [
    "import { test, describe, it } from 'node:test'",
    "import assert from 'node:assert/strict'",
    "test('adds two numbers', () => { assert.equal('a' + 'b', 'ab') })",
    "describe('formatting', () => {",
    "  it('fails on purpose', () => { assert.equal('a'.toUpperCase(), 'B') })",
    "  it.skip('is skipped', () => {})",
    "  it.todo('is todo')",
    '})',
    '',
  ].join('\n'),
  'tests/odd.test.mjs': [
    "import { test } from 'node:test'",
    "test('quotes \"and\" <angle> & amp \\u0001 ünï \\u{1F600} lone\\uD800', () => {})",
    "test('fails with markup', () => { throw new Error('bad <tag> & \"quote\" \\u0002') })",
    '',
  ].join('\n'),
  'tests/broken.test.mjs': 'import { test } from "node:test"\nthis is not javascript\n',
  'tests/hook.test.mjs': [
    "import { describe, it, before } from 'node:test'",
    "describe('with hook', () => {",
    "  before(() => { throw new Error('hook exploded') })",
    "  it('never runs', () => {})",
    '})',
    '',
  ].join('\n'),
}

describe('node:test JUnit reporter（随附）', () => {
  let dir = ''
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tenon-node-reporter-'))
    for (const [path, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, path)), { recursive: true })
      await writeFile(join(dir, path), text, 'utf8')
    }
  })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  async function runReporter(files: readonly string[]): Promise<{ readonly xml: string; readonly cases: readonly ParsedCase[]; readonly status: number | null }> {
    const reporter = await writeNodeTestReporter(join(dir, 'runtime', 'reporters'))
    await mkdir(join(dir, 'test-results'), { recursive: true })
    const result = spawnSync(process.execPath, [
      '--test', `--test-reporter=${reporter}`, '--test-reporter-destination=test-results/junit.xml', ...files,
    ], { cwd: dir, encoding: 'utf8' })
    const xml = await readFile(join(dir, 'test-results', 'junit.xml'), 'utf8')
    // Node 报告里的路径是 realpath（macOS 的临时目录在 /private 下），换算相对路径也要用 realpath，和 tenon test run 一致。
    const root = await realpath(dir)
    const parsed = parseJunit(xml, { repoRoot: root, cwd: root })
    if (!parsed.ok) throw new Error(parsed.reason)
    return { xml, cases: parsed.cases, status: result.status }
  }

  const shape = (cases: readonly ParsedCase[]): string[] => cases.map((item) => `${item.status} ${item.file} :: ${[...item.suite_path, item.name].join(' > ')}`)

  it('每条用例落在真实文件上：同名用例按文件分开，describe 嵌套进分组链，失败带断言信息，skip / todo 算跳过', async () => {
    const { xml, cases, status } = await runReporter(['tests/math.test.mjs', 'tests/strings.test.mjs'])
    expect(status).toBe(1)
    expect(shape(cases).sort()).toEqual([
      'fail tests/strings.test.mjs :: formatting > fails on purpose',
      'pass tests/math.test.mjs :: adds two numbers',
      'pass tests/math.test.mjs :: division > divides evenly',
      'pass tests/math.test.mjs :: division > rounding > keeps fractions',
      'pass tests/strings.test.mjs :: adds two numbers',
      'skip tests/strings.test.mjs :: formatting > is skipped',
      'skip tests/strings.test.mjs :: formatting > is todo',
    ])
    expect(cases.find((item) => item.status === 'fail')?.failure?.message).toContain("'A' !== 'B'")
    expect(xml).toContain('<testsuite name="rounding" file=')
    expect(xml).not.toContain('hostname')
  })

  it('特殊字符：< > & " 与非法控制字符不会写坏 XML，名字与失败信息如实保留（控制字符除外）', async () => {
    const { cases } = await runReporter(['tests/odd.test.mjs'])
    expect(cases.map((item) => [item.status, item.file, item.name])).toEqual([
      ['pass', 'tests/odd.test.mjs', 'quotes "and" <angle> & amp ünï \u{1F600} lone'],
      ['fail', 'tests/odd.test.mjs', 'fails with markup'],
    ])
    expect(cases[1]?.failure?.message).toBe('bad <tag> & "quote"')
  })

  it('文件加载失败与 hook 失败都是挂在该文件上的失败用例，不会因为丢了外壳而变成 0 用例', async () => {
    const { cases, status } = await runReporter(['tests/broken.test.mjs', 'tests/hook.test.mjs'])
    expect(status).toBe(1)
    expect(cases.length).toBeGreaterThan(0)
    expect(cases.every((item) => item.status === 'fail')).toBe(true)
    expect(cases.map((item) => item.file).sort()).toEqual(expect.arrayContaining(['tests/broken.test.mjs', 'tests/hook.test.mjs']))
  })
})

describe('随附 reporter 的落地', () => {
  it('落在调用方给的目录下，返回 file URL；源码是独立 ESM，不含反引号与模板插值', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tenon-node-reporter-write-'))
    try {
      const target = join(dir, 'a', 'reporters')
      const url = await writeNodeTestReporter(target)
      expect(url).toBe(pathToFileURL(join(target, NODE_TEST_REPORTER_FILE)).href)
      expect(await readFile(join(target, NODE_TEST_REPORTER_FILE), 'utf8')).toBe(NODE_TEST_JUNIT_REPORTER_SOURCE)
      expect((await readdir(dir)).sort()).toEqual(['a'])
      expect((await stat(join(target, NODE_TEST_REPORTER_FILE))).mode & 0o077).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
    expect(NODE_TEST_JUNIT_REPORTER_SOURCE).not.toMatch(/`|\$\{/)
    // 源码里的转义与不可见字符会被编辑器 / 打包器改写成字面字符：只允许 ASCII，也不写 unicode 转义。
    expect(NODE_TEST_JUNIT_REPORTER_SOURCE).toMatch(/^[\x00-\x7F]*$/)
    expect(NODE_TEST_JUNIT_REPORTER_SOURCE).not.toContain('\\u')
    expect(NODE_TEST_JUNIT_REPORTER_SOURCE).toMatch(/^import \{ inspect \} from 'node:util'/)
  })

  it('只有命令引用了环境变量才需要落文件', () => {
    expect(usesNodeTestReporter(['node --test', undefined])).toBe(false)
    expect(usesNodeTestReporter(['node --test --test-reporter=junit'])).toBe(false)
    expect(usesNodeTestReporter(['x', 'node --test {files} --test-reporter="${TENON_NODE_TEST_REPORTER:-junit}"'])).toBe(true)
  })

  it('node-test 预设的命令与 select 模板都读这个环境变量，且变量为空时退回内置 junit', () => {
    const preset = RUNNER_PRESETS['node-test']
    expect(preset?.command).toContain(`\${${NODE_TEST_REPORTER_ENV}:-junit}`)
    expect(preset?.select?.files).toContain(`\${${NODE_TEST_REPORTER_ENV}:-junit}`)
    expect(preset?.report).toEqual({ format: 'junit', path: 'test-results/junit.xml' })
  })
})
