/**
 * `integration-next-runner-test-support.ts` 的契约模式部分：升级前创建、冻结着文档契约的任务
 * （`h.initLegacyContractDefault`）怎么跟着 `next` 做文档——按 kind 读取、scaffold、record、register-field，
 * 以及整条 open → 完结的 `walkContract`。
 *
 * Skill 回执落在 PostToolUse hook 最终调用的那条生产命令上（`internal-native-skill-receipt`），时间戳跟 harness 的
 * 固定 clock 走。路径到 kind 的对应关系只从同一份 `step.documents` 里取。
 */
import { appendFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect } from 'vitest'
import { FIXED_CLOCK } from './integration-harness.js'
import { parseJsonRecord, recordOf, recordRows } from './integration-harness-json.js'
import {
  NextRunner, SHIP_TASK, STEP_KEYS, type ActionHandler, type RunnerStep, type StepAction,
} from './integration-next-runner-test-support.js'

export interface ContractDocumentView {
  readonly kind: string
  readonly path: string | null
  readonly producers: readonly string[]
  readonly status: string
}

export interface ContractStep extends RunnerStep {
  readonly documents: { readonly reads: readonly ContractDocumentView[] }
}

const DESIGN_DOC = [
  '# design', '', '```coverage', 'touches:',
  ...['L1_api', 'L2_data', 'L3_rules', 'L4_state', 'L5_errors', 'L6_security', 'L7_perf', 'L8_deps', 'L10_terms']
    .map((layer) => `${layer}: filled -> §1`),
  '```', '',
].join('\n')

