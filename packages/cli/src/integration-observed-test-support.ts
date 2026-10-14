/**
 * 观察模式（没有旧文档契约的新任务）端到端用例的共用夹具：
 *   - 临时 git 项目（观察基于 git，harness 项目默认不是仓库）；
 *   - 技能加载走真实 PostToolUse hook（`recordWorkflowPhaseSkill`）——技能加载时间是来源标注的依据；
 *   - 按步骤剧本推进的驱动器：只照 `tenon status --json` 的 `next` 做事，技能加载完成后由剧本写文件（模拟技能自己的
 *     SKILL.md 写出的东西），Tenon 不预先告诉它写什么；
 *   - 产出账本 `.pipeline-step-outputs.json` 的读取。
 * 非 *.test.ts，只给集成测试引用。
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from 'vitest'
import type { Harness } from './integration-harness.js'
import { parseJsonRecord, recordRows } from './integration-harness-json.js'
import { recordWorkflowPhaseSkill } from './integration-phase-skill-test-support.js'
import {
  NextRunner, type ActionHandler, type FinishCommit, type NextRunnerOptions, type RunnerStep, type StepAction,
} from './integration-next-runner-test-support.js'
import { putFile, runGit } from './test-git-fixture.js'

export interface ObservedInput {
  readonly path: string
  readonly from_step: string
  readonly skill: string | null
  readonly status: 'read' | 'unread'
}

export interface ObservedOutput {
  readonly path: string
  readonly change: 'added' | 'modified' | 'deleted'
  readonly skill: string | null
}

export interface ObservedRequired {
  readonly path: string
  readonly status: 'produced' | 'missing'
}

export interface ObservedStep extends RunnerStep {
  readonly documents: {
    readonly mode: 'observed'
    readonly observation: 'observed' | 'unavailable' | 'truncated'
    readonly inputs: readonly ObservedInput[]
    readonly outputs: readonly ObservedOutput[]
    readonly required: readonly ObservedRequired[]
  }
  readonly exits: readonly { readonly event: string; readonly direction: string }[]
}

export type LedgerOutput = {
  readonly path: string
  readonly change: 'added' | 'modified' | 'deleted'
  readonly sha256: string | null
  readonly skill: string | null
}

export type LedgerVisit = {
  readonly run_id: string
  readonly sequence: number
  readonly step: string
  readonly checkpoint: unknown
  readonly exit: { readonly event: string; readonly to: string; readonly at: string; readonly observation: string } | null
  readonly outputs: readonly LedgerOutput[]
  readonly reads: readonly { readonly path: string; readonly sha256: string; readonly read_at: string }[]
}

/** 任务目录里的产出账本（任务被归档后传归档目录）。 */
export async function readLedger(changeDir: string): Promise<readonly LedgerVisit[]> {
  const ledger = parseJsonRecord(await readFile(join(changeDir, '.pipeline-step-outputs.json'), 'utf8'), '步骤产出账本')
  return recordRows(ledger.visits, '步骤产出账本 visits').map((visit) => {
    if (typeof visit.step !== 'string' || typeof visit.sequence !== 'number' || !Array.isArray(visit.outputs)) {
      throw new Error(`账本里的访问记录形状非法：${JSON.stringify(visit)}`)
    }
    return visit as LedgerVisit
  })
}

/** 任务完结后搬进 `openspec/changes/archive/<日期>-<名>/`：账本随任务目录一起走。 */
export async function archivedChangeDir(cwd: string, change: string): Promise<string> {
  const archive = join(cwd, 'openspec', 'changes', 'archive')
  const found = (await readdir(archive)).filter((entry) => entry.endsWith(`-${change}`))
  const [only] = found
  if (found.length !== 1 || only === undefined) throw new Error(`archive/ 里应有且只有一个 ${change} 的归档目录：${JSON.stringify(found)}`)
  return join(archive, only)
}

