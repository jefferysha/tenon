/**
 * Dashboard 快照 × 谁的测试记录（真机验收 F15）：记录按用户分目录，`tenon test run`、`transition` 都只认负责人，
 * 所以别人打开 Dashboard 看到的测试状态也必须是负责人的记录——而不是「查看者」的空目录（曾一律显示 test-not-run）。
 * 真临时项目、真 CLI 建任务并跑测试、真快照扫描，零 mock。
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createStateStore, type TenonUser } from '@tenon/kernel'
import { afterEach, describe, expect, test } from 'vitest'
import { freshHarness, type Harness } from '../../cli/src/integration-harness.js'
import { testFlow } from './test-support.js'
import { buildListSnapshot, buildSnapshot, scanChangeDetail, type SnapshotDeps } from './snapshot.js'

const FIXED = '2026-09-30T10:00:00Z'
const OWNER: TenonUser = { id: 'a@x.io', name: 'A', slug: 'a-at-x.io', source: 'env', trust: 'declared' }
const VIEWER: TenonUser = { id: 'b@x.io', name: 'B', slug: 'b-at-x.io', source: 'env', trust: 'declared' }
const WORKFLOW = `name: ownerflow
steps:
  - id: build
    label: 实现
    gate: null
    skills: []
    inputs: []
    outputs: []
    tests:
      - id: probe
        direction: unit
        command: "true"
        label: 探针
        timeout_s: 60
        required: true
    guards: []
    test_policy:
      run: [unit]
      scope: full
    transitions:
      - event: build-done
        to: done
  - id: done
    label: 完结
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`

let harness: Harness | undefined
afterEach(async () => {
  if (harness !== undefined) await rm(harness.cwd, { recursive: true, force: true })
  harness = undefined
})

const asOwner = { TENON_USER: OWNER.id, TENON_USER_NAME: OWNER.name }

async function ownedProject(): Promise<Harness> {
  const h = await freshHarness()
  harness = h
  await mkdir(join(h.cwd, '.pipeline', 'workflows'), { recursive: true })
  await writeFile(join(h.cwd, '.pipeline', 'workflows', 'ownerflow.yaml'), WORKFLOW, 'utf8')
  expect(await h.run(['init', 'demo', '--track', 'backend', '--workflow', 'ownerflow', '--preset', 'full'], { env: asOwner }), h.err.join('\n')).toBe(0)
  expect(await h.run(['test', 'run', 'demo', 'probe'], { env: asOwner }), h.err.join('\n')).toBe(0)
  return h
}

function depsFor(h: Harness, viewer: TenonUser, withFlow = false): SnapshotDeps {
  return {
    registry: () => [h.cwd], store: createStateStore(), version: '1', clock: () => FIXED, resolveUser: () => viewer,
    ...(withFlow ? { flow: testFlow() } : {}),
  }
}

async function changeSeenBy(h: Harness, viewer: TenonUser) {
  const snapshot = await buildSnapshot(depsFor(h, viewer))
  const change = snapshot.projects[0]?.changes.find((candidate) => candidate.name === 'demo')
  if (change === undefined) throw new Error('demo change missing from the snapshot')
  return change
}

describe('快照里的测试状态按负责人的记录判定', () => {
  test('非负责人查看：状态与负责人自己看到的一致，并标出这是谁的记录', async () => {
    const h = await ownedProject()
    const own = await changeSeenBy(h, OWNER)
    const other = await changeSeenBy(h, VIEWER)

    expect(own.tests?.[0]?.items.map((item) => [item.id, item.status])).toEqual([['probe', 'passed']])
    expect(other.tests?.[0]?.items.map((item) => [item.id, item.status])).toEqual([['probe', 'passed']])
    expect(other.tests?.[0]?.items[0]?.run).toMatchObject({ user: OWNER.slug, actor: { id: OWNER.id } })
  })

  test('没有负责人（旧任务）时退回查看者身份，不猜别人', async () => {
    const h = await ownedProject()
    const store = createStateStore()
    const dir = join(h.cwd, 'openspec', 'changes', 'demo')
    const state = await store.read(dir)
    await store.writeUnderLock(dir, { ...state, fields: { ...state.fields, assignee: 'unknown' } }, { kind: 'set-many' })
    const other = await changeSeenBy(h, VIEWER)
    expect(other.tests?.[0]?.items.map((item) => [item.id, item.status])).toEqual([['probe', 'missing']])
  })

  test('列表层级的 readiness 与单任务详情读同一份负责人记录（拆分后的两条读取路径不各算各的）', async () => {
    const h = await ownedProject()
    const detailBy = async (viewer: TenonUser) => {
      const scanned = await scanChangeDetail(depsFor(h, viewer), h.cwd, 'demo', Date.parse(FIXED))
      if (scanned === undefined) throw new Error('demo detail missing')
      return scanned.change
    }
    const own = await detailBy(OWNER)
    const other = await detailBy(VIEWER)
    expect(own.tests?.[0]?.items.map((item) => [item.id, item.status])).toEqual([['probe', 'passed']])
    expect(other.tests?.[0]?.items.map((item) => [item.id, item.status])).toEqual([['probe', 'passed']])
    expect(other.tests?.[0]?.items[0]?.run).toMatchObject({ user: OWNER.slug, actor: { id: OWNER.id } })

    const listed = await buildListSnapshot(depsFor(h, VIEWER, true))
    const listChange = listed.projects[0]?.changes.find((candidate) => candidate.name === 'demo')
    const readiness = (change: typeof listChange | undefined) => JSON.stringify(change?.workflowExecution?.readinessByTransition ?? null)
    const listedAsOwner = await buildListSnapshot(depsFor(h, OWNER, true))
    expect(readiness(listChange)).toBe(readiness(listedAsOwner.projects[0]?.changes.find((candidate) => candidate.name === 'demo')))
  })
})
