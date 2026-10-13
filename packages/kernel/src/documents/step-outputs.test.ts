import { afterEach, describe, expect, test } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  readStepHandoff,
  readStepOutputs,
  recordInputReads,
  recordStepExit,
  requiredOutputMet,
  requiredOutputSatisfied,
  startStepVisit,
  stepOutputsContextFor,
  unreadInputs,
  type StepOutputsContext,
} from './step-outputs.js'
import { readStepOutputLedger, STEP_OUTPUT_LEDGER_FILE, StepOutputLedgerError } from '../state/step-output-ledger.js'
import { emptyFields } from '../state/parse.js'
import { publishInitialRunRevision, publishRunRevision, readCurrentRunRevision } from '../state/run-revision-store.js'
import { createTransitionRecordStore } from '../state/transition-record-store.js'
import { appendSkillInvocationEvent, SKILL_INVOCATION_LEDGER_FILE, skillInvocationProjectId } from '../skill-invocation/repository.js'
import type { TransitionRecord } from '../workflow/run-types.js'

const AT = '2026-10-12T00:00:00.000Z'
const LATER = '2026-10-12T00:10:00.000Z'
const PLANS = 'docs/superpowers/plans/*.md'
const SPECS = 'docs/superpowers/specs/*.md'
const roots: string[] = []
let eventCounter = 0
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

interface Fixture { readonly root: string; readonly changeDir: string; readonly ctx: StepOutputsContext }

function git(root: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@t.test', '-c', 'user.name=t', ...args], { cwd: root, stdio: 'pipe' })
}

async function write(f: Fixture, path: string, content: string): Promise<void> {
  await mkdir(dirname(join(f.root, path)), { recursive: true })
  await writeFile(join(f.root, path), content)
}

/** 临时项目 + 一个已发布初始 revision（phase=open, sequence=0）的任务；useGit=false 模拟非 git 目录。 */
async function fixture(options: { readonly useGit?: boolean; readonly committed?: Readonly<Record<string, string>> } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'step-outputs-'))
  roots.push(root)
  const changeDir = join(root, 'openspec', 'changes', 'demo')
  const f: Fixture = { root, changeDir, ctx: stepOutputsContextFor(changeDir) }
  await mkdir(changeDir, { recursive: true })
  await write(f, 'README.md', '# readme\n')
  for (const [path, content] of Object.entries(options.committed ?? {})) await write(f, path, content)
  if (options.useGit !== false) {
    git(root, 'init', '-q', '-b', 'main')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'init')
  }
  const fields = emptyFields()
  fields.workflow = 'default'
  fields.phase = 'open'
  await publishInitialRunRevision(changeDir, {
    fields, runMetadata: { runId: 'run-1', transitionSequence: 0, transitionHead: undefined }, opaqueTail: '',
  }, AT)
  return f
}

async function currentVisit(f: Fixture): Promise<{ readonly runId: string; readonly sequence: number; readonly step: string }> {
  const current = await readCurrentRunRevision(f.changeDir)
  const phase = current?.state.fields.phase
  if (current?.state.runMetadata === undefined || typeof phase !== 'string') throw new Error('fixture: 缺少 run 身份')
  return { runId: current.state.runMetadata.runId, sequence: current.state.runMetadata.transitionSequence, step: phase }
}

/** 与转换一致的两步：先 recordStepExit（锁内、提交前），再真实提交一条 transition revision。 */
async function leave(f: Fixture, to: string, event = 'next', at = LATER): Promise<void> {
  const visit = await currentVisit(f)
  await recordStepExit(f.ctx, { ...visit, event, to, at })
  await commitTransition(f, to, event)
}

