/**
 * Dashboard 快照的就绪判定（readinessByTransition）对三个通用离开条件的接线：与 transition 同一份能力，
 * 不会把「没人注入」当成任务本身的问题；宿主没有文件面时依赖项失败关闭而不是放行。
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'
import {
  compileEffectiveWorkflowPlan, makeGuardFileContext, parseWorkflow,
  type EffectiveWorkflowPlan, type StateStore,
} from '@tenon/kernel'
import { snapshotWorkflowExecution } from './workflowSnapshot.js'
import { initChange, makeProject, newStore } from './test-support.js'

const NAME = 'demo'
const WORKFLOW = `name: ugsnap
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
let changeDir: string
let plan: EffectiveWorkflowPlan

beforeEach(async () => {
  store = newStore()
  root = await makeProject()
  changeDir = await initChange(store, root, NAME, {
    initialWorkflow: { workflow: 'ugsnap', phase: 'build', openspecContract: false },
  })
  plan = compileEffectiveWorkflowPlan('ugsnap', parseWorkflow(WORKFLOW))
})

async function readinessOf(withFileContext: boolean) {
  const state = await store.read(changeDir)
  const execution = await snapshotWorkflowExecution(plan, state, root, changeDir, NAME, withFileContext
    ? {
        stepExits: {
          guardCheck: () => ({ pass: true, failures: [] }),
          fileContext: makeGuardFileContext(root, { automationRunner: false })(NAME),
          testContext: undefined,
          skillResolver: undefined,
        },
      }
    : {})
  const exit = execution.readinessByTransition.build?.['build-done']
  if (exit === undefined) throw new Error('期望 build-done 出边的就绪判定')
  return exit
}

describe('快照 readiness：通用离开条件', () => {
  test('任务未勾 + AFK 排队 + 依赖未结束：三条都以 guard-failed 列出，出边不可走', async () => {
    await writeFile(join(changeDir, 'tasks.md'), '- [ ] 还没做\n', 'utf8')
    await store.set(changeDir, 'automation', 'queued')
    await store.set(changeDir, 'depends_on', ['dep-open'])
    const exit = await readinessOf(true)
    expect(exit.ready).toBe(false)
    expect(exit.blockers.map((blocker) => blocker.kind === 'guard-failed' ? blocker.guardType : blocker.kind)).toEqual([
      'tasks-through-step', 'not-afk-queued', 'dependencies-ended',
    ])
    expect(exit.blockers.every((blocker) => blocker.kind === 'guard-failed' && blocker.actual !== 'capability-unavailable')).toBe(true)
  })

  test('三项都满足：出边就绪', async () => {
    await writeFile(join(changeDir, 'tasks.md'), '- [x] 做完了\n', 'utf8')
    const exit = await readinessOf(true)
    expect(exit).toEqual({ ready: true, blockers: [] })
  })

  test('宿主没有文件面：依赖结束无从判定，失败关闭（不是放行），任务与 AFK 两项照常判定', async () => {
    await writeFile(join(changeDir, 'tasks.md'), '- [x] 做完了\n', 'utf8')
    const exit = await readinessOf(false)
    expect(exit.ready).toBe(false)
    expect(exit.blockers).toEqual([
      { kind: 'guard-failed', guardType: 'dependencies-ended', actual: 'capability-unavailable' },
    ])
  })
})
