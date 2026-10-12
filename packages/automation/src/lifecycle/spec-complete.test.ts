import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  compileEffectiveWorkflowPlan,
  createStateStore,
  planAutomationPolicy,
  type AutomationPolicyBits,
  type WorkflowDef,
} from '@tenon/kernel'
import { enqueueAfterSpecComplete } from './spec-complete.js'

const TEST_CREATOR = { id: 'tester@tenon.test', name: 'Tester', trust: 'declared' } as const

const CLOCK = '2026-07-24T06:30:00Z'
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function project(track: string): Promise<{ root: string; dir: string; store: ReturnType<typeof createStateStore> }> {
  const root = await mkdtemp(join(tmpdir(), 'tenon-spec-complete-'))
  roots.push(root)
  await mkdir(join(root, 'openspec', 'changes'), { recursive: true })
  const store = createStateStore()
  const dir = await store.init({
    repoRoot: root,
    name: 'demo',
    track,
    reviewSeed: track === 'pm' ? 'skipped' : 'pending',
    creator: TEST_CREATOR, preset: 'full',
    clock: () => CLOCK,
  })
  await store.set(dir, 'phase', 'build')
  return { root, dir, store }
}

/** 策略位只来自任务冻结计划里所选分支的 `automation`（与 CLI / server 的解析器同口径）。 */
const defaultBranchPolicy = (track: string): AutomationPolicyBits =>
  planAutomationPolicy(compileEffectiveWorkflowPlan('default', undefined, { track }))

const SPEC_COMPLETE = {
  changeName: 'demo',
  event: 'spec-complete',
  from: 'spec',
  to: 'build',
} as const

const step = (id: string) => ({ id, label: id, gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] })

/** 自定义工作流：docs 声明规格完成后自动入队，ops 只允许手动进 AFK，notes 没写 automation。 */
const RELEASE: WorkflowDef = {
  name: 'release',
  steps: [],
  tracks: {
    docs: { steps: [step('write')], automation: { eligible: true, enqueueAfterSpec: true } },
    ops: { steps: [step('write')], automation: { eligible: true, enqueueAfterSpec: false } },
    notes: { steps: [step('write')] },
  },
}
const releaseBranchPolicy = (track: string): AutomationPolicyBits =>
  planAutomationPolicy(compileEffectiveWorkflowPlan('release', RELEASE, { track }))

describe('enqueueAfterSpecComplete —— 已提交的 spec 出口自动 AFK 编排', () => {
  test('产品轨的分支声明 enqueue_after_spec 后，spec -> build 原子挂队，且不启动 runner', async () => {
    const { root, dir, store } = await project('pm')

    const outcome = await enqueueAfterSpecComplete({
      repoRoot: root,
      store,
      clock: () => CLOCK,
      resolveTrackPolicy: defaultBranchPolicy,
      config: { enabled: true, defaultOptIn: true },
    }, SPEC_COMPLETE)

    expect(outcome).toEqual({ kind: 'queued' })
    const fields = (await store.read(dir)).fields
    expect(fields.automation).toBe('queued')
    expect(fields.automation_queued_at).toBe(CLOCK)
  })

  test('显式 runtime opt-out 仍能关闭产品轨的自动挂队（安全控制不靠项目文件伪开关）', async () => {
    const { root, dir, store } = await project('pm')
    const outcome = await enqueueAfterSpecComplete({
      repoRoot: root,
      store,
      clock: () => CLOCK,
      resolveTrackPolicy: defaultBranchPolicy,
      config: { enabled: false },
    }, SPEC_COMPLETE)
    expect(outcome).toEqual({ kind: 'not-opted-in' })
    expect(await store.read(dir)).toMatchObject({ fields: { automation: 'off' } })
  })

  test.each(['frontend', 'backend'])('%s 分支 eligible 但没写 enqueue_after_spec：只能手动进 AFK，不会因 spec-complete 被自动挂队', async (track) => {
    const { root, dir, store } = await project(track)

    const outcome = await enqueueAfterSpecComplete({
      repoRoot: root,
      store,
      clock: () => CLOCK,
      resolveTrackPolicy: defaultBranchPolicy,
    }, SPEC_COMPLETE)

    expect(outcome).toEqual({ kind: 'track-disabled' })
    expect((await store.read(dir)).fields.automation).toBe('off')
  })

  test('轻量分支不可进入 AFK：spec-complete 之后也不会被挂队', async () => {
    const { root, dir, store } = await project('lite')

    const outcome = await enqueueAfterSpecComplete({
      repoRoot: root,
      store,
      clock: () => CLOCK,
      resolveTrackPolicy: defaultBranchPolicy,
      config: { enabled: true, defaultOptIn: true },
    }, SPEC_COMPLETE)

    expect(outcome).toEqual({ kind: 'track-disabled' })
    expect((await store.read(dir)).fields.automation).toBe('off')
  })

  test('自动入队只看分支的 automation，不看轨道 id：自定义工作流的 docs 分支声明了就挂队', async () => {
    const { root, dir, store } = await project('docs')

    const outcome = await enqueueAfterSpecComplete({
      repoRoot: root,
      store,
      clock: () => CLOCK,
      resolveTrackPolicy: releaseBranchPolicy,
      config: { enabled: true, defaultOptIn: true },
    }, SPEC_COMPLETE)

    expect(outcome).toEqual({ kind: 'queued' })
    expect((await store.read(dir)).fields.automation).toBe('queued')
  })

  test.each([
    ['ops', 'eligible: true 但没写 enqueue_after_spec'],
    ['notes', '没写 automation（失败关闭）'],
  ])('自定义工作流的 %s 分支（%s）不自动挂队', async (track) => {
    const { root, dir, store } = await project(track)

    const outcome = await enqueueAfterSpecComplete({
      repoRoot: root,
      store,
      clock: () => CLOCK,
      resolveTrackPolicy: releaseBranchPolicy,
      config: { enabled: true, defaultOptIn: true },
    }, SPEC_COMPLETE)

    expect(outcome).toEqual({ kind: 'track-disabled' })
    expect((await store.read(dir)).fields.automation).toBe('off')
  })

  test('不是已提交的 spec -> build 边时零写入，不能被任意后置调用伪造入队', async () => {
    const { root, dir, store } = await project('pm')

    const outcome = await enqueueAfterSpecComplete({
      repoRoot: root,
      store,
      clock: () => CLOCK,
      resolveTrackPolicy: defaultBranchPolicy,
    }, {
      changeName: 'demo',
      event: 'build-complete',
      from: 'build',
      to: 'verify',
    })

    expect(outcome).toEqual({ kind: 'not-applicable' })
    expect((await store.read(dir)).fields.automation).toBe('off')
  })
})
