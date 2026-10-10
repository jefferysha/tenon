/**
 * 真实 e2e —— Dashboard 服务的 transition 写回端点（performTransition）也执行验证轮次上限：用完后受约束步骤的回退边
 * 返回 409 + code `rounds-exhausted`（写出已用轮次与上限），前进边与不受约束的步骤不受影响；上限调高后恢复。
 * 轮次读 canonical 转换记录链（recordStore），与 CLI 的 `review request` / `transition` 同一份实现（kernel readStepRounds）。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'
import { createTransitionRecordStore, createWorkflowRunRepository, type StateStore } from '@tenon/kernel'
import { performTransition, type TransitionDeps } from './transition.js'
import { initChange, makeProject, newStore, testFlow } from './test-support.js'

const NAME = 'demo'
const WORKFLOW = `name: roundswf
steps:
  - id: spec
    label: Spec
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: spec-done
        to: build
  - id: build
    label: Build
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: build-done
        to: verify
      - event: requirements-changed
        to: spec
  - id: verify
    label: Verify
    gate: review
    max_rounds: 2
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: verify-pass
        to: done
      - event: verify-fail
        to: build
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
const go = (event: string) => performTransition(deps, root, NAME, event)

beforeEach(async () => {
  store = newStore()
  root = await makeProject()
  await mkdir(join(root, '.pipeline', 'workflows'), { recursive: true })
  await writeFile(join(root, '.pipeline', 'workflows', 'roundswf.yaml'), WORKFLOW, 'utf8')
  await initChange(store, root, NAME, {
    track: 'simple',
    initialWorkflow: { workflow: 'roundswf', phase: 'spec', openspecContract: false },
  })
  const recordStore = createTransitionRecordStore()
  deps = {
    store,
    runRepo: createWorkflowRunRepository({ store, recordStore, clock: () => '2026-10-09T00:00:00Z' }),
    recordStore,
    flow: testFlow(),
    clock: () => '2026-10-09T00:00:00Z',
  }
})

/** 真实走到第 N 轮的 verify：每一轮之前都经 verify-fail 回到实现（上限临时调高，让回退可走）。 */
async function toVerifyRound(round: number): Promise<void> {
  expect((await go('spec-done')).code).toBe(200)
  await store.set(changeDir(), 'max_rounds', '20')
  for (let index = 1; index <= round; index += 1) {
    expect((await go('build-done')).code).toBe(200)
    if (index < round) {
      // 回退边有评审确认门：这里只关心轮次，用 verify-fail 之前直接把相位推回 build（canonical 链里补一条转换）。
      await backToBuild()
    }
  }
}

async function backToBuild(): Promise<void> {
  await deps.runRepo.transact(changeDir(), async (tx) => {
    await tx.commit({ ...tx.state.fields, phase: 'build' }, { event: 'verify-fail', from: 'verify', to: 'build' })
  })
}

describe('Dashboard 服务的 transition：验证轮次上限', () => {
  test('用完后回退边被拒：409 + code rounds-exhausted，写出已用轮次与上限；相位不动', async () => {
    await toVerifyRound(2)
    await store.set(changeDir(), 'max_rounds', '2')
    const result = await go('verify-fail')
    expect(result.code).toBe(409)
    expect(result.body).toMatchObject({ ok: false, code: 'rounds-exhausted', step: 'verify', event: 'verify-fail', current: 2, max: 2, source: 'task' })
    expect(String(result.body.error)).toContain('2/2')
    expect(String(result.body.error)).toContain(`tenon set ${NAME} max_rounds <N>`)
    // 回到规格没有直达的边（requirements-changed 声明在 build 上）：与 CLI 的 transition.roundsExhausted（zh）同义，不暗示在 verify 上直接执行。
    expect(String(result.body.error)).not.toContain('经 requirements-changed 回到规格')
    expect(String(result.body.error)).toContain('没有直达的边')
    expect((await store.read(changeDir())).fields.phase).toBe('verify')
  })

  test('调整上限：设为 1 仍用完；设为 3 才恢复（越过这道门，由后面的评审确认门接着判）', async () => {
    await toVerifyRound(2)
    await store.set(changeDir(), 'max_rounds', '1')
    expect((await go('verify-fail')).body).toMatchObject({ code: 'rounds-exhausted', current: 2, max: 1 })
    await store.set(changeDir(), 'max_rounds', '3')
    expect((await go('verify-fail')).body).toMatchObject({ code: 'review-approval-required' })
  })

  test('未用完：回退边照旧（后面的评审确认门接着判）', async () => {
    await toVerifyRound(1)
    await store.set(changeDir(), 'max_rounds', '2')
    expect((await go('verify-fail')).body).toMatchObject({ code: 'review-approval-required' })
  })

  test('用完后前进边不受影响：同样走到评审确认门，而不是 rounds-exhausted', async () => {
    await toVerifyRound(2)
    await store.set(changeDir(), 'max_rounds', '1')
    expect((await go('verify-pass')).body).toMatchObject({ code: 'review-approval-required' })
  })

  test('不受约束的步骤不受影响：build 的 requirements-changed 在上限用完时照常可用', async () => {
    await toVerifyRound(2)
    await store.set(changeDir(), 'max_rounds', '1')
    await backToBuild()
    const result = await go('requirements-changed')
    expect(result.code).toBe(200)
    expect((await store.read(changeDir())).fields.phase).toBe('spec')
  })
})