/** 骨架占位符的记号（与 kernel 模板渲染器同一份：`[待填写…]`、`: 待填写` 等）。 */
const PLACEHOLDER = /\[待填写|: 待填写$|\*\* 待填写$|- \[ \] 待填写$/mu

/** 作者写成的文档内容。delta spec 要过 OpenSpec strict 校验，所以写成一条真需求。 */
function authored(kind: string): string {
  // ship 段留一项未勾：ship 的 next 必须先发带这条原文的 fix（运行器照做去勾它），而不是
  // 越过它去 apply-spec。
  if (kind === 'tasks') {
    return '## Open\n- [x] scope\n## Build\n- [x] implementation\n## Verify\n- [x] verification\n'
      + `## Ship\n- [ ] ${SHIP_TASK}\n`
  }
  // 新 capability 主规格的 Purpose 取自 proposal（spec apply 不再留上游 TBD 占位）。
  if (kind === 'proposal') return '# proposal\n\n## Why\n\nThe runner flow needs a durable capability.\n'
  if (kind === 'delta-spec') {
    return [
      '# capability', '', '## ADDED Requirements', '',
      '### Requirement: Runner capability', 'The system SHALL complete the runner flow.', '',
      '#### Scenario: runner completes', '- **WHEN** the runner follows next', '- **THEN** the change finishes', '',
    ].join('\n')
  }
  return `# ${kind}\n\nwritten by the runner\n`
}

/**
 * 宿主加载一个 Skill：落一行 PostToolUse 历史，再经生产命令把它绑定到 canonical StepVisit 上
 * （hooks/skill-tracker.sh 最终调用的就是这条）。时间戳跟 harness 的固定 clock 走，与文档登记
 * 时刻同一口径。
 */
export function contractSkillLoader(runner: () => NextRunner): (skill: string) => Promise<void> {
  let toolUseSeq = 0
  return async (skill) => {
    const current = runner()
    toolUseSeq += 1
    await appendFile(
      join(current.changeDir(), '.pipeline-history.jsonl'),
      `${JSON.stringify({ ts: FIXED_CLOCK, kind: 'tool', raw: `Skill: ${skill}` })}\n`,
      'utf8',
    )
    await current.run(['internal-native-skill-receipt', current.change, skill, 'runner-session', `tool-${toolUseSeq}`, FIXED_CLOCK])
  }
}

/** 动作载荷里当前步认的第一个 producer；没有就是 `next` 发了一条执行不了的动作。 */
function firstProducer(action: StepAction, message: string): string {
  const producer = (action.producers as readonly string[] | undefined)?.[0]
  if (producer === undefined) throw new Error(`${message}：${JSON.stringify(action)}`)
  return producer
}

/** 契约模式独有的四条动作。 */
export function contractHandlers(runner: () => NextRunner): Readonly<Record<string, ActionHandler>> {
  const handlers: Record<string, ActionHandler> = {
    'read-documents': async (rawStep, action) => {
      // 动作给的是路径，命令吃的是 kind；两者出自同一份 step 分块，所以就在那里对应，
      // 不从外部知识补。两个 kind 共用一条路径时（superpower-plan 与 plan）都要读到。
      const step = rawStep as ContractStep
      const kinds = new Set<string>()
      for (const path of action.documents as readonly string[]) {
        for (const doc of step.documents.reads) if (doc.path === path) kinds.add(doc.kind)
      }
      expect(kinds.size, `read-documents 的路径在 step.documents.reads 里必须找得到 kind：${JSON.stringify(action)}`)
        .toBeGreaterThan(0)
      for (const kind of kinds) await runner().run(['document', 'read', runner().change, kind])
      return false
    },
    'scaffold-document': async (_step, action) => {
      const args = ['document', 'scaffold', runner().change, String(action.kind)]
      // path=null 时 path_template 说缺哪个变量；capability 由作者拍板，运行器就是那个作者。
      if (action.path === null) args.push('--capability', 'capability')
      await runner().run(args)
      return false
    },
    'record-document': async (_step, action) => {
      const { h, change } = runner()
      const producer = firstProducer(action, 'record-document 必须带当前步认的 producer')
      const path = (action.path as string | null) ?? `openspec/changes/${change}/specs/capability/spec.md`
      // 运行器替作者把活干完：骨架里满是占位符（登记闸拒收，D7），tasks.md 全是未勾选的框（而 open/spec
      // 出口要求全勾）。作者要做的就是把骨架写成真内容。
      const abs = join(h.cwd, path)
      // tasks 的骨架行（「将本阶段目标拆成可验证任务」）不带占位记号，按「还没写成作者的清单」判；
      // 写成之后（含运行器勾过的项）不再覆盖。
      const current = existsSync(abs) ? await readFile(abs, 'utf8') : null
      if (current === null || PLACEHOLDER.test(current) || (action.kind === 'tasks' && !current.includes(SHIP_TASK))) {
        await runner().put(path, authored(String(action.kind)))
      }
      await runner().loadSkill(producer)
      await runner().run(['document', 'record', change, String(action.kind), path, '--producer', producer])
      return false
    },
    'register-field': async (_step, action) => {
      const { change } = runner()
      const producer = firstProducer(action, 'register-field 必须带合法 producer')
      const path = `docs/${change}-${String(action.field)}.md`
      await runner().put(path, action.field === 'design_doc' ? DESIGN_DOC : `# ${String(action.field)}\n`)
      await runner().loadSkill(producer)
      await runner().run(['artifact', 'register', change, String(action.field), path, '--producer', producer])
      return false
    },
  }
  return handlers
}

export interface WalkOptions {
  readonly editAt?: string
  /** 每条动作照做之前的观察点（用例在这里探测 CLI 对「越过 next 的写法」的拒绝）。 */
  readonly before?: (step: ContractStep, action: StepAction) => Promise<void>
  /** 立项：返回 `tenon init` 同款的退出码（用例选 initLegacyContractDefault 与它的工作流源）。 */
  readonly init: () => Promise<number>
  /** 用项目自己的 default 时，验证步的必需测试也会出现在 `test status` 里。 */
  readonly extraVerifyTests?: readonly string[]
}

export interface WalkResult {
  readonly seen: readonly string[]
  readonly actions: readonly { readonly step: string; readonly action: StepAction }[]
}

/** 跑完整条链；返回每一轮所在的 step 与所有下发过的动作名。 */
export async function walkContract(runner: NextRunner, options: WalkOptions): Promise<WalkResult> {
  const { h, change } = runner
  expect(await options.init()).toBe(0)
  // Skill 回执绑定当前用户的活跃任务，真实宿主会话就是这样起头的。
  expect(await h.run(['session', 'activate', change])).toBe(0)
  const proposal = join(runner.changeDir(), 'proposal.md')
  const seen: string[] = []
  const actions: { step: string; action: StepAction }[] = []
  let edited = options.editAt === undefined
  for (let round = 1; round <= 160; round++) {
    const step = await runner.readStep<ContractStep>()
    expect(Object.keys(step)).toEqual(STEP_KEYS)
    seen.push(step.id)
    // 已登记的文档在相位中途被改：它的状态变 stale，读不动了。
    if (!edited && step.id === options.editAt) {
      edited = true
      await runner.put(`openspec/changes/${change}/proposal.md`, `${await readFile(proposal, 'utf8')}\n调研后补的一段。\n`)
      continue
    }
    expect(step.next.length, `phase=${step.id} 的 next 不能是空的`).toBeGreaterThan(0)
    let done = false
    for (const action of step.next) {
      actions.push({ step: step.id, action })
      await options.before?.(step, action)
      done = (await runner.perform(step, action)) || done
    }
    if (done) {
      expect(edited, '用例必须真的改过一份已登记的文档').toBe(true)
      await expectFinished(runner, options.extraVerifyTests ?? [])
      return { seen, actions }
    }
  }
  throw new Error(`runner: 160 轮还没走到完结，最后停在 ${seen[seen.length - 1]}`)
}

/**
 * 搬进 archive/ 之后没有可做的事了：step 照样在（结构与活跃任务一致），next 是 stop finished；
 * 任务在 finished_changes（与 simple 收尾后同一形态）。已完结的 test status 不再是空 items：按步骤给出每项测试的
 * 最后记录，并点名完整报告。
 */
export async function expectFinished(runner: NextRunner, extraVerifyTests: readonly string[]): Promise<void> {
  const { change } = runner
  await runner.run(['status', change, '--json'])
  const after = parseJsonRecord(runner.h.out.join('\n'), 'status --json')
  expect(Object.keys(after.step === undefined ? {} : recordOf(after.step, 'status step'))).toEqual(STEP_KEYS)
  expect(after.step).toMatchObject({ archived: true, next: [{ action: 'stop', code: 'finished' }] })
  expect(recordRows(after.finished_changes, 'finished_changes').map((row) => row.name)).toEqual([change])
  await runner.run(['test', 'status', change, '--json'])
  const tests = parseJsonRecord(runner.h.out.join('\n'), 'test status --json')
  expect(tests.finished).toBe(true)
  expect(tests.report).toBe(`tenon test report ${change}`)
  // 每条轨道的验证都声明了 code-size 测试；项目自己的 default 可能多要 backend 验证的 integration。
  expect(recordRows(tests.items, 'test status items').map((item) => [item.step, item.id, item.run === undefined ? undefined : recordOf(item.run, 'run').result]))
    .toEqual([...extraVerifyTests, 'code-size'].map((id) => ['verify', id, 'pass']))
  await runner.run(['list', '--finished', '--json'])
  const finished = parseJsonRecord(runner.h.out.join('\n'), 'list --finished --json')
  expect(recordRows(finished.finished, 'finished')).toEqual([expect.objectContaining({ name: change, archived: 'true' })])
}
