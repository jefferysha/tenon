import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createWorkflowRunRepository } from './workflow-run-repository.js'
import { createStateStore } from './store.js'
import { createTransitionRecordStore } from './transition-record-store.js'
import { readCurrentRunRevision } from './run-revision-store.js'
import type { FieldName, InitOptions, PipelineState, StateStore, StateWriteIntent } from '../types.js'
import { compileAutomationPolicySnapshot } from '../loops/automation-policy.js'
import type { LoopEntry } from '../loops/types.js'
import {
  compileEffectiveWorkflowPlan,
  effectiveWorkflowPlanBinding,
} from '../workflow/effective-plan.js'
import { createWorkflowActionAuthoritySnapshot } from './workflow-action-authority-snapshot.js'
import {
  readWorkflowActionAuthorityRecord,
  workflowActionAuthorityRecordPath,
} from './workflow-action-authority-record.js'

const TEST_CREATOR = { id: 'tester@tenon.test', name: 'Tester', trust: 'declared' } as const

const governedPolicy = compileAutomationPolicySnapshot({
  id: 'loop-a', name: 'Loop A', kind: 'executor', goal: 'Keep green', cadence: 'manual', risk: 'low',
  runner: 'codex', change_prefix: 'a-', phases: [], human_gates: [], state: 'legacy', design_doc: 'x',
  status: 'active', budget: { max_runs_per_day: 1, max_in_flight: 1, on_exceed: 'skip-run' },
  kill_criteria: [], autonomy_level: 'L1', allowlist: ['**'], denylist: [], skill_bundle_id: '_all',
} satisfies LoopEntry, { capturedAt: '2026-07-19T00:00:00Z' })

const authoritySnapshot = (over: {
  attemptId?: string
  reservationId?: string
  runId?: string
} = {}) => {
  const workflow = compileEffectiveWorkflowPlan('default')
  const attemptId = over.attemptId ?? 'att-1'
  const iterationId = `iteration-${attemptId}`
  return createWorkflowActionAuthoritySnapshot({
    action: 'enter-afk',
    workflowRunId: over.runId ?? 'id-1',
    workflowId: workflow.id,
    workflowFingerprint: workflow.workflowFingerprint,
    loopId: governedPolicy.loop_id,
    iterationId,
    attemptId,
    reservationId: over.reservationId ?? 'res-1',
    skillBundleId: '_all',
    trackId: 'backend',
    trackRegistryRevision: '0123456789abcdef',
    layers: {
      platform: { status: 'valid', grants: ['enter-afk'] },
      skill: { status: 'valid', grants: ['enter-afk'] },
      project: { status: 'valid', grants: ['enter-afk'] },
      workflow: { status: 'valid', grants: ['enter-afk'] },
      run: { status: 'valid', grants: ['enter-afk'] },
    },
    provenance: {
      platform: { kind: 'platform-policy', identity: 'tenon-afk', revision: 'v1' },
      skill: { kind: 'skill-contract', identity: '_all', revision: workflow.workflowFingerprint },
      project: { kind: 'track-registry', identity: 'backend', revision: '0123456789abcdef' },
      workflow: { kind: 'workflow-plan', identity: workflow.id, revision: workflow.workflowFingerprint },
      run: { kind: 'workflow-run', identity: over.runId ?? 'id-1', revision: iterationId },
    },
  })
}

/** 测试专用：只改 phase，其余 fields 原样带过——commit() 只收 nextFields（不是完整
 * PipelineState，opaqueTail/runMetadata 由 repository 自己处理，调用方结构上传不进去）。 */
function withPhase(state: PipelineState, phase: string): Record<FieldName, string | string[]> {
  return { ...state.fields, phase }
}

const dirs: string[] = []
async function freshRepoRoot(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'pl-run-repo-'))
  dirs.push(d)
  return d
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

let idSeq = 0
function makeRepo(clockValue = '2026-07-16T00:00:00Z') {
  idSeq = 0
  const store = createStateStore()
  const recordStore = createTransitionRecordStore()
  const repo = createWorkflowRunRepository({
    store,
    recordStore,
    clock: () => clockValue,
    newId: () => `id-${++idSeq}`,
  })
  return { repo, store }
}

async function initChange(store: ReturnType<typeof createStateStore>, repoRoot: string, name = 'demo'): Promise<string> {
  const opts: InitOptions = {
    repoRoot, name, track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full',
    clock: () => '2026-07-16T00:00:00Z',
  }
  return store.init(opts)
}

/**
 * 包一层真 StateStore，可控制"下一次 write() 调用抛错"——用于故障注入测试（record 写成功、
 * YAML 写失败、随后重试）。object spread 对 class 实例只拷贝own属性、拷贝不到原型方法，
 * 这里逐个方法显式代理，不是偷懒 {...realStore, write: ...}（那样 read/withLock 等方法会
 * 直接是 undefined）。
 */
