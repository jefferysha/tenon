import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readCatalogFile, updateCatalog } from './catalog-file.js'
import { testSystemPaths } from './paths.js'

let repo: string
beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'tenon-catalog-file-')) })
afterEach(async () => { await rm(repo, { recursive: true, force: true }) })

const CATALOG = [
  'schema: tenon-test-catalog/v1', 'suites: []', 'not_applicable:',
  '  - { kind: typecheck, reason: 纯 JavaScript 项目, approved_by: null }', '',
].join('\n')

async function writeCatalog(text: string): Promise<string> {
  const path = testSystemPaths(repo).catalog
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, text, 'utf8')
  return path
}

const COMMENTED = [
  '# 项目测试目录：改命令请直接改这里', 'schema: tenon-test-catalog/v1', 'suites:', '  # ── 单测 ──',
  '  - id: unit', '    kind: unit', '    runner: vitest', '    command: npm test', '    files:', '      - src/**/*.test.ts',
  '    report:', '      format: junit', '      path: test-results/unit.xml',
  '  # ── 静态检查 ──',
  '  - id: lint', '    kind: lint', '    runner: custom', '    command: npm run lint', '    report:', '      format: exit-code', '',
].join('\n')

describe('updateCatalog 按节点写回', () => {
  it('改一个套件的命令：只有这一行变，注释与排版逐字保留', async () => {
    const path = await writeCatalog(COMMENTED)
    const outcome = await updateCatalog(repo, (current) => ({
      catalog: { ...current, suites: current.suites.map((suite) => (suite.id === 'unit' ? { ...suite, command: 'npm run unit' } : suite)) },
      value: 'edited',
    }))
    expect(outcome).toEqual({ ok: true, value: 'edited' })
    expect(await readFile(path, 'utf8')).toBe(COMMENTED.replace('command: npm test', 'command: npm run unit'))
  })

  it('得到的目录与原来深相等但是新对象：不重写文件，字节一个不动', async () => {
    const path = await writeCatalog(COMMENTED)
    expect(await updateCatalog(repo, (current) => ({ catalog: { ...current, suites: [...current.suites] }, value: 1 }))).toEqual({ ok: true, value: 1 })
    expect(await readFile(path, 'utf8')).toBe(COMMENTED)
  })

  it('目录文件不存在：整份规范化写出（新建）', async () => {
    const path = testSystemPaths(repo).catalog
    const outcome = await updateCatalog(repo, (current) => ({
      catalog: { ...current, not_applicable: [{ kind: 'typecheck', reason: '纯 JavaScript 项目', approved_by: null }] }, value: 'created',
    }))
    expect(outcome).toEqual({ ok: true, value: 'created' })
    expect(await readFile(path, 'utf8')).toBe('schema: tenon-test-catalog/v1\nsuites: []\nnot_applicable:\n  - kind: typecheck\n    reason: 纯 JavaScript 项目\n    approved_by: null\n')
  })

  it('改出不合法的目录：拒绝并说明，原文件一个字节都不动', async () => {
    const path = await writeCatalog(COMMENTED)
    const outcome = await updateCatalog(repo, (current) => ({
      catalog: { ...current, suites: current.suites.map((suite) => (suite.id === 'unit' ? { ...suite, report: { format: 'junit' as const, path: 'src/escape.xml' } } : suite)) },
      value: 'bad',
    }))
    expect(outcome.ok).toBe(false)
    expect(outcome.ok ? '' : outcome.message).toContain('改动后的目录不合法')
    expect(await readFile(path, 'utf8')).toBe(COMMENTED)
  })

  it('并发的两个写者：读—改—写都在锁内，注释保留，两边的改动都在', async () => {
    const path = await writeCatalog(COMMENTED)
    const setCommand = (id: string, command: string) => updateCatalog(repo, (current) => ({
      catalog: { ...current, suites: current.suites.map((suite) => (suite.id === id ? { ...suite, command } : suite)) }, value: id,
    }))
    const results = await Promise.all([setCommand('unit', 'npm run unit'), setCommand('lint', 'npm run lint:all')])
    expect(results.map((result) => result.ok)).toEqual([true, true])
    expect(await readFile(path, 'utf8')).toBe(COMMENTED.replace('command: npm test', 'command: npm run unit').replace('command: npm run lint', 'command: npm run lint:all'))
  })
})

describe('updateCatalog 的观察步骤', () => {
  it('observe 在持锁时、读目录之前运行：它的结果交给 mutate，它期间落盘的改动 mutate 读得到', async () => {
    const path = await writeCatalog(CATALOG)
    let readByMutate: string | undefined
    const outcome = await updateCatalog(
      repo,
      (current, seen: { readonly note: string }) => {
        readByMutate = `${seen.note}:${current.not_applicable?.map((entry) => entry.reason).join(',')}`
        return 'refused on purpose'
      },
      async () => {
        await writeFile(path, CATALOG.replace('纯 JavaScript 项目', '观察期间改的理由'), 'utf8')
        return { note: 'observed' }
      },
    )
    expect(outcome).toEqual({ ok: false, message: 'refused on purpose' })
    expect(readByMutate).toBe('observed:观察期间改的理由')
  })

  it('观察与写在同一个临界区：观察期间启动的另一个写者要等第一个写完，读到的是第一个写之后的目录', async () => {
    await writeCatalog(CATALOG)
    const order: string[] = []
    let second: Promise<unknown> | undefined
    const first = await updateCatalog(
      repo,
      (current) => {
        order.push('first-mutate')
        return { catalog: { ...current, not_applicable: [{ kind: 'typecheck', reason: '第一个写者', approved_by: 'a@x.io' }] }, value: undefined }
      },
      async () => {
        second = updateCatalog(repo, (current) => {
          order.push(`second-mutate saw ${current.not_applicable?.[0]?.reason}`)
          return { catalog: current, value: undefined }
        })
        // 给另一个写者足够的时间去抢锁；它抢不到，因为这里还在临界区里。
        await new Promise((resolve) => setTimeout(resolve, 200))
        order.push('observe-done')
      },
    )
    expect(first.ok).toBe(true)
    await second
    expect(order).toEqual(['observe-done', 'first-mutate', 'second-mutate saw 第一个写者'])
    const catalog = await readCatalogFile(repo)
    expect(catalog.state === 'ok' && catalog.catalog.not_applicable?.[0]?.approved_by).toBe('a@x.io')
  })

  it('没有 observe 时与原来一样：mutate 照常运行，无改动不重写文件', async () => {
    const path = await writeCatalog(CATALOG)
    const before = await readFile(path, 'utf8')
    expect(await updateCatalog(repo, (current) => ({ catalog: current, value: 'unchanged' }))).toEqual({ ok: true, value: 'unchanged' })
    expect(await readFile(path, 'utf8')).toBe(before)
  })
})
