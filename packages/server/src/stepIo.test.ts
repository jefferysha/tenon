/**
 * `changeStepIo`：编排接口里每步的输入与输出。新任务（观察模式）是 Tenon 离开步骤时观察到的真实产出，没有预先规定；
 * 升级前创建的任务（契约模式）仍按冻结计划的旧文档契约归属账本记录。两种模式同一个形状，不带摘要、访问 id、正文与绝对路径。
 *
 * 零 mock：观察模式在真 git 仓库里建任务、写文件、走真转换；技能来源来自真的 PostToolUse hook 写下的加载记录；
 * 契约模式用升级前 default 的冻结快照建任务，登记真账本。
 */
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  effectiveWorkflowPlanFromSnapshot, recordDocumentReads, recordInputReads, stepOutputsContextFor, STEP_OUTPUT_LEDGER_FILE,
  type EffectiveWorkflowPlan, type StateStore,
} from '@tenon/kernel'
import { legacyDefaultInitialWorkflow } from '@tenon/kernel/workflow/test-support'
import { changeStepIo, type ChangeStepIo } from './stepIo.js'
import {
  finishObservedExplore, initChange, makeProject, newStore, observedExploreTask, putProjectFile, recordWorkflowPhaseSkill,
  seedGovernedDocumentEvidence, OBSERVED_CHANGE as NAME, OBSERVED_DESIGN as DESIGN, type ObservedTask,
} from './test-support.js'

const CLOCK = '2026-10-12T00:00:00Z'

const observedTask = observedExploreTask
const put = putProjectFile
const finishExplore = finishObservedExplore

const ioOf = async (fixture: ObservedTask): Promise<ChangeStepIo> => changeStepIo({
  root: fixture.root,
  changeDir: fixture.changeDir,
  changeName: NAME,
  plan: fixture.plan,
  state: await fixture.store.read(fixture.changeDir),
})

describe('changeStepIo · 观察模式', () => {
  it('当前步骤按实时比较列出新写的文件并标注来源技能；必须产出只认本任务写的，历史文件不算', async () => {
    const fixture = await observedTask()
    const before = await ioOf(fixture)
    expect(before.explore?.outputs).toEqual([])
    expect(before.explore?.required).toEqual([{ path: 'docs/specs/*.md', produced: false }])

    await recordWorkflowPhaseSkill(fixture.root, fixture.changeDir, 'brainstorming')
    await put(fixture.root, DESIGN, '# Design\n')
    const after = await ioOf(fixture)
    expect(after.explore?.outputs).toEqual([{ path: DESIGN, change: 'added', skill: 'brainstorming' }])
    expect(after.explore?.required).toEqual([{ path: 'docs/specs/*.md', produced: true }])
  })

  it('离开步骤之后：上一步的产出读自账本，下一步的输入是它且还没读；读过之后 read 为 true', async () => {
    const fixture = await observedTask()
    expect(await finishExplore(fixture)).toBe(200)

    const handed = await ioOf(fixture)
    expect(handed.explore?.outputs).toEqual([{ path: DESIGN, change: 'added', skill: 'brainstorming' }])
    expect(handed.spec?.inputs).toEqual([{ path: DESIGN, fromStep: 'explore', skill: 'brainstorming', read: false }])
    expect(handed.spec?.outputs).toEqual([])
    // 路径模式里的 {change} 换成任务名，显示的是真路径。
    expect(handed.spec?.required).toEqual([{ path: `docs/plans/${NAME}-plan.md`, produced: false }])

    await recordInputReads(stepOutputsContextFor(fixture.changeDir), 'all', CLOCK)
    expect((await ioOf(fixture)).spec?.inputs).toEqual([{ path: DESIGN, fromStep: 'explore', skill: 'brainstorming', read: true }])

    await put(fixture.root, `docs/plans/${NAME}-plan.md`, '# Plan\n')
    expect((await ioOf(fixture)).spec?.required).toEqual([{ path: `docs/plans/${NAME}-plan.md`, produced: true }])
  })

  it('计划里的每一步都有条目，还没到的步骤是空的（门禁的必须产出照列）', async () => {
    const fixture = await observedTask()
    const io = await ioOf(fixture)
    expect(Object.keys(io)).toEqual(['explore', 'spec', 'done'])
    expect(io.done).toEqual({ inputs: [], outputs: [], required: [] })
    expect(io.spec).toEqual({ inputs: [], outputs: [], required: [{ path: `docs/plans/${NAME}-plan.md`, produced: false }] })
  })

  it('不返回摘要、访问 id、正文与绝对路径', async () => {
    const fixture = await observedTask()
    await finishExplore(fixture)
    const text = JSON.stringify(await ioOf(fixture))
    for (const secret of [fixture.root, 'sha256', 'runId', 'run_id', 'observed, not declared']) expect(text).not.toContain(secret)
  })

  it('非 git 项目观察不可用：没有产出，必须产出退化为存在匹配的文件', async () => {
    const fixture = await observedTask({ git: false })
    await put(fixture.root, DESIGN, '# Design\n')
    const io = await ioOf(fixture)
    expect(io.explore?.outputs).toEqual([])
    expect(io.explore?.required).toEqual([{ path: 'docs/specs/*.md', produced: true }])
  })

  it('产出账本损坏不让整个编排读失败：输入输出为空，必须产出按文件存在判定', async () => {
    const fixture = await observedTask()
    await writeFile(join(fixture.changeDir, STEP_OUTPUT_LEDGER_FILE), '{not json', 'utf8')
    const io = await ioOf(fixture)
    expect(io.explore).toEqual({ inputs: [], outputs: [], required: [{ path: 'docs/specs/*.md', produced: true }] })
  })

  it('已结束任务：不做实时比较，必须产出不求值，任务目录里的文件路径改到归档后的位置', async () => {
    const fixture = await observedTask()
    await put(fixture.root, `openspec/changes/${NAME}/notes.md`, '# notes\n')
    await finishExplore(fixture)
    // 任务结束时整个任务目录搬进 archive/<日期>-<名>/，账本随目录走。
    const moved = join(fixture.root, 'openspec', 'changes', 'archive', `2026-10-12-${NAME}`)
    await mkdir(dirname(moved), { recursive: true })
    await cp(fixture.changeDir, moved, { recursive: true })
    await rm(fixture.changeDir, { recursive: true, force: true })
    // 搬走之后又有别的改动：已结束任务的最后一步不再拿它当本步产出。
    await put(fixture.root, 'docs/specs/after-the-task-ended.md', '# later\n')
    const io = await changeStepIo({
      root: fixture.root, changeDir: moved, changeName: `2026-10-12-${NAME}`, plan: fixture.plan, state: await fixture.store.read(moved),
    })
    expect(io.explore?.outputs.map((file) => file.path).sort()).toEqual([DESIGN, `openspec/changes/archive/2026-10-12-${NAME}/notes.md`])
    // 输入只列现在还在原路径上的文件（kernel 的规则）：搬进归档的任务目录文件不再出现在输入里。
    expect(io.spec?.inputs.map((file) => file.path)).toEqual([DESIGN])
    expect(io.spec?.outputs).toEqual([])
    expect(io.spec?.required).toEqual([])
  })
})

