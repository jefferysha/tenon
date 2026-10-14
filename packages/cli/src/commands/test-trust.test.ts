import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { catalogExecDigest, isTenonUser, isTrusted, parseTestCatalog, readTestSeal, userSlug, type TestCatalog } from '@tenon/kernel'
import { afterEach, describe, expect, test } from 'vitest'
import { realDeps } from '../integration-harness.js'
import { catalogTrustTarget, cmdTestTrust } from './test-trust.js'

const SUITE = `  - id: unit
    kind: unit
    runner: custom
    command: node run.mjs
    report: { format: junit, path: test-results/unit.xml }
    artifacts: [test-results/unit.xml]
`

function catalogText(opts: { setup?: string; suites?: boolean } = {}): string {
  return `schema: tenon-test-catalog/v1\n${opts.setup === undefined ? '' : `setup: ${opts.setup}\n`}suites:${opts.suites === false ? ' []\n' : `\n${SUITE}`}`
}

function parsed(text: string): TestCatalog {
  const result = parseTestCatalog(text)
  if (!result.ok) throw new Error(result.issues.map((issue) => issue.message).join('；'))
  return result.catalog
}

describe('tenon test trust 向用户列出的待信任命令', () => {
  const temps: string[] = []
  afterEach(async () => {
    for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
  })

  async function projectWith(text: string): Promise<string> {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'test-trust-')))
    temps.push(cwd)
    await mkdir(join(cwd, '.tenon', 'tests'), { recursive: true })
    await writeFile(join(cwd, '.tenon', 'tests', 'catalog.yaml'), text, 'utf8')
    return cwd
  }

  test('目录声明了 setup：待信任命令里列出它，用户知道自己信任了什么；摘要与可执行摘要一致', () => {
    const catalog = parsed(catalogText({ setup: 'npm ci' }))
    const target = catalogTrustTarget(catalog)
    expect(target.lines).toContain('准备命令 setup  $ npm ci')
    expect(target.digest).toBe(catalogExecDigest(catalog))
  })

  test('目录没有 setup：待信任命令不出现准备命令那一行', () => {
    const target = catalogTrustTarget(parsed(catalogText()))
    expect(target.lines).toEqual(['套件 unit（unit）  $ node run.mjs'])
  })

  test('tenon test trust --yes：输出逐条列出 setup，信任写进封存', async () => {
    const cwd = await projectWith(catalogText({ setup: 'npm ci' }))
    const out: string[] = []
    const err: string[] = []
    const deps = realDeps(cwd, out, err)
    expect(await cmdTestTrust(deps, undefined, { yes: true }), err.join('\n')).toBe(0)
    expect(out.join('\n')).toContain('准备命令 setup  $ npm ci')
    expect(out.join('\n')).toContain('套件 unit（unit）  $ node run.mjs')
    const user = deps.user()
    if (!isTenonUser(user)) throw new Error('测试装配没有声明身份')
    const { seal } = await readTestSeal(cwd, userSlug(user.id))
    expect(isTrusted(seal, catalogExecDigest(parsed(catalogText({ setup: 'npm ci' }))))).toBe(true)
  })

  test('目录只有 setup、没有套件与服务：也要列出并允许信任（否则这份 setup 永远得不到信任）', async () => {
    const cwd = await projectWith(catalogText({ setup: 'npm ci', suites: false }))
    const out: string[] = []
    const err: string[] = []
    expect(await cmdTestTrust(realDeps(cwd, out, err), undefined, { yes: true }), err.join('\n')).toBe(0)
    expect(out.join('\n')).toContain('准备命令 setup  $ npm ci')
    expect(out.join('\n')).not.toContain('没有需要信任的测试命令')
  })

  test('目录既没有 setup 也没有套件与服务：仍是「没有需要信任的测试命令」', async () => {
    const cwd = await projectWith(catalogText({ suites: false }))
    const out: string[] = []
    const err: string[] = []
    expect(await cmdTestTrust(realDeps(cwd, out, err), undefined, { yes: true }), err.join('\n')).toBe(0)
    expect(out).toEqual(['[TEST] 没有需要信任的测试命令'])
  })
})
