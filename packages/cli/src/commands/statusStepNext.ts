/**
 * `next`：`tenon status <change> --json` 的 step 分块里那张闭集动作表，以及它唯一的顺序。
 *
 * 这里是纯函数——投影层（statusStep.ts）把证据摊平成 `StepNextInput` 之后，本模块只决定
 * 「下一步照做什么」。每条动作名就是一条真能跑通的命令：投影说得出口的事，命令必须接受；
 * 命令拒绝的写法，投影一条都不许发。
 */
import { aliasesForSkill } from '@tenon/kernel'
import type { StepAgentView } from './statusStepAgents.js'
import type { StepBlocker, StepExit } from './stepExitReport.js'
import type {
  StepDocumentsView, StepDocumentView, StepFieldView, StepSkillView,
} from './statusStepParts.js'

export interface StepTestView {
  readonly id: string
  readonly direction: string
  readonly required: boolean
  readonly status: string
  readonly run_id: string | null
}

/** 交互模式：AFK 环境变量 → afk；本任务有交互授权 → continuous；否则 interactive。 */
export type StepMode = 'interactive' | 'continuous' | 'afk'

export interface StepAction {
  readonly action: string
  readonly [key: string]: unknown
}

export function stop(code: string, message: string): readonly StepAction[] {
  return [{ action: 'stop', code, message }]
}

export interface StepNextInput {
  readonly change: string
  readonly loaded: boolean
  readonly skills: readonly StepSkillView[]
  readonly executors: readonly StepAgentView[]
  readonly reviewers: readonly StepAgentView[]
  readonly tests: readonly StepTestView[]
  readonly documents: StepDocumentsView
  readonly fields: readonly StepFieldView[]
  readonly review: { readonly status: string; readonly event: string | null }
  readonly gate: string | null
  readonly mode: StepMode
  readonly runArchived: boolean
  readonly governedOpenspec: boolean
  readonly exits: readonly StepExit[]
  /** 还没拿到一份对得上当前 delta spec 的彩排结论（`tenon spec apply --dry-run` 即可满足）。 */
  readonly specRehearsalPending: boolean
  /** delta spec 还没真的应用进主规格（彩排不算——它连一个字节都不写）。 */
  readonly specApplicationPending: boolean
  readonly ownsDeltaSpec: boolean
  readonly ownsAppliedSpec: boolean
  /** artifact 字段的合法 `--producer` 集（与 register 命令同源；空 = 无合法 producer）。 */
  readonly artifactProducers: readonly string[]
}

/**
 * 待填字段 → 它真正接受的那条写入动作。
 *
 * 动作名就是命令名：`set-field` 走 `tenon set`，`register-field` 走 `tenon artifact register`。
 * 从前任何缺字段都只发 `set-field`，遇上 artifact 声明过的字段，运行器照做就撞上「禁止通过
 * set/set-many/cas 写入」，只能自己猜。`transition` 那一类槽（archived / archived_at / review
 * receipt）由转换副作用落值，这里不发任何动作——让流程走到出边，由转换自己填。
 */
function writeFieldActions(
  fields: readonly StepFieldView[],
  producers: readonly string[],
): readonly StepAction[] {
  const actions: StepAction[] = []
  for (const field of fields) {
    if (field.writer === 'transition') continue
    actions.push(field.writer === 'artifact-register'
      ? { action: 'register-field', field: field.field, producers }
      : {
          action: 'set-field',
          field: field.field,
          allowed: field.allowed,
          recommended: field.recommended,
        })
  }
  return actions
}

/**
 * 文档写入动作：本步产出铺骨架并登记；本步可改的、以及只读输入里已登记又变了的，重新登记。
 *
 * 三条从前都不成立的规则各自对应一条真机死路：
 *   · `scaffold-document` 写完文件，台账仍是 `missing`（只有 record 才会登记），`next` 于是原样
 *     再发一遍同一条 scaffold——文件写对了，状态一步不动。骨架与登记是一对动作，一起下发。
 *   · `role: update` 的槽是「本步可以改它」，不是「本步必须产出它」——文档取证层早就是这个口径
 *     （update 槽从不进 blockers）。当成必须产出时，前端 `ship` 会被要求 scaffold 一份 contract
 *     里根本没声明为产出的 `design-md`，命令当场拒：未登记的 update 槽不发任何动作。
 *   · 只读输入被改动后状态是 `stale`，`document read` 当场拒（「已变更；先重新 record 后再 read」），
 *     它要的是一次重新登记。
 * producers 一律取该文档在**当前步**合法的那组——登记命令认的就是这一组。
 */
