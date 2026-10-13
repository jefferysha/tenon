/**
 * 观察模式（没有旧文档契约的新任务）下的 `tenon document` 命令与 step.documents 投影：
 * 在临时 git 项目里用真实的任务目录、状态存储与步骤产出账本，不 mock kernel。
 */
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  compileEffectiveWorkflowPlan, createStateStore, createTransitionRecordStore, createWorkflowRunRepository,
  effectiveWorkflowPlanBinding, publishRunRevision, readCurrentRunRevision, readStepOutputs, recordStepExit,
  stepOutputsContextFor, STEP_OUTPUT_LEDGER_FILE, unreadInputs, workflowPlanSnapshot,
  type EffectiveWorkflowPlan, type TransitionRecord,
} from '@tenon/kernel'
import { legacyContractDefaultPlan } from '@tenon/kernel/workflow/test-support'
import type { CliDeps } from '../deps.js'
import { putFile, runGit } from '../test-git-fixture.js'
import { makeDeps, type TestDeps } from '../test-support.js'
import { cmdCheck } from './check.js'
import { cmdDocumentInit, cmdDocumentMigrateDelta, cmdDocumentRead, cmdDocumentScaffold, cmdDocumentStatus } from './document.js'
import { cmdDocumentRecordCommand } from './document-batch.js'
import { observedRequiredOutputBlockers } from './document-observed.js'
import { cmdReview } from './review.js'
import { observedStepDocuments } from './statusStepParts.js'
import { loadStepBlock } from './step-view.js'

const CLOCK = '2026-10-12T00:00:00.000Z'
const LATER = '2026-10-12T00:10:00.000Z'
const CREATOR = { id: 'tester@tenon.test', name: 'Tester', trust: 'declared' } as const
const CHANGE = 'demo'
const PROPOSAL = `openspec/changes/${CHANGE}/proposal.md`
const SPEC_DOC = 'docs/superpowers/specs/2026-10-12-demo-design.md'
const AUTO_RECORDED = '本任务的产出由 Tenon 在离开步骤时自动记录'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

interface Project {
  readonly root: string
  readonly dir: string
  readonly plan: EffectiveWorkflowPlan
  readonly deps: TestDeps & CliDeps
}

/** 临时 git 项目（`committed` 里的文件随初始提交入库） + 一个已立项的任务（第一次步骤访问的检查点已写）。 */
async function project(
  options: { readonly plan?: EffectiveWorkflowPlan; readonly track?: string; readonly committed?: Readonly<Record<string, string>> } = {},
): Promise<Project> {
  const root = await mkdtemp(join(tmpdir(), 'document-observed-'))
  roots.push(root)
  await putFile(root, 'README.md', '# readme\n')
  for (const [path, content] of Object.entries(options.committed ?? {})) await putFile(root, path, content)
  runGit(root, ['init', '-q', '-b', 'main'])
  runGit(root, ['add', '-A'])
  runGit(root, ['commit', '-q', '-m', 'init'])
  const track = options.track ?? 'backend'
  const plan = options.plan ?? compileEffectiveWorkflowPlan('default', undefined, { track })
  const first = plan.workflow.steps[0]
  if (first === undefined) throw new Error('fixture: 计划没有步骤')
  const store = createStateStore()
  const repo = createWorkflowRunRepository({ store, recordStore: createTransitionRecordStore(), clock: () => CLOCK })
  const { changeDir } = await repo.initChange({
    repoRoot: root, name: CHANGE, track, reviewSeed: 'pending', preset: 'full', creator: CREATOR, clock: () => CLOCK,
    initialWorkflow: {
      workflow: plan.id, phase: first.id, ...effectiveWorkflowPlanBinding(plan), workflowPlanSnapshot: workflowPlanSnapshot(plan),
      ...(plan.capabilities.documents.policy?.id === 'openspec-v1' ? { openspecContract: true } : {}),
    },
  })
  const fingerprint = async () => `workspace:sha256:${'a'.repeat(64)}`
  const deps: TestDeps & CliDeps = Object.assign(makeDeps({ cwd: root, workspaceFingerprint: fingerprint }), {
    store, recordStore: createTransitionRecordStore(), clock: () => LATER,
  })
  return { root, dir: changeDir, plan, deps }
}