/** 最近一次离开了 `step` 的访问。 */
export function exitedVisit(visits: readonly LedgerVisit[], step: string): LedgerVisit {
  const found = [...visits].reverse().find((visit) => visit.step === step && visit.exit !== null)
  if (found === undefined) throw new Error(`账本里没有离开过 ${step} 的访问：${JSON.stringify(visits.map((v) => [v.sequence, v.step, v.exit?.event]))}`)
  return found
}

/**
 * 把 harness 项目变成 git 仓库并做初次提交：`files` 先写进去随初始提交入库（项目里早就有的文件，不算本任务的产出）。
 * 观察是否生效取决于它：非 git 的项目只记 `unavailable`。
 */
export async function initGitProject(h: Harness, files: Readonly<Record<string, string>> = {}): Promise<void> {
  for (const [path, body] of Object.entries(files)) await putFile(h.cwd, path, body)
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-q', '-m', 'initial']]) {
    const result = runGit(h.cwd, args)
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${result.output}`)
  }
}

/**
 * 来源标注按秒比较「技能加载时间 ≤ 文件修改时间」：同一秒里先写文件再加载下一个技能，两者都算「不晚于」，
 * 来源会落到后加载的那个。所以每次写文件之后、下一次加载技能之前，要等到下一秒——真实使用里技能之间隔着
 * 模型的思考时间，这里用一个时钟守卫复现。
 */
export class WriteClock {
  private lastWriteSecond = 0

  noteWrite(): void {
    this.lastWriteSecond = Math.floor(Date.now() / 1000)
  }

  async untilAfterLastWrite(): Promise<void> {
    while (Math.floor(Date.now() / 1000) <= this.lastWriteSecond) await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

export interface ObservedRunner {
  readonly runner: NextRunner
  readonly clock: WriteClock
  /** 写一个文件（缺的父目录一并建出）并记下写入时刻。 */
  put(rel: string, body: string): Promise<void>
}

/** 一个跟着 `next` 做事的运行器：技能加载走真实 hook，写文件都经时钟守卫。 */
export function observedRunner(h: Harness, change: string, options: Omit<NextRunnerOptions, 'loadSkill' | 'onWrite'>): ObservedRunner {
  const clock = new WriteClock()
  const runner: NextRunner = new NextRunner(h, change, {
    ...options,
    handlers: {
      // 观察模式只有这一条文档动作：读完直接上游的产出（`all`）。
      'read-documents': async () => {
        await runner.run(['document', 'read', change, 'all'])
        return false
      },
      ...options.handlers,
    },
    loadSkill: async (skill) => {
      await clock.untilAfterLastWrite()
      await recordWorkflowPhaseSkill(h.cwd, join(h.cwd, 'openspec', 'changes', change), skill)
    },
    onWrite: () => clock.noteWrite(),
  })
  return { runner, clock, put: (rel, body) => runner.put(rel, body) }
}

/** 一个步骤的剧本：技能加载完成后写什么（技能自己的活）、以及开始时的观察点。 */
export interface StepScript {
  /** 技能 `skill` 加载完成后（它的活开始了）写文件；返回后重新读 status。 */
  readonly afterSkill?: Readonly<Record<string, () => Promise<void>>>
  /** 本步第一次读到 status 时（还没动手）的观察点。 */
  readonly atStart?: (step: ObservedStep) => Promise<void>
}

export interface DriveResult {
  /** 本步里下发过的所有动作（按下发顺序）。 */
  readonly actions: readonly StepAction[]
  /** 每一轮读到的 step 分块（只保留 documents 与 next，用于断言 `read-documents` 的内容）。 */
  readonly steps: readonly ObservedStep[]
}

/**
 * 驱动 `stepId` 这一步直到离开它：每一轮读 status，按 `next` 逐条执行；某个技能加载完成且剧本为它写了文件，
 * 就停下重新读 status（写文件会改变 `next`）。`stuck` 在 `next` 卡在一条执行不了的动作上时接管——返回 true
 * 表示它已经替运行器离开了这一步。
 */
export async function driveStep(
  runner: NextRunner,
  stepId: string,
  script: StepScript = {},
  stuck?: (step: ObservedStep, action: StepAction) => Promise<boolean>,
): Promise<DriveResult> {
  const actions: StepAction[] = []
  const steps: ObservedStep[] = []
  const authored = new Set<string>()
  let started = false
  for (let round = 1; round <= 60; round++) {
    const step = await runner.readStep<ObservedStep>()
    if (step.id !== stepId) return { actions, steps }
    if (!started) {
      started = true
      if (script.atStart !== undefined) {
        // 观察点可能已经改变了状态（加载技能、写文件）：之后按最新的 status 继续。
        await script.atStart(step)
        continue
      }
    }
    steps.push(step)
    expectNonEmpty(step)
    for (const action of step.next) {
      actions.push(action)
      if (stuck !== undefined && await stuck(step, action)) break
      const done = await runner.perform(step, action)
      const skill = action.action === 'load-skill' ? String(action.skill) : action.action === 'load-tenon' ? 'tenon' : undefined
      const write = skill === undefined || authored.has(skill) ? undefined : script.afterSkill?.[skill]
      if (skill !== undefined) authored.add(skill)
      if (write !== undefined) {
        await write()
        break
      }
      if (done) return { actions, steps }
    }
  }
  throw new Error(`runner: ${stepId} 走了 60 轮还没离开；下发过：${actions.map((action) => action.action).join(' → ')}`)
}

function expectNonEmpty(step: ObservedStep): void {
  if (step.next.length === 0) throw new Error(`runner: ${step.id} 的 next 是空的`)
}

/** 所有动作的名字（去重保序）。 */
export const actionNames = (actions: readonly StepAction[]): string[] => [...new Set(actions.map((action) => action.action))]

/** 本步 `read-documents` 动作列出的路径（没有这条动作 = 空）。 */
export function readList(drive: DriveResult): string[] {
  return drive.actions.filter((action) => action.action === 'read-documents').flatMap((action) => action.documents as string[])
}

/** 步骤访问里 `path` 这条产出必须存在，带指定的变化类型与来源技能（`undefined` = 不看来源）。 */
export function expectOutput(visit: LedgerVisit, path: string, change: 'added' | 'modified', skill?: string | null): void {
  expect(visit.outputs, `${visit.step} 的产出里要有 ${path}`).toContainEqual(expect.objectContaining({
    path, change, ...(skill === undefined ? {} : { skill }),
  }))
}

/** 平铺自定义工作流（没有 `tracks`、不走 OpenSpec）的一步：必须产出模式与出边事件；最后一步没有出边。 */
export interface FlatStep {
  readonly id: string
  readonly required?: readonly string[]
  readonly event?: string
  readonly to?: string
}

/** 把步骤列表写成工作流 YAML（Spec Kit 风格或最小的三步流）。 */
export function flatWorkflow(name: string, steps: readonly FlatStep[]): string {
  const lines = [`name: ${name}`, 'steps:']
  for (const step of steps) {
    lines.push(`  - id: ${step.id}`, `    label: ${step.id}`, '    gate: null', '    skills: []')
    const required = step.required ?? []
    if (required.length === 0) lines.push('    guards: []')
    else lines.push('    guards:', ...required.flatMap((path) => ['      - type: required-output', `        path: ${path}`]))
    if (step.event === undefined || step.to === undefined) lines.push('    transitions: []')
    else lines.push('    transitions:', `      - event: ${step.event}`, `        to: ${step.to}`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * 不走 OpenSpec 的工作流（轻量轨道、平铺自定义工作流）完结后的 `finish-change`：先 `tenon task finish`，再照动作给的提交做一次
 * （放弃出口或没有验证通过时 `commit` 为 null，不提交）。
 */
export function finishNonOpenspecHandler(getRunner: () => NextRunner): ActionHandler {
  return async (_step, action) => {
    const current = getRunner()
    await current.run(['task', 'finish', current.change])
    if (action.commit !== null && action.commit !== undefined) current.commitAsInstructed(action.commit as FinishCommit)
    return true
  }
}
