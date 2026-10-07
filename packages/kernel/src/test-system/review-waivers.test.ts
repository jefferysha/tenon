import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PipelineState } from '../types.js'
import { readCatalogFile } from './catalog-file.js'
import { testSystemPaths } from './paths.js'
import { readTestPlanState, writeTestPlan } from './plan-ledger.js'
import { emptyTestPlan, type PlanWaiver } from './plan.js'
import { protectedFileDigest } from './protected-files.js'
import {
  REVIEW_WAIVERS_FILE, approveFrozenWaivers, boundReviewWaiverSelection, clearReviewWaiverSelection,
  pendingReviewWaivers, readReviewWaiverSelection, writeReviewWaiverSelection, type FrozenProtectedChange,
} from './review-waivers.js'
import { isApproved, readTestSeal } from './seal.js'

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
    const outcome = await approveFrozenWaivers({ repoRoot: dir, dir, change: 'demo', state: reviewState(), actor: ACTOR, recordedAt: STAMP })
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
    const outcome = await approveFrozenWaivers({ repoRoot: dir, dir, change: 'demo', state: reviewState(), actor: ACTOR, recordedAt: STAMP })
    expect(outcome).toEqual({ approved: [], skipped: [{ key: 'kind:benchmark', why: 'reason-changed' }], digest: null, note: null, protectedApproved: [], protectedSkipped: [] })
    expect(await readTestPlanState(dir, 'demo')).toEqual(before)
  })

  it('清单不属于这一次请求：什么都不批准并说明；没有清单：无操作', async () => {
    await writePlanWith([{ kind: 'benchmark', reason: '纯文案改动', approved_by: null }])
    expect(await approveFrozenWaivers({ repoRoot: dir, dir, change: 'demo', state: reviewState(), actor: ACTOR, recordedAt: STAMP }))
      .toEqual({ approved: [], skipped: [], digest: null, note: null, protectedApproved: [], protectedSkipped: [] })
    await writeReviewWaiverSelection(dir, FROZEN)
    const outcome = await approveFrozenWaivers({
      repoRoot: dir, dir, change: 'demo', state: reviewState({ requestedAt: '2026-01-01T00:00:00.000Z' }), actor: ACTOR, recordedAt: STAMP,
    })
    expect(outcome.approved).toEqual([])
    expect(outcome.note).toContain('不属于这一次 review request')
  })

  it('计划不存在：不批准，说明原因', async () => {
    await writeReviewWaiverSelection(dir, FROZEN)
    const outcome = await approveFrozenWaivers({ repoRoot: dir, dir, change: 'demo', state: reviewState(), actor: ACTOR, recordedAt: STAMP })
    expect(outcome).toMatchObject({ approved: [], digest: null, note: '测试计划不存在，未批准任何豁免' })
  })
})