async function currentVisit(p: Project) {
  const current = await readCurrentRunRevision(p.dir)
  const phase = current?.state.fields.phase
  if (current?.state.runMetadata === undefined || typeof phase !== 'string') throw new Error('fixture: 缺少 run 身份')
  return { runId: current.state.runMetadata.runId, sequence: current.state.runMetadata.transitionSequence, step: phase }
}

/** 与转换一致的两步：锁内、提交之前 recordStepExit，再真实提交一条转换 revision。 */
async function leave(p: Project, to: string, event = 'next'): Promise<void> {
  const visit = await currentVisit(p)
  await recordStepExit(stepOutputsContextFor(p.dir), { ...visit, event, to, at: LATER })
  const current = await readCurrentRunRevision(p.dir)
  const metadata = current?.state.runMetadata
  if (current === undefined || metadata === undefined) throw new Error('fixture: 缺少 run 身份')
  const sequence = metadata.transitionSequence + 1
  const id = `${event}-${sequence}`
  const record = {
    schemaVersion: 1, id, runId: metadata.runId, sequence, previousRecordId: metadata.transitionHead,
    workflowId: p.plan.id, event, from: visit.step, to, effects: [{ kind: 'state-field-change', field: 'phase', from: visit.step, to }], observedAt: CLOCK,
  } satisfies TransitionRecord
  await createTransitionRecordStore().write(p.dir, record)
  await publishRunRevision(p.dir, current, {
    ...current.state,
    fields: { ...current.state.fields, phase: to },
    runMetadata: { ...metadata, transitionSequence: sequence, transitionHead: id },
  }, { kind: 'transition', transitionRecordId: id, observedAt: CLOCK })
}

/** 立项步写出 proposal.md 后进入调研步：proposal.md 成为调研步的交接输入。 */
async function inExploreWithProposal(p: Project): Promise<void> {
  await putFile(p.root, PROPOSAL, '# Proposal\n目标：观察模式\n')
  await leave(p, 'explore', 'open-complete')
}

async function stateOf(p: Project) {
  return p.deps.store.read(p.dir)
}

/** 终止任务：状态记 task_result=terminated，目录搬进 openspec/changes/archive/（与 `tenon task terminate` 的结果一致）。 */
async function terminateTask(p: Project): Promise<void> {
  const state = await stateOf(p)
  await p.deps.store.withLock(p.dir, () =>
    p.deps.store.writeUnderLock(p.dir, { ...state, fields: { ...state.fields, task_result: 'terminated' } }, { kind: 'set' }))
  await mkdir(join(p.root, 'openspec', 'changes', 'archive'), { recursive: true })
  await rename(p.dir, join(p.root, 'openspec', 'changes', 'archive', `2026-10-12-${CHANGE}`))
}

const documentsOf = async (p: Project) => observedStepDocuments(CHANGE, p.dir, p.plan, await stateOf(p), (await currentVisit(p)).step)

