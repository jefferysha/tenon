import { mkdtemp, readFile, readdir, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { testRunRecordsDir } from './paths.js'
import {
  appendTestRunRecordV2, createRecordChainCache, listRecordDirectory, pruneRecordChain, readRecordChain, recordV2Digest,
  verifyRecordChain,
} from './record-chain.js'
import { declaresRecordV2, decodeTestRunRecordV2 } from './record-v2-codec.js'
import type { TestRunRecordV2 } from './record-v2-types.js'
import { fixtureCase, fixtureChain, fixtureRecordDraft, fixtureSuiteRun } from './test-support.js'

const SLUG = 'tester-at-tenon.test'

describe('记录 v2 解码（闭集）', () => {
  const [record] = fixtureChain([fixtureRecordDraft()])
  if (record === undefined) throw new Error('fixture')

  it('合法记录原样解码', () => {
    expect(decodeTestRunRecordV2(JSON.parse(JSON.stringify(record)))).toEqual(record)
    expect(declaresRecordV2(record)).toBe(true)
    expect(declaresRecordV2({ schema: 'tenon-test-run-v1' })).toBe(false)
  })

  const suite = record.suites[0]
  if (suite === undefined) throw new Error('fixture suite')
  it.each([
    ['附加键', { ...record, extra: 1 }],
    ['缺键', (({ git_head: _git, ...rest }) => rest)(record)],
    ['schema 不对', { ...record, schema: 'tenon-test-run-v1' }],
    ['run-id 形状', { ...record, run_id: 'x' }],
    ['机器画像形状', { ...record, machine_profile: 'Bad Profile' }],
    ['没有套件', { ...record, suites: [] }],
    ['结论非法', { ...record, result: 'ok' }],
    ['摘要形状', { ...record, digest: 'md5:x' }],
    ['候选形状', { ...record, bindings: { ...record.bindings, candidate: 'nope' } }],
    ['工作流指纹形状', { ...record, bindings: { ...record.bindings, workflow_fingerprint: 'x' } }],
    ['演员非法', { ...record, actor: { id: 'x' } }],
    ['宿主非法', { ...record, host: { kind: 'vim', sandbox: null } }],
    ['链重置形状', { ...record, chain_reset: true }],
    ['计数对不上', { ...record, suites: [{ ...suite, totals: { ...suite.totals, cases: 99 } }] }],
    ['来源与 id 不一致', { ...record, suites: [{ ...suite, origin: 'step' }] }],
    ['用例状态未知', { ...record, suites: [{ ...suite, cases: [{ ...fixtureCase({ file: 'a', name: 'b' }), status: 'odd' }] }] }],
    ['用例 attempts 为 0', { ...record, suites: [{ ...suite, cases: [{ ...fixtureCase({ file: 'a', name: 'b' }), attempts: 0 }] }] }],
    ['覆盖率越界', { ...record, suites: [{ ...suite, coverage: { lines: 101 } }] }],
    ['覆盖率未知项', { ...record, suites: [{ ...suite, coverage: { mutation: 1 } }] }],
    ['产物越界', { ...record, suites: [{ ...suite, artifacts: [{ path: '../x', bytes: 1, digest: record.digest, media: 'image' }] }] }],
    ['产物媒体未知', { ...record, suites: [{ ...suite, artifacts: [{ path: 'x', bytes: 1, digest: record.digest, media: 'pdf' }] }] }],
    ['原因码未知', { ...record, suites: [{ ...suite, reasons: [{ code: 'weird' }] }] }],
    ['报告格式未知', { ...record, suites: [{ ...suite, report: { ...suite.report, format: 'xml' } }] }],
    ['种类未知', { ...record, suites: [{ ...suite, kind: 'ui' }] }],
    ['服务退出未知', { ...record, services: [{ id: 'web', ready_ms: 1, exit: 'gone', log: null, leaked_pids: [] }] }],
    ['指标方向非法', { ...record, suites: [{ ...suite, metrics: [{ name: 'x', better: 'up', samples: [], median: 1, p95: 1, mad: 0 }] }] }],
    ['超长失败消息', { ...record, suites: [{ ...suite, cases: [fixtureCase({ file: 'a', name: 'b', status: 'fail', failure: { message: 'x'.repeat(70000) } })], totals: { ...suite.totals, pass: 0, fail: 1 } }] }],
  ])('%s → 损坏', (_name, value) => {
    expect(decodeTestRunRecordV2(value)).toBeUndefined()
  })
})

describe('哈希链校验（纯）', () => {
  const entries = (records: readonly TestRunRecordV2[]) => records.map((record) => ({ file: `${record.run_id}.json`, record }))

  it('空目录 = empty；完好的链 = intact（链序）', () => {
    expect(verifyRecordChain({ records: [], problems: [] })).toEqual({ state: 'empty' })
    const chain = fixtureChain([fixtureRecordDraft(), fixtureRecordDraft(), fixtureRecordDraft()])
    const report = verifyRecordChain({ records: entries([...chain].reverse()), problems: [] })
    expect(report.state).toBe('intact')
    if (report.state !== 'intact') return
    expect(report.active.map((record) => record.run_id)).toEqual(chain.map((record) => record.run_id))
    expect(report.head).toBe(chain[2]?.digest)
  })

  it('内容改动、摘要重算后断链、中间记录缺失、链首缺失、分叉、文件改名、坏文件 → broken', () => {
    const chain = fixtureChain([fixtureRecordDraft(), fixtureRecordDraft(), fixtureRecordDraft()])
    const [first, second, third] = chain
    if (first === undefined || second === undefined || third === undefined) throw new Error('fixture')
    const edited = { ...second, result: 'fail' as const }
    expect(verifyRecordChain({ records: entries([first, edited, third]), problems: [] })).toMatchObject({ state: 'broken', reason: '记录内容与摘要不符（被改动）' })
    const rehashed = { ...edited, digest: recordV2Digest(edited) }
    expect(verifyRecordChain({ records: entries([first, rehashed, third]), problems: [] })).toMatchObject({ state: 'broken' })
    expect(verifyRecordChain({ records: entries([first, third]), problems: [] })).toMatchObject({ state: 'broken', reason: expect.stringMatching(/不在当前链上/) })
    expect(verifyRecordChain({ records: entries([second, third]), problems: [] })).toMatchObject({ state: 'broken', reason: '找不到链首记录' })
    const fork = fixtureChain([fixtureRecordDraft()])[0]
    const forked = fork === undefined ? undefined : { ...fork, prev_digest: first.digest }
    const forkRecord = forked === undefined ? undefined : { ...forked, digest: recordV2Digest(forked) }
    if (forkRecord === undefined) throw new Error('fixture')
    expect(verifyRecordChain({ records: entries([first, second, forkRecord]), problems: [] })).toMatchObject({ state: 'broken', reason: '记录链出现分叉' })
    expect(verifyRecordChain({ records: [{ file: 'renamed.json', record: first }], problems: [] })).toMatchObject({ state: 'broken' })
    expect(verifyRecordChain({ records: entries(chain), problems: ['junk.json'] })).toMatchObject({ state: 'broken', files: ['junk.json'] })
  })

  it('另起新链：被取代的旧记录与坏文件不再算断链，但新链之外的记录仍算', () => {
    const old = fixtureChain([fixtureRecordDraft(), fixtureRecordDraft()])
    const superseded = [...entries(old).map((entry) => entry.file), 'junk.json'].sort()
    const reset = fixtureChain([{ ...fixtureRecordDraft() }])[0]
    if (reset === undefined) throw new Error('fixture')
    const base = { ...reset, chain_reset: { superseded } }
    const genesis = { ...base, digest: recordV2Digest(base) }
    const report = verifyRecordChain({ records: entries([...old, genesis]), problems: ['junk.json'] })
    expect(report).toMatchObject({ state: 'intact', superseded })
    expect(report.state === 'intact' ? report.active.map((record) => record.run_id) : []).toEqual([genesis.run_id])
    expect(verifyRecordChain({ records: entries([...old, genesis]), problems: ['junk.json', 'new-junk.json'] })).toMatchObject({ state: 'broken' })
  })
})

describe('追加与读取（真文件系统）', () => {
  let repo: string
  beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'tenon-chain-')) })
  afterEach(async () => { await rm(repo, { recursive: true, force: true }) })

  it('第一条 started，之后 appended；并发追加不分叉', async () => {
    const first = await appendTestRunRecordV2(repo, SLUG, fixtureRecordDraft())
    expect(first.chain).toBe('started')
    expect(first.record.prev_digest).toBeNull()
    const results = await Promise.all([1, 2, 3].map(() => appendTestRunRecordV2(repo, SLUG, fixtureRecordDraft())))
    expect(results.every((result) => result.chain === 'appended')).toBe(true)
    const report = await readRecordChain(repo, SLUG, 'demo')
    expect(report.state).toBe('intact')
    expect(report.state === 'intact' ? report.active.length : 0).toBe(4)
  })

  it('v1 记录不参与链；手工改动 → broken；重跑 → reset 并恢复 intact', async () => {
    const dir = testRunRecordsDir(repo, SLUG, 'demo')
    const one = await appendTestRunRecordV2(repo, SLUG, fixtureRecordDraft())
    await appendTestRunRecordV2(repo, SLUG, fixtureRecordDraft())
    await writeFile(join(dir, '20260101T000000Z-000001.json'), JSON.stringify({ schema: 'tenon-test-run-v1' }), 'utf8')
    expect((await readRecordChain(repo, SLUG, 'demo')).state).toBe('intact')
    const text = await readFile(one.path, 'utf8')
    await writeFile(one.path, text.replace('"result": "pass"', '"result": "fail"'), 'utf8')
    expect((await readRecordChain(repo, SLUG, 'demo')).state).toBe('broken')
    const again = await appendTestRunRecordV2(repo, SLUG, fixtureRecordDraft())
    expect(again.chain).toBe('reset')
    expect(again.record.chain_reset?.superseded).toHaveLength(2)
    const report = await readRecordChain(repo, SLUG, 'demo')
    expect(report.state).toBe('intact')
    expect(report.state === 'intact' ? report.active.map((record) => record.run_id) : []).toEqual([again.record.run_id])
  })

  it('删除中间记录 → broken；非 JSON 文件 → broken', async () => {
    await appendTestRunRecordV2(repo, SLUG, fixtureRecordDraft())
    const middle = await appendTestRunRecordV2(repo, SLUG, fixtureRecordDraft())
    await appendTestRunRecordV2(repo, SLUG, fixtureRecordDraft())
    await unlink(middle.path)
    expect((await readRecordChain(repo, SLUG, 'demo')).state).toBe('broken')
    const dir = testRunRecordsDir(repo, SLUG, 'demo')
    await appendTestRunRecordV2(repo, SLUG, fixtureRecordDraft())
    expect((await readRecordChain(repo, SLUG, 'demo')).state).toBe('intact')
    await writeFile(join(dir, 'zz.json'), 'not json', 'utf8')
    expect(await readRecordChain(repo, SLUG, 'demo')).toMatchObject({ state: 'broken', files: ['zz.json'] })
    expect((await listRecordDirectory(join(repo, 'nope'))).records).toEqual([])
    expect((await readdir(dir)).some((name) => name.startsWith('.test-run-v2'))).toBe(false)
  })

  it('同 run-id 不覆盖；形状非法拒绝写入', async () => {
    const draft = fixtureRecordDraft()
    await appendTestRunRecordV2(repo, SLUG, draft)
    await expect(appendTestRunRecordV2(repo, SLUG, draft)).rejects.toThrow()
    await expect(appendTestRunRecordV2(repo, SLUG, { ...fixtureRecordDraft(), suites: [fixtureSuiteRun({ suite: 'x', kind: 'nope' as 'unit' })] }))
      .rejects.toThrow(/形状非法/)
  })
})

