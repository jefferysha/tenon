/**
 * `tenon status <change> --json` 的 `step` 分块：单个 `tenon` skill 每一步照做的全部输入。
 *
 * 工作流数据说这一步要加载哪些技能、跑哪些 agent 与测试、产出并登记哪些文档、按什么门禁退出；
 * 这里把这些声明与现有证据合成一份闭集的 `next` 动作表。顺序只在这一个函数里，不写在 skill 文案里。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  completedWorkflowSkillsSinceStepEntry, defaultEventGuardFields, isTenonUser, reviewGateEvent,
  reviewGateMatches, reviewGateStatus, userProjectPaths, userSlug,
  type EffectiveWorkflowPlan, type EventName, type PipelineState,
} from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { str } from '../render.js'
import { archivedChangesForUser } from '../archivedGuard.js'
import { parseContinuousAuthority } from '../continuousAuthority.js'
import { changeDir } from '../paths.js'
import { agentStepViews, type StepAgentView } from './statusStepAgents.js'
import { evaluateStepExitReport, type StepBlocker, type StepExit } from './stepExitReport.js'
import {
  stepDocuments, stepFields, stepSkills,
  type StepDocumentsView, type StepFieldRequirement, type StepFieldView, type StepSkillView,
} from './statusStepParts.js'
import { effectiveArtifactFields } from './effective-artifacts.js'
import { effectiveArtifactProducers } from './artifact.js'
import { retiredSkillReferences, retiredSkillsChangeMessage } from '@tenon/kernel'
import { testEvidenceContextFor, testEvidenceReaderFor } from '../testEvidenceContext.js'
import { currentCandidate } from './candidate.js'
import { SPEC_APPLY_RECEIPT } from './specApply.js'
import { specApplyReceiptFresh } from './statusStepSpec.js'

export interface StepTestView {
  readonly id: string
  readonly direction: string
  readonly required: boolean
  readonly status: string
  readonly run_id: string | null
}

export interface StepAction {
  readonly action: string
  readonly [key: string]: unknown
}

export interface StepBlock {
  readonly schema: 'tenon-step-v1'
  readonly change: string
  readonly workflow: string
  readonly track: string
  readonly source: 'frozen-snapshot' | 'current-definition'
  readonly id: string
  readonly label: string
  readonly prompt: string | null
  readonly gate: string | null
  readonly mode: 'interactive' | 'continuous' | 'afk'
  readonly archived: boolean
  readonly governed_openspec: boolean
  readonly candidate: string
  readonly skills: readonly StepSkillView[]
  readonly executors: readonly StepAgentView[]
  readonly reviewers: readonly StepAgentView[]
  readonly tests: readonly StepTestView[]
  readonly documents: StepDocumentsView
  readonly fields: readonly StepFieldView[]
  readonly review: { readonly status: string; readonly event: string | null }
  readonly exits: readonly StepExit[]
  readonly next: readonly StepAction[]
}

const TENON_SKILL = 'tenon'

async function historyRaw(dir: string): Promise<string> {
  try {
    return await readFile(join(dir, '.pipeline-history.jsonl'), 'utf8')
  } catch {
    return ''
  }
}

/** 持续模式的证据是「这个 Change 上有交互授权」（`tenon session activate --continuous` 写的那份）。 */
async function modeOf(deps: CliDeps, name: string): Promise<StepBlock['mode']> {
  if ((deps.env?.('TENON_AFK') ?? '') === '1') return 'afk'
  const user = deps.user()
  if (!isTenonUser(user)) return 'interactive'
  try {
    const raw = await readFile(userProjectPaths(deps.cwd, userSlug(user.id)).authority, 'utf8')
    return parseContinuousAuthority(raw)?.changeName === name ? 'continuous' : 'interactive'
  } catch {
    return 'interactive'
  }
}

function stop(code: string, message: string): readonly StepAction[] {
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
  readonly mode: StepBlock['mode']
  readonly exits: readonly StepExit[]
  readonly specApplyPending: boolean
  readonly ownsDeltaSpec: boolean
  readonly ownsAppliedSpec: boolean
  /** artifact 字段的合法 `--producer` 集（与 register 命令同源；空 = 无合法 producer）。 */
  readonly artifactProducers: readonly string[]
}

