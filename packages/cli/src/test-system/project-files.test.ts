import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { testSystemPaths, type CatalogSuite } from '@tenon/kernel'
import { emptyCatalog, readCatalogFile, readKnownFailuresFile, updateCatalog, updateKnownFailures } from './project-files.js'

let repo = ''
beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'tenon-project-files-')) })
afterEach(async () => { await rm(repo, { recursive: true, force: true }) })

function suite(id: string): CatalogSuite {
  return {
    id, kind: 'unit', runner: 'vitest', command: 'npx vitest run', cwd: '.', timeout_s: 900, files: [], covers: [],
    report: { format: 'vitest-json', path: 'test-results/v.json' }, artifacts: [], env: [], services: [], retries: 0,
    parallel: false, tags: [], browsers: [],
  }
}

describe('catalog.yaml 读写', () => {
  it('缺失 → missing；updateCatalog 从空目录起步并规范化写出，可读回', async () => {
    expect(await readCatalogFile(repo)).toEqual({ state: 'missing' })
    const outcome = await updateCatalog(repo, (catalog) => ({ catalog: { ...catalog, suites: [suite('unit')] }, value: 'ok' }))
    expect(outcome).toEqual({ ok: true, value: 'ok' })
    expect(await readCatalogFile(repo)).toMatchObject({ state: 'ok', catalog: { suites: [{ id: 'unit' }] } })
  })

  it('写坏的目录进不了盘；已存在但无效的目录不被覆盖', async () => {
    const bad = await updateCatalog(repo, (catalog) => ({ catalog: { ...catalog, suites: [{ ...suite('unit'), report: { format: 'exit-code' as const } }] }, value: 1 }))
    expect(bad.ok).toBe(false)
    expect(await readCatalogFile(repo)).toEqual({ state: 'missing' })
    await mkdir(testSystemPaths(repo).root, { recursive: true })
    await writeFile(testSystemPaths(repo).catalog, 'schema: nope\n', 'utf8')
    const refused = await updateCatalog(repo, (catalog) => ({ catalog, value: 1 }))
    expect(refused).toMatchObject({ ok: false, message: expect.stringContaining('无效') })
    expect(await readFile(testSystemPaths(repo).catalog, 'utf8')).toBe('schema: nope\n')
  })

  it('mutate 返回字符串即拒绝，磁盘不动', async () => {
    await updateCatalog(repo, (catalog) => ({ catalog: { ...catalog, suites: [suite('unit')] }, value: 0 }))
    const before = await readFile(testSystemPaths(repo).catalog, 'utf8')
    expect(await updateCatalog(repo, () => '不行')).toEqual({ ok: false, message: '不行' })
    expect(await readFile(testSystemPaths(repo).catalog, 'utf8')).toBe(before)
  })

  it('并发的读—改—写不丢更新', async () => {
    await Promise.all(Array.from({ length: 6 }, (_, index) => updateCatalog(repo, (catalog) => ({
      catalog: { ...catalog, suites: [...catalog.suites, suite(`s${index}`)] }, value: index,
    }))))
    const file = await readCatalogFile(repo)
    expect(file.state === 'ok' ? file.catalog.suites.map((item) => item.id).sort() : []).toEqual(['s0', 's1', 's2', 's3', 's4', 's5'])
    expect(emptyCatalog().suites).toEqual([])
  })
})

describe('known-failures.yaml 读写', () => {
  const entry = { suite: 'unit', test: 'src/a.test.ts › x', reason: 'r', expires: '2026-12-31', added_by: 'a@x.io' }

  it('缺失 = 空清单；写入后按 套件 + 用例 排序读回；无效文件被拒绝覆盖', async () => {
    expect(await readKnownFailuresFile(repo)).toEqual({ state: 'ok', entries: [] })
    await updateKnownFailures(repo, (entries) => ({ entries: [...entries, { ...entry, test: 'src/b.test.ts › y' }, entry], value: 2 }))
    const read = await readKnownFailuresFile(repo)
    expect(read.state === 'ok' ? read.entries.map((item) => item.test) : []).toEqual(['src/a.test.ts › x', 'src/b.test.ts › y'])
    await writeFile(testSystemPaths(repo).knownFailures, 'schema: nope\n', 'utf8')
    expect((await readKnownFailuresFile(repo)).state).toBe('invalid')
    expect((await updateKnownFailures(repo, (entries) => ({ entries, value: 0 }))).ok).toBe(false)
  })
})