describe('changeStepIo · 契约模式（升级前创建的任务）', () => {
  async function legacyTask(): Promise<{ root: string; changeDir: string; store: StateStore; plan: EffectiveWorkflowPlan }> {
    const store = newStore()
    const root = await makeProject()
    const changeDir = await initChange(store, root, NAME, { track: 'backend', initialWorkflow: legacyDefaultInitialWorkflow('backend', 'step-graph') })
    await seedGovernedDocumentEvidence(root, changeDir, NAME)
    const snapshot = (await store.read(changeDir)).runMetadata?.workflowPlanSnapshot
    if (snapshot === undefined) throw new Error('legacy task must freeze its plan')
    return { root, changeDir, store, plan: effectiveWorkflowPlanFromSnapshot(snapshot, 'backend') }
  }

  it('立项步的输出是账本里的 proposal / design / tasks 记录，来源技能是记录的 producer，没有必须产出', async () => {
    const task = await legacyTask()
    const io = await changeStepIo({ root: task.root, changeDir: task.changeDir, changeName: NAME, plan: task.plan, state: await task.store.read(task.changeDir) })
    expect(task.plan.capabilities.documents.mode).toBe('contract')
    expect(io.open?.outputs).toEqual([
      { path: `openspec/changes/${NAME}/proposal.md`, skill: 'openspec-propose' },
      { path: `openspec/changes/${NAME}/design.md`, skill: 'openspec-propose' },
      { path: `openspec/changes/${NAME}/tasks.md`, skill: 'openspec-propose' },
    ])
    expect(io.open?.inputs).toEqual([])
    expect(Object.values(io).every((entry) => entry.required.length === 0)).toBe(true)
  })

  it('契约的 reads 进对应步骤的输入：来自产出它的步骤；本次访问有匹配回执才算已读', async () => {
    const task = await legacyTask()
    const read = async (): Promise<ChangeStepIo> => changeStepIo({
      root: task.root, changeDir: task.changeDir, changeName: NAME, plan: task.plan, state: await task.store.read(task.changeDir),
    })
    const unread = (await read()).explore
    expect(unread?.inputs.map((file) => [file.path, file.fromStep, file.skill, file.read])).toEqual([
      [`openspec/changes/${NAME}/proposal.md`, 'open', 'openspec-propose', false],
      [`openspec/changes/${NAME}/design.md`, 'open', 'openspec-propose', false],
      [`openspec/changes/${NAME}/tasks.md`, 'open', 'openspec-propose', false],
    ])
    const policy = task.plan.capabilities.documents.policy
    if (policy === undefined) throw new Error('contract plan must carry a policy')
    await task.store.set(task.changeDir, 'phase', 'explore')
    await recordDocumentReads({ repoRoot: task.root, changeDir: task.changeDir, phase: 'explore', policy, kind: 'all', readAt: CLOCK })
    expect((await read()).explore?.inputs.map((file) => file.read)).toEqual([true, true, true])
  })

  it('同一路径登记在两个 kind 下只列一次', async () => {
    const task = await legacyTask()
    const io = await changeStepIo({ root: task.root, changeDir: task.changeDir, changeName: NAME, plan: task.plan, state: await task.store.read(task.changeDir) })
    const paths = (io.spec?.outputs ?? []).map((file) => file.path)
    expect(new Set(paths).size).toBe(paths.length)
    expect(paths).toContain(`docs/superpowers/plans/${NAME}.md`)
  })
})