function documentWriteActions(documents: StepDocumentsView): readonly StepAction[] {
  const actions: StepAction[] = []
  const seen = new Set<string>()
  const push = (doc: StepDocumentView, scaffold: boolean): void => {
    if (seen.has(doc.kind)) return
    seen.add(doc.kind)
    // path=null 时 path_template 说明还缺哪个变量（delta-spec 缺 {capability}，由作者拍板后
    // 经 `tenon document scaffold <change> delta-spec --capability <x>` 定下来）。
    const shape = {
      kind: doc.kind,
      path: doc.path,
      path_template: doc.path_template,
      producers: doc.producers,
    }
    if (scaffold) actions.push({ action: 'scaffold-document', ...shape })
    actions.push({ action: 'record-document', ...shape })
  }
  for (const doc of documents.records) {
    if (doc.status === 'missing' || doc.status === 'stale') push(doc, doc.status === 'missing')
  }
  for (const doc of [...documents.updates, ...documents.reads]) {
    if (doc.status === 'stale' && doc.producers.length > 0) push(doc, false)
  }
  return actions
}

/**
 * 已调用、但契约绑定给它的文档还没在本次步骤访问里登记的技能：剩下的就是登记那些文档。
 *
 * 文档在台账上可能已是 `recorded`（上一次访问登记过，verify-fail 回来后的第二次 verify 就是这样），
 * 按台账状态派的写入分支因此一条都不会发；这里按技能欠的 kind 发，缺文件时连骨架一起。
 * producers 收窄到与该技能等价的那几个——登记者必须是它，别的合法 producer 不能替它交作业。
 */
function skillDocumentActions(
  skills: readonly StepSkillView[],
  documents: StepDocumentsView,
): readonly StepAction[] {
  const actions: StepAction[] = []
  const seen = new Set<string>()
  for (const skill of skills) {
    if (skill.status !== 'invoked') continue
    const aliases = new Set(aliasesForSkill(skill.id))
    for (const kind of skill.pending_documents) {
      const doc = documents.records.find((candidate) => candidate.kind === kind)
      if (doc === undefined || seen.has(kind)) continue
      seen.add(kind)
      const own = doc.producers.filter((producer) =>
        aliasesForSkill(producer).some((alias) => aliases.has(alias)))
      const shape = {
        kind: doc.kind,
        path: doc.path,
        path_template: doc.path_template,
        producers: own.length > 0 ? own : doc.producers,
        skill: skill.id,
      }
      if (doc.status === 'missing') actions.push({ action: 'scaffold-document', ...shape })
      actions.push({ action: 'record-document', ...shape })
    }
  }
  return actions
}

/** 同一波的动作一起下发；`next` 的第一条规则命中即返回，顺序就是执行顺序。 */
export function stepNextActions(input: StepNextInput): readonly StepAction[] {
  // 状态机已归档（fields.archived=true，不是 per-user 收起表）：只剩治理归档这一步，排在
  // load-tenon 之前——终态自边的步骤访问不会再前进，补技能证据只会原地打转，而动作自带整条命令。
  // 归档跑完前目录还在 openspec/changes/ 下而 archived=true，两张列表都看不见它，不点名就只剩空 fix。
  if (input.runArchived) {
    if (!input.governedOpenspec) return stop('run-archived', `任务 '${input.change}' 已完结`)
    const command = `openspec archive ${input.change} --skip-specs --yes --json`
    return [{ action: 'finish-change', change: input.change, command }]
  }
  if (!input.loaded) return [{ action: 'load-tenon' }]

  // 只有 `unread` 是 `tenon document read` 能推进的状态。`stale` 的文档读不动——命令当场拒
  // 「document 'x' 已变更：…；先重新 record 后再 read」——而这条过滤从前把它也算进读清单，
  // 于是 `next` 发一条必定失败的命令，状态一动不动，下一轮再发同一条：真机实测里五个相位都撞上
  // 了这个死循环。`missing` 同理（没有内容可读）。两者要的都是一次写入，交给下面的写入分支。
  const unread = input.documents.reads.filter((doc) => doc.status === 'unread')
  if (unread.length > 0) {
    // 路径还定不下来的文档不进读清单：没有路径就没有可读的文件，列出 null 只会让执行者读空气。
    return [{ action: 'read-documents', documents: unread.flatMap((doc) => doc.path ?? []) }]
  }

  const executors = pendingAgents(input.executors, true)
  if (executors.length > 0) return executors

  const ready = input.skills.filter((skill) => skill.status === 'ready')
  if (ready.length > 0) {
    return ready.map((skill) => ({ action: 'load-skill', skill: skill.id, wave: skill.wave }))
  }
  const producing = skillDocumentActions(input.skills, input.documents)
  if (producing.length > 0) return producing

  if (input.ownsAppliedSpec && input.specApplicationPending) return [{ action: 'apply-spec' }]
  const writes = documentWriteActions(input.documents)
  if (writes.length > 0) return writes
  const missingFields = writeFieldActions(
    input.fields.filter((field) => field.kind !== 'outcome' && field.status === 'missing'),
    input.artifactProducers,
  )
  if (missingFields.length > 0) return missingFields
  if (input.ownsDeltaSpec && input.specRehearsalPending) return [{ action: 'validate-spec' }]

  const tests = input.tests.filter((test) => test.required && test.status !== 'passed')
  if (tests.length > 0) return tests.map((test) => ({ action: 'run-test', test: test.id }))

  const reviewers = pendingAgents(input.reviewers, false)
  if (reviewers.length > 0) return reviewers

  const outcomes = writeFieldActions(
    input.fields.filter((field) => field.kind === 'outcome' && field.status === 'missing'),
    input.artifactProducers,
  )
  if (outcomes.length > 0) return outcomes

  return exitActions(input)
}