describe('observedStepDocuments —— step.documents 的观察模式形状（设计 §10）', () => {
  test('立项步还没写 proposal.md：必须产出 missing，没有输入也没有产出', async () => {
    const p = await project()
    expect(await documentsOf(p)).toEqual({
      mode: 'observed', observation: 'observed', inputs: [], outputs: [],
      required: [{ path: PROPOSAL, status: 'missing' }], reads: [], records: [], updates: [],
    })
  })

  test('写出 proposal.md 之后实时比较：它是本步新增的产出，必须产出 produced（路径渲染了 {change}）', async () => {
    const p = await project()
    await putFile(p.root, PROPOSAL, '# Proposal\n')
    const documents = await documentsOf(p)
    expect(documents).toMatchObject({
      mode: 'observed',
      outputs: [{ path: PROPOSAL, change: 'added', skill: null }],
      required: [{ path: PROPOSAL, status: 'produced' }],
    })
  })

  test('离开立项步之后：proposal.md 是调研步的交接输入，未读；调研步的必须产出还缺', async () => {
    const p = await project()
    await inExploreWithProposal(p)
    expect(await documentsOf(p)).toMatchObject({
      inputs: [{ path: PROPOSAL, from_step: 'open', skill: null, status: 'unread' }],
      outputs: [],
      required: [{ path: 'docs/superpowers/specs/*.md', status: 'missing' }],
    })
  })

  test('读完之后输入变 read；调研步写出设计文档 → 必须产出 produced', async () => {
    const p = await project()
    await inExploreWithProposal(p)
    expect(await cmdDocumentRead(p.deps, CHANGE, 'all')).toBe(0)
    await putFile(p.root, SPEC_DOC, '# 设计\n')
    expect(await documentsOf(p)).toMatchObject({
      inputs: [{ path: PROPOSAL, status: 'read' }],
      outputs: [{ path: SPEC_DOC, change: 'added' }],
      required: [{ path: 'docs/superpowers/specs/*.md', status: 'produced' }],
    })
  })

  test('项目里早就有的同名模式文件不能满足本步的必须产出', async () => {
    const p = await project({ committed: { 'docs/superpowers/specs/old-design.md': '# 旧设计\n' } })
    await putFile(p.root, PROPOSAL, '# Proposal\n')
    await leave(p, 'explore', 'open-complete')
    expect(await documentsOf(p)).toMatchObject({ required: [{ path: 'docs/superpowers/specs/*.md', status: 'missing' }] })
  })

  test('步骤产出账本损坏：投影降级为不可用的空视图而不是抛，必须产出退化为按存在判定', async () => {
    const p = await project()
    await putFile(p.root, PROPOSAL, '# Proposal\n')
    await writeFile(join(p.dir, STEP_OUTPUT_LEDGER_FILE), '{ not json')
    expect(await documentsOf(p)).toMatchObject({
      mode: 'observed', observation: 'unavailable', inputs: [], outputs: [],
      required: [{ path: PROPOSAL, status: 'produced' }],
    })
  })

  test('账本里没有任何记录（升级前创建、没有账本的任务）：观察不可用，同样不抛', async () => {
    const p = await project()
    await rm(join(p.dir, STEP_OUTPUT_LEDGER_FILE))
    expect(await documentsOf(p)).toMatchObject({ observation: 'unavailable', inputs: [], outputs: [] })
  })
})