describe('目录里项目级「不适用」声明的评审批准', () => {
  const CATALOG = [
    '# 人手写的注释', 'schema: tenon-test-catalog/v1', 'suites: []', 'not_applicable:',
    '  - { kind: typecheck, reason: 纯 JavaScript 项目, approved_by: null }',
    '  - { kind: integration, reason: 没有集成面, approved_by: null }', '',
  ].join('\n')
  const FROZEN = {
    ...SELECTION,
    waivers: [
      { key: 'kind:benchmark', reason: '纯文案改动' },
      { key: 'not-applicable:typecheck', reason: '纯 JavaScript 项目' },
    ],
  }

  async function writeCatalog(text = CATALOG): Promise<string> {
    const path = testSystemPaths(dir).catalog
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, text, 'utf8')
    return path
  }

  it('pendingReviewWaivers = 计划里未批准的豁免 + 目录里未批准的声明；目录缺失 / 计划缺失时各自为空', async () => {
    expect(await pendingReviewWaivers({ repoRoot: dir, dir, change: 'demo' })).toEqual([])
    await writeCatalog()
    expect(await pendingReviewWaivers({ repoRoot: dir, dir, change: 'demo' })).toEqual([
      { key: 'not-applicable:integration', reason: '没有集成面' },
      { key: 'not-applicable:typecheck', reason: '纯 JavaScript 项目' },
    ])
    await writePlanWith([{ kind: 'benchmark', reason: '纯文案改动', approved_by: null }])
    expect((await pendingReviewWaivers({ repoRoot: dir, dir, change: 'demo' })).map((item) => item.key)).toEqual([
      'kind:benchmark', 'not-applicable:integration', 'not-applicable:typecheck',
    ])
  })

  it('冻结清单里的声明被批准并写回 catalog.yaml（记录批准人）；清单外的不动；计划豁免同一次批准', async () => {
    await writeCatalog()
    await writePlanWith([{ kind: 'benchmark', reason: '纯文案改动', approved_by: null }])
    await writeReviewWaiverSelection(dir, FROZEN)
    const outcome = await approveFrozenWaivers({ repoRoot: dir, dir, change: 'demo', state: reviewState(), actor: ACTOR, recordedAt: STAMP })
    expect(outcome).toMatchObject({ approved: ['kind:benchmark', 'not-applicable:typecheck'], skipped: [], note: null })
    const catalog = await readCatalogFile(dir)
    expect(catalog.state === 'ok' && catalog.catalog.not_applicable).toEqual([
      { kind: 'typecheck', reason: '纯 JavaScript 项目', approved_by: ACTOR.id },
      { kind: 'integration', reason: '没有集成面', approved_by: null },
    ])
  })

  it('理由被改过 / 已批准过 / 声明已不在目录里：不批准并说明；没有可批准的就不重写目录文件', async () => {
    const path = await writeCatalog(CATALOG.replace('纯 JavaScript 项目', '换了理由'))
    await writeReviewWaiverSelection(dir, { ...SELECTION, waivers: [{ key: 'not-applicable:typecheck', reason: '纯 JavaScript 项目' }, { key: 'not-applicable:lint', reason: 'x' }] })
    const before = await readFile(path, 'utf8')
    const outcome = await approveFrozenWaivers({ repoRoot: dir, dir, change: 'demo', state: reviewState(), actor: ACTOR, recordedAt: STAMP })
    expect(outcome.approved).toEqual([])
    expect(outcome.skipped).toEqual([
      { key: 'not-applicable:typecheck', why: 'reason-changed' }, { key: 'not-applicable:lint', why: 'missing' },
    ])
    expect(await readFile(path, 'utf8')).toBe(before)
  })

  it('目录不存在：不批准，说明原因；计划豁免不受影响', async () => {
    await writePlanWith([{ kind: 'benchmark', reason: '纯文案改动', approved_by: null }])
    await writeReviewWaiverSelection(dir, FROZEN)
    const outcome = await approveFrozenWaivers({ repoRoot: dir, dir, change: 'demo', state: reviewState(), actor: ACTOR, recordedAt: STAMP })
    expect(outcome.approved).toEqual(['kind:benchmark'])
    expect(outcome.note).toContain('测试目录（catalog.yaml）不存在')
  })
})