/**
 * 执行者失败可以直接重跑；评审者不行——评审结论是证据，代码没改就重跑只会得到同一份结论，
 * 该走的是回退边。
 */
function pendingAgents(views: readonly StepAgentView[], rerunFailed: boolean): readonly StepAction[] {
  const pending = views.filter((view) =>
    view.wave_ready && view.status !== 'pass' && (rerunFailed || view.status !== 'fail'))
  return pending.map((view) => ({
    action: 'run-agent',
    agent: view.agent,
    role: view.role,
    wave: view.wave,
  }))
}

/**
 * 回退边也要过本步的人工确认门。
 *
 * 真机实测：评审者打回后 `next` 直接给 `choose-exit: [verify-fail]`，照做却得到
 * 「phase 'verify' 的 event 'verify-fail' 尚未取得人工确认；先运行 tenon review request …
 * --event verify-fail」——`review request` 的事件绑定是逐边的（一次「回到实现」的决定不能顺便
 * 授权 verify-pass），所以回退边和前进边一样要走 request → await → transition 这条链。
 */
function gatedBackActions(
  input: { readonly gate: string | null; readonly review: { readonly status: string; readonly event: string | null } },
  back: readonly StepExit[],
): readonly StepAction[] {
  const choose: StepAction = { action: 'choose-exit', exits: back.map((exit) => exit.event) }
  if (input.gate !== 'review') return [choose]
  const bound = back.find((exit) => exit.event === input.review.event)
  if (bound !== undefined) {
    if (input.review.status === 'pending') return [{ action: 'await-review', event: bound.event }]
    if (input.review.status === 'approved') return [{ action: 'transition', event: bound.event }]
  }
  const only = back.length === 1 ? back[0] : undefined
  return only === undefined ? [choose] : [{ action: 'request-review', event: only.event }]
}

function exitActions(input: {
  readonly review: { readonly status: string; readonly event: string | null }
  readonly gate: string | null
  readonly exits: readonly StepExit[]
  readonly tests: readonly StepTestView[]
  readonly reviewers: readonly StepAgentView[]
}): readonly StepAction[] {
  const forward = input.exits.filter((exit) => exit.direction !== 'back')
  const back = input.exits.filter((exit) => exit.direction === 'back')
  const failed = input.tests.some((test) => test.required && test.status === 'failed')
    || input.reviewers.some((view) => view.required && view.status === 'fail')
  if (failed && back.length > 0) return gatedBackActions(input, back)
  const readyForward = forward.filter((exit) => exit.ready)
  if (input.gate === 'review') {
    if (input.review.status === 'pending') return [{ action: 'await-review', event: input.review.event }]
    if (input.review.status === 'approved' && input.review.event !== null) {
      const exit = input.exits.find((candidate) => candidate.event === input.review.event)
      return [{
        action: exit?.direction === 'completion' ? 'complete' : 'transition',
        event: input.review.event,
      }]
    }
    if (readyForward.length === 1 && readyForward[0] !== undefined) {
      return [{ action: 'request-review', event: readyForward[0].event }]
    }
  } else if (readyForward.length === 1 && readyForward[0] !== undefined) {
    const exit = readyForward[0]
    return [{ action: exit.direction === 'completion' ? 'complete' : 'transition', event: exit.event }]
  }
  if (readyForward.length > 1) {
    return [{ action: 'choose-exit', exits: readyForward.map((exit) => exit.event) }]
  }
  const blockers: StepBlocker[] = []
  for (const exit of forward) blockers.push(...exit.blockers)
  return [{ action: 'fix', blockers }]
}
