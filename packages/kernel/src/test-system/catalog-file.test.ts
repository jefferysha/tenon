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