describe('tenon document read —— 观察模式写读取回执', () => {
  test('all：当前步骤的交接输入全部标为已读，退出码 0 且不输出', async () => {
    const p = await project()
    await inExploreWithProposal(p)
    expect(await cmdDocumentRead(p.deps, CHANGE, 'all')).toBe(0)
    expect(p.deps.errLines).toEqual([])
    const ctx = stepOutputsContextFor(p.dir)
    expect(unreadInputs(await readStepOutputs(ctx, { live: false }))).toEqual([])
  })

  test('给一个输入路径：只读那一个', async () => {
    const p = await project()
    await putFile(p.root, PROPOSAL, '# Proposal\n')
    await putFile(p.root, SPEC_DOC, '# 设计\n')
    await leave(p, 'explore', 'open-complete')
    expect(await cmdDocumentRead(p.deps, CHANGE, PROPOSAL)).toBe(0)
    const view = await readStepOutputs(stepOutputsContextFor(p.dir), { live: false })
    // 账本里的输入按路径排序（docs/ 在 openspec/ 前）。
    expect(view.inputs.map((input) => [input.path, input.read])).toEqual([[SPEC_DOC, false], [PROPOSAL, true]])
  })

  test('绝对路径指向项目内的输入也行（折成项目相对路径再判定）', async () => {
    const p = await project()
    await inExploreWithProposal(p)
    expect(await cmdDocumentRead(p.deps, CHANGE, join(p.root, PROPOSAL))).toBe(0)
    expect(unreadInputs(await readStepOutputs(stepOutputsContextFor(p.dir), { live: false }))).toEqual([])
  })

  test('不是交接输入的路径被拒：退出码 1，点名路径，回执不变', async () => {
    const p = await project()
    await inExploreWithProposal(p)
    expect(await cmdDocumentRead(p.deps, CHANGE, 'README.md')).toBe(1)
    expect(p.deps.errLines.join('\n')).toContain('README.md')
    expect(p.deps.errLines.join('\n')).toContain('不是本步的交接输入')
    expect(unreadInputs(await readStepOutputs(stepOutputsContextFor(p.dir), { live: false }))).toHaveLength(1)
  })

  test.each(['../outside.md', '../../etc/passwd', '/etc/passwd', 'docs/../../outside.md'])('越出项目的路径 %s 被拒，不碰文件系统', async (path) => {
    const p = await project()
    await inExploreWithProposal(p)
    expect(await cmdDocumentRead(p.deps, CHANGE, path)).toBe(1)
    expect(p.deps.errLines.join('\n')).toContain('不在项目内')
    expect(unreadInputs(await readStepOutputs(stepOutputsContextFor(p.dir), { live: false }))).toHaveLength(1)
  })

  test('没有输入时 all 也是成功的空操作', async () => {
    const p = await project()
    expect(await cmdDocumentRead(p.deps, CHANGE, 'all')).toBe(0)
  })

  test('回执在任务锁内写：锁回调还没返回时账本里就已经有回执', async () => {
    const p = await project()
    await inExploreWithProposal(p)
    const ctx = stepOutputsContextFor(p.dir)
    const store = p.deps.store
    const locked: string[] = []
    // 只替换 withLock；其余方法沿原型链回到真实存储（类实例的方法不在自有属性里，不能用展开复制）。
    const lockSpy = Object.assign(Object.create(store), {
      withLock: async <T,>(dir: string, fn: () => Promise<T>): Promise<T> => {
        locked.push(dir)
        return store.withLock(dir, async () => {
          const value = await fn()
          // fn 返回时仍在锁内：回执必须已经写好，说明写入发生在锁里而不是锁外。
          expect(unreadInputs(await readStepOutputs(ctx, { live: false }))).toEqual([])
          return value
        })
      },
    })
    const observed: CliDeps = { ...p.deps, store: lockSpy }
    expect(await cmdDocumentRead(observed, CHANGE, 'all')).toBe(0)
    expect(locked).toEqual([p.dir])
  })

  test('两个输入被并发读：回执互不覆盖（读-改-写在同一把任务锁里串行）', async () => {
    const p = await project()
    await putFile(p.root, PROPOSAL, '# Proposal\n')
    await putFile(p.root, SPEC_DOC, '# 设计\n')
    await leave(p, 'explore', 'open-complete')
    const codes = await Promise.all([cmdDocumentRead(p.deps, CHANGE, PROPOSAL), cmdDocumentRead(p.deps, CHANGE, SPEC_DOC)])
    expect(codes).toEqual([0, 0])
    expect(unreadInputs(await readStepOutputs(stepOutputsContextFor(p.dir), { live: false }))).toEqual([])
  })

  test('非法任务名 / 不存在的任务：退出码 1', async () => {
    const p = await project()
    expect(await cmdDocumentRead(p.deps, 'bad name!', 'all')).toBe(1)
    expect(await cmdDocumentRead(p.deps, 'nope', 'all')).toBe(1)
  })
})