async function commitTransition(f: Fixture, to: string, event: string): Promise<void> {
  const current = await readCurrentRunRevision(f.changeDir)
  const metadata = current?.state.runMetadata
  if (current === undefined || metadata === undefined) throw new Error('fixture: 缺少 run 身份')
  const from = String(current.state.fields.phase)
  const sequence = metadata.transitionSequence + 1
  const id = `${event}-${sequence}`
  const record = {
    schemaVersion: 1, id, runId: metadata.runId, sequence, previousRecordId: metadata.transitionHead,
    workflowId: 'default', event, from, to, effects: [{ kind: 'state-field-change', field: 'phase', from, to }], observedAt: AT,
  } satisfies TransitionRecord
  await createTransitionRecordStore().write(f.changeDir, record)
  await publishRunRevision(f.changeDir, current, {
    ...current.state,
    fields: { ...current.state.fields, phase: to },
    runMetadata: { ...metadata, transitionSequence: sequence, transitionHead: id },
  }, { kind: 'transition', transitionRecordId: id, observedAt: AT })
}

/** 在当前步骤访问里记一次技能加载（原生 hook 写下的 invocation-started），加载时间取「几十秒前」，早于随后写出的文件。 */
async function loadSkill(f: Fixture, skill: string, secondsAgo: number): Promise<void> {
  const visit = await currentVisit(f)
  eventCounter += 1
  await appendSkillInvocationEvent(f.changeDir, {
    schema_version: 'skill-invocation-evidence/v1',
    event_id: `event-${eventCounter}`,
    invocation_id: `invocation-${eventCounter}`,
    sequence: 1,
    type: 'invocation-started',
    subject: {
      project_id: await skillInvocationProjectId(f.root), workflow_definition_id: 'default', workflow_run_id: visit.runId,
      step_id: visit.step, step_visit: { run_id: visit.runId, transition_sequence: visit.sequence },
    },
    recorded_at: new Date(Date.now() - secondsAgo * 1000).toISOString(),
    payload: {
      skill: { id: skill, version: '1' },
      input: { schema_id: 'input/v1', fields: [] },
      adapter: { kind: 'native', proof_ref: `proof-${eventCounter}` },
    },
  }, {})
}

const PROPOSAL = 'openspec/changes/demo/proposal.md'

