import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PipelineState } from '../types.js'
import { readTestPlanState, writeTestPlan } from './plan-ledger.js'
import { emptyTestPlan, type PlanWaiver } from './plan.js'
import {
  REVIEW_WAIVERS_FILE, approveFrozenWaivers, boundReviewWaiverSelection, clearReviewWaiverSelection,
  readReviewWaiverSelection, writeReviewWaiverSelection,
} from './review-waivers.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'tenon-review-waivers-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const SELECTION = {
  phase: 'verify',
  event: 'verify-pass',
  requestedAt: '2026-09-29T10:00:00.000Z',
  waivers: [{ key: 'kind:benchmark', reason: '纯文案改动' }, { key: 'covers:spec:auth/登录成功', reason: '手工验收' }],
}

describe('评审请求冻结的豁免清单', () => {
  it('写入后原样读回；清除后读不到', async () => {
    expect(await readReviewWaiverSelection(dir)).toBeUndefined()
    await writeReviewWaiverSelection(dir, SELECTION)
    expect(await readReviewWaiverSelection(dir)).toEqual({ version: 1, ...SELECTION })
    await clearReviewWaiverSelection(dir)
    expect(await readReviewWaiverSelection(dir)).toBeUndefined()
    await expect(clearReviewWaiverSelection(dir)).resolves.toBeUndefined()
  })

  it('形状不对（多键、缺键、坏键名、非 JSON）一律当作没有清单', async () => {
    const bad = [
      '{"version":1,"phase":"verify","event":"e","requestedAt":"t","waivers":[],"extra":1}',
      '{"version":2,"phase":"verify","event":"e","requestedAt":"t","waivers":[]}',
      '{"version":1,"phase":"verify","event":"e","requestedAt":"t","waivers":[{"key":"benchmark","reason":"x"}]}',
      '{"version":1,"phase":"verify","event":"e","requestedAt":"t","waivers":[{"key":"kind:a","reason":""}]}',
      '{"version":1,"phase":"","event":"e","requestedAt":"t","waivers":[]}',
      'not json',
    ]
    for (const body of bad) {
      await writeFile(join(dir, REVIEW_WAIVERS_FILE), body, 'utf8')
      expect(await readReviewWaiverSelection(dir), body).toBeUndefined()
    }
  })
})

const ACTOR = { id: 'tester@tenon.test', name: 'Tester', trust: 'declared' as const }
const STAMP = '2026-09-29T10:00:00.000Z'

/** 只带评审门字段的最小状态（绑定判定只读这三项）。 */
function reviewState(over: { phase?: string; event?: string; requestedAt?: string } = {}): PipelineState {
  return {
    fields: {
      review_gate_phase: over.phase ?? SELECTION.phase,
      review_gate_event: over.event ?? SELECTION.event,
      review_requested_at: over.requestedAt ?? SELECTION.requestedAt,
    },
    opaqueTail: '',
  } as unknown as PipelineState
}

async function writePlanWith(waivers: readonly PlanWaiver[]): Promise<void> {
  await writeTestPlan(dir, { ...emptyTestPlan('demo'), waivers: [...waivers] }, { actor: ACTOR, recordedAt: STAMP })
}

describe('冻结清单绑定评审请求', () => {
  it('phase / event / requestedAt 逐项相同才算绑定；旧请求的残留报 unbound，没有清单不算 unbound', async () => {
    expect(await boundReviewWaiverSelection(dir, reviewState())).toEqual({ selection: undefined, unbound: false })
    await writeReviewWaiverSelection(dir, SELECTION)
    expect((await boundReviewWaiverSelection(dir, reviewState())).selection).toEqual({ version: 1, ...SELECTION })
    for (const over of [{ phase: 'spec' }, { event: 'other' }, { requestedAt: '2026-01-01T00:00:00.000Z' }]) {
      expect(await boundReviewWaiverSelection(dir, reviewState(over)), JSON.stringify(over)).toEqual({ selection: undefined, unbound: true })
    }
  })
})

describe('approveFrozenWaivers', () => {
  const FROZEN = { ...SELECTION, waivers: [{ key: 'kind:benchmark', reason: '纯文案改动' }] }

  it('只批准清单里仍原样存在的豁免，写盘并给出新摘要', async () => {
    await writePlanWith([
      { kind: 'benchmark', reason: '纯文案改动', approved_by: null },
      { kind: 'unit', reason: '请求之后才加的', approved_by: null },
    ])
    await writeReviewWaiverSelection(dir, FROZEN)
    const outcome = await approveFrozenWaivers({ dir, change: 'demo', state: reviewState(), actor: ACTOR, recordedAt: STAMP })
    expect(outcome).toMatchObject({ approved: ['kind:benchmark'], skipped: [], note: null })
    expect(outcome.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    const plan = await readTestPlanState(dir, 'demo')
    expect(plan).toMatchObject({ state: 'ok', digest: outcome.digest })
    expect(plan.state === 'ok' && plan.plan.waivers).toEqual([
      { kind: 'benchmark', reason: '纯文案改动', approved_by: ACTOR.id },
      { kind: 'unit', reason: '请求之后才加的', approved_by: null },
    ])
  })

  it('理由被改过 / 已批准过的不再批准，计划原样不动', async () => {
    await writePlanWith([{ kind: 'benchmark', reason: '换了理由', approved_by: null }])
    await writeReviewWaiverSelection(dir, FROZEN)
    const before = await readTestPlanState(dir, 'demo')
    const outcome = await approveFrozenWaivers({ dir, change: 'demo', state: reviewState(), actor: ACTOR, recordedAt: STAMP })
    expect(outcome).toEqual({ approved: [], skipped: [{ key: 'kind:benchmark', why: 'reason-changed' }], digest: null, note: null })
    expect(await readTestPlanState(dir, 'demo')).toEqual(before)
  })

  it('清单不属于这一次请求：什么都不批准并说明；没有清单：无操作', async () => {
    await writePlanWith([{ kind: 'benchmark', reason: '纯文案改动', approved_by: null }])
    expect(await approveFrozenWaivers({ dir, change: 'demo', state: reviewState(), actor: ACTOR, recordedAt: STAMP }))
      .toEqual({ approved: [], skipped: [], digest: null, note: null })
    await writeReviewWaiverSelection(dir, FROZEN)
    const outcome = await approveFrozenWaivers({
      dir, change: 'demo', state: reviewState({ requestedAt: '2026-01-01T00:00:00.000Z' }), actor: ACTOR, recordedAt: STAMP,
    })
    expect(outcome.approved).toEqual([])
    expect(outcome.note).toContain('不属于这一次 review request')
  })

  it('计划不存在：不批准，说明原因', async () => {
    await writeReviewWaiverSelection(dir, FROZEN)
    const outcome = await approveFrozenWaivers({ dir, change: 'demo', state: reviewState(), actor: ACTOR, recordedAt: STAMP })
    expect(outcome).toMatchObject({ approved: [], digest: null, note: '测试计划不存在，未批准任何豁免' })
  })
})
