/**
 * afk.test —— #29d AFK 指挥面数据端真 HTTP 端到端（GOAL C9 / A5）。
 * 真起 http server（listen(0)）+ 真建带 automation_* 字段的 change（kernel StateStore 真落盘）
 * → 真 node:http GET /api/afk/snapshot、/api/afk/log → 断言真实泳道 / 调度器灯 / 流水。零 mock。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { createDashboardServer } from './server.js'
import { resolveServerPaths } from './paths.js'
import { writeFile } from 'node:fs/promises'
import { ensureUserLocalDir, serializeTaskArchive } from '@tenon/kernel'
import { buildAfkLog, buildAfkSnapshot } from './afk.js'
import { buildSnapshot } from './snapshot.js'
import type { DashboardServer, Snapshot } from './types.js'
import { initChange, makeProject, makeTempHome, newStore, reqGet, testFlow } from './test-support.js'
import type { StateStore } from '@tenon/kernel'

const openServers: DashboardServer[] = []
afterEach(async () => {
  while (openServers.length) await openServers.pop()!.close()
})

interface Harness {
  srv: DashboardServer
  port: number
  root: string
  store: StateStore
}

/** 键约定：'state' → automation 字段本体；其余 <k> → automation_<k>。 */
function buildAutomationKv(fields: Partial<Record<string, string>>): Record<string, string> {
  const kv: Record<string, string> = {}
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue
    kv[k === 'state' ? 'automation' : `automation_${k}`] = v
  }
  return kv
}

/** 真建一批 change，各自 setMany 到指定 automation 态（真落盘 .pipeline.yaml）。 */
async function startWith(states: Record<string, Partial<Record<string, string>>>): Promise<Harness> {
  const store = newStore()
  const root = await makeProject()
  for (const [name, fields] of Object.entries(states)) {
    await initChange(store, root, name)
    const dir = join(root, 'openspec', 'changes', name)
    await store.setMany(dir, buildAutomationKv(fields) as never)
  }
  const srv = createDashboardServer({
    paths: resolveServerPaths({ home: await makeTempHome(), env: {} }),
    version: '9.9.9', token: 't', registry: () => [root], store, flow: testFlow(),
    clock: () => '2026-07-07T00:00:00Z',
  })
  openServers.push(srv)
  const { port } = await srv.listen(0, '127.0.0.1')
  return { srv, port, root, store }
}

describe('#29d capabilities.afk —— 数据端已接线（不谎报）', () => {
  it('/api/snapshot 声明 capabilities.afk = true', async () => {
    const h = await startWith({ a: { state: 'queued' } })
    const s = (await reqGet(h.port, '/api/snapshot')).json<any>()
    expect(s.capabilities.afk).toBe(true)
  })
})

describe('GET /api/afk/snapshot —— 聚合 automation_* → 泳道 + 调度器灯', () => {
  it('各 change 按 automation 态落对应泳道；off 不入板', async () => {
    const h = await startWith({
      q1: { state: 'queued' },
      r1: { state: 'running' },
      m1: { state: 'merged' },
      f1: { state: 'failed' },
      c1: { state: 'conflict' },
      p1: { state: 'paused' },
      idle: { state: 'off' },
    })
    const r = await reqGet(h.port, '/api/afk/snapshot')
    expect(r.status).toBe(200)
    const a = r.json<any>()
    expect(a.lanes.queued.map((c: any) => c.name)).toEqual(['q1'])
    expect(a.lanes.running.map((c: any) => c.name)).toEqual(['r1'])
    expect(a.lanes.merged.map((c: any) => c.name)).toEqual(['m1'])
    expect(a.lanes.failed.map((c: any) => c.name)).toEqual(['f1'])
    expect(a.lanes.conflict.map((c: any) => c.name)).toEqual(['c1'])
    expect(a.lanes.paused.map((c: any) => c.name)).toEqual(['p1'])
    // off 的 change 绝不出现在任一泳道或 cards
    const allNames = a.cards.map((c: any) => c.name)
    expect(allNames).not.toContain('idle')
    expect(a.cards.length).toBe(6)
  })

  it('scheduled（已认领在飞）归并进 running 泳道', async () => {
    const h = await startWith({ sc: { state: 'scheduled' } })
    const a = (await reqGet(h.port, '/api/afk/snapshot')).json<any>()
    expect(a.lanes.running.map((c: any) => c.name)).toEqual(['sc'])
  })

  it('card 携带真 automation_* 明细（attempts/queued_at/last_error/root/path）', async () => {
    const h = await startWith({
      boom: { state: 'failed', attempts: '2', queued_at: '2026-07-07T01:02:03Z', last_error: 'verify exploded' },
    })
    const a = (await reqGet(h.port, '/api/afk/snapshot')).json<any>()
    const card = a.cards.find((c: any) => c.name === 'boom')
    expect(card.attempts).toBe(2)
    expect(card.queued_at).toBe('2026-07-07T01:02:03Z')
    expect(card.last_error).toBe('verify exploded')
    expect(card.root).toBe(h.root)
    expect(card.path).toBe(join(h.root, 'openspec', 'changes', 'boom'))
    expect(card.lane).toBe('failed')
  })

  it('调度器 doctor 灯：有 conflict/failed → attention；纯排队/在跑 → busy；空 → ok', async () => {
    const attn = await startWith({ c1: { state: 'conflict' }, q1: { state: 'queued' } })
    const sa = (await reqGet(attn.port, '/api/afk/snapshot')).json<any>()
    expect(sa.scheduler.status).toBe('attention')
    expect(sa.scheduler.conflict).toBe(1)
    expect(sa.scheduler.queued).toBe(1)
    expect(sa.scheduler.total).toBe(2)
    expect(sa.scheduler.message).toContain('conflict')

    const busy = await startWith({ r1: { state: 'running' }, q1: { state: 'queued' } })
    const sb = (await reqGet(busy.port, '/api/afk/snapshot')).json<any>()
    expect(sb.scheduler.status).toBe('busy')

    const idle = await startWith({ off1: { state: 'off' } })
    const si = (await reqGet(idle.port, '/api/afk/snapshot')).json<any>()
    expect(si.scheduler.status).toBe('ok')
    expect(si.scheduler.total).toBe(0)
  })
})

