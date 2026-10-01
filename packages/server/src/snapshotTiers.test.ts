/**
 * The list tier, the full tier and the change detail read the same projects: the list row is the full row without
 * the per-change evidence, and the detail is the full row. The wire form of the list tier adds nothing a reader
 * could not put back.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ensureUserLocalDir, serializeTaskArchive, type TenonUserResolution } from '@tenon/kernel'
import { buildListSnapshot, buildSnapshot, scanChangeDetail, scanProject, type SnapshotDeps } from './snapshot.js'
import { computeRootFingerprints } from './snapshotFingerprint.js'
import { readTerminalActivity } from './snapshot.js'
import { encodeListProject, LIST_FIELD_KEYS } from './snapshotWire.js'
import { initChange, makeProject, newStore, recordWorkflowPhaseSkill, seedGovernedDocumentEvidence, sleep, testFlow } from './test-support.js'
import type { ChangeSnapshot } from './types.js'

const HEAVY = ['documents', 'skillRuns', 'agentRuns', 'tests', 'testPolicy', 'testPlan', 'testUser', 'testDiagnostics'] as const

function depsFor(roots: readonly string[], extra: Partial<SnapshotDeps> = {}): SnapshotDeps {
  return { registry: () => [...roots], store: newStore(), version: '1', clock: () => 't', flow: testFlow(), ...extra }
}

/** The list-tier shape of a full-tier change: no evidence, no `policy`, stage statuses only. */
function asListRow(change: ChangeSnapshot): Record<string, unknown> {
  const { workflowRules, todo, ...rest } = change
  const { policy: _policy, ...rules } = workflowRules
  const row: Record<string, unknown> = { ...rest, workflowRules: rules }
  for (const key of HEAVY) delete row[key]
  if (todo !== undefined) row.todo = { hasTaskSource: todo.hasTaskSource, stages: todo.stages.map(({ id, label, status }) => ({ id, label, status, tasks: [] })) }
  return row
}

describe('list tier = full tier without the per-change evidence', () => {
  it('同一个项目、同一个 change：列表行等于完整行去掉证据、policy 与任务文本', async () => {
    const store = newStore()
    const root = await makeProject()
    const dir = await initChange(store, root, 'alpha')
    await seedGovernedDocumentEvidence(root, dir, 'alpha')
    await recordWorkflowPhaseSkill(root, dir)
    await writeFile(join(dir, 'tasks.md'), '## open\n- [ ] first\n- [x] second\n', 'utf8')
    const deps = depsFor([root], { store })
    const full = await buildSnapshot(deps)
    const list = await buildListSnapshot(deps)
    const fullChange = full.projects[0]?.changes[0]
    const listChange = list.projects[0]?.changes[0]
    expect(fullChange).toBeDefined()
    expect(fullChange?.documents).toBeDefined()
    expect(fullChange?.todo?.stages.some((stage) => stage.tasks.length > 0)).toBe(true)
    expect(listChange).toEqual(asListRow(fullChange as ChangeSnapshot))
    for (const key of HEAVY) expect(listChange, key).not.toHaveProperty(key)
    expect(listChange?.workflowRules).not.toHaveProperty('policy')
    expect(listChange?.todo?.stages.every((stage) => stage.tasks.length === 0)).toBe(true)
    expect(listChange?.todo?.hasTaskSource).toBe(true)
    expect(list.projects[0]).not.toHaveProperty('workflowRules')
    expect(full.projects[0]).toHaveProperty('workflowRules')
    expect({ ...list, projects: [] }).toEqual({ ...full, projects: [] })
  })

  it('同一计划的 change 在列表层共用同一个规则对象（按身份）；没有 tasks.md → hasTaskSource 为 false', async () => {
    const store = newStore()
    const root = await makeProject()
    await initChange(store, root, 'one')
    await initChange(store, root, 'two')
    const list = await scanProject(depsFor([root], { store }), root, 1, 'list')
    const [one, two] = list.changes
    expect(one?.workflowRules).toBe(two?.workflowRules)
  })

  it('项目根不可达：两个层级都给出同样的错误项目，只有完整层级带兼容用的 workflowRules', async () => {
    const deps = depsFor(['/definitely/not/a/project'])
    const list = await scanProject(deps, '/definitely/not/a/project', 1, 'list')
    const full = await scanProject(deps, '/definitely/not/a/project', 1, 'full')
    expect(list).toMatchObject({ ok: false, changes: [], error: expect.any(String) })
    expect(list).not.toHaveProperty('workflowRules')
    expect(full).toMatchObject({ ok: false, changes: [], workflowRules: {} })
  })

  it('详情 = 完整层级里那个 change；读不了的名字 → undefined', async () => {
    const store = newStore()
    const root = await makeProject()
    const dir = await initChange(store, root, 'alpha')
    await seedGovernedDocumentEvidence(root, dir, 'alpha')
    const deps = depsFor([root], { store })
    const full = await buildSnapshot(deps)
    const detail = await scanChangeDetail(deps, root, 'alpha', 1)
    expect(detail?.change).toEqual(full.projects[0]?.changes[0])
    expect(detail?.archive).toBeUndefined()
    expect(await scanChangeDetail(deps, root, 'ghost', 1)).toBeUndefined()
    await mkdir(join(root, 'openspec', 'changes', 'not-a-change'), { recursive: true })
    expect(await scanChangeDetail(deps, root, 'not-a-change', 1)).toBeUndefined()
  })

  it('查看者归档了这个 change：详情带 archive，列表里它在 archived 而不在 changes', async () => {
    const store = newStore()
    const root = await makeProject()
    await initChange(store, root, 'alpha')
    const alice: TenonUserResolution = { id: 'a@x.io', name: 'A', slug: 'a-at-x.io', source: 'env', trust: 'declared' }
    const paths = await ensureUserLocalDir(root, alice.slug)
    await writeFile(paths.archived, serializeTaskArchive({
      version: 1,
      changes: { alpha: { archivedAt: '2026-09-15T12:00:00.000Z', phase: 'open', actor: { id: alice.id, name: 'A', trust: 'declared' } } },
    }), 'utf8')
    const deps = depsFor([root], { store, viewer: () => alice, resolveUser: () => alice })
    const list = await buildListSnapshot(deps)
    expect(list.projects[0]?.changes).toEqual([])
    expect(list.projects[0]?.archived?.map((change) => change.name)).toEqual(['alpha'])
    const detail = await scanChangeDetail(deps, root, 'alpha', 1)
    expect(detail?.archive).toMatchObject({ phase: 'open', actor: { id: alice.id } })
  })
})

