/**
 * 真实 e2e —— server 侧并发 transition 尾部写入严格串行（W1 第二增量必须修 #3：此前只有
 * CLI 层的并发覆盖，server/跨入口路径完全没有等价证据）。
 *
 * 直接调用 performTransition（不经 HTTP 层）：既是 server 真实使用的同一个函数（HTTP handler
 * 只是在它外面包一层鉴权+JSON序列化，见 server.ts），又能在不新增生产测试专用旗标的前提下
 * 注入一个可控（阻塞）的 breadcrumb writer——跟 CLI 侧 transition-concurrency.integration.test.ts
 * 复现的是同一类真实缺陷：breadcrumb/history/marker 曾经在锁外写，第一次转换的尾部被拖慢时，
 * 第二次转换可能在锁内抢先完成、随后姗姗来迟的第一次尾部写入用旧相位覆盖掉最新状态。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  createBreadcrumbWriter, createTransitionRecordStore, createWorkflowRunRepository,
  reviewGateBindingForState, writeReviewGateBindingUnderLock,
} from '@tenon/kernel'
import type { BreadcrumbWriter } from '@tenon/kernel'
import { performTransition, type TransitionDeps } from './transition.js'
import {
  initChange,
  makeProject,
  newStore,
  recordWorkflowPhaseSkill,
  seedGovernedDocumentEvidence,
  testFlow,
} from './test-support.js'

describe('真实 e2e —— server 并发 transition 尾部写入严格串行（不逆序覆盖）', () => {
  test('第一次 transition 的 breadcrumb 写入被阻塞期间，第二次 transition（同一 change）无法' +
    '抢先完成；释放阻塞后两次严格按序结算，最终 state/breadcrumb 都反映最新相位', async () => {
    const store = newStore()
    const root = await makeProject()
    const name = 'demo'
    await mkdir(join(root, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(root, '.pipeline', 'workflows', 'serial.yaml'), `name: serial
document_contract:
  version: v1
  slots:
    - kind: proposal
      owner_step: one
      producers: [openspec-propose]
  reads:
    - step: two
      kinds: [proposal]
steps:
  - id: one
    label: One
    gate: null
    skills:
      - id: openspec-propose
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: one-complete
        to: two
  - id: two
    label: Two
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: two-complete
        to: one
`, 'utf8')
    const initializedChangeDir = await initChange(store, root, name, {
      track: 'simple',
      initialWorkflow: { workflow: 'serial', phase: 'one', openspecContract: false },
    })
    const changeDir = join(root, 'openspec', 'changes', name)
    await seedGovernedDocumentEvidence(root, initializedChangeDir, name)
    // Use a non-review custom workflow so the lock-tail assertion does not need to
    // write an approval receipt while the first transition still owns the Change lock.
    await recordWorkflowPhaseSkill(root, changeDir, 'openspec-propose')

    const realBreadcrumb = createBreadcrumbWriter()
    let releaseFirst: () => void = () => {}
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve })
    let markFirstEntered: () => void = () => {}
    const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve })
    const order: string[] = []
    let firstBreadcrumbSeen = false
    const breadcrumb: BreadcrumbWriter = {
      write: async (dir, content) => {
        if (!firstBreadcrumbSeen) {
          firstBreadcrumbSeen = true
          order.push('first-breadcrumb-blocked')
          markFirstEntered()
          await firstBlocked
        }
        order.push(`breadcrumb:${content.trim()}`)
        await realBreadcrumb.write(dir, content)
      },
    }

    const deps: TransitionDeps = {
      store,
      runRepo: createWorkflowRunRepository({ store, recordStore: createTransitionRecordStore(), clock: () => '2026-07-16T00:00:00Z' }),
      flow: testFlow(),
      clock: () => '2026-07-16T00:00:00Z',
      breadcrumb,
    }

    const p1 = performTransition(deps, root, name, 'one-complete')
    await firstEntered
    expect(order).toEqual(['first-breadcrumb-blocked']) // 确认真的卡住了
    const p2 = performTransition(deps, root, name, 'two-complete')
    await new Promise((r) => setTimeout(r, 30))
    expect(order).toEqual(['first-breadcrumb-blocked']) // p2 仍未进入（被锁挡住，不是碰巧慢）

    releaseFirst()
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.code).toBe(200)
    expect(r2.code).toBe(200)
    expect(order).toEqual([
      'first-breadcrumb-blocked',
      'breadcrumb:pipeline:demo phase=two',
      'breadcrumb:pipeline:demo phase=one',
    ])

    const finalState = await store.read(changeDir)
    expect(finalState.fields.phase).toBe('one')
    expect(await readFile(join(changeDir, '.breadcrumb'), 'utf8')).toContain('phase=one')
  })

  test('server 生产 TaskPlan callback 不用未完成 Verify tasks 阻断 verify-fail 回退', async () => {
    const store = newStore()
    const root = await makeProject()
    const name = 'rollback'
    const changeDir = await initChange(store, root, name)
    await seedGovernedDocumentEvidence(root, changeDir, name)
    await writeFile(join(changeDir, 'tasks.md'), '# Tasks\n\n## Verify\n\n- [ ] Investigate failure\n', 'utf8')
    await store.setMany(changeDir, {
      phase: 'verify',
      build_sha: 'FROZEN',
      review_gate_phase: 'verify',
      review_gate_status: 'approved',
      review_gate_event: 'verify-fail',
      review_requested_at: '2026-07-16T00:00:00Z',
      review_acknowledged_at: '2026-07-16T00:00:00Z',
    })
    const approvedState = await store.read(changeDir)
    await writeReviewGateBindingUnderLock(
      changeDir,
      reviewGateBindingForState(approvedState, 'verify', 'verify-fail', '2026-07-16T00:00:00Z'),
    )
    await recordWorkflowPhaseSkill(root, changeDir)
    const deps: TransitionDeps = {
      store,
      runRepo: createWorkflowRunRepository({
        store, recordStore: createTransitionRecordStore(), clock: () => '2026-07-16T00:00:00Z',
      }),
      flow: testFlow(),
      clock: () => '2026-07-16T00:00:00Z',
    }

    await store.set(changeDir, 'build_sha', 'CHANGED_AFTER_APPROVAL')
    const mismatched = await performTransition(deps, root, name, 'verify-fail')
    expect(mismatched).toMatchObject({
      code: 409,
      body: { ok: false, code: 'review-approval-required' },
    })
    expect((await store.read(changeDir)).fields.phase).toBe('verify')

    const reboundState = await store.read(changeDir)
    await writeReviewGateBindingUnderLock(
      changeDir,
      reviewGateBindingForState(reboundState, 'verify', 'verify-fail', '2026-07-16T00:00:00Z'),
    )

    const result = await performTransition(deps, root, name, 'verify-fail')

    expect(result).toMatchObject({ code: 200, body: { ok: true, from: 'verify', to: 'build' } })
    expect((await store.read(changeDir)).fields.phase).toBe('build')
  })

  test('server 生产 TaskPlan callback 拒绝非法 UTF-8 tasks 且零提交', async () => {
    const store = newStore()
    const root = await makeProject()
    const name = 'invalid-utf8'
    const changeDir = await initChange(store, root, name)
    await seedGovernedDocumentEvidence(root, changeDir, name)
    await writeFile(join(changeDir, 'tasks.md'), Buffer.from([0xc3, 0x28]))
    await store.setMany(changeDir, {
      phase: 'build',
      build_mode: 'direct',
      direct_override: 'true',
      isolation: 'worktree',
      pre_verify_review_result: 'pass',
    })
    await recordWorkflowPhaseSkill(root, changeDir)
    const deps: TransitionDeps = {
      store,
      runRepo: createWorkflowRunRepository({
        store, recordStore: createTransitionRecordStore(), clock: () => '2026-07-16T00:00:00Z',
      }),
      flow: testFlow(),
      clock: () => '2026-07-16T00:00:00Z',
    }

    const result = await performTransition(deps, root, name, 'build-complete')

    expect(result).toMatchObject({
      code: 409,
      body: { ok: false, error: 'build 出口：tasks.md 不可信或超出预算' },
    })
    expect((await store.read(changeDir)).fields.phase).toBe('build')
  })
})