describe('tenon document status —— 观察模式', () => {
  test('--json：{ change, workflow, mode, observation, inputs, outputs, required }；有未读输入或必须产出缺失 → 退出码 2', async () => {
    const p = await project()
    await inExploreWithProposal(p)
    expect(await cmdDocumentStatus(p.deps, CHANGE, true)).toBe(2)
    expect(JSON.parse(p.deps.outLines[0] ?? 'null')).toEqual({
      change: CHANGE,
      workflow: 'default',
      mode: 'observed',
      observation: 'observed',
      inputs: [{ path: PROPOSAL, from_step: 'open', skill: null, status: 'unread' }],
      outputs: [],
      required: [{ path: 'docs/superpowers/specs/*.md', status: 'missing' }],
    })
  })

  test('读完输入且必须产出齐全 → 退出码 0', async () => {
    const p = await project()
    await inExploreWithProposal(p)
    await cmdDocumentRead(p.deps, CHANGE, 'all')
    await putFile(p.root, SPEC_DOC, '# 设计\n')
    expect(await cmdDocumentStatus(p.deps, CHANGE, true)).toBe(0)
    expect(JSON.parse(p.deps.outLines[0] ?? 'null')).toMatchObject({
      inputs: [{ status: 'read' }], outputs: [{ path: SPEC_DOC, change: 'added' }], required: [{ status: 'produced' }],
    })
  })

  test('只缺必须产出（输入都读完了）也是退出码 2', async () => {
    const p = await project()
    await inExploreWithProposal(p)
    await cmdDocumentRead(p.deps, CHANGE, 'all')
    expect(await cmdDocumentStatus(p.deps, CHANGE, true)).toBe(2)
  })

  test('人读输出：每个输入 / 产出 / 必须产出一行，失败项点名修复办法', async () => {
    const p = await project()
    await inExploreWithProposal(p)
    expect(await cmdDocumentStatus(p.deps, CHANGE, false)).toBe(2)
    const out = p.deps.outLines.join('\n')
    expect(out).toContain('[DOCUMENT] demo (workflow=default, step=explore, observation=observed)')
    expect(out).toContain(`[UNREAD] ${PROPOSAL}`)
    expect(out).toContain('open')
    expect(out).toContain('[MISSING] docs/superpowers/specs/*.md')
    expect(out).toContain('tenon document read demo all')
    expect(out).toContain('[FAIL]')
    expect(out).not.toContain('[PASS]')
  })

  test('人读输出（全部满足）：[PASS]；产出行带变更类型与来源技能（未知）', async () => {
    const p = await project()
    await inExploreWithProposal(p)
    await cmdDocumentRead(p.deps, CHANGE, 'all')
    await putFile(p.root, SPEC_DOC, '# 设计\n')
    expect(await cmdDocumentStatus(p.deps, CHANGE, false)).toBe(0)
    const out = p.deps.outLines.join('\n')
    expect(out).toContain(`[READ] ${PROPOSAL}`)
    expect(out).toContain(`[OUT:added] ${SPEC_DOC} · 未知`)
    expect(out).toContain('[PRODUCED] docs/superpowers/specs/*.md')
    expect(out).toContain('[PASS]')
  })

  test('英文：用户可见文案走英文目录', async () => {
    const p = await project()
    await inExploreWithProposal(p)
    const en: CliDeps = { ...p.deps, locale: 'en' }
    expect(await cmdDocumentStatus(en, CHANGE, false)).toBe(2)
    const out = p.deps.outLines.join('\n')
    expect(out).toContain('from open')
    expect(out).toContain('Unread inputs: 1')
    expect(out).not.toMatch(/[㐀-鿿]/u)
  })
})

