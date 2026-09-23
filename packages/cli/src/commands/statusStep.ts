/**
 * `tenon status <change> --json` 的 `step` 分块：单个 `tenon` skill 每一步照做的全部输入。
 *
 * 工作流数据说这一步要加载哪些技能、跑哪些 agent 与测试、产出并登记哪些文档、按什么门禁退出；
 * 这里把这些声明与现有证据合成一份闭集的 `next` 动作表。顺序只在这一个函数里，不写在 skill 文案里。
 */
import { readFile } from 'node:fs/promises'
import {
  defaultEventGuardFields, isTenonUser, phaseExitGuardFields, readSpecApplyReceiptStatus, reviewGateEvent,
  reviewGateMatches, reviewGateStatus, userProjectPaths, userSlug,
  type EffectiveWorkflowPlan, type EventName, type PipelineState,
} from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { str } from '../render.js'
import { archivedChangesForUser } from '../archivedGuard.js'
import { parseContinuousAuthority } from '../continuousAuthority.js'
import { changeDir } from '../paths.js'
import { agentStepViews, type StepAgentView } from './statusStepAgents.js'
import { evaluateStepExitReport, type StepExit } from './stepExitReport.js'
import {
  stepDocuments, stepFields, stepSkills,
  type StepDocumentsView, type StepFieldRequirement, type StepFieldView, type StepSkillView,
} from './statusStepParts.js'
import { effectiveArtifactFields } from './effective-artifacts.js'
import { effectiveArtifactProducers } from './artifact.js'
import { retiredSkillReferences, retiredSkillsChangeMessage } from '@tenon/kernel'
import { testEvidenceContextFor, testEvidenceReaderFor } from '../testEvidenceContext.js'
import { currentCandidate } from './candidate.js'
import { unconfiguredMessage, unconfiguredNpmScript } from '../test-runner/npmScript.js'
import { SPEC_APPLY_RECEIPT } from './specApply.js'
import { PR_URL_NO_REMOTE, repositoryHasNoRemote } from './prUrlField.js'
import {
  stepNextActions, stop,
  type StepAction, type StepFinishFacts, type StepMode, type StepNextInput, type StepTestConfigGap,
  type StepTestView,
} from './statusStepNext.js'

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
  readonly mode: StepMode
  /**
   * 这个任务不再是活跃任务：当前用户把它收起了（per-user 归档表），或状态机已完结
   * （`fields.archived=true`）。两种都为 true——已完结的 change 不会再带一个 `archived:false` 的 step。
   */
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

