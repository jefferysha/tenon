import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { testPlanLedgerPath, testPlanPath } from './paths.js'
import { withLock } from '../state/lock.js'
import { decodeTestPlanLedger, readTestPlanState, updateTestPlan, writeTestPlan, writeTestPlanUnderLock } from './plan-ledger.js'
import { emptyTestPlan, testPlanDigest, type TestPlan } from './plan.js'

const ACTOR = { id: 'tester@tenon.test', name: 'Tester', trust: 'declared' as const }
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenon-plan-ledger-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const PLAN: TestPlan = {
  ...emptyTestPlan('demo'),
  suites: [{ suite: 'web-unit', scope: 'changed' }],
  files: [{ path: 'src/a.test.ts', suite: 'web-unit' }],
}

describe('测试计划台账', () => {
  it('两者都不在 → missing', async () => {
    expect(await readTestPlanState(dir, 'demo')).toEqual({ state: 'missing' })
  })

  it('CLI 写入后可读回，摘要等于规范化字节摘要', async () => {
    const { digest } = await writeTestPlan(dir, PLAN, { actor: ACTOR, recordedAt: '2026-09-29T00:00:00.000Z' })
    expect(digest).toBe(testPlanDigest(PLAN))
    const state = await readTestPlanState(dir, 'demo')
    expect(state.state).toBe('ok')
    if (state.state !== 'ok') return
    expect(state.plan.suites).toEqual(PLAN.suites)
    expect(state.digest).toBe(digest)
    expect(state.ledger.actor).toEqual(ACTOR)
  })

  it('已持锁的调用方用 writeTestPlanUnderLock：不嵌套加锁，结果与 writeTestPlan 一致', async () => {
    const { digest } = await withLock(dir, () => writeTestPlanUnderLock(dir, PLAN, { actor: ACTOR, recordedAt: 't' }))
    expect(digest).toBe(testPlanDigest(PLAN))
    const state = await readTestPlanState(dir, 'demo')
    expect(state.state === 'ok' ? state.digest : undefined).toBe(digest)
  })

  it('手改计划文件 → tampered', async () => {
    await writeTestPlan(dir, PLAN, { actor: ACTOR, recordedAt: 't' })
    const text = await readFile(testPlanPath(dir), 'utf8')
    await writeFile(testPlanPath(dir), text.replace('changed', 'full'), 'utf8')
    expect(await readTestPlanState(dir, 'demo')).toEqual({ state: 'tampered', reason: '计划文件内容与登记摘要不符（被手工改动）' })
  })

  it('只有计划没有台账 / 只有台账没有计划 / 台账损坏 → tampered', async () => {
    await writeFile(testPlanPath(dir), 'schema: tenon-test-plan/v1\nchange: demo\n', 'utf8')
    expect((await readTestPlanState(dir, 'demo')).state).toBe('tampered')
    await writeTestPlan(dir, PLAN, { actor: ACTOR, recordedAt: 't' })
    await rm(testPlanPath(dir))
    expect(await readTestPlanState(dir, 'demo')).toEqual({ state: 'tampered', reason: '计划文件被删除，台账仍在' })
    await writeTestPlan(dir, PLAN, { actor: ACTOR, recordedAt: 't' })
    await writeFile(testPlanLedgerPath(dir), '{"version":1}', 'utf8')
    expect(await readTestPlanState(dir, 'demo')).toEqual({ state: 'tampered', reason: '计划摘要台账损坏' })
    await writeFile(testPlanLedgerPath(dir), 'not json', 'utf8')
    expect((await readTestPlanState(dir, 'demo')).state).toBe('tampered')
  })

  it('摘要对得上但属于别的任务 → tampered（附解析原因）', async () => {
    await writeTestPlan(dir, PLAN, { actor: ACTOR, recordedAt: 't' })
    const state = await readTestPlanState(dir, 'other')
    expect(state.state).toBe('tampered')
    expect(state.state === 'tampered' ? state.reason : '').toMatch(/无法解析：.*属于任务 'demo'/)
  })

  it('updateTestPlan：锁内读—改—写，并发更新不丢失；拒绝时磁盘不动', async () => {
    const meta = { actor: ACTOR, recordedAt: 't' }
    await Promise.all(Array.from({ length: 8 }, (_, index) => updateTestPlan(dir, 'demo', meta, (state) => {
      const base = state.state === 'ok' ? state.plan : emptyTestPlan('demo')
      return { plan: { ...base, suites: [...base.suites, { suite: `s${index}`, scope: 'full' as const }] } }
    })))
    const state = await readTestPlanState(dir, 'demo')
    expect(state.state === 'ok' ? state.plan.suites.map((item) => item.suite).sort() : []).toEqual(
      ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7'],
    )
    const before = await readFile(testPlanPath(dir), 'utf8')
    expect(await updateTestPlan(dir, 'demo', meta, () => ({ reject: '不行' }))).toEqual({ rejected: '不行' })
    expect(await readFile(testPlanPath(dir), 'utf8')).toBe(before)
  })

  it('台账解码是闭集', () => {
    const ok = { version: 1, digest: `sha256:${'a'.repeat(64)}`, recorded_at: 't', actor: ACTOR }
    expect(decodeTestPlanLedger(ok)).toEqual(ok)
    expect(decodeTestPlanLedger({ ...ok, extra: 1 })).toBeUndefined()
    expect(decodeTestPlanLedger({ ...ok, digest: 'md5:x' })).toBeUndefined()
    expect(decodeTestPlanLedger({ ...ok, actor: { id: 'x' } })).toBeUndefined()
    expect(decodeTestPlanLedger([])).toBeUndefined()
  })
})