/**
 * 一个待填字段 → 该字段真正接受的那条写入动作。
 *
 * artifact 声明过的字段被 set/set-many/cas 拒写，只能 `tenon artifact register`；从前这里一律
 * 发 `set-field`，运行器照做就撞上 `禁止通过 set/set-many/cas 写入`，只能自己猜。现在动作名就是
 * 命令名，枚举与推荐值也一并带上，运行器不需要解析任何散文。
 */
function writeFieldAction(
  field: StepFieldView,
  producers: readonly string[],
): StepAction {
  return field.writer === 'artifact-register'
    ? { action: 'register-artifact', field: field.field, producers }
    : {
        action: 'set-field',
        field: field.field,
        allowed: field.allowed,
        recommended: field.recommended,
      }
}

/** 同一波的动作一起下发；`next` 的第一条规则命中即返回，顺序就是执行顺序。 */
export function stepNextActions(input: StepNextInput): readonly StepAction[] {
  if (!input.loaded) return [{ action: 'load-tenon' }]

  const unread = input.documents.reads.filter((doc) => doc.status !== 'recorded' && doc.status !== 'read')
  if (unread.length > 0) {
    return [{ action: 'read-documents', documents: unread.map((doc) => doc.path) }]
  }

  const executors = pendingAgents(input.executors, true)
  if (executors.length > 0) return executors

  const ready = input.skills.filter((skill) => skill.status === 'ready')
  if (ready.length > 0) {
    return ready.map((skill) => ({ action: 'load-skill', skill: skill.id, wave: skill.wave }))
  }

  if (input.ownsAppliedSpec && input.specApplyPending) return [{ action: 'apply-spec' }]
  const writes = [...input.documents.records, ...input.documents.updates]
    .filter((doc) => doc.status !== 'recorded')
  if (writes.length > 0) {
    return writes.map((doc) => ({
      action: doc.status === 'missing' ? 'scaffold-document' : 'record-document',
      kind: doc.kind,
      path: doc.path,
      producers: doc.producers,
    }))
  }
  const missingFields = input.fields.filter((field) => field.kind !== 'outcome' && field.status === 'missing')
  if (missingFields.length > 0) {
    return missingFields.map((field) => writeFieldAction(field, input.artifactProducers))
  }
  if (input.ownsDeltaSpec && input.specApplyPending) return [{ action: 'validate-spec' }]

  const tests = input.tests.filter((test) => test.required && test.status !== 'passed')
  if (tests.length > 0) return tests.map((test) => ({ action: 'run-test', test: test.id }))

  const reviewers = pendingAgents(input.reviewers, false)
  if (reviewers.length > 0) return reviewers

  const outcomes = input.fields.filter((field) => field.kind === 'outcome' && field.status === 'missing')
  if (outcomes.length > 0) {
    return outcomes.map((field) => writeFieldAction(field, input.artifactProducers))
  }

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
  const firstBack = back[0]
  if (failed && firstBack !== undefined) {
    return [{ action: 'choose-exit', exits: back.map((exit) => exit.event) }]
  }
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

/**
 * 本步被 set/set-many/cas 拒写的字段集。优先用 fields.ts 拒写时用的那份判定（当前定义），
 * 二者同源才不会出现「投影说 set、命令说不许 set」；该判定对坏 workflow fail-loud，此时退回
 * 冻结快照里这一步的 artifact 声明——投影是只读面，不该因为 workflow 坏了就整块消失。
 */
function artifactFieldsOf(
  deps: CliDeps,
  state: PipelineState,
  step: { readonly artifacts: readonly { readonly field: string }[] } | undefined,
): ReadonlySet<string> {
  try {
    return effectiveArtifactFields(deps, state)
  } catch {
    return new Set((step?.artifacts ?? []).map((artifact) => artifact.field))
  }
}

/**
 * default 轨的前置 guard 在 flow/default-event-policy.ts 的事件政策表里，不在 step.guards 上。
 * 按本步每条出边的事件去那张表取字段，投影层与转换强制层就读同一份声明。
 * custom 轨（execution.model !== 'phase-manifest'）的 guard 全在 step 上，返回空集。
 */
function nativeGuardFieldsOf(
  plan: EffectiveWorkflowPlan,
  state: PipelineState,
  exits: readonly StepExit[],
): readonly StepFieldRequirement[] {
  if (plan.capabilities.execution.model !== 'phase-manifest') return []
  const out: StepFieldRequirement[] = []
  for (const exit of exits) {
    if (exit.direction === 'back') continue
    for (const item of defaultEventGuardFields(exit.event as EventName, state)) {
      if (out.some((seen) => seen.field === item.field)) continue
      out.push(item.required === undefined ? { field: item.field } : { field: item.field, required: item.required })
    }
  }
  return out
}

export async function buildStatusStep(
  deps: CliDeps,
  name: string,
  state: PipelineState,
  plan: EffectiveWorkflowPlan,
): Promise<StepBlock> {
  const dir = changeDir(deps.cwd, name)
  const stepId = str(state.fields.phase)
  const step = plan.workflow.steps.find((candidate) => candidate.id === stepId)
  const archived = (await archivedChangesForUser(deps)).has(name)
  const completed = completedWorkflowSkillsSinceStepEntry(await historyRaw(dir), stepId)
  const skills = stepSkills(deps, plan, stepId, completed)
  const agents = await agentStepViews(deps, name, dir, state, plan, stepId)
  const testReport = await testEvidenceReaderFor(deps)({
    repoRoot: deps.cwd, changeDir: dir, changeName: name, plan, stepId,
    context: testEvidenceContextFor(deps, name),
  })
  const tests: readonly StepTestView[] = testReport.items.map((item) => ({
    id: item.test.id,
    direction: item.test.direction,
    required: item.test.required,
    status: item.status,
    run_id: item.run?.run_id ?? null,
  }))
  const report = await evaluateStepExitReport(deps, name, dir, state, plan)
  const policy = plan.capabilities.documents.policy
  const documents = stepDocuments(name, policy, stepId, report.documents?.items ?? [])
  const artifacts = artifactFieldsOf(deps, state, step)
  const fields = stepFields(state, step, artifacts, nativeGuardFieldsOf(plan, state, report.exits))
  const gateStatus = reviewGateStatus(state)
  const review = {
    status: gateStatus !== null && reviewGateMatches(state, stepId) ? gateStatus : 'none',
    event: gateStatus !== null && reviewGateMatches(state, stepId) ? reviewGateEvent(state) : null,
  }
  const specApply = await specApplyReceiptFresh(deps.cwd, dir)
  const retired = retiredSkillReferences(plan)
  const block: Omit<StepBlock, 'next'> = {
    schema: 'tenon-step-v1',
    change: name,
    workflow: plan.id,
    track: str(state.fields.track),
    source: state.runMetadata?.workflowPlanSnapshot === undefined ? 'current-definition' : 'frozen-snapshot',
    id: stepId,
    label: step?.label ?? stepId,
    prompt: step?.prompt ?? null,
    gate: step?.gate ?? null,
    mode: await modeOf(deps, name),
    archived,
    governed_openspec: plan.capabilities.documents.governed,
    candidate: await currentCandidate(deps, name, state, plan, stepId),
    skills,
    executors: agents.executors,
    reviewers: agents.reviewers,
    tests,
    documents,
    fields,
    review,
    exits: report.exits,
  }
  if (archived) return { ...block, next: stop('archived', `任务 '${name}' 已归档；先取消归档再继续`) }
  if (retired.length > 0) {
    return { ...block, next: stop('retired-skills', retiredSkillsChangeMessage(name, retired)) }
  }
  if (step === undefined) {
    return {
      ...block,
      next: stop('step-not-in-plan', `step '${stepId}' 不在 workflow '${plan.id}' 里；新建任务`),
    }
  }
  return {
    ...block,
    next: stepNextActions({
      change: name,
      loaded: completed.has(TENON_SKILL),
      skills,
      executors: agents.executors,
      reviewers: agents.reviewers,
      tests,
      documents,
      fields,
      review,
      gate: step.gate ?? null,
      mode: block.mode,
      exits: report.exits,
      specApplyPending: !specApply.fresh,
      ownsDeltaSpec: documents.records.some((doc) => doc.kind === 'delta-spec'),
      ownsAppliedSpec: documents.records.some((doc) => doc.kind === 'applied-spec'),
      artifactProducers: artifacts.size === 0 ? [] : effectiveArtifactProducers(deps, state),
    }),
  }
}

export { SPEC_APPLY_RECEIPT }