describe('旧命令在观察模式被拒：退出码 2，说明产出由 Tenon 自动记录', () => {
  const refused = (p: Project, command: string) => {
    const line = p.deps.errLines.join('\n')
    expect(line).toContain(`ERROR: ${AUTO_RECORDED}`)
    expect(line).toContain(`tenon ${command} 只服务升级前创建的任务`)
  }

  test('document scaffold', async () => {
    const p = await project()
    expect(await cmdDocumentScaffold(p.deps, CHANGE, 'proposal')).toBe(2)
    refused(p, 'document scaffold')
  })

  test('document record <kind> <path> --producer', async () => {
    const p = await project()
    expect(await cmdDocumentRecordCommand(p.deps, CHANGE, 'proposal', PROPOSAL, { producer: 'openspec-propose' })).toBe(2)
    refused(p, 'document record')
  })

  test('document record --all', async () => {
    const p = await project()
    expect(await cmdDocumentRecordCommand(p.deps, CHANGE, undefined, undefined, { all: true })).toBe(2)
    refused(p, 'document record')
  })

  test('document init', async () => {
    const p = await project()
    expect(await cmdDocumentInit(p.deps, CHANGE)).toBe(2)
    refused(p, 'document init')
  })

  test('document migrate-delta', async () => {
    const p = await project()
    expect(await cmdDocumentMigrateDelta(p.deps, CHANGE, 'a.md', 'b.md')).toBe(2)
    refused(p, 'document migrate-delta')
  })

  test('被拒时什么都不写：账本和任务目录不变', async () => {
    const p = await project()
    const before = await readStepOutputs(stepOutputsContextFor(p.dir), { live: false })
    await cmdDocumentScaffold(p.deps, CHANGE, 'proposal')
    await cmdDocumentInit(p.deps, CHANGE)
    expect(await readStepOutputs(stepOutputsContextFor(p.dir), { live: false })).toEqual(before)
  })

  test('英文文案', async () => {
    const p = await project()
    const en: CliDeps = { ...p.deps, locale: 'en' }
    expect(await cmdDocumentScaffold(en, CHANGE, 'proposal')).toBe(2)
    const line = p.deps.errLines.join('\n')
    expect(line).toContain('recorded automatically by Tenon')
    expect(line).toContain('tenon document scaffold')
    expect(line).not.toMatch(/[㐀-鿿]/u)
  })

  test('已终止的任务先按结束任务的口径拒绝（退出码 1，指向新建任务），不是退出码 2', async () => {
    const p = await project()
    await terminateTask(p)
    expect(await cmdDocumentRecordCommand(p.deps, CHANGE, 'proposal', PROPOSAL, { producer: 'tenon-open' })).toBe(1)
    expect(await cmdDocumentRecordCommand(p.deps, CHANGE, undefined, undefined, { all: true })).toBe(1)
    expect(await cmdDocumentScaffold(p.deps, CHANGE, 'proposal')).toBe(1)
    expect(await cmdDocumentInit(p.deps, CHANGE)).toBe(1)
    expect(await cmdDocumentMigrateDelta(p.deps, CHANGE, 'a.md', 'b.md')).toBe(1)
    expect(await cmdDocumentRead(p.deps, CHANGE, 'all')).toBe(1)
    const err = p.deps.errLines.join('\n')
    expect(err).toContain(`任务 '${CHANGE}' 已终止`)
    expect(err).not.toContain(AUTO_RECORDED)
  })

  test('名字不合法或任务不存在时不抢先拒绝：交给命令自己的错误路径（退出码 1）', async () => {
    const p = await project()
    expect(await cmdDocumentScaffold(p.deps, 'bad name!', 'proposal')).toBe(1)
    expect(await cmdDocumentInit(p.deps, 'nope')).toBe(1)
    expect(await cmdDocumentRecordCommand(p.deps, 'bad name!', 'proposal', 'x.md', { producer: 'p' })).toBe(1)
  })
})

describe('契约模式（升级前创建的任务）：命令照旧，不被观察模式的分支接走', () => {
  test('document status 仍是契约证据报告，不带 mode: observed', async () => {
    const p = await project({ plan: legacyContractDefaultPlan('backend') })
    await cmdDocumentStatus(p.deps, CHANGE, true)
    const reported = JSON.parse(p.deps.outLines[0] ?? 'null')
    expect(reported).toMatchObject({ change: CHANGE, governed: true })
    expect(reported).not.toHaveProperty('mode')
  })

  test('document scaffold / init 不被拒绝', async () => {
    const p = await project({ plan: legacyContractDefaultPlan('backend') })
    expect(await cmdDocumentInit(p.deps, CHANGE)).toBe(0)
    expect(await cmdDocumentScaffold(p.deps, CHANGE, 'proposal')).toBe(0)
    expect(p.deps.errLines.join('\n')).not.toContain(AUTO_RECORDED)
  })
})

