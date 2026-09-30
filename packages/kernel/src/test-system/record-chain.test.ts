import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { testRunRecordsDir } from './paths.js'
import {
  appendTestRunRecordV2, listRecordDirectory, readRecordChain, recordV2Digest, verifyRecordChain,
} from './record-chain.js'
import { declaresRecordV2, decodeTestRunRecordV2 } from './record-v2-codec.js'
import type { TestRunRecordV2 } from './record-v2-types.js'
import { readTestSeal } from './seal.js'
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

  it('每次追加都把新链头封存；绕开命令补写一条重算过摘要的记录，链仍完好但链头对不上封存，下次追加另起新链取代它', async () => {
    await appendTestRunRecordV2(repo, SLUG, fixtureRecordDraft())
    const second = await appendTestRunRecordV2(repo, SLUG, fixtureRecordDraft())
    expect((await readTestSeal(repo, SLUG)).seal.heads.demo).toBe(second.record.digest)
    const dir = testRunRecordsDir(repo, SLUG, 'demo')
    const { digest: _digest, ...forgedBody } = {
      ...second.record,
      run_id: '20260929T235959Z-ffffff',
      prev_digest: second.record.digest,
      suites: [fixtureSuiteRun({ suite: 'e2e', kind: 'playwright', runner: 'playwright' })],
    }
    const forged = { ...forgedBody, digest: recordV2Digest(forgedBody as Omit<TestRunRecordV2, 'digest'>) }
    await writeFile(join(dir, `${forged.run_id}.json`), JSON.stringify(forged, null, 2), 'utf8')
    const chain = await readRecordChain(repo, SLUG, 'demo')
    expect(chain.state).toBe('intact')
    expect(chain.state === 'intact' ? chain.head : '').toBe(forged.digest)
    expect((await readTestSeal(repo, SLUG)).seal.heads.demo).not.toBe(forged.digest)
    const next = await appendTestRunRecordV2(repo, SLUG, fixtureRecordDraft())
    expect(next.chain).toBe('reset')
    expect(next.record.chain_reset?.superseded).toContain(`${forged.run_id}.json`)
    const after = await readRecordChain(repo, SLUG, 'demo')
    expect(after.state === 'intact' ? after.active.map((record) => record.run_id) : []).toEqual([next.record.run_id])
    expect((await readTestSeal(repo, SLUG)).seal.heads.demo).toBe(next.record.digest)
  })

  it('同 run-id 不覆盖；形状非法拒绝写入', async () => {
    const draft = fixtureRecordDraft()
    await appendTestRunRecordV2(repo, SLUG, draft)
    await expect(appendTestRunRecordV2(repo, SLUG, draft)).rejects.toThrow()
    await expect(appendTestRunRecordV2(repo, SLUG, { ...fixtureRecordDraft(), suites: [fixtureSuiteRun({ suite: 'x', kind: 'nope' as 'unit' })] }))
      .rejects.toThrow(/形状非法/)
  })
})