function makeFlakyStore(realStore: StateStore): { store: StateStore; failNextWrite: () => void } {
  let shouldFailNext = false
  const store: StateStore = {
    read: (dir) => realStore.read(dir),
    write: async (dir, state, intent?: StateWriteIntent) => {
      if (shouldFailNext) {
        shouldFailNext = false
        throw new Error('模拟 YAML 写入失败（磁盘满/权限/进程被杀等）')
      }
      return realStore.write(dir, state, intent)
    },
    writeUnderLock: async (dir, state, intent?: StateWriteIntent) => {
      if (shouldFailNext) {
        shouldFailNext = false
        throw new Error('模拟 YAML 写入失败（磁盘满/权限/进程被杀等）')
      }
      return realStore.writeUnderLock(dir, state, intent)
    },
    get: (dir, field) => realStore.get(dir, field),
    set: (dir, field, value) => realStore.set(dir, field, value),
    setMany: (dir, kv) => realStore.setMany(dir, kv),
    cas: (dir, field, expect, next) => realStore.cas(dir, field, expect, next),
    casMany: (dir, field, expects, kv) => realStore.casMany(dir, field, expects, kv),
    init: (opts) => realStore.init(opts),
    inspectProjection: (dir) => realStore.inspectProjection(dir),
    repairProjection: (dir, opts) => realStore.repairProjection(dir, opts),
    importLegacyProjection: (dir) => realStore.importLegacyProjection(dir),
    withLock: (dir, fn) => realStore.withLock(dir, fn),
  }
  return { store, failNextWrite: () => { shouldFailNext = true } }
}