describe('tenon status 的 step 分块 —— 观察模式', () => {
  test('step.documents 是观察模式形状（输入 / 产出 / 必须产出），未读输入的出口阻断是 document 来源的 input-unread', async () => {
    const p = await project()
    await inExploreWithProposal(p)
    const step = await loadStepBlock(p.deps, CHANGE)
    if ('error' in step) throw new Error(step.error)
    expect(step.id).toBe('explore')
    expect(step.documents).toEqual({
      mode: 'observed', observation: 'observed',
      inputs: [{ path: PROPOSAL, from_step: 'open', skill: null, status: 'unread' }],
      outputs: [],
      required: [{ path: 'docs/superpowers/specs/*.md', status: 'missing' }],
      reads: [], records: [], updates: [],
    })
    const blockers = step.exits.flatMap((exit) => exit.blockers).filter((blocker) => blocker.code === 'input-unread')
    expect(blockers).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'document', code: 'input-unread', subject: PROPOSAL })]))
  })

  test('契约模式的任务仍给 { mode: contract, reads, records, updates }', async () => {
    const p = await project({ plan: legacyContractDefaultPlan('backend') })
    const step = await loadStepBlock(p.deps, CHANGE)
    if ('error' in step) throw new Error(step.error)
    expect(step.documents.mode).toBe('contract')
    expect(Object.keys(step.documents).sort()).toEqual(['mode', 'reads', 'records', 'updates'])
  })

  test('观察模式的 next 从不带契约动作：新任务进来先要加载 tenon，之后没有 scaffold / record / register', async () => {
    const p = await project()
    await inExploreWithProposal(p)
    const step = await loadStepBlock(p.deps, CHANGE)
    if ('error' in step) throw new Error(step.error)
    expect(step.next.map((action) => action.action)).toEqual(['load-tenon'])
    expect(JSON.stringify(step)).not.toMatch(/scaffold-document|record-document|register-field/u)
  })
})

describe('observedRequiredOutputBlockers —— 供 review verify-fail 就绪检查使用', () => {
  test('必须产出还缺：每个缺的模式一条阻断，点名步骤与路径', async () => {
    const p = await project()
    const blockers = await observedRequiredOutputBlockers(p.deps, CHANGE, p.dir, p.plan, await stateOf(p), 'open')
    expect(blockers).toEqual([`step 'open' 要求产出匹配 ${PROPOSAL} 的文件（本任务里这一步还没有写出这样的文件）`])
  })

  test('本步已写出 → 没有阻断', async () => {
    const p = await project()
    await putFile(p.root, PROPOSAL, '# Proposal\n')
    expect(await observedRequiredOutputBlockers(p.deps, CHANGE, p.dir, p.plan, await stateOf(p), 'open')).toEqual([])
  })

  test('本步没有声明必须产出 → 没有阻断', async () => {
    const p = await project()
    expect(await observedRequiredOutputBlockers(p.deps, CHANGE, p.dir, p.plan, await stateOf(p), 'build')).toEqual([])
  })
})