describe('声明早于任务起点就已提交：批准写回目录的那次改写（F19）', () => {
  const CATALOG_PATH = '.tenon/tests/catalog.yaml'
  const SLUG = 'tester-at-tenon.test'
  const CATALOG = [
    'schema: tenon-test-catalog/v1', 'suites: []', 'not_applicable:',
    '  - { kind: typecheck, reason: 纯 JavaScript 项目, approved_by: null }', '',
  ].join('\n')
  const FROZEN = { ...SELECTION, waivers: [{ key: 'not-applicable:typecheck', reason: '纯 JavaScript 项目' }] }
  const MODIFIED = { path: CATALOG_PATH, kind: 'catalog' as const, status: 'modified' as const, digest: 'sha256:other' }

  async function writeCatalog(text = CATALOG): Promise<string> {
    const path = testSystemPaths(dir).catalog
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, text, 'utf8')
    return path
  }

  const approve = (protectedChanges: () => Promise<readonly (typeof MODIFIED)[]>) => approveFrozenWaivers({
    repoRoot: dir, dir, change: 'demo', state: reviewState(), actor: ACTOR, recordedAt: STAMP, protectedChanges,
  })

  it('目录相对任务起点原样：批准写入之后的摘要被封存，目录算已批准', async () => {
    await writeCatalog()
    await writeReviewWaiverSelection(dir, FROZEN)
    const outcome = await approve(async () => [])
    expect(outcome).toMatchObject({ approved: ['not-applicable:typecheck'], protectedApproved: [CATALOG_PATH] })
    const after = await protectedFileDigest(dir, CATALOG_PATH)
    expect(isApproved((await readTestSeal(dir, SLUG)).seal, 'demo', CATALOG_PATH, after)).toBe(true)
    expect(await readFile(testSystemPaths(dir).catalog, 'utf8')).toContain(`approved_by: ${ACTOR.id}`)
  })

  it('目录在任务里另有改动而冻结清单没带它：批准照写，但这次改写不被封存', async () => {
    await writeCatalog()
    await writeReviewWaiverSelection(dir, FROZEN)
    const outcome = await approve(async () => [MODIFIED])
    expect(outcome).toMatchObject({ approved: ['not-applicable:typecheck'], protectedApproved: [] })
    expect((await readTestSeal(dir, SLUG)).seal.approvals).toEqual([])
  })

  it('检查与写入之间有人改了目录：拒绝，什么都不批准、不封存、不重写他的改动；重新确认之后正常', async () => {
    const path = await writeCatalog()
    await writeReviewWaiverSelection(dir, FROZEN)
    const edited = CATALOG.replace('suites: []', 'suites: []\n# 检查期间有人手改了目录')
    // 观察到目录原样、读完 diff 之后、写入之前，一次手改落了盘。
    await expect(approve(async () => {
      await writeFile(path, edited, 'utf8')
      return []
    })).rejects.toThrow('在评审确认的检查与写入之间被改动')
    expect(await readFile(path, 'utf8')).toBe(edited)
    expect((await readTestSeal(dir, SLUG)).seal.approvals).toEqual([])
    // 同一条确认重试：这次 diff 里能看到那处改动（目录不再原样），声明照批，改写不被封存。
    const retried = await approve(async () => [MODIFIED])
    expect(retried).toMatchObject({ approved: ['not-applicable:typecheck'], protectedApproved: [] })
    expect((await readTestSeal(dir, SLUG)).seal.approvals).toEqual([])
  })

  it('冻结清单已带着目录摘要时不再观察（摘要在请求时已冻结，封存走原来的路径）', async () => {
    await writeCatalog()
    const frozen: FrozenProtectedChange = { ...MODIFIED, digest: await protectedFileDigest(dir, CATALOG_PATH), origin: 'pending' }
    await writeReviewWaiverSelection(dir, { ...FROZEN, protected: [frozen] })
    let observed = false
    const outcome = await approve(async () => { observed = true; return [] })
    expect(observed).toBe(false)
    expect(outcome).toMatchObject({ approved: ['not-applicable:typecheck'], protectedApproved: [CATALOG_PATH] })
  })
})