/** 持续模式的证据是「这个 Change 上有交互授权」（`tenon session activate --continuous` 写的那份）。 */
async function modeOf(deps: CliDeps, name: string): Promise<StepMode> {
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
 * default 轨的前置 guard 分在两张表里，都不在 step.guards 上：
 *   · flow/default-event-policy.ts —— 每条出边事件自己的前置（build_mode / isolation / …）；
 *   · flow/guard.ts 的 EXIT_RULES —— 离开本相位的出口条件（pm 的 prd_path、pm verify 的
 *     verify_result、非 pm 的 pr_url …）。第二张表此前只有 `tenon check` 读，于是 pm 在 verify
 *     步既看不到 verify_result 也收不到对应 blocker，只能在 request-review 上空转。
 * 两张都取，投影层与转换强制层就读同一份声明。custom 轨的 guard 全在 step 上，返回空集。
 */
function nativeGuardFieldsOf(
  plan: EffectiveWorkflowPlan,
  state: PipelineState,
  exits: readonly StepExit[],
): readonly StepFieldRequirement[] {
  if (plan.capabilities.execution.model !== 'phase-manifest') return []
  const out: StepFieldRequirement[] = []
  const push = (item: { readonly field: string; readonly required?: readonly string[] }): void => {
    if (out.some((seen) => seen.field === item.field)) return
    out.push(item.required === undefined ? { field: item.field } : { field: item.field, required: item.required })
  }
  for (const exit of exits) {
    if (exit.direction === 'back') continue
    for (const item of defaultEventGuardFields(exit.event as EventName, state)) push(item)
  }
  for (const item of phaseExitGuardFields(state)) push(item)
  return out
}

/**
 * `pr_url` 在没有 git 远端的仓库里只有一个真值：`no-remote`（本地交付、没有 PR；`tenon set` 会
 * 复核仓库确实没有远端）。有远端时不推荐任何值——那得是真实的 PR URL。
 */
async function withPrUrlRecommendation(
  deps: CliDeps,
  fields: readonly StepFieldView[],
): Promise<readonly StepFieldView[]> {
  const index = fields.findIndex((field) => field.field === 'pr_url' && field.status === 'missing')
  if (index < 0 || !await repositoryHasNoRemote(deps)) return fields
  return fields.map((field, at) => at === index ? { ...field, recommended: PR_URL_NO_REMOTE } : field)
}

/** 完结收尾要的 git 事实；只在状态机已归档时才去问 git（活跃步骤的每次 status 不付这份开销）。 */
async function finishFacts(deps: CliDeps, name: string, state: PipelineState): Promise<StepFinishFacts> {
  const verified = str(state.fields.verify_result) === 'pass'
  if (str(state.fields.archived) !== 'true') return { git: null, verified }
  return { git: await (deps.gitFinishProbe?.(name) ?? Promise.resolve(null)), verified }
}

/**
 * 本步与下一步（前进边指向的步骤）声明的必需测试里未配置的那些。本步已通过的不算；下一步的测试
 * 还没有自己的证据，只看命令配没配。
 */
async function testConfigGaps(
  deps: CliDeps,
  plan: EffectiveWorkflowPlan,
  stepId: string,
  tests: readonly StepTestView[],
  exits: readonly StepExit[],
): Promise<readonly StepTestConfigGap[]> {
  const gaps: StepTestConfigGap[] = tests
    .filter((test) => test.required && test.status === 'unconfigured' && test.hint !== undefined)
    .map((test) => ({ id: test.id, step: stepId, hint: test.hint ?? '' }))
  const ahead = new Set(exits.filter((exit) => exit.direction === 'forward' && exit.to !== stepId).map((exit) => exit.to))
  for (const step of plan.workflow.steps) {
    if (!ahead.has(step.id)) continue
    for (const test of step.tests ?? []) {
      if (!test.required || gaps.some((gap) => gap.id === test.id)) continue
      const gap = await unconfiguredNpmScript(deps.cwd, test)
      if (gap !== undefined) {
        const hint = `${unconfiguredMessage(test.id, test.command, gap)}`
          + `（下一步 '${step.id}' 的必需测试，先在本步配置好）`
        gaps.push({ id: test.id, step: step.id, hint })
      }
    }
  }
  return gaps
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
  // 出边报告与技能分块共用同一份完成证据；两处各算一遍就是 check/transition 分歧的来源。
  const report = await evaluateStepExitReport(deps, name, dir, state, plan)
  const completed = report.completedSkillIds
  const skills = stepSkills(plan, stepId, report.skillSlots)
  const agents = await agentStepViews(deps, name, dir, state, plan, stepId)
  const testReport = await testEvidenceReaderFor(deps)({
    repoRoot: deps.cwd, changeDir: dir, changeName: name, plan, stepId,
    context: testEvidenceContextFor(deps, name),
  })
  const tests: readonly StepTestView[] = await Promise.all(testReport.items.map(async (item) => {
    // 还没通过、且命令要的 npm 脚本在项目里不存在：这是「未配置」，不是「未运行」——run-test 只会
    // 被拒，next 在步骤入口就把它作为待配置项提出来。
    const gap = item.status === 'passed' ? undefined : await unconfiguredNpmScript(deps.cwd, item.test)
    return {
      id: item.test.id,
      direction: item.test.direction,
      required: item.test.required,
      status: gap === undefined ? item.status : 'unconfigured',
      run_id: item.run?.run_id ?? null,
      ...(gap === undefined ? {} : { hint: unconfiguredMessage(item.test.id, item.test.command, gap) }),
    }
  }))
  const policy = plan.capabilities.documents.policy
  const documents = stepDocuments(name, policy, stepId, report.documents?.items ?? [])
  const artifacts = artifactFieldsOf(deps, state, step)
  const fields = await withPrUrlRecommendation(
    deps, stepFields(state, step, artifacts, nativeGuardFieldsOf(plan, state, report.exits)))
  const gateStatus = reviewGateStatus(state)
  const review = {
    status: gateStatus !== null && reviewGateMatches(state, stepId) ? gateStatus : 'none',
    event: gateStatus !== null && reviewGateMatches(state, stepId) ? reviewGateEvent(state) : null,
  }
  const specApply = await readSpecApplyReceiptStatus(deps.cwd, dir)
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
    archived: archived || str(state.fields.archived) === 'true',
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
      runArchived: str(state.fields.archived) === 'true',
      governedOpenspec: plan.capabilities.documents.governed,
      exits: report.exits,
      specRehearsalPending: !specApply.rehearsed,
      // 彩排与应用是两件事：`--dry-run` 也写同一份 result=pass 的回执，只认 result 就等于让一次
      // 彩排顶替一次应用，ship 于是去铺 applied-spec 骨架而不是真的把 delta 应用进主规格。
      specApplicationPending: !specApply.applied,
      ownsDeltaSpec: documents.records.some((doc) => doc.kind === 'delta-spec'),
      ownsAppliedSpec: documents.records.some((doc) => doc.kind === 'applied-spec'),
      artifactProducers: artifacts.size === 0 ? [] : effectiveArtifactProducers(deps, state),
      finish: await finishFacts(deps, name, state),
      testConfigGaps: await testConfigGaps(deps, plan, stepId, tests, report.exits),
    }),
  }
}

export { SPEC_APPLY_RECEIPT }
// 顺序表与它的输入面归 statusStepNext.ts；从这里转出，投影的消费方（测试、dashboard）只认一个入口。
export {
  stepNextActions, type StepAction, type StepFinishFacts, type StepMode, type StepNextInput, type StepTestView,
}