describe('tenon check —— 观察模式把没读完的输入渲染进 document 段', () => {
  const UNREAD_LINE = `  [FAIL] document: 本步输入 ${PROPOSAL}（open 的产出）还没读；读完后执行 tenon document read ${CHANGE} all`

  test('不带 event（离开本步的预览）：未读输入是 document: 阻断', async () => {
    const p = await project()
    await inExploreWithProposal(p)
    expect(await cmdCheck(p.deps, CHANGE)).toBe(2)
    expect(p.deps.outLines).toContain(UNREAD_LINE)
  })

  test('读完之后 document 段不再出现', async () => {
    const p = await project()
    await inExploreWithProposal(p)
    await cmdDocumentRead(p.deps, CHANGE, 'all')
    await cmdCheck(p.deps, CHANGE)
    expect(p.deps.outLines.filter((line) => line.includes('document:'))).toEqual([])
  })

  test('回退边与前进边一样要读完（带 event 的预览）', async () => {
    const p = await project()
    await inExploreWithProposal(p)
    await cmdCheck(p.deps, CHANGE, { event: 'explore-complete' })
    expect(p.deps.outLines).toContain(UNREAD_LINE)
  })

  test('放弃边不查未读输入：任务要被放弃了，读不读输入都不该拦它', async () => {
    const p = await project({ track: 'lite' })
    await putFile(p.root, 'docs/note.md', '# 笔记\n')
    await leave(p, 'build', 'open-complete')
    await cmdCheck(p.deps, CHANGE, { event: 'scope-expanded' })
    expect(p.deps.outLines.filter((line) => line.includes('document:'))).toEqual([])
    p.deps.outLines.length = 0
    await cmdCheck(p.deps, CHANGE)
    expect(p.deps.outLines.filter((line) => line.includes('document:'))).toEqual([
      `  [FAIL] document: 本步输入 docs/note.md（open 的产出）还没读；读完后执行 tenon document read ${CHANGE} all`,
    ])
  })

  test('必须产出缺失由步骤守卫报出（不是 document 段）', async () => {
    const p = await project()
    await cmdCheck(p.deps, CHANGE)
    expect(p.deps.outLines.join('\n')).toContain(`要求产出匹配 ${PROPOSAL} 的文件`)
    expect(p.deps.outLines.join('\n')).not.toContain('{change}')
  })

  test('步骤产出账本损坏：document 段给出修复办法，而不是崩溃或当作没有输入', async () => {
    const p = await project()
    await writeFile(join(p.dir, STEP_OUTPUT_LEDGER_FILE), '{ not json')
    expect(await cmdCheck(p.deps, CHANGE)).toBe(2)
    expect(p.deps.outLines.some((line) => line.startsWith('  [FAIL] document: 步骤产出账本损坏'))).toBe(true)
  })
})

describe('tenon review request —— 观察模式的 verify-fail 就绪检查', () => {
  /** 升级前建的任务按旧阶段清单模型执行；冻结计划没有文档契约，所以文档判定走观察模式。 */
  async function atVerify(): Promise<Project> {
    const p = await project({ plan: compileEffectiveWorkflowPlan('default', undefined, { track: 'backend', executionModel: 'phase-manifest' }) })
    await leave(p, 'verify', 'build-complete')
    return p
  }
  const REPORT = `docs/superpowers/reports/${CHANGE}-verify.md`

  test('验证报告还没写：不读 verification_report 字段，要求本次验证访问写出声明的必须产出（退出码 2）', async () => {
    const p = await atVerify()
    const code = await cmdReview(p.deps, 'request', CHANGE, { event: 'verify-fail' })
    expect(p.deps.errLines).toEqual([])
    expect(code).toBe(2)
    expect(p.deps.outLines).toContain(`[CHECK] ${CHANGE} (phase=verify, event=verify-fail)`)
    expect(p.deps.outLines.join('\n')).toContain(`step 'verify' 要求产出匹配 ${REPORT} 的文件`)
    expect(p.deps.outLines.join('\n')).not.toContain('verification_report')
  })

  test('本次验证访问写出了报告：就绪检查通过', async () => {
    const p = await atVerify()
    await putFile(p.root, REPORT, '# 验证报告\n')
    await cmdReview(p.deps, 'request', CHANGE, { event: 'verify-fail' })
    expect(p.deps.outLines.some((line) => line.startsWith('  [PASS]'))).toBe(true)
    expect(p.deps.outLines.filter((line) => line.includes('[FAIL]'))).toEqual([])
  })
})