describe('GET /api/afk/log —— 调度器流水（从 automation_* 派生）', () => {
  it('failed change 产出 error 流水（含 last_error）+ queued 流水', async () => {
    const h = await startWith({
      boom: { state: 'failed', queued_at: '2026-07-07T01:00:00Z', last_error: 'kaboom' },
    })
    const r = await reqGet(h.port, '/api/afk/log')
    expect(r.status).toBe(200)
    const log = r.json<any>()
    const kinds = log.entries.map((e: any) => e.kind)
    expect(kinds).toContain('error')
    expect(kinds).toContain('queued')
    const err = log.entries.find((e: any) => e.kind === 'error')
    expect(err.detail).toContain('kaboom')
    expect(err.name).toBe('boom')
  })

  it('off change 不产流水', async () => {
    const h = await startWith({ idle: { state: 'off' } })
    const log = (await reqGet(h.port, '/api/afk/log')).json<any>()
    expect(log.entries).toEqual([])
  })
})

// ── F-b 成因结构化落盘（读取端）：AfkCard.cause = automation_cause 原样透传（开放集契约）。
//    此段刻意用桩 Snapshot 直测 buildAfkSnapshot 而非上面的真落盘 e2e 路——kernel serialize 只走
//    FIELD_ORDER，在写入端（并行落 FIELD_ORDER + automation 落盘）合入前，setMany('automation_cause')
//    不会round-trip；桩数据让本测与写入端合入时序解耦、两侧独立常绿（写入端合入后其 e2e 自然补真盘
//    覆盖）。转发逻辑本身是纯函数投影，桩即足证。──
describe('F-b AfkCard.cause —— automation_cause 原样透传（开放集，读取端不校验值域）', () => {
  function stubSnapshotWith(fields: Record<string, string>): Snapshot {
    return {
      version: '9.9.9',
      generated_at: '2026-07-07T00:00:00Z',
      capabilities: {},
      project_count: 1,
      change_count: 1,
      projects: [
        {
          root: '/repo',
          ok: true,
          changes: [
            {
              name: 'boom',
              path: '/repo/openspec/changes/boom',
              phase: 'build',
              phase_status: '',
              track: 'backend',
              preset: '',
              archived: '',
              updated_at: '',
              fields: fields as never,
            },
          ],
        },
      ],
    }
  }

  it('automation_cause 有值 → card.cause 原样转发（值域开放：未来新增值零 server 改动）', () => {
    const a = buildAfkSnapshot(
      stubSnapshotWith({ automation: 'failed', automation_cause: 'cancelled', automation_last_error: '任务被人工终止' }),
      () => '2026-07-07T00:00:00Z',
    )
    expect(a.cards).toHaveLength(1)
    expect(a.cards[0]!.cause).toBe('cancelled')
    // 既有字段不受牵连（cause 是纯追加，不改任何旧投影）
    expect(a.cards[0]!.last_error).toBe('任务被人工终止')
    expect(a.cards[0]!.lane).toBe('failed')
  })

  it('缺 automation_cause（老数据/写入端未落）→ card.cause 空串（前端回落 last_error regex 的契约信号）', () => {
    const a = buildAfkSnapshot(
      stubSnapshotWith({ automation: 'failed', automation_last_error: 'kaboom' }),
      () => '2026-07-07T00:00:00Z',
    )
    expect(a.cards[0]!.cause).toBe('')
    expect(a.cards[0]!.last_error).toBe('kaboom')
  })
})

describe('AFK 面排除查看者已归档的 change', () => {
  const alice = { id: 'a@x.io', name: 'A', slug: 'a-at-x.io', source: 'env', trust: 'declared' } as const

  it('归档后不再进泳道与流水；无查看者时照常看到', async () => {
    const h = await startWith({ q1: { state: 'queued' }, q2: { state: 'queued' } })
    const paths = await ensureUserLocalDir(h.root, alice.slug)
    await writeFile(paths.archived, serializeTaskArchive({
      version: 1,
      changes: {
        q1: { archivedAt: '2026-09-15T12:00:00.000Z', phase: 'build', actor: { id: 'a@x.io', name: 'A', trust: 'declared' } },
      },
    }), 'utf8')
    const clock = (): string => '2026-07-07T00:00:00Z'
    const deps = { registry: () => [h.root], store: h.store, version: '9.9.9', clock }

    const forAlice = await buildSnapshot({ ...deps, viewer: () => alice })
    expect(buildAfkSnapshot(forAlice, clock).lanes.queued.map((c) => c.name)).toEqual(['q2'])
    expect(buildAfkLog(forAlice, clock).entries.some((entry) => entry.change === 'q1')).toBe(false)

    const forAnyone = await buildSnapshot(deps)
    expect(buildAfkSnapshot(forAnyone, clock).lanes.queued.map((c) => c.name)).toEqual(['q1', 'q2'])
  })
})