describe('list wire encoding', () => {
  it('共享子树只写一次，change 用整数指回；fields 只留列表行读的键；rev 来自指纹', async () => {
    const store = newStore()
    const root = await makeProject()
    await initChange(store, root, 'one')
    await initChange(store, root, 'two')
    const project = await scanProject(depsFor([root], { store }), root, 1, 'list')
    const wire = JSON.parse(encodeListProject(project, new Map([['one', 'r1']]))) as {
      changes: Record<string, unknown>[]
      shared: Record<string, unknown[]>
    }
    expect(wire.shared.workflowRules).toHaveLength(1)
    expect(wire.changes.map((change) => change.workflowRules)).toEqual([0, 0])
    expect(wire.changes.map((change) => change.rev)).toEqual(['r1', undefined])
    expect(wire.shared.user.length).toBeGreaterThan(0)
    expect(typeof wire.changes[0]?.owner).toBe('number')
    for (const change of wire.changes) expect(Object.keys(change.fields as Record<string, unknown>).every((key) => (LIST_FIELD_KEYS as readonly string[]).includes(key))).toBe(true)
    expect(wire.changes[0]?.fields).toMatchObject({ workflow: 'default' })
  })

  it('没有任何 change 的项目也是合法的线格式（空表）', async () => {
    const root = await makeProject()
    const project = await scanProject(depsFor([root]), root, 1, 'list')
    const wire = JSON.parse(encodeListProject(project, new Map())) as { changes: unknown[]; shared: Record<string, unknown[]> }
    expect(wire.changes).toEqual([])
    expect(Object.values(wire.shared).every((entries) => entries.length === 0)).toBe(true)
  })
})

describe('per-project fingerprints', () => {
  async function fingerprintsOf(roots: readonly string[]) {
    return computeRootFingerprints(roots, 1, undefined, readTerminalActivity, undefined, undefined)
  }

  it('只有被改的 change 的 rev 变，项目指纹变，另一个项目的指纹不变', async () => {
    const store = newStore()
    const a = await makeProject()
    const b = await makeProject()
    const dirOne = await initChange(store, a, 'one')
    await initChange(store, a, 'two')
    await initChange(store, b, 'solo')
    const before = await fingerprintsOf([a, b])
    await sleep(5)
    await store.set(dirOne, 'phase', 'explore')
    const after = await fingerprintsOf([a, b])
    expect(after[0]?.key).not.toBe(before[0]?.key)
    expect(after[1]?.key).toBe(before[1]?.key)
    expect(after[0]?.revs.get('one')).not.toBe(before[0]?.revs.get('one'))
    expect(after[0]?.revs.get('two')).toBe(before[0]?.revs.get('two'))
  })

  it('无关文件不改指纹；新增测试记录目录会改该 change 的 rev', async () => {
    const store = newStore()
    const root = await makeProject()
    await initChange(store, root, 'one')
    const before = (await fingerprintsOf([root]))[0]
    await writeFile(join(root, 'irrelevant.txt'), 'x', 'utf8')
    expect((await fingerprintsOf([root]))[0]?.key).toBe(before?.key)
    await mkdir(join(root, '.tenon', 'users', 'someone', 'tests', 'one'), { recursive: true })
    const after = (await fingerprintsOf([root]))[0]
    expect(after?.revs.get('one')).not.toBe(before?.revs.get('one'))
  })

  it('指纹次序跟注册表走、重复的 root 只算一次', async () => {
    const a = await makeProject()
    const b = await makeProject()
    expect((await fingerprintsOf([b, a, b])).map((fp) => fp.root)).toEqual([b, a])
  })
})
