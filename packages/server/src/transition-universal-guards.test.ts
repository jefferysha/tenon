/**
 * 真实 e2e —— Dashboard 服务的 transition 写回端点也注入三个通用离开条件的能力
 * （tasks-through-step / not-afk-queued / dependencies-ended，设计 §1b Q5 / Q7 / Q8），
 * 与 CLI 的 `tenon transition` 同一份判定：未满足时 409 一次列出全部，满足后放行。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'
import { createTransitionRecordStore, createWorkflowRunRepository, type StateStore } from '@tenon/kernel'
import { performTransition, type TransitionDeps } from './transition.js'
import { initChange, makeProject, newStore, testFlow } from './test-support.js'

const NAME = 'demo'
const WORKFLOW = `name: ugwf
steps:
  - id: build
    label: Build
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards:
      - type: tasks-through-step
      - type: not-afk-queued
      - type: dependencies-ended
    transitions:
      - event: build-done
        to: done
  - id: done
    label: Done
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`

let root: string
let store: StateStore
let deps: TransitionDeps

const changeDir = (): string => join(root, 'openspec', 'changes', NAME)
const go = () => performTransition(deps, root, NAME, 'build-done')

beforeEach(async () => {
  store = newStore()
  root = await makeProject()
  await mkdir(join(root, '.pipeline', 'workflows'), { recursive: true })
  await writeFile(join(root, '.pipeline', 'workflows', 'ugwf.yaml'), WORKFLOW, 'utf8')
  await initChange(store, root, NAME, {
    initialWorkflow: { workflow: 'ugwf', phase: 'build', openspecContract: false },
  })
  const recordStore = createTransitionRecordStore()
  deps = {
    store,
    runRepo: createWorkflowRunRepository({ store, recordStore, clock: () => '2026-10-10T00:00:00Z' }),
    recordStore,
    flow: testFlow(),
    clock: () => '2026-10-10T00:00:00Z',
  }
})

describe('Dashboard 服务的 transition：通用离开条件', () => {
  test('未勾任务 + AFK 排队 + 依赖未结束：409 一次列出三条，不提前吞掉任何一条，相位不动', async () => {
    await writeFile(join(changeDir(), 'tasks.md'), '- [ ] 还没做\n', 'utf8')
    await store.set(changeDir(), 'automation', 'queued')
    await store.set(changeDir(), 'depends_on', ['dep-open'])
    const result = await go()
    expect(result.code).toBe(409)
    const detail = result.body.detail
    if (!Array.isArray(detail)) throw new Error('期望 detail 是失败列表')
    expect(detail).toHaveLength(4) // 抬头 + 三条失败
    const text = detail.join('\n')
    expect(text).toContain('1 项未勾')
    expect(text).toContain('automation')
    expect(text).toContain('dep-open')
    expect(text).not.toContain('缺少能力')
    expect((await store.read(changeDir())).fields.phase).toBe('build')
  })

  test('任务已勾、未排队、依赖已归档：放行并推进相位', async () => {
    await writeFile(join(changeDir(), 'tasks.md'), '- [x] 做完了\n', 'utf8')
    await store.set(changeDir(), 'depends_on', ['dep-done'])
    await mkdir(join(root, 'openspec', 'changes', 'archive', '2026-10-01-dep-done'), { recursive: true })
    const result = await go()
    expect(result.code).toBe(200)
    expect((await store.read(changeDir())).fields.phase).toBe('done')
  })
})