describe('WorkflowRunRepository.initChange —— 新 change 的唯一创建入口（W1 第二增量第五轮' +
  'codex review：必须修 #1 的最终形态——身份随 init 的独占创建一次性写入，不是"先 init 再补' +
  '一次 establishRun"两步，消灭两步之间的竞态窗口与"第二步失败被吞掉"问题）', () => {
  test('返回时 changeDir 与 run 身份同时可用，read 立即能看到 fields 与 runMetadata 都已存在' +
    '（不需要额外一次调用才"补齐"身份——这就是消灭两步竞态窗口的直接证明）', async () => {
    const root = await freshRepoRoot()
    const { repo, store } = makeRepo()
    const opts: InitOptions = {
      repoRoot: root, name: 'demo', track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full',
      clock: () => '2026-07-16T00:00:00Z',
    }
    const { changeDir, run } = await repo.initChange(opts)
    expect(run.id).toBe('id-1')
    expect(run.transitionSequence).toBe(0)
    const state = await store.read(changeDir)
    expect(state.fields.track).toBe('backend')
    expect(state.runMetadata).toMatchObject({
      runId: 'id-1',
      transitionSequence: 0,
      documentProfile: 'legacy-full',
      documentGovernanceFingerprint:
        effectiveWorkflowPlanBinding(compileEffectiveWorkflowPlan('default')).documentGovernanceFingerprint,
      workflowPlanFingerprint: compileEffectiveWorkflowPlan('default').workflowFingerprint,
      workflowPlanSnapshot: {
        version: 3,
        workflowId: 'default',
        workflowFingerprint: compileEffectiveWorkflowPlan('default').workflowFingerprint,
      },
    })
    await expect(readFile(join(changeDir, '.pipeline-document-locale.json'), 'utf8'))
      .resolves.toBe('{"version":1,"locale":"zh-CN"}\n')
  })

  test('default init 同时补最小 OpenSpec 文档与 tasks.md 来源；custom workflow 不被注入 default 骨架', async () => {
    const root = await freshRepoRoot()
    const { repo } = makeRepo()
    const base: InitOptions = {
      repoRoot: root, name: 'default-change', track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full',
      clock: () => '2026-07-16T00:00:00Z',
    }
    const created = await repo.initChange(base)
    await expect(readFile(join(created.changeDir, 'proposal.md'), 'utf8')).resolves.toContain('# 提案')
    await expect(readFile(join(created.changeDir, 'design.md'), 'utf8')).resolves.toContain('# 设计')
    await expect(readFile(join(created.changeDir, 'tasks.md'), 'utf8')).resolves.toContain('- [ ]')

    const english = await repo.initChange({ ...base, name: 'english-change', documentLocale: 'en' })
    await expect(readFile(join(english.changeDir, 'proposal.md'), 'utf8')).resolves.toContain('# Proposal')
    await expect(readFile(join(english.changeDir, 'design.md'), 'utf8')).resolves.toContain('# Design')
    await expect(readFile(join(english.changeDir, '.pipeline-document-locale.json'), 'utf8'))
      .resolves.toBe('{"version":1,"locale":"en"}\n')

    const custom = await repo.initChange({
      ...base,
      name: 'custom-change',
      initialWorkflow: { workflow: 'release-train', phase: 'draft' },
    })
    await expect(readFile(join(custom.changeDir, 'tasks.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('store.init 失败（如同名 change 已存在）→ initChange 整体 reject，不会返回一个"半成品"结果', async () => {
    const root = await freshRepoRoot()
    const { repo } = makeRepo()
    const opts: InitOptions = {
      repoRoot: root, name: 'demo', track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full',
      clock: () => '2026-07-16T00:00:00Z',
    }
    await repo.initChange(opts)
    await expect(repo.initChange(opts)).rejects.toThrow() // 同名 change 二次 init，old store.init 的 wx 闸真会拒
  })

  test('initChange 产出的身份立即被 transact() 复用，不会重新生成一个不同的 id' +
    '（证明不存在"init 完成、但 transact 看到的还是旧的无身份状态"这种竞态残留）', async () => {
    const root = await freshRepoRoot()
    const { repo, store } = makeRepo()
    const opts: InitOptions = {
      repoRoot: root, name: 'demo', track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full',
      clock: () => '2026-07-16T00:00:00Z',
    }
    const { changeDir, run } = await repo.initChange(opts)
    await repo.transact(changeDir, async (tx) => {
      expect(tx.run.id).toBe(run.id)
      expect(tx.run.transitionSequence).toBe(0)
    })
    expect(await store.read(changeDir)).toBeDefined()
  })
})

describe('WorkflowRunRepository.establishRun —— 新 change 在 init 时钉死稳定身份（W1 第二增量' +
  '第四轮 codex review 必须修 #1：此前无 metadata 时每次 transact() 都生成新 runId，只有真正' +
  'commit 才持久化，新 change 在第一次 commit 前的身份是不稳定的）', () => {
  test('新 change 调用一次 establishRun() → 立即真落盘 runMetadata（不等第一次 commit）', async () => {
    const root = await freshRepoRoot()
    const { repo, store } = makeRepo()
    const dir = await initChange(store, root)
    const run = await repo.establishRun(dir)
    expect(run.id).toBe('id-1')
    expect(run.transitionSequence).toBe(0)
    expect(run.transitionHead).toBeUndefined()
    const after = await store.read(dir)
    expect(after.runMetadata?.runId).toBe('id-1')
  })

  test('establishRun 之后，即使不 commit，反复 transact() 看到的 run.id 恒定不变' +
    '（这正是修复的核心断言：此前每次都会生成一个新 id）', async () => {
    const root = await freshRepoRoot()
    const { repo, store } = makeRepo()
    const dir = await initChange(store, root)
    await repo.establishRun(dir)
    const idsFromInspection: string[] = []
    for (let i = 0; i < 3; i++) {
      await repo.transact(dir, async (tx) => {
        idsFromInspection.push(tx.run.id)
      })
    }
    expect(idsFromInspection).toEqual(['id-1', 'id-1', 'id-1'])
  })

  test('对已有 runMetadata 的 change 重复调用 establishRun() → 幂等，不重新生成 ID、不重复落盘', async () => {
    const root = await freshRepoRoot()
    const { repo, store } = makeRepo()
    const dir = await initChange(store, root)
    const first = await repo.establishRun(dir)
    const second = await repo.establishRun(dir)
    expect(second.id).toBe(first.id)
    expect(idSeq).toBe(1) // newId() 只被真正调用过一次，第二次 establishRun 没有再生成
  })

  test('establishRun 不影响 fields，只新增 runMetadata（不是一次 transition，不产生 TransitionRecord）', async () => {
    const root = await freshRepoRoot()
    const { repo, store } = makeRepo()
    const dir = await initChange(store, root)
    const before = await store.read(dir)
    await repo.establishRun(dir)
    const after = await store.read(dir)
    expect(after.fields).toEqual(before.fields)
  })

  test('旧 openspecContract boolean 在 establishRun 时恢复 legacy-full 治理绑定', async () => {
    const root = await freshRepoRoot()
    const { repo, store } = makeRepo()
    const dir = await store.init({
      repoRoot: root,
      name: 'legacy-governed',
      track: 'backend',
      reviewSeed: 'pending',
      creator: TEST_CREATOR, preset: 'full',
      clock: () => '2026-07-16T00:00:00Z',
      initialWorkflow: {
        workflow: 'default',
        phase: 'open',
        openspecContract: true,
      },
    })
    expect((await store.read(dir)).runMetadata).toBeUndefined()

    const run = await repo.establishRun(dir, { openspecContract: true })
    const defaultBinding = effectiveWorkflowPlanBinding(compileEffectiveWorkflowPlan('default'))

    expect(run).toMatchObject(defaultBinding)
    expect((await store.read(dir)).runMetadata).toMatchObject(defaultBinding)
  })

  test('已有 run identity 但缺治理绑定时原子补齐，保留 transition 坐标且重复调用幂等', async () => {
    const root = await freshRepoRoot()
    const { repo, store } = makeRepo()
    const dir = await initChange(store, root)
    await repo.establishRun(dir)
    await repo.transact(dir, async (tx) => {
      await tx.commit(withPhase(tx.state, 'explore'), {
        event: 'open-complete', from: 'open', to: 'explore',
      })
    })
    await rm(join(dir, '.pipeline-workflow-governance.json'))
    const binding = effectiveWorkflowPlanBinding(compileEffectiveWorkflowPlan('default'))

    const upgraded = await repo.establishRun(dir, binding)
    expect(upgraded).toMatchObject({
      id: 'id-1',
      transitionSequence: 1,
      transitionHead: 'id-2',
      ...binding,
    })
    expect(await repo.establishRun(dir, binding)).toEqual(upgraded)
    expect(idSeq).toBe(2)
  })

  test('已有治理绑定与请求不一致时拒绝覆盖并保持原值', async () => {
    const root = await freshRepoRoot()
    const { repo, store } = makeRepo()
    const dir = await initChange(store, root)
    await repo.establishRun(dir, {
      documentProfile: 'document-v1',
      documentGovernanceFingerprint: 'a'.repeat(64),
      workflowPlanFingerprint: 'b'.repeat(64),
    })

    await expect(repo.establishRun(dir, {
      documentProfile: 'legacy-full',
      documentGovernanceFingerprint: 'c'.repeat(64),
      workflowPlanFingerprint: 'd'.repeat(64),
    })).rejects.toThrow('拒绝覆盖已有 documentProfile')
    expect((await store.read(dir)).runMetadata).toMatchObject({
      documentProfile: 'document-v1',
      documentGovernanceFingerprint: 'a'.repeat(64),
      workflowPlanFingerprint: 'b'.repeat(64),
    })
  })
})

describe('WorkflowRunRepository.bindAutomationPolicy · H4 immutable policy snapshot', () => {
  test('H9 governed binding atomically exposes policy/loop/iteration identities and transitions preserve them', async () => {
    const root = await freshRepoRoot()
    const { repo, store } = makeRepo()
    const dir = await initChange(store, root)
    const bound = await repo.bindAutomationPolicy(dir, governedPolicy, {
      loopId: governedPolicy.loop_id, iterationId: 'iteration-att-1',
    })
    expect(bound).toMatchObject({
      policyId: governedPolicy.policy_id, policyVersion: governedPolicy.policy_version,
      loopId: governedPolicy.loop_id, iterationId: 'iteration-att-1',
    })
    await repo.transact(dir, async (tx) => {
      expect(tx.run).toMatchObject({ loopId: governedPolicy.loop_id, iterationId: 'iteration-att-1' })
      const committed = await tx.commit(withPhase(tx.state, 'explore'), {
        event: 'open-complete', from: 'open', to: 'explore',
      })
      expect(committed.run).toMatchObject({ loopId: governedPolicy.loop_id, iterationId: 'iteration-att-1' })
      expect(committed.record).toMatchObject({
        policyId: governedPolicy.policy_id,
        policyVersion: governedPolicy.policy_version,
        loopId: governedPolicy.loop_id,
        iterationId: 'iteration-att-1',
      })
    })
    expect((await store.read(dir)).runMetadata).toMatchObject({
      loopId: governedPolicy.loop_id, iterationId: 'iteration-att-1',
    })
  })

  test('H9 同一 WorkflowRun 可进入下一 iteration，且各 transition audit 保留提交当时身份', async () => {
    const root = await freshRepoRoot()
    const { repo, store } = makeRepo()
    const dir = await initChange(store, root)
    await repo.bindAutomationPolicy(dir, governedPolicy, { loopId: governedPolicy.loop_id, iterationId: 'iteration-1' })
    let firstRecord: Awaited<ReturnType<Parameters<Parameters<typeof repo.transact>[1]>[0]['commit']>>['record'] | undefined
    await repo.transact(dir, async (tx) => {
      firstRecord = (await tx.commit(withPhase(tx.state, 'explore'), {
        event: 'open-complete', from: 'open', to: 'explore',
      })).record
    })
    await expect(repo.bindAutomationPolicy(dir, governedPolicy, {
      loopId: governedPolicy.loop_id, iterationId: 'iteration-2',
    })).resolves.toMatchObject({ iterationId: 'iteration-2' })
    await repo.transact(dir, async (tx) => {
      const secondRecord = (await tx.commit(withPhase(tx.state, 'spec'), {
        event: 'explore-complete', from: 'explore', to: 'spec',
      })).record
      expect(secondRecord.iterationId).toBe('iteration-2')
    })
    expect(firstRecord).toMatchObject({ iterationId: 'iteration-1' })
  })

  test('bind writes the complete snapshot and every later run/transition still carries it', async () => {
    const root = await freshRepoRoot()
    const { repo, store } = makeRepo()
    const dir = await initChange(store, root)
    const bound = await repo.bindAutomationPolicy(dir, governedPolicy)
    expect(bound.automationPolicy).toEqual(governedPolicy)
    await repo.transact(dir, async (tx) => {
      expect(tx.run.automationPolicy).toEqual(governedPolicy)
      const committed = await tx.commit(withPhase(tx.state, 'explore'), {
        event: 'open-complete', from: 'open', to: 'explore',
      })
      expect(committed.run.automationPolicy).toEqual(governedPolicy)
    })
    expect((await store.read(dir)).runMetadata?.automationPolicy).toEqual(governedPolicy)
  })

  test('same version is idempotent; a different policy cannot replace the run snapshot', async () => {
    const root = await freshRepoRoot()
    const { repo, store } = makeRepo()
    const dir = await initChange(store, root)
    await repo.bindAutomationPolicy(dir, governedPolicy)
    await expect(repo.bindAutomationPolicy(dir, governedPolicy)).resolves.toMatchObject({ id: 'id-1' })
    const changed = { ...governedPolicy, policy_version: 'f'.repeat(64) }
    await expect(repo.bindAutomationPolicy(dir, changed)).rejects.toThrow(/immutable/)
  })

  test('same content version with a later capture timestamp is a no-write replay; the first exact snapshot stays immutable', async () => {
    const root = await freshRepoRoot()
    const { repo, store } = makeRepo()
    const dir = await initChange(store, root)
    await repo.bindAutomationPolicy(dir, governedPolicy)
    const replay = { ...governedPolicy, captured_at: '2026-07-19T01:00:00Z' }

    const rebound = await repo.bindAutomationPolicy(dir, replay)

    expect(rebound.automationPolicy).toEqual(governedPolicy)
    expect((await store.read(dir)).runMetadata?.automationPolicy).toEqual(governedPolicy)
  })

  test('a forged same-version replay is rejected instead of being mistaken for idempotence', async () => {
    const root = await freshRepoRoot()
    const { repo, store } = makeRepo()
    const dir = await initChange(store, root)
    await repo.bindAutomationPolicy(dir, governedPolicy)
    const forged = { ...governedPolicy, goal: 'replace the bound goal without changing its digest' }

    await expect(repo.bindAutomationPolicy(dir, forged)).rejects.toThrow(/content digest mismatch/)
    expect((await store.read(dir)).runMetadata?.automationPolicy).toEqual(governedPolicy)
  })
})

describe('WorkflowRunRepository.bindWorkflowActionAuthority · immutable per-attempt audit binding', () => {
  test('legacy run with no sidecar remains readable; exact bind is durable, visible, and idempotent', async () => {
    const root = await freshRepoRoot()
    const { repo, store } = makeRepo()
    const dir = await initChange(store, root)
    await repo.establishRun(dir)
    await repo.bindAutomationPolicy(dir, governedPolicy, {
      loopId: governedPolicy.loop_id,
      iterationId: 'iteration-att-1',
    })
    await repo.transact(dir, async (tx) => {
      expect(tx.run.workflowActionAuthority).toBeUndefined()
    })

    const metadataBefore = (await store.read(dir)).runMetadata
    const snapshot = authoritySnapshot()
    const first = await repo.bindWorkflowActionAuthority(dir, snapshot)
    const rebound = await repo.bindWorkflowActionAuthority(dir, snapshot)

    expect(first.workflowActionAuthority).toEqual(snapshot)
    expect(rebound.workflowActionAuthority).toEqual(snapshot)
    const metadataAfter = (await store.read(dir)).runMetadata
    expect(metadataAfter).toEqual(metadataBefore)
    expect(metadataAfter).not.toHaveProperty('workflowActionAuthority')
    await repo.transact(dir, async (tx) => {
      expect(tx.run.workflowActionAuthority).toEqual(snapshot)
      const committed = await tx.commit(withPhase(tx.state, 'explore'), {
        event: 'open-complete', from: 'open', to: 'explore',
      })
      expect(committed.run.workflowActionAuthority).toEqual(snapshot)
    })
  })

  test('rejects identity mismatch, conflicting valid rebind, and tampered durable bytes', async () => {
    const root = await freshRepoRoot()
    const { repo, store } = makeRepo()
    const dir = await initChange(store, root)
    await repo.establishRun(dir)
    await repo.bindAutomationPolicy(dir, governedPolicy, {
      loopId: governedPolicy.loop_id,
      iterationId: 'iteration-att-1',
    })

    await expect(repo.bindWorkflowActionAuthority(dir, authoritySnapshot({ runId: 'other-run' })))
      .rejects.toThrow(/run/i)
    const snapshot = authoritySnapshot()
    await repo.bindWorkflowActionAuthority(dir, snapshot)
    await expect(repo.bindWorkflowActionAuthority(dir, authoritySnapshot({ reservationId: 'res-2' })))
      .rejects.toThrow(/immutable|different|不同/i)

    const path = workflowActionAuthorityRecordPath(dir, snapshot.iteration_id)
    await writeFile(path, JSON.stringify({ ...snapshot, reservation_id: 'forged' }))
    await expect(repo.bindWorkflowActionAuthority(dir, snapshot)).rejects.toThrow(/fingerprint|digest/i)
  })

  test('advancing to a later attempt retains the prior immutable audit record', async () => {
    const root = await freshRepoRoot()
    const { repo, store } = makeRepo()
    const dir = await initChange(store, root)
    await repo.establishRun(dir)
    await repo.bindAutomationPolicy(dir, governedPolicy, {
      loopId: governedPolicy.loop_id,
      iterationId: 'iteration-att-1',
    })
    const first = authoritySnapshot()
    await repo.bindWorkflowActionAuthority(dir, first)

    await repo.bindAutomationPolicy(dir, governedPolicy, {
      loopId: governedPolicy.loop_id,
      iterationId: 'iteration-att-2',
    })
    const second = authoritySnapshot({ attemptId: 'att-2', reservationId: 'res-2' })
    const rebound = await repo.bindWorkflowActionAuthority(dir, second)

    expect(rebound.workflowActionAuthority).toEqual(second)
    expect(await readWorkflowActionAuthorityRecord(dir, first.iteration_id)).toEqual(first)
    expect(await readWorkflowActionAuthorityRecord(dir, second.iteration_id)).toEqual(second)
  })
})

describe('WorkflowRunRepository.transact —— 老 change 首次提交时生成 run 身份', () => {
  test('缺 runMetadata 的老 change → transact 内生成新 runId，不用 change 名/路径冒充', async () => {
    const root = await freshRepoRoot()
    const { repo, store } = makeRepo()
    const dir = await initChange(store, root)
    const result = await repo.transact(dir, async (tx) => {
      expect(tx.run.id).toBe('id-1') // 首次生成
      expect(tx.run.transitionSequence).toBe(0)
      expect(tx.run.transitionHead).toBeUndefined()
      return 'no-commit'
    })
    expect(result).toBe('no-commit')
  })

  test('transaction 内不调用 commit() → state 与 metadata 都不落盘改动（提交是显式动作，不是自动发生）', async () => {
    const root = await freshRepoRoot()
    const { repo, store } = makeRepo()
    const dir = await initChange(store, root)
    await repo.transact(dir, async () => 'skip')
    const after = await store.read(dir)
    expect(after.runMetadata).toBeUndefined() // 没 commit，没有任何东西被生成或落盘
  })
})

describe('WorkflowRunRepository.transact —— commit() 真提交', () => {
  test('第一次 commit：state 真落盘、runMetadata 真生成（sequence=1，head=新记录 id）', async () => {
    const root = await freshRepoRoot()
    const { repo, store } = makeRepo()
    const dir = await initChange(store, root)
    let committedRecordId = ''
    await repo.transact(dir, async (tx) => {
      const { run, record } = await tx.commit(withPhase(tx.state, 'explore'), { event: 'open-complete', from: 'open', to: 'explore' })
      committedRecordId = record.id
      expect(run.currentStep).toBe('explore')
      expect(run.transitionSequence).toBe(1)
      expect(run.transitionHead).toBe(record.id)
      expect(record.sequence).toBe(1)
      expect(record.previousRecordId).toBeUndefined()
      expect(record.effects).toContainEqual({ kind: 'state-field-change', field: 'phase', from: 'open', to: 'explore' })
    })
    const after = await store.read(dir)
    expect(after.fields.phase).toBe('explore')
    expect(after.runMetadata?.transitionSequence).toBe(1)
    expect(after.runMetadata?.transitionHead).toBeDefined()
    const current = await readCurrentRunRevision(dir)
    expect(current?.mutation).toMatchObject({
      kind: 'transition',
      transitionRecordId: committedRecordId,
    })
    expect(current?.state.runMetadata?.transitionHead).toBe(committedRecordId)
  })

  test('commit 保留初始化时绑定的 document profile 与 fingerprint', async () => {
    const root = await freshRepoRoot()
    const { repo, store } = makeRepo()
    const fingerprint = 'c'.repeat(64)
    const { changeDir } = await repo.initChange({
      repoRoot: root,
      name: 'bound-docs',
      track: 'backend',
      reviewSeed: 'pending',
      creator: TEST_CREATOR, preset: 'full',
      clock: () => '2026-07-16T00:00:00Z',
      initialWorkflow: {
        workflow: 'compact',
        phase: 'shape',
        documentProfile: 'document-v1',
        documentGovernanceFingerprint: fingerprint,
      },
    })
    await repo.transact(changeDir, async (tx) => {
      await tx.commit(withPhase(tx.state, 'done'), { event: 'complete', from: 'shape', to: 'done' })
    })

    expect((await store.read(changeDir)).runMetadata).toMatchObject({
      documentProfile: 'document-v1',
      documentGovernanceFingerprint: fingerprint,
    })
  })

  test('commit 保留初始化时绑定的完整 workflow plan fingerprint', async () => {
    const root = await freshRepoRoot()
    const { repo, store } = makeRepo()
    const plan = compileEffectiveWorkflowPlan('default')
    const { changeDir } = await repo.initChange({
      repoRoot: root,
      name: 'bound-plan',
      track: 'backend',
      reviewSeed: 'pending',
      creator: TEST_CREATOR, preset: 'full',
      clock: () => '2026-07-16T00:00:00Z',
      initialWorkflow: {
        workflow: 'default',
        phase: 'open',
        ...effectiveWorkflowPlanBinding(plan),
      },
    })
    await repo.transact(changeDir, async (tx) => {
      await tx.commit(withPhase(tx.state, 'explore'), {
        event: 'open-complete',
        from: 'open',
        to: 'explore',
      })
    })

    expect((await store.read(changeDir)).runMetadata?.workflowPlanFingerprint)
      .toBe(plan.workflowFingerprint)
    expect((await store.read(changeDir)).runMetadata?.workflowPlanSnapshot)
      .toMatchObject({
        version: 3,
        workflowId: 'default',
        workflowFingerprint: plan.workflowFingerprint,
      })
  })

  test('第二次 commit：sequence 从已存在的 metadata 继续递增，previousRecordId 指向上一条 head', async () => {
    const root = await freshRepoRoot()
    const { repo, store } = makeRepo()
    const dir = await initChange(store, root)
    let firstHead = ''
    await repo.transact(dir, async (tx) => {
      const { record } = await tx.commit(withPhase(tx.state, 'explore'), { event: 'open-complete', from: 'open', to: 'explore' })
      firstHead = record.id
    })
    await repo.transact(dir, async (tx) => {
      expect(tx.run.transitionSequence).toBe(1) // 复用已生成的身份，不重新生成
      const { record } = await tx.commit(withPhase(tx.state, 'spec'), { event: 'explore-complete', from: 'explore', to: 'spec' })
      expect(record.sequence).toBe(2)
      expect(record.previousRecordId).toBe(firstHead)
    })
  })

  test('同一 transaction 内调用 commit() 两次 → 第二次抛错（禁止双重提交）', async () => {
    const root = await freshRepoRoot()
    const { repo, store } = makeRepo()
    const dir = await initChange(store, root)
    await expect(
      repo.transact(dir, async (tx) => {
        await tx.commit(withPhase(tx.state, 'explore'), { event: 'open-complete', from: 'open', to: 'explore' })
        await tx.commit(withPhase(tx.state, 'spec'), { event: 'explore-complete', from: 'explore', to: 'spec' })
      }),
    ).rejects.toThrow()
  })

  test('effects 只包含真实改动的字段，phase 之外没改的字段不出现', async () => {
    const root = await freshRepoRoot()
    const { repo, store } = makeRepo()
    const dir = await initChange(store, root)
    await repo.transact(dir, async (tx) => {
      const { record } = await tx.commit(withPhase(tx.state, 'explore'), { event: 'open-complete', from: 'open', to: 'explore' })
      expect(record.effects).toHaveLength(1)
    })
  })

  test('调用方原地修改 tx.state.fields 不会污染 commit() 内部用于 diff 的"改动前"快照' +
    '（W1 第二增量第三轮 codex review 抓到的真实风险：state 与内部快照共享引用会让 effects 变空/不完整）', async () => {
    const root = await freshRepoRoot()
    const { repo, store } = makeRepo()
    const dir = await initChange(store, root)
    await repo.transact(dir, async (tx) => {
      // 恶意/粗心调用方：直接原地改 tx.state.fields，而不是像 withPhase 那样 spread 出新对象。
      // eslint 风格的"不要修改参数"规则在真实业务代码里未必总被遵守，repository 必须自己防御。
      tx.state.fields.phase = 'explore'
      const { record } = await tx.commit(tx.state.fields, { event: 'open-complete', from: 'open', to: 'explore' })
      // 即便调用方原地改了 tx.state.fields，repository 内部持有的 beforeFields 快照应该还是
      // "改之前"的样子——effects 必须依然精确捕捉到 phase 这一条改动，不是空数组也不是全字段。
      expect(record.effects).toEqual([{ kind: 'state-field-change', field: 'phase', from: 'open', to: 'explore' }])
    })
  })

  test('调用方原地修改 tx.state.runMetadata 不会污染 commit() 用来算 sequence/previousRecordId' +
    '的内部快照（W1 第二增量第五轮 codex review 抓到：早期实现里 tx.state.runMetadata 与内部' +
    'metadata 变量是同一个对象引用，tx.state.runMetadata!.transitionSequence=99 这种原地改会' +
    '直接污染 commit() 的计算）', async () => {
    const root = await freshRepoRoot()
    const { repo, store } = makeRepo()
    const dir = await initChange(store, root)
    // 先真提交一次，让 change 有一份持久化的 runMetadata（触发"metadata 取自 state.runMetadata"
    // 这条路径——新 change 首次 transact 走的是"现生成"分支，不会复现这个 bug，必须是已有
    // runMetadata 的 change）。
    await repo.transact(dir, async (tx) => {
      await tx.commit(withPhase(tx.state, 'explore'), { event: 'open-complete', from: 'open', to: 'explore' })
    })
    await repo.transact(dir, async (tx) => {
      expect(tx.state.runMetadata?.transitionSequence).toBe(1) // 确认这次真的带着已有 metadata 进来
      // 恶意/粗心调用方：原地篡改暴露出来的 runMetadata，企图让下一条记录的 sequence/
      // previousRecordId 算错。
      tx.state.runMetadata!.transitionSequence = 99
      tx.state.runMetadata!.transitionHead = 'poisoned-head'
      const { record } = await tx.commit(withPhase(tx.state, 'spec'), { event: 'explore-complete', from: 'explore', to: 'spec' })
      // sequence 必须还是基于真实的旧值（1）递增到 2，不是被污染成 100；previousRecordId 必须
      // 指向真实的上一条记录 id，不是 'poisoned-head'。
      expect(record.sequence).toBe(2)
      expect(record.previousRecordId).not.toBe('poisoned-head')
    })
  })

  test('workflowId 诚实回显 resolveWorkflowName（空值 → default）', async () => {
    const root = await freshRepoRoot()
    const { repo, store } = makeRepo()
    const dir = await initChange(store, root)
    await repo.transact(dir, async (tx) => {
      expect(tx.run.workflowId).toBe('default')
    })
  })

  test('lifecycle 只诚实表达 archived===\'true\'，其余状态一律 active', async () => {
    const root = await freshRepoRoot()
    const { repo, store } = makeRepo()
    const dir = await initChange(store, root)
    await repo.transact(dir, async (tx) => {
      expect(tx.run.lifecycle).toBe('active')
    })
  })
})

describe('WorkflowRunRepository.transact —— 并发安全（同一 change 严格串行，复用 withLock）', () => {
  test('两个并发 transact 调用不交错：第二个必须等第一个的 callback 完全返回才开始', async () => {
    const root = await freshRepoRoot()
    const { repo, store } = makeRepo()
    const dir = await initChange(store, root)
    const order: string[] = []
    let releaseFirst: () => void = () => {}
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve })

    const p1 = repo.transact(dir, async (tx) => {
      order.push('first-start')
      await tx.commit(withPhase(tx.state, 'explore'), { event: 'open-complete', from: 'open', to: 'explore' })
      await firstBlocked // 卡住，直到测试主动放行
      order.push('first-end')
    })
    // 给第一个 transact 时间真正进入并卡住
    await new Promise((r) => setTimeout(r, 20))
    const p2 = repo.transact(dir, async (tx) => {
      order.push('second-start')
      expect(tx.run.transitionSequence).toBe(1) // 必须已经看到第一个的提交结果
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(order).toEqual(['first-start']) // 第二个此时还没能进入（被锁挡住）
    releaseFirst()
    await Promise.all([p1, p2])
    expect(order).toEqual(['first-start', 'first-end', 'second-start'])
  })
})

describe('WorkflowRunRepository —— 故障注入：record 写成功、YAML 写失败、随后重试' +
  '（W1 第二增量第四轮 codex review 必须修 #3：手工构造孤儿只证明了 readChain 不枚举目录，' +
  '没有证明 repository 真实的失败恢复行为）', () => {
  test('YAML write 失败 → transact() 整体 reject，state 未改动，失败尝试产生的 record 是' +
    '孤儿；重试基于正确的旧状态继续，不会断链、不会把孤儿记录接进链里', async () => {
    const root = await freshRepoRoot()
    const realStore = createStateStore()
    const { store: flakyStore, failNextWrite } = makeFlakyStore(realStore)
    idSeq = 0
    const repo = createWorkflowRunRepository({
      store: flakyStore, recordStore: createTransitionRecordStore(),
      clock: () => '2026-07-16T00:00:00Z', newId: () => `id-${++idSeq}`,
    })
    const dir = await initChange(realStore, root)

    // 第一次尝试：record 会真写成功，但紧接着的 YAML write 被注入失败
    failNextWrite()
    await expect(
      repo.transact(dir, async (tx) => {
        await tx.commit(withPhase(tx.state, 'explore'), { event: 'open-complete', from: 'open', to: 'explore' })
      }),
    ).rejects.toThrow('模拟 YAML 写入失败')

    // 验证：YAML 真的没有被改动——runMetadata 仍然缺失（第一次尝试从未真正提交）
    const afterFailedAttempt = await realStore.read(dir)
    expect(afterFailedAttempt.runMetadata).toBeUndefined()
    expect(afterFailedAttempt.fields.phase).toBe('open') // state 也没被污染

    // 重试：这次 write 不再被注入失败，应该正常成功。因为第一次尝试从未提交，这次应该表现得
    // 就像"第一次真正的转换"——sequence=1，previousRecordId 为 undefined（不是指向那条孤儿记录）
    let committedRecordId = ''
    await repo.transact(dir, async (tx) => {
      expect(tx.run.transitionSequence).toBe(0) // 没有被失败的尝试污染
      expect(tx.run.transitionHead).toBeUndefined()
      const { record } = await tx.commit(withPhase(tx.state, 'explore'), { event: 'open-complete', from: 'open', to: 'explore' })
      expect(record.sequence).toBe(1)
      expect(record.previousRecordId).toBeUndefined()
      committedRecordId = record.id
    })

    // 最终真相：state 与 canonical head 一致指向重试成功的那条记录
    const final = await realStore.read(dir)
    expect(final.fields.phase).toBe('explore')
    expect(final.runMetadata?.transitionHead).toBe(committedRecordId)
    expect(final.runMetadata?.transitionSequence).toBe(1)
  })
})