describe('冻结清单里的受保护配置改动（R1 / R3）', () => {
  const KF_PATH = '.tenon/tests/known-failures.yaml'
  const CATALOG_PATH = '.tenon/tests/catalog.yaml'
  const SLUG = 'tester-at-tenon.test'

  async function writeProtected(path: string, body: string): Promise<void> {
    await mkdir(join(dir, '.tenon', 'tests'), { recursive: true })
    await writeFile(join(dir, path), body)
  }

  async function frozen(path: string, kind: FrozenProtectedChange['kind'], origin: FrozenProtectedChange['origin'] = 'pending'): Promise<FrozenProtectedChange> {
    return { path, kind, status: 'modified', digest: await protectedFileDigest(dir, path), origin }
  }

  it('protected 键随清单原样写入读回；旧清单（没有该键）照常读；坏形状当作没有清单', async () => {
    await writeProtected(KF_PATH, 'a\n')
    const item = await frozen(KF_PATH, 'known-failures', 'outside-command')
    await writeReviewWaiverSelection(dir, { ...SELECTION, protected: [item] })
    expect(await readReviewWaiverSelection(dir)).toEqual({ version: 1, ...SELECTION, protected: [item] })
    await writeReviewWaiverSelection(dir, SELECTION)
    expect((await readReviewWaiverSelection(dir))?.protected).toBeUndefined()
    const base = { version: 1, phase: 'verify', event: 'e', requestedAt: 't', waivers: [] }
    for (const bad of [
      { ...base, protected: [{ path: 'src/a.ts', kind: 'catalog', status: 'modified', digest: 'sha256:x', origin: 'pending' }] },
      { ...base, protected: [{ path: CATALOG_PATH, kind: 'known-failures', status: 'modified', digest: 'sha256:x', origin: 'pending' }] },
      { ...base, protected: [{ path: CATALOG_PATH, kind: 'catalog', status: 'weird', digest: 'sha256:x', origin: 'pending' }] },
      { ...base, protected: [{ path: CATALOG_PATH, kind: 'catalog', status: 'added', digest: 'sha256:x', origin: 'approved' }] },
      { ...base, protected: [{ path: CATALOG_PATH, kind: 'catalog', status: 'added', digest: 'sha256:x', origin: 'pending', extra: 1 }] },
      { ...base, protected: 'nope' },
    ]) {
      await writeFile(join(dir, REVIEW_WAIVERS_FILE), JSON.stringify(bad), 'utf8')
      expect(await readReviewWaiverSelection(dir), JSON.stringify(bad)).toBeUndefined()
    }
  })

  it('只有受保护改动、没有豁免的清单也算数（绑定请求、可被批准）', async () => {
    await writeProtected(KF_PATH, 'a\n')
    await writeReviewWaiverSelection(dir, { ...SELECTION, waivers: [], protected: [await frozen(KF_PATH, 'known-failures')] })
    expect((await boundReviewWaiverSelection(dir, reviewState())).selection?.protected).toHaveLength(1)
    expect(await boundReviewWaiverSelection(dir, reviewState({ event: 'other' }))).toEqual({ selection: undefined, unbound: true })
  })

  it('人工确认把冻结摘要仍然相同的项写进本机封存；批准绑定 change + 路径 + 摘要', async () => {
    await writeProtected(KF_PATH, 'entries\n')
    await writeProtected(CATALOG_PATH, 'suites\n')
    const kf = await frozen(KF_PATH, 'known-failures')
    const catalog = await frozen(CATALOG_PATH, 'catalog')
    await writeReviewWaiverSelection(dir, { ...SELECTION, waivers: [], protected: [kf, catalog] })
    const outcome = await approveFrozenWaivers({ repoRoot: dir, dir, change: 'demo', state: reviewState(), actor: ACTOR, recordedAt: STAMP })
    expect(outcome).toMatchObject({ approved: [], protectedApproved: [KF_PATH, CATALOG_PATH], protectedSkipped: [] })
    const { seal } = await readTestSeal(dir, SLUG)
    expect(isApproved(seal, 'demo', KF_PATH, kf.digest)).toBe(true)
    expect(isApproved(seal, 'demo', CATALOG_PATH, catalog.digest)).toBe(true)
    expect(isApproved(seal, 'other', KF_PATH, kf.digest)).toBe(false)
    expect(seal.approvals[0]).toMatchObject({ by: ACTOR.id, at: STAMP })
    // 重试同一条确认是幂等的：不重复记批准。
    await approveFrozenWaivers({ repoRoot: dir, dir, change: 'demo', state: reviewState(), actor: ACTOR, recordedAt: STAMP })
    expect((await readTestSeal(dir, SLUG)).seal.approvals).toHaveLength(2)
  })

  it('请求之后文件又被改（含被删）：不批准，报 content-changed', async () => {
    await writeProtected(KF_PATH, 'as requested\n')
    await writeProtected(CATALOG_PATH, 'as requested\n')
    await writeReviewWaiverSelection(dir, {
      ...SELECTION, waivers: [], protected: [await frozen(KF_PATH, 'known-failures'), await frozen(CATALOG_PATH, 'catalog')],
    })
    await writeProtected(KF_PATH, 'sneaky extra entry\n')
    await rm(join(dir, CATALOG_PATH))
    const outcome = await approveFrozenWaivers({ repoRoot: dir, dir, change: 'demo', state: reviewState(), actor: ACTOR, recordedAt: STAMP })
    expect(outcome.protectedApproved).toEqual([])
    expect(outcome.protectedSkipped).toEqual([
      { path: KF_PATH, why: 'content-changed' },
      { path: CATALOG_PATH, why: 'content-changed' },
    ])
    expect((await readTestSeal(dir, SLUG)).seal.approvals).toEqual([])
  })

  it('清单不属于这一次请求：受保护改动也一并不批准', async () => {
    await writeProtected(KF_PATH, 'x\n')
    await writeReviewWaiverSelection(dir, { ...SELECTION, waivers: [], protected: [await frozen(KF_PATH, 'known-failures')] })
    const outcome = await approveFrozenWaivers({
      repoRoot: dir, dir, change: 'demo', state: reviewState({ requestedAt: '2026-01-01T00:00:00.000Z' }), actor: ACTOR, recordedAt: STAMP,
    })
    expect(outcome.protectedApproved).toEqual([])
    expect(outcome.note).toContain('不属于这一次 review request')
    expect((await readTestSeal(dir, SLUG)).seal.approvals).toEqual([])
  })

  it('目录改动与它里面的「不适用」声明同一次确认一起批准：批准会重写 catalog.yaml，目录项按写入之后的内容记批准', async () => {
    await writeProtected(CATALOG_PATH, [
      'schema: tenon-test-catalog/v1', 'suites: []', 'not_applicable:',
      '  - { kind: typecheck, reason: 纯 JavaScript 项目, approved_by: null }', '',
    ].join('\n'))
    const catalog = await frozen(CATALOG_PATH, 'catalog')
    await writeReviewWaiverSelection(dir, {
      ...SELECTION, waivers: [{ key: 'not-applicable:typecheck', reason: '纯 JavaScript 项目' }], protected: [catalog],
    })
    const outcome = await approveFrozenWaivers({ repoRoot: dir, dir, change: 'demo', state: reviewState(), actor: ACTOR, recordedAt: STAMP })
    expect(outcome).toMatchObject({ approved: ['not-applicable:typecheck'], protectedApproved: [CATALOG_PATH], protectedSkipped: [] })
    const after = await protectedFileDigest(dir, CATALOG_PATH)
    expect(after).not.toBe(catalog.digest)
    const { seal } = await readTestSeal(dir, SLUG)
    expect(isApproved(seal, 'demo', CATALOG_PATH, after)).toBe(true)
    expect(isApproved(seal, 'demo', CATALOG_PATH, catalog.digest)).toBe(false)
    // 批准之后目录再被改（哪怕只改一个字）又要重新确认。
    await writeProtected(CATALOG_PATH, `${await readFile(join(dir, CATALOG_PATH), 'utf8')}# 事后加的\n`)
    expect(isApproved((await readTestSeal(dir, SLUG)).seal, 'demo', CATALOG_PATH, await protectedFileDigest(dir, CATALOG_PATH))).toBe(false)
  })

  it('目录项在请求之后又被改：不批准目录项，也不连带批准它里面的声明之外的内容', async () => {
    await writeProtected(CATALOG_PATH, 'schema: tenon-test-catalog/v1\nsuites: []\nnot_applicable:\n  - { kind: typecheck, reason: 纯 JavaScript 项目, approved_by: null }\n')
    const catalog = await frozen(CATALOG_PATH, 'catalog')
    await writeReviewWaiverSelection(dir, {
      ...SELECTION, waivers: [{ key: 'not-applicable:typecheck', reason: '纯 JavaScript 项目' }], protected: [catalog],
    })
    await writeProtected(CATALOG_PATH, 'schema: tenon-test-catalog/v1\nsuites: []\nnot_applicable:\n  - { kind: typecheck, reason: 纯 JavaScript 项目, approved_by: null }\n# 请求之后加的\n')
    const outcome = await approveFrozenWaivers({ repoRoot: dir, dir, change: 'demo', state: reviewState(), actor: ACTOR, recordedAt: STAMP })
    expect(outcome.protectedApproved).toEqual([])
    expect(outcome.protectedSkipped).toEqual([{ path: CATALOG_PATH, why: 'content-changed' }])
    expect((await readTestSeal(dir, SLUG)).seal.approvals).toEqual([])
  })

  it('豁免与受保护改动同一次确认一起批准', async () => {
    await writePlanWith([{ kind: 'benchmark', reason: '纯文案改动', approved_by: null }])
    await writeProtected(KF_PATH, 'x\n')
    await writeReviewWaiverSelection(dir, {
      ...SELECTION, waivers: [{ key: 'kind:benchmark', reason: '纯文案改动' }], protected: [await frozen(KF_PATH, 'known-failures')],
    })
    const outcome = await approveFrozenWaivers({ repoRoot: dir, dir, change: 'demo', state: reviewState(), actor: ACTOR, recordedAt: STAMP })
    expect(outcome).toMatchObject({ approved: ['kind:benchmark'], protectedApproved: [KF_PATH] })
  })
})