describe('一次访问的开始、离开与交接', () => {
  test('离开时记下产出与来源技能，并为下一步开始新的访问', async () => {
    const f = await fixture()
    await startStepVisit(f.ctx, await currentVisit(f), AT)
    await loadSkill(f, 'tenon', 50) // 编排技能不算来源
    await loadSkill(f, 'openspec-propose', 40)
    await write(f, PROPOSAL, '# proposal\n')
    await write(f, 'src/a.ts', 'export const a = 1\n')
    await leave(f, 'explore', 'open-complete')

    const ledger = await readStepOutputLedger(f.changeDir)
    const [opened, explore] = ledger.visits
    expect(opened).toMatchObject({
      run_id: 'run-1', sequence: 0, step: 'open', checkpoint: null,
      exit: { event: 'open-complete', to: 'explore', at: LATER, observation: 'observed' },
    })
    expect(opened?.outputs).toEqual([
      { path: PROPOSAL, change: 'added', sha256: expect.stringMatching(/^[0-9a-f]{64}$/u), skill: 'openspec-propose' },
      { path: 'src/a.ts', change: 'added', sha256: expect.stringMatching(/^[0-9a-f]{64}$/u), skill: 'openspec-propose' },
    ])
    expect(explore).toMatchObject({ run_id: 'run-1', sequence: 1, step: 'explore', exit: null, outputs: [], reads: [], entered_at: LATER })
    expect(explore?.checkpoint).not.toBeNull()
  })

  test('没有加载记录时来源记未知；删除的产出来源也是未知', async () => {
    const f = await fixture({ committed: { 'docs/old.md': '# old\n' } })
    await startStepVisit(f.ctx, await currentVisit(f), AT)
    await write(f, 'docs/new.md', '# new\n')
    await rm(join(f.root, 'docs/old.md'))
    await leave(f, 'explore')
    const outputs = (await readStepOutputLedger(f.changeDir)).visits[0]?.outputs
    expect(outputs?.map((o) => [o.path, o.change, o.skill])).toEqual([['docs/new.md', 'added', null], ['docs/old.md', 'deleted', null]])
  })

  test('技能加载记录读不了：来源记未知，转换不受影响', async () => {
    const f = await fixture()
    await startStepVisit(f.ctx, await currentVisit(f), AT)
    await writeFile(join(f.changeDir, SKILL_INVOCATION_LEDGER_FILE), '{broken')
    await write(f, 'docs/new.md', '# new\n')
    await leave(f, 'explore')
    expect((await readStepOutputLedger(f.changeDir)).visits[0]?.outputs[0]?.skill).toBeNull()
  })

  test('同一访问 recordStepExit 调两次结果相同；改了目标步骤则改写离开记录与下一次访问', async () => {
    const f = await fixture()
    await startStepVisit(f.ctx, await currentVisit(f), AT)
    await write(f, 'docs/a.md', '# a\n')
    const exit = { ...(await currentVisit(f)), event: 'next', to: 'explore', at: LATER }
    await recordStepExit(f.ctx, exit)
    const first = await readFile(join(f.changeDir, STEP_OUTPUT_LEDGER_FILE), 'utf8')
    await recordStepExit(f.ctx, exit)
    expect(await readFile(join(f.changeDir, STEP_OUTPUT_LEDGER_FILE), 'utf8')).toBe(first)

    await recordStepExit(f.ctx, { ...exit, event: 'other', to: 'build' })
    const [opened, next] = (await readStepOutputLedger(f.changeDir)).visits
    expect(opened?.exit).toMatchObject({ event: 'other', to: 'build' })
    expect(opened?.outputs.map((o) => o.path)).toEqual(['docs/a.md'])
    expect(next).toMatchObject({ sequence: 1, step: 'build' })
  })

  test('下一步的输入只有直接上游的文档，不含代码与更早步骤的产出', async () => {
    const f = await fixture()
    await startStepVisit(f.ctx, await currentVisit(f), AT)
    await loadSkill(f, 'openspec-propose', 40)
    await write(f, PROPOSAL, '# proposal\n')
    await leave(f, 'explore')
    await loadSkill(f, 'brainstorming', 40)
    await write(f, 'docs/superpowers/specs/demo-design.md', '# design\n')
    await write(f, 'src/a.ts', 'export const a = 1\n')
    await leave(f, 'spec')

    const view = await readStepOutputs(f.ctx, { live: true })
    expect(view.visit).toEqual({ runId: 'run-1', sequence: 2, step: 'spec' })
    expect(view.observation).toBe('observed')
    expect(view.inputs).toEqual([
      { path: 'docs/superpowers/specs/demo-design.md', sha256: expect.stringMatching(/^[0-9a-f]{64}$/u), fromStep: 'explore', skill: 'brainstorming', read: false },
    ])
    expect(unreadInputs(view)).toHaveLength(1)
  })

  test('recordInputReads(all) 写回执后全部算读过；读完后本步再改它仍算读过，改动成为本步产出', async () => {
    const f = await fixture()
    await startStepVisit(f.ctx, await currentVisit(f), AT)
    await write(f, PROPOSAL, '# proposal\n')
    await leave(f, 'explore')

    expect(await recordInputReads(f.ctx, 'all', LATER)).toEqual([PROPOSAL])
    expect(await recordInputReads(f.ctx, 'all', LATER)).toEqual([PROPOSAL])
    expect((await readStepOutputLedger(f.changeDir)).visits[1]?.reads).toHaveLength(1) // 同路径同摘要不重复

    await write(f, PROPOSAL, '# proposal, revised in explore\n')
    const view = await readStepOutputs(f.ctx, { live: true })
    expect(view.inputs.map((input) => input.read)).toEqual([true])
    expect(unreadInputs(view)).toEqual([])
    expect(view.outputs.map((o) => [o.path, o.change])).toEqual([[PROPOSAL, 'modified']])
    expect(view.steps.explore?.outputs.map((o) => o.path)).toEqual([PROPOSAL])
  })

  test('读到的不是上游版本也不是当前版本的回执不算；改完再读一次就好', async () => {
    const f = await fixture()
    await startStepVisit(f.ctx, await currentVisit(f), AT)
    await write(f, PROPOSAL, '# v1\n')
    await leave(f, 'explore')
    await write(f, PROPOSAL, '# v2\n')
    await recordInputReads(f.ctx, 'all', LATER) // 回执 = v2，既不是上游 v1 也……恰好是当前版本，算读过
    expect(unreadInputs(await readStepOutputs(f.ctx, { live: false }))).toEqual([])
    await write(f, PROPOSAL, '# v3\n') // 回执 v2 与上游 v1、当前 v3 都对不上
    expect(unreadInputs(await readStepOutputs(f.ctx, { live: false })).map((input) => input.path)).toEqual([PROPOSAL])
    await recordInputReads(f.ctx, PROPOSAL, LATER)
    expect(unreadInputs(await readStepOutputs(f.ctx, { live: false }))).toEqual([])
  })

  test('输入文件在下一步被删除：不再列入，不卡住离开', async () => {
    const f = await fixture()
    await startStepVisit(f.ctx, await currentVisit(f), AT)
    await write(f, PROPOSAL, '# proposal\n')
    await leave(f, 'explore')
    await rm(join(f.root, PROPOSAL))
    const view = await readStepOutputs(f.ctx, { live: true })
    expect(view.inputs).toEqual([])
    expect(await recordInputReads(f.ctx, 'all', LATER)).toEqual([])
  })

  test('recordInputReads 拒绝不是交接输入的路径', async () => {
    const f = await fixture()
    await startStepVisit(f.ctx, await currentVisit(f), AT)
    await write(f, 'src/a.ts', 'export const a = 1\n')
    await write(f, PROPOSAL, '# proposal\n')
    await leave(f, 'explore')
    await expect(recordInputReads(f.ctx, 'src/a.ts', LATER)).rejects.toThrow('不是本步的交接输入')
    await expect(recordInputReads(f.ctx, '../outside.md', LATER)).rejects.toThrow('不是本步的交接输入')
  })

  test('非 git 目录：不观察、没有输入，转换不被挡住', async () => {
    const f = await fixture({ useGit: false })
    await startStepVisit(f.ctx, await currentVisit(f), AT)
    await write(f, 'docs/new.md', '# new\n')
    await expect(leave(f, 'explore')).resolves.toBeUndefined()
    const ledger = await readStepOutputLedger(f.changeDir)
    expect(ledger.visits[0]).toMatchObject({ checkpoint: null, outputs: [], exit: { observation: 'unavailable' } })
    expect(ledger.visits[1]).toMatchObject({ step: 'explore', checkpoint: null })
    const view = await readStepOutputs(f.ctx, { live: true })
    expect(view.observation).toBe('unavailable')
    expect(view.inputs).toEqual([])
  })

  test('当前访问从来没有检查点（升级前创建的任务）：unavailable，recordStepExit 不抛，下一步恢复观察', async () => {
    const f = await fixture() // 没有 startStepVisit
    expect((await readStepOutputs(f.ctx, { live: true })).observation).toBe('unavailable')
    await write(f, 'docs/a.md', '# a\n')
    await expect(leave(f, 'explore')).resolves.toBeUndefined()
    const ledger = await readStepOutputLedger(f.changeDir)
    expect(ledger.visits[0]).toMatchObject({ checkpoint: null, outputs: [], exit: { observation: 'unavailable' } })
    expect(ledger.visits[1]?.checkpoint).not.toBeNull()
    await write(f, 'docs/b.md', '# b\n')
    await leave(f, 'build')
    expect((await readStepOutputLedger(f.changeDir)).visits[1]?.outputs.map((o) => o.path)).toEqual(['docs/b.md'])
  })

  test('状态里的步骤被手改成和账本记录不同：那条记录不可信，按没有检查点处理', async () => {
    const f = await fixture()
    await startStepVisit(f.ctx, await currentVisit(f), AT)
    const current = await readCurrentRunRevision(f.changeDir)
    if (current === undefined) throw new Error('fixture')
    await publishRunRevision(f.changeDir, current, { ...current.state, fields: { ...current.state.fields, phase: 'build' } }, { kind: 'set', observedAt: AT })
    await write(f, 'docs/a.md', '# a\n')
    const view = await readStepOutputs(f.ctx, { live: true })
    expect(view.visit).toEqual({ runId: 'run-1', sequence: 0, step: 'build' })
    expect(view.observation).toBe('unavailable')
    expect(view.outputs).toEqual([])
  })

  test('产出超过 2000 条：截断并记 truncated', async () => {
    const f = await fixture()
    await startStepVisit(f.ctx, await currentVisit(f), AT)
    await Promise.all(Array.from({ length: 2001 }, (_, index) => write(f, `gen/f${String(index).padStart(4, '0')}.txt`, `${index}`)))
    await leave(f, 'explore')
    const opened = (await readStepOutputLedger(f.changeDir)).visits[0]
    expect(opened?.outputs).toHaveLength(2000)
    expect(opened?.exit?.observation).toBe('truncated')
  })

  test('账本损坏：读取与离开都抛 StepOutputLedgerError，且不改写损坏的文件', async () => {
    const f = await fixture()
    await startStepVisit(f.ctx, await currentVisit(f), AT)
    await writeFile(join(f.changeDir, STEP_OUTPUT_LEDGER_FILE), '{"version":2}')
    await expect(readStepOutputs(f.ctx, { live: true })).rejects.toBeInstanceOf(StepOutputLedgerError)
    await expect(recordStepExit(f.ctx, { ...(await currentVisit(f)), event: 'e', to: 'x', at: LATER })).rejects.toBeInstanceOf(StepOutputLedgerError)
    expect(await readFile(join(f.changeDir, STEP_OUTPUT_LEDGER_FILE), 'utf8')).toBe('{"version":2}')
  })

  test('没有 run 身份的目录：没有当前访问，不观察', async () => {
    const root = await mkdtemp(join(tmpdir(), 'step-outputs-norun-'))
    roots.push(root)
    const changeDir = join(root, 'openspec', 'changes', 'demo')
    await mkdir(changeDir, { recursive: true })
    const ctx = stepOutputsContextFor(changeDir)
    const view = await readStepOutputs(ctx, { live: true })
    expect(view).toMatchObject({ visit: null, observation: 'unavailable', inputs: [], outputs: [], steps: {}, produced: {} })
    await expect(recordInputReads(ctx, 'all', LATER)).rejects.toThrow('没有')
  })
})

