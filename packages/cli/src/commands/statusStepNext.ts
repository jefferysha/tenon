/**
 * `next`：`tenon status <change> --json` 的 step 分块里那张闭集动作表，以及它唯一的顺序。
 *
 * 这里是纯函数——投影层（statusStep.ts）把证据摊平成 `StepNextInput` 之后，本模块只决定
 * 「下一步照做什么」。每条动作名就是一条真能跑通的命令：投影说得出口的事，命令必须接受；
 * 命令拒绝的写法，投影一条都不许发。
 */
import { aliasesForSkill } from '@tenon/kernel'
import type { GitFinishProbe } from '../gitWorkspace.js'
import type { StepAgentView } from './statusStepAgents.js'
import type { StepBlocker, StepExit } from './stepExitReport.js'
import type {
  StepDocumentsView, StepDocumentView, StepFieldView, StepSkillView,
} from './statusStepParts.js'

export interface StepTestView {
  readonly id: string
  readonly direction: string
  readonly required: boolean
  /** kernel 测试证据状态；命令要的 npm 脚本在项目里不存在时为 `unconfigured`（带 `hint`）。 */
  readonly status: string
  readonly run_id: string | null
  /** 仅 `unconfigured`：为什么未配置、怎么配置（与 `tenon test run` 的拒绝同一份文案）。 */
  readonly hint?: string
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

/** 完结时要问 git 的事实（只在 `runArchived` 时由投影层取）。 */
export interface StepFinishFacts {
  /** gitWorkspace.ts probeGitFinish；null = 不是 git 仓或 git 跑不起来。 */
  readonly git: GitFinishProbe | null
  /** 这次运行以验证通过收尾（verify_result=pass）；scope-expanded 之类的放弃出口不提交。 */
  readonly verified: boolean
}

/** 一条未配置的必需测试（本步或下一步声明的）。 */
export interface StepTestConfigGap {
  readonly id: string
  readonly step: string
  readonly hint: string
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
  readonly finish: StepFinishFacts
  /** 本步与下一步声明的必需测试里，命令要的 npm 脚本在项目里不存在的那些。 */
  readonly testConfigGaps: readonly StepTestConfigGap[]
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
          // 出口只接受的值（guard 点名）；结论字段没有推荐值，只有这一项——写入时 CLI 核对证据。
          required: field.required,
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

/**
 * 完结之后的收尾：治理归档（OpenSpec 工作流）与一次提交。
 *
 * 提交是 `git add -A -- <paths…>`，`untrack` 非空时再 `git rm --cached -q --ignore-unmatch --
 * <untrack…>`，最后 `git commit -m <message>`；三条都必须一次成功（真机：原目录从未被 git 跟踪，
 * 搬走之后 `fatal: pathspec 'openspec/changes/<c>' did not match any files`，exit 128）。所以：
 *   · archive/ 目录在搬移后一定存在，恒列出；
 *   · 原目录只有被跟踪过才列出——`-A` 据索引项暂存删除；没被跟踪过就没有什么删除可提交；
 *   · 状态目录自己的 `.gitignore` 存在且没被忽略时一起列出，收尾后 `git status` 才干净；
 *   · 已被旧版本提交、如今按忽略规则应被忽略的终端心跳列进 `untrack`（`--ignore-unmatch` 让它在
 *     搬移之后不再存在时也不报错）。
 * 不是 git 仓（或 git 跑不起来）时不发提交（`commit: null`）：没有可以一次成功的写法。
 *
 * 非 OpenSpec 治理的工作流（内置 simple）没有归档命令，但以验证通过收尾时同样留下一整个工作区的
 * 改动（功能代码与任务状态文件）：`command: null`，只带提交 `paths: ['.']`；工作区已干净（已提交）、
 * 不是 git 仓或以放弃出口（scope-expanded）收尾时就停。
 */
function finishActions(input: StepNextInput): readonly StepAction[] {
  const change = input.change
  const git = input.finish.git
  if (!input.governedOpenspec) {
    if (!input.finish.verified || git === null || (!git.workspaceDirty && git.untrack.length === 0)) {
      return stop('run-archived', `任务 '${change}' 已完结`)
    }
    return [{
      action: 'finish-change',
      change,
      command: null,
      commit: { paths: ['.'], untrack: git.untrack, message: `chore(tenon): finish ${change}` },
    }]
  }
  const command = `openspec archive ${change} --skip-specs --yes --json`
  const commit = git === null
    ? null
    : {
        paths: [
          ...(git.changeDirTracked ? [`openspec/changes/${change}`] : []),
          'openspec/changes/archive',
          ...git.housekeeping,
        ],
        untrack: git.untrack,
        message: `chore(openspec): archive ${change}`,
      }
  return [{ action: 'finish-change', change, command, commit }]
}

/** 同一波的动作一起下发；`next` 的第一条规则命中即返回，顺序就是执行顺序。 */
export function stepNextActions(input: StepNextInput): readonly StepAction[] {
  // 状态机已归档（fields.archived=true，不是 per-user 收起表）：只剩收尾这一步，排在 load-tenon
  // 之前——终态自边的步骤访问不会再前进，补技能证据只会原地打转，而动作自带整条命令。
  if (input.runArchived) return finishActions(input)
  if (!input.loaded) return [{ action: 'load-tenon' }]

  // 只有 `unread` 是 `tenon document read` 能推进的状态。`stale` 的文档读不动——命令当场拒
  // 「document 'x' 已变更：…；先重新 record 后再 read」——而这条过滤从前把它也算进读清单，
  // 于是 `next` 发一条必定失败的命令，状态一动不动，下一轮再发同一条：真机实测里五个相位都撞上
  // 了这个死循环。`missing` 同理（没有内容可读）。两者要的都是一次写入，交给下面的写入分支。
  const unread = input.documents.reads.filter((doc) => doc.status === 'unread')
  if (unread.length > 0) {
    // 路径还定不下来的文档不进读清单：没有路径就没有可读的文件，列出 null 只会让执行者读空气。
    // 多个 kind 可以共用一份文件（plan / superpower-plan）：路径只列一次；各 kind 仍各自在
    // step.documents.reads 里，`tenon document read <c> all` 一次把它们都标为已读。
    return [{ action: 'read-documents', documents: [...new Set(unread.flatMap((doc) => doc.path ?? []))] }]
  }

  // 必需测试未配置（命令要的 npm 脚本在项目里不存在）：在步骤入口就作为待配置项提出，本步的与
  // 下一步（前进边指向的步骤）的都算——配置是一次工作区改动，等到 verify 才发现，改完 package.json
  // 就让 build 冻结的候选版本失效；等到出口前才发 run-test 只会被拒（真机：模型临时加一条与
  // npm test 相同的脚本凑数）。
  if (input.testConfigGaps.length > 0) {
    return [{
      action: 'fix',
      blockers: input.testConfigGaps.map((gap) => ({
        source: 'test', code: 'test-unconfigured', message: gap.hint,
      })),
    }]
  }

  const missing = input.fields.filter((field) => field.kind !== 'outcome' && field.status === 'missing')
  // 决定类字段（带枚举、走 `tenon set`：build_mode / isolation / direct_override…）是「怎么做」的
  // 选择，必须在动手之前拍板：排在执行者与本步技能之前。真机 build 步里它排在技能之后，代码写完
  // 才被要求登记 build_mode，模型只能事后补填一个与事实不符的值（直接实现却登记成
  // subagent-driven-development）。artifact 登记不在这一档——它登记的是技能的产出，要等技能跑完。
  const decisions = writeFieldActions(
    missing.filter((field) => field.allowed !== null && field.writer === 'set'),
    input.artifactProducers,
  )
  if (decisions.length > 0) return decisions

  const executors = pendingAgents(input.executors, true)
  if (executors.length > 0) return executors

  const ready = input.skills.filter((skill) => skill.status === 'ready')
  if (ready.length > 0) {
    return ready.map((skill) => ({ action: 'load-skill', skill: skill.id, wave: skill.wave }))
  }
  const producing = skillDocumentActions(input.skills, input.documents)
  if (producing.length > 0) return producing

  const writes = documentWriteActions(input.documents)
  // 未勾的任务是本步还没做完的工作：排在应用规格、登记文档与一切字段之前——它们记录的都是「做完
  // 之后」的事实。真机 ship 步 exits 里明明有 tasks-incomplete，next 却只给 apply-spec 与
  // applied-spec 的骨架/登记，任务一直排在它们后面，模型只能自己去 exits 里发现并勾选。
  // 唯一的例外是 tasks.md 本身还等着产出或重新登记（open 步）：先写出来，才谈得上勾选。
  const tasksPending = [...producing, ...writes].some((action) => action.kind === 'tasks')
  const tasks = tasksPending ? [] : taskBlockers(input.exits)
  if (tasks.length > 0) return [{ action: 'fix', blockers: tasks }]

  if (input.ownsAppliedSpec && input.specApplicationPending) return [{ action: 'apply-spec' }]
  if (writes.length > 0) return writes
  // artifact 登记（技能产出的字段）；最后才是自由文本的交付值（pr_url / prd_path）——交付值记录
  // 的是做完之后的事实。
  const registers = writeFieldActions(
    missing.filter((field) => field.writer !== 'set'),
    input.artifactProducers,
  )
  if (registers.length > 0) return registers
  const freeform = writeFieldActions(
    missing.filter((field) => field.allowed === null && field.writer === 'set'),
    input.artifactProducers,
  )
  if (freeform.length > 0) return freeform
  if (input.ownsDeltaSpec && input.specRehearsalPending) return [{ action: 'validate-spec' }]

  const tests = input.tests.filter((test) => test.required && test.status !== 'passed')
  if (tests.length > 0) return tests.map((test) => ({ action: 'run-test', test: test.id }))

  const reviewers = pendingAgents(input.reviewers, false)
  if (reviewers.length > 0) return reviewers

  // 结果字段是「本步通过」的结论；必需测试或必需评审者已经不通过时，填它只会让运行器去写一条
  // 与证据相反的结论（真机：verify 里评审者打回后 next 仍给 set-field branch_status）。直接去出口：
  // 有回退边走回退边，没有就 fix。
  if (!requiredEvidenceFailed(input)) {
    const outcomes = writeFieldActions(
      input.fields.filter((field) => field.kind === 'outcome' && field.status === 'missing'),
      input.artifactProducers,
    )
    if (outcomes.length > 0) return outcomes
  }

  return exitActions(input)
}

/** 前进边上的未勾任务（`source: tasks`），按文案去重；每条带未勾项原文（`items`）。 */
function taskBlockers(exits: readonly StepExit[]): readonly StepBlocker[] {
  return exits.filter((exit) => exit.direction !== 'back')
    .flatMap((exit) => exit.blockers)
    .filter((item, index, all) => item.source === 'tasks'
      && all.findIndex((other) => other.message === item.message) === index)
}

function requiredEvidenceFailed(input: {
  readonly tests: readonly StepTestView[]
  readonly reviewers: readonly StepAgentView[]
}): boolean {
  return input.tests.some((test) => test.required && test.status === 'failed')
    || input.reviewers.some((view) => view.required && view.status === 'fail')
}

/**
 * 执行者失败可以直接重跑；评审者不行——评审结论是证据，代码没改就重跑只会得到同一份结论，
 * 该走的是回退边。
 *
 * 已经在跑（`running`）的 agent 先于一切新动作：`agent prompt` 之后还没 `record` 时，从前
 * 波次判定把它排除在外（进行中的不算可运行），`next` 于是越过它去发 `load-skill`，那次运行就此
 * 悬空。现在它原样回到 `run-agent`，带上 `run_id` 与 `report_path`：宿主等它跑完，把报告写到
 * 该路径，再 `tenon agent record <c> <run_id>`——不重开一次新的运行。
 */
function pendingAgents(views: readonly StepAgentView[], rerunFailed: boolean): readonly StepAction[] {
  const running = views.filter((view) => view.status === 'running')
  if (running.length > 0) {
    return running.map((view) => ({
      action: 'run-agent',
      agent: view.agent,
      role: view.role,
      wave: view.wave,
      status: 'running',
      run_id: view.run_id,
      report_path: view.report_path,
    }))
  }
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
  if (requiredEvidenceFailed(input) && back.length > 0) return gatedBackActions(input, back)
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