describe('保留上限清理（真机验收 F14 / P2：记录永不清理，一次交付提交带上 27 份）', () => {
  let repo: string
  beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'tenon-chain-prune-')) })
  afterEach(async () => { await rm(repo, { recursive: true, force: true }) })
  const dirOf = () => testRunRecordsDir(repo, SLUG, 'demo')

  async function append(count: number): Promise<string[]> {
    const ids: string[] = []
    for (let i = 0; i < count; i++) ids.push((await appendTestRunRecordV2(repo, SLUG, fixtureRecordDraft())).record.run_id)
    return ids
  }

  it('超过上限：只留最新的 N 条，链仍 intact、链首是保留的最老一条；之后照常追加', async () => {
    const ids = await append(6)
    const removed = await pruneRecordChain(repo, SLUG, 'demo', 3)
    expect(removed).toEqual(ids.slice(0, 3).map((id) => `${id}.json`))
    const report = await readRecordChain(repo, SLUG, 'demo')
    expect(report.state).toBe('intact')
    expect(report.state === 'intact' ? report.active.map((record) => record.run_id) : []).toEqual(ids.slice(3))
    expect((await readdir(dirOf())).filter((name) => name.endsWith('.json')).sort()).toEqual(ids.slice(3).map((id) => `${id}.json`).sort())
    const next = await appendTestRunRecordV2(repo, SLUG, fixtureRecordDraft())
    expect(next.chain).toBe('appended')
    expect(next.record.prev_digest).toBe(report.state === 'intact' ? report.head : null)
    expect((await readRecordChain(repo, SLUG, 'demo')).state).toBe('intact')
  })

  it('没超过上限、目录不存在、链已断：什么都不删', async () => {
    expect(await pruneRecordChain(repo, SLUG, 'demo', 3)).toEqual([])
    const ids = await append(3)
    expect(await pruneRecordChain(repo, SLUG, 'demo', 3)).toEqual([])
    expect((await readdir(dirOf())).filter((name) => name.endsWith('.json'))).toHaveLength(3)
    await unlink(join(dirOf(), `${ids[1]}.json`))
    expect((await readRecordChain(repo, SLUG, 'demo')).state).toBe('broken')
    expect(await pruneRecordChain(repo, SLUG, 'demo', 1)).toEqual([])
    expect((await readdir(dirOf())).filter((name) => name.endsWith('.json'))).toHaveLength(2)
  })

  it('反复清理：每次留最新的 N 条，标记跟着走', async () => {
    await append(5)
    await pruneRecordChain(repo, SLUG, 'demo', 4)
    const more = await append(3)
    const removed = await pruneRecordChain(repo, SLUG, 'demo', 4)
    expect(removed).toHaveLength(3)
    const report = await readRecordChain(repo, SLUG, 'demo')
    expect(report.state).toBe('intact')
    expect(report.state === 'intact' ? report.active : []).toHaveLength(4)
    expect(report.state === 'intact' ? report.active.at(-1)?.run_id : '').toBe(more.at(-1))
  })

  it('清理中途崩溃的现场（标记已写、旧文件还在）：链仍 intact，下一次清理收尾', async () => {
    const ids = await append(5)
    const dir = dirOf()
    const listing = await listRecordDirectory(dir)
    const dropped = listing.records.slice(0, 2)
    const last = dropped.at(-1)?.record.digest
    await writeFile(join(dir, 'chain-base'), JSON.stringify({ schema: 'tenon-record-chain-base/v1', base: last, pruned: dropped.map((entry) => entry.file) }), 'utf8')
    const report = await readRecordChain(repo, SLUG, 'demo')
    expect(report.state).toBe('intact')
    expect(report.state === 'intact' ? report.active.map((record) => record.run_id) : []).toEqual(ids.slice(2))
    await pruneRecordChain(repo, SLUG, 'demo', 10)
    expect((await readdir(dir)).filter((name) => name.endsWith('.json')).sort()).toEqual(ids.slice(2).map((id) => `${id}.json`).sort())
    expect((await readRecordChain(repo, SLUG, 'demo')).state).toBe('intact')
  })

  it('标记不放行缺口：手工删掉保留下来的记录、或标记指向别的摘要，仍是 broken', async () => {
    const ids = await append(5)
    await pruneRecordChain(repo, SLUG, 'demo', 3)
    const dir = dirOf()
    const marker = await readFile(join(dir, 'chain-base'), 'utf8')
    await writeFile(join(dir, 'chain-base'), marker.replace(/sha256:[0-9a-f]{64}/, `sha256:${'0'.repeat(64)}`), 'utf8')
    expect((await readRecordChain(repo, SLUG, 'demo')).state).toBe('broken')
    await writeFile(join(dir, 'chain-base'), marker, 'utf8')
    expect((await readRecordChain(repo, SLUG, 'demo')).state).toBe('intact')
    await unlink(join(dir, `${ids[3]}.json`))
    expect((await readRecordChain(repo, SLUG, 'demo')).state).toBe('broken')
    await writeFile(join(dir, 'chain-base'), 'not json', 'utf8')
    expect(await readRecordChain(repo, SLUG, 'demo')).toMatchObject({ state: 'broken', files: expect.arrayContaining(['chain-base']) })
  })

  it('重新另起链（断链后重跑）之后，标记里旧的基点不再起作用', async () => {
    await append(5)
    await pruneRecordChain(repo, SLUG, 'demo', 2)
    const dir = dirOf()
    const [keep] = (await listRecordDirectory(dir)).records
    if (keep === undefined) throw new Error('fixture')
    await unlink(join(dir, keep.file))
    expect((await readRecordChain(repo, SLUG, 'demo')).state).toBe('broken')
    const again = await appendTestRunRecordV2(repo, SLUG, fixtureRecordDraft())
    expect(again.chain).toBe('reset')
    const report = await readRecordChain(repo, SLUG, 'demo')
    expect(report.state).toBe('intact')
    expect(report.state === 'intact' ? report.active.map((record) => record.run_id) : []).toEqual([again.record.run_id])
  })
})