describe('必须产出', () => {
  test('stepOutputsContextFor：项目根是任务目录上三级，任务名取目录名', () => {
    expect(stepOutputsContextFor('/p/openspec/changes/demo')).toEqual({ root: '/p', changeDir: '/p/openspec/changes/demo', change: 'demo' })
  })

  test('本步产出过匹配的文件才满足；进入前就有的历史文件不满足', async () => {
    const f = await fixture({ committed: { 'docs/superpowers/specs/old-design.md': '# old\n' } })
    await startStepVisit(f.ctx, await currentVisit(f), AT)
    await write(f, 'docs/superpowers/specs/demo-design.md', '# design\n')
    const view = await readStepOutputs(f.ctx, { live: true })
    expect(await requiredOutputSatisfied(f.ctx, view, 'open', SPECS)).toBe(true)
    expect(await requiredOutputSatisfied(f.ctx, view, 'open', 'docs/superpowers/specs/old-*.md')).toBe(false)
    expect(await requiredOutputSatisfied(f.ctx, view, 'explore', SPECS)).toBe(false) // 别的步骤产出的不算
  })

  test('产出后又删掉：不满足；非法模式失败关闭', async () => {
    const f = await fixture()
    await startStepVisit(f.ctx, await currentVisit(f), AT)
    await write(f, 'docs/superpowers/specs/demo-design.md', '# design\n')
    await leave(f, 'explore')
    await leave(f, 'open')
    await rm(join(f.root, 'docs/superpowers/specs/demo-design.md'))
    const view = await readStepOutputs(f.ctx, { live: true })
    expect(await requiredOutputSatisfied(f.ctx, view, 'open', SPECS)).toBe(false)
    expect(await requiredOutputSatisfied(f.ctx, view, 'open', '../x.md')).toBe(false)
  })

  test('观察不可用时退化为存在匹配的文件（非 git 目录）', async () => {
    const f = await fixture({ useGit: false, committed: { 'docs/superpowers/specs/old-design.md': '# old\n' } })
    const view = await readStepOutputs(f.ctx, { live: true })
    expect(view.observation).toBe('unavailable')
    expect(await requiredOutputSatisfied(f.ctx, view, 'open', SPECS)).toBe(true)
    expect(await requiredOutputSatisfied(f.ctx, view, 'open', 'docs/superpowers/plans/*.md')).toBe(false)
    expect(await requiredOutputSatisfied(f.ctx, view, 'open', 'README.md')).toBe(true)
    expect(await requiredOutputSatisfied(f.ctx, view, 'open', 'DESIGN.md')).toBe(false)
    expect(await requiredOutputSatisfied(f.ctx, view, 'open', 'openspec/changes/{change}/proposal.md')).toBe(false)
    await write(f, PROPOSAL, '# p\n')
    expect(await requiredOutputSatisfied(f.ctx, view, 'open', 'openspec/changes/{change}/proposal.md')).toBe(true)
    expect(await requiredOutputSatisfied(f.ctx, view, 'open', '**/old-design.md')).toBe(true)
  })

  test('回到同一步：上一次访问产出过计划，这次没改它也满足', async () => {
    const f = await fixture()
    await startStepVisit(f.ctx, await currentVisit(f), AT)
    await leave(f, 'spec')
    await write(f, 'docs/superpowers/plans/demo.md', '# plan\n')
    await leave(f, 'build')
    await leave(f, 'spec') // 第二次进入 spec，什么也没改
    const view = await readStepOutputs(f.ctx, { live: true })
    expect(view.visit).toEqual({ runId: 'run-1', sequence: 3, step: 'spec' })
    expect(view.outputs).toEqual([])
    expect(await requiredOutputSatisfied(f.ctx, view, 'spec', PLANS)).toBe(true)
    expect(view.produced.spec).toEqual(['docs/superpowers/plans/demo.md'])
    expect(view.steps.build?.inputs.map((input) => input.path)).toEqual(['docs/superpowers/plans/demo.md'])
    expect(view.steps.spec?.inputs).toEqual([]) // build 没产出，spec 第二次访问没有输入
  })

  test('离开已记录但提交失败、状态仍在原步骤：重试时用账本里的产出，必须产出照样满足', async () => {
    const f = await fixture()
    await startStepVisit(f.ctx, await currentVisit(f), AT)
    await write(f, 'docs/superpowers/specs/demo-design.md', '# design\n')
    await recordStepExit(f.ctx, { ...(await currentVisit(f)), event: 'next', to: 'explore', at: LATER }) // 没有 commitTransition
    const view = await readStepOutputs(f.ctx, { live: true })
    expect(view.visit).toEqual({ runId: 'run-1', sequence: 0, step: 'open' })
    expect(view.observation).toBe('observed')
    expect(view.outputs.map((o) => o.path)).toEqual(['docs/superpowers/specs/demo-design.md'])
    expect(await requiredOutputSatisfied(f.ctx, view, 'open', SPECS)).toBe(true)
  })

  test('requiredOutputMet：账本能定论或模式下没有文件时不做实时比较；否则才比较，结论与实时视图相同', async () => {
    const f = await fixture({ committed: { 'docs/superpowers/specs/old-design.md': '# old\n' } })
    await startStepVisit(f.ctx, await currentVisit(f), AT)
    let comparisons = 0
    const live = () => { comparisons += 1; return readStepOutputs(f.ctx, { live: true }) }
    expect(await requiredOutputMet(f.ctx, 'open', PLANS, live)).toBe(false) // 一个匹配的文件都没有
    expect(await requiredOutputMet(f.ctx, 'open', '../x.md', live)).toBe(false) // 非法模式失败关闭
    expect(comparisons).toBe(0)
    expect(await requiredOutputMet(f.ctx, 'open', SPECS, live)).toBe(false) // 只有进入前就有的历史文件：比较后才知道
    expect(comparisons).toBe(1)
    await write(f, 'docs/superpowers/specs/demo-design.md', '# design\n')
    expect(await requiredOutputMet(f.ctx, 'open', SPECS, live)).toBe(true)
    expect(comparisons).toBe(2)
    await leave(f, 'explore')
    await leave(f, 'open') // 回到这一步：上一次访问已在账本里产出过
    expect(await requiredOutputMet(f.ctx, 'open', SPECS, live)).toBe(true)
    expect(comparisons).toBe(2)
  })

  test('requiredOutputMet：观察不可用（非 git 目录）时按文件存在判定，不做实时比较', async () => {
    const f = await fixture({ useGit: false, committed: { 'docs/superpowers/specs/old-design.md': '# old\n' } })
    let comparisons = 0
    const live = () => { comparisons += 1; return readStepOutputs(f.ctx, { live: true }) }
    expect(await requiredOutputMet(f.ctx, 'open', SPECS, live)).toBe(true)
    expect(await requiredOutputMet(f.ctx, 'open', PLANS, live)).toBe(false)
    expect(comparisons).toBe(0)
  })
})

describe('交接视图（Context Bundle 逐个核对摘要用）', () => {
  test('当前步骤的交接输入加上本访问写过的读取回执；输入文件已删除的不列入', async () => {
    const f = await fixture()
    await startStepVisit(f.ctx, await currentVisit(f), AT)
    await write(f, PROPOSAL, '# v1\n')
    await write(f, 'docs/gone.md', '# gone\n')
    await leave(f, 'explore')
    await rm(join(f.root, 'docs/gone.md'))
    await recordInputReads(f.ctx, 'all', LATER)
    await write(f, PROPOSAL, '# v2\n')
    await recordInputReads(f.ctx, 'all', LATER)

    const handoff = await readStepHandoff(f.ctx)
    expect(handoff.step).toBe('explore')
    expect(handoff.inputs.map((input) => [input.path, input.fromStep])).toEqual([[PROPOSAL, 'open']])
    // 回执保留逐次读到的摘要：v1 与 v2 各一条（同路径同摘要才去重）。
    expect(handoff.reads.map((read) => read.path)).toEqual([PROPOSAL, PROPOSAL])
    expect(new Set(handoff.reads.map((read) => read.sha256)).size).toBe(2)
  })

  test('没有 run 状态：step 为 null，没有输入', async () => {
    const root = await mkdtemp(join(tmpdir(), 'step-outputs-nohandoff-'))
    roots.push(root)
    const changeDir = join(root, 'openspec', 'changes', 'demo')
    await mkdir(changeDir, { recursive: true })
    expect(await readStepHandoff(stepOutputsContextFor(changeDir))).toEqual({ step: null, inputs: [], reads: [] })
  })

  test('账本损坏照实抛 StepOutputLedgerError', async () => {
    const f = await fixture()
    await writeFile(join(f.changeDir, STEP_OUTPUT_LEDGER_FILE), '{broken')
    await expect(readStepHandoff(f.ctx)).rejects.toBeInstanceOf(StepOutputLedgerError)
  })
})