describe('记录链缓存：按文件指纹复用校验结果，改动仍然逐条发现', () => {
  let repo: string
  beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'tenon-chain-cache-')) })
  afterEach(async () => { await rm(repo, { recursive: true, force: true }) })

  it('没有任何文件变化：直接返回上一次的链报告，记录对象也是同一批', async () => {
    const cache = createRecordChainCache()
    await appendTestRunRecordV2(repo, SLUG, fixtureRecordDraft())
    await appendTestRunRecordV2(repo, SLUG, fixtureRecordDraft())
    const first = await readRecordChain(repo, SLUG, 'demo', cache)
    const second = await readRecordChain(repo, SLUG, 'demo', cache)
    expect(second).toBe(first)
    expect(first).toEqual(await readRecordChain(repo, SLUG, 'demo'))
  })

  it('追加一条：旧记录不重读（同一对象），新链含新记录', async () => {
    const cache = createRecordChainCache()
    await appendTestRunRecordV2(repo, SLUG, fixtureRecordDraft())
    const before = await readRecordChain(repo, SLUG, 'demo', cache)
    await appendTestRunRecordV2(repo, SLUG, fixtureRecordDraft())
    const after = await readRecordChain(repo, SLUG, 'demo', cache)
    expect(after.state === 'intact' ? after.active.length : 0).toBe(2)
    if (before.state !== 'intact' || after.state !== 'intact') throw new Error('chain')
    expect(after.active[0]).toBe(before.active[0])
  })

  it('改文件内容、保持大小并把 mtime 还原：ctime 变了，缓存不放过 → broken', async () => {
    const cache = createRecordChainCache()
    const one = await appendTestRunRecordV2(repo, SLUG, fixtureRecordDraft())
    await appendTestRunRecordV2(repo, SLUG, fixtureRecordDraft())
    expect((await readRecordChain(repo, SLUG, 'demo', cache)).state).toBe('intact')
    const original = await stat(one.path)
    const text = await readFile(one.path, 'utf8')
    const edited = text.replace('"result": "pass"', '"result": "fail"')
    expect(edited.length).toBe(text.length)
    await writeFile(one.path, edited, 'utf8')
    await utimes(one.path, original.atime, original.mtime)
    expect((await readRecordChain(repo, SLUG, 'demo', cache)).state).toBe('broken')
  })

  it('删除中间记录、放进坏文件、删掉整个目录：都立刻反映', async () => {
    const cache = createRecordChainCache()
    await appendTestRunRecordV2(repo, SLUG, fixtureRecordDraft())
    const middle = await appendTestRunRecordV2(repo, SLUG, fixtureRecordDraft())
    await appendTestRunRecordV2(repo, SLUG, fixtureRecordDraft())
    expect((await readRecordChain(repo, SLUG, 'demo', cache)).state).toBe('intact')
    await unlink(middle.path)
    expect((await readRecordChain(repo, SLUG, 'demo', cache)).state).toBe('broken')
    const dir = testRunRecordsDir(repo, SLUG, 'demo')
    await rm(dir, { recursive: true, force: true })
    expect(await readRecordChain(repo, SLUG, 'demo', cache)).toEqual({ state: 'empty' })
    await appendTestRunRecordV2(repo, SLUG, fixtureRecordDraft())
    await writeFile(join(dir, 'zz.json'), 'not json', 'utf8')
    expect(await readRecordChain(repo, SLUG, 'demo', cache)).toMatchObject({ state: 'broken', files: ['zz.json'] })
  })

  it('缓存的目录数有上限，最久没用的先丢；丢掉之后照样读得对', async () => {
    const cache = createRecordChainCache(1)
    await appendTestRunRecordV2(repo, SLUG, fixtureRecordDraft())
    await appendTestRunRecordV2(repo, SLUG, { ...fixtureRecordDraft(), change: 'other' })
    expect((await readRecordChain(repo, SLUG, 'demo', cache)).state).toBe('intact')
    expect((await readRecordChain(repo, SLUG, 'other', cache)).state).toBe('intact')
    expect(cache.directories.size).toBe(1)
    expect((await readRecordChain(repo, SLUG, 'demo', cache)).state).toBe('intact')
  })

  it('清理（链基点标记）后缓存跟着变：基点、被删的文件、被改坏的标记都立刻反映', async () => {
    const cache = createRecordChainCache()
    const ids: string[] = []
    for (let i = 0; i < 5; i++) ids.push((await appendTestRunRecordV2(repo, SLUG, fixtureRecordDraft())).record.run_id)
    const before = await readRecordChain(repo, SLUG, 'demo', cache)
    expect(before.state === 'intact' ? before.active.length : 0).toBe(5)
    expect(await pruneRecordChain(repo, SLUG, 'demo', 3)).toHaveLength(2)
    const pruned = await readRecordChain(repo, SLUG, 'demo', cache)
    expect(pruned.state).toBe('intact')
    expect(pruned.state === 'intact' ? pruned.active.map((record) => record.run_id) : []).toEqual(ids.slice(2))
    expect(await readRecordChain(repo, SLUG, 'demo', cache)).toBe(pruned)
    const dir = testRunRecordsDir(repo, SLUG, 'demo')
    const marker = await readFile(join(dir, 'chain-base'), 'utf8')
    await writeFile(join(dir, 'chain-base'), marker.replace(/sha256:[0-9a-f]{64}/, `sha256:${'0'.repeat(64)}`), 'utf8')
    expect((await readRecordChain(repo, SLUG, 'demo', cache)).state).toBe('broken')
    await writeFile(join(dir, 'chain-base'), 'not json', 'utf8')
    expect(await readRecordChain(repo, SLUG, 'demo', cache)).toMatchObject({ state: 'broken', files: expect.arrayContaining(['chain-base']) })
    await writeFile(join(dir, 'chain-base'), marker, 'utf8')
    expect((await readRecordChain(repo, SLUG, 'demo', cache)).state).toBe('intact')
    await rm(join(dir, 'chain-base'))
    expect((await readRecordChain(repo, SLUG, 'demo', cache)).state).toBe('broken')
  })
})
