/**
 * 编排总览的两个读用例：工作流定义（工作流页，按轨道选分支）与任务（工作台，读任务冻结的计划 + 运行状态）。
 *
 * 编排本身归 kernel buildOrchestration；这里只负责拿到对的计划，再把运行状态按与 `tenon status` 同一份判定
 * 贴到条目上：技能 = 技能门的判定（judgeStepSkillsFromHistory）+ skill-order 的前置；执行者 / 评审者 =
 * projectAgentRuns；测试 = projectTestEvidence（与快照、转换拦截同源）。快照不带这些数据，轮询不因此变慢。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  HISTORY_FILE,
  buildOrchestration, compileEffectiveWorkflowPlan, completedWorkflowSkillsSinceStepEntry,
  documentRecordsInCurrentStepVisit, judgeStepSkillsFromHistory, manifestSkillOverlay, orderSkillSlots,
  pendingSkillDocumentKinds, planEffectiveIo, skillSlotStatuses,
  type AgentView, type EffectiveSkillResolver, type EffectiveWorkflowPlan, type OrchestrationEntry,
  type OrchestrationStage, type PipelineState, type TenonUser, type TrackDefinition, type WorkflowDef,
  type WorkflowEffectiveIo, type WorkflowOrchestration,
} from '@tenon/kernel'
import { projectAgentRuns, type AgentRunsSnapshot } from './agentRuns.js'
import { projectTestEvidence } from './testEvidenceSnapshot.js'
import type { TestStepSnapshot } from './types.js'

/** 工作台节点的四态：运行中 / 完成 / 等待 / 失败。 */
export type OrchestrationRunStatus = 'running' | 'done' | 'waiting' | 'failed'

export interface DefinitionOrchestrationResponse extends WorkflowOrchestration {
  readonly workflow: string
  readonly track: string | null
  /** 每步 manifest 叠加的必需技能 token；编辑器画草稿时与声明技能合并（同一个 kernel orchestrate）。 */
  readonly overlay: Readonly<Record<string, readonly string[]>>
}

export interface ChangeOrchestrationEntry extends OrchestrationEntry {
  readonly status: OrchestrationRunStatus
}

export interface ChangeOrchestrationStage extends Omit<OrchestrationStage, 'entries'> {
  readonly entries: readonly ChangeOrchestrationEntry[]
}

export interface ChangeOrchestrationResponse {
  readonly change: string
  readonly workflow: string
  readonly track: string | null
  /** 任务当前所在阶段。 */
  readonly current: string
  readonly stages: readonly ChangeOrchestrationStage[]
  readonly returns: WorkflowOrchestration['returns']
  readonly flows: WorkflowOrchestration['flows']
  /** 冻结计划物化的每步输入 / 输出（工作台 IO 表读它，不读当前定义）。 */
  readonly io: WorkflowEffectiveIo
}

export function definitionOrchestration(input: {
  readonly name: string
  readonly definition: WorkflowDef
  readonly track: TrackDefinition | undefined
  readonly resolver: EffectiveSkillResolver | undefined
}): DefinitionOrchestrationResponse {
  const plan = compileEffectiveWorkflowPlan(input.name, input.definition, input.track)
  return {
    workflow: input.name,
    track: input.track?.id ?? null,
    ...buildOrchestration(plan, input.resolver),
    overlay: manifestSkillOverlay(plan, input.resolver),
  }
}

/** 运行事实：当前阶段技能的状态（按条目 id）、各步 agent 投影、各步测试证据。 */
export interface ChangeRunFacts {
  readonly phase: string
  readonly archived: boolean
  readonly skills: ReadonlyMap<string, OrchestrationRunStatus>
  readonly agents: AgentRunsSnapshot
  readonly tests: readonly TestStepSnapshot[]
}

function agentStatus(view: AgentView | undefined): OrchestrationRunStatus {
  if (view === undefined) return 'waiting'
  if (view.state === 'running') return 'running'
  if (view.state !== 'done') return 'waiting'
  return view.result === 'fail' || view.result === 'failed' ? 'failed' : 'done'
}

function testStatus(status: TestStepSnapshot['items'][number]['status'] | undefined): OrchestrationRunStatus {
  if (status === 'passed') return 'done'
  if (status === 'failed') return 'failed'
  if (status === 'running') return 'running'
  return 'waiting'
}

/**
 * 把运行事实贴到编排条目上。更早的阶段技能一律完成，更晚的阶段一律等待；当前阶段按事实。已归档的任务
 * 当前阶段也算完成。执行者、评审者、测试在更早阶段显示它们最后一次访问留下的结论。
 */
export function withRunStatus(
  orchestration: WorkflowOrchestration,
  facts: ChangeRunFacts,
): readonly ChangeOrchestrationStage[] {
  const current = orchestration.stages.findIndex((stage) => stage.id === facts.phase)
  return orchestration.stages.map((stage, index) => {
    const agents = facts.agents.find((step) => step.stepId === stage.id)?.agents ?? []
    const tests = facts.tests.find((step) => step.stepId === stage.id)?.items ?? []
    const past = current >= 0 && (index < current || (index === current && facts.archived))
    const future = current < 0 || index > current
    return {
      ...stage,
      entries: stage.entries.map((entry): ChangeOrchestrationEntry => {
        if (future) return { ...entry, status: 'waiting' }
        if (entry.kind === 'skill') return { ...entry, status: past ? 'done' : facts.skills.get(entry.id) ?? 'waiting' }
        if (entry.kind === 'test') return { ...entry, status: testStatus(tests.find((item) => item.id === entry.id)?.status) }
        return { ...entry, status: agentStatus(agents.find((view) => view.agent === entry.id)) }
      }),
    }
  })
}

async function historyRaw(changeDir: string): Promise<string> {
  try {
    return await readFile(join(changeDir, HISTORY_FILE), 'utf8')
  } catch (error) {
    if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT') return ''
    throw error
  }
}

/**
 * 当前阶段技能的状态：必需槽位走技能门的判定与 skill-order 的前置（done / invoked→running /
 * ready·waiting→waiting）；OpenSpec 注入的技能看它在本次步骤访问里是否已登记完绑定给它的文档。
 */
async function currentSkillStatuses(input: {
  readonly plan: EffectiveWorkflowPlan
  readonly orchestration: WorkflowOrchestration
  readonly phase: string
  readonly changeDir: string
  readonly resolver: EffectiveSkillResolver | undefined
}): Promise<ReadonlyMap<string, OrchestrationRunStatus>> {
  const { plan, phase, changeDir } = input
  const out = new Map<string, OrchestrationRunStatus>()
  const capability = plan.capabilities.skills
  const step = capability.steps.find((candidate) => candidate.stepId === phase)
  if (step === undefined) return out
  const policy = plan.capabilities.documents.policy
  const judgement = await judgeStepSkillsFromHistory({
    resolver: input.resolver,
    capability,
    stepId: phase,
    changeDir,
    completed: new Set(completedWorkflowSkillsSinceStepEntry(await historyRaw(changeDir), phase)),
    documentPolicy: policy,
  })
  const ordered = orderSkillSlots(judgement.slots.map((slot) => ({ token: slot.token, alternatives: slot.token.split('|') })), step.declared)
  skillSlotStatuses(ordered, judgement.slots).forEach((status, index) => {
    const token = judgement.slots[index]?.token
    if (token !== undefined) out.set(token, status === 'done' ? 'done' : status === 'invoked' ? 'running' : 'waiting')
  })
  const injected = input.orchestration.stages.find((stage) => stage.id === phase)?.entries
    .filter((entry) => entry.kind === 'skill' && entry.source === 'openspec') ?? []
  if (injected.length > 0 && policy !== undefined) {
    const visit = await documentRecordsInCurrentStepVisit(changeDir)
    for (const entry of injected) {
      out.set(entry.id, pendingSkillDocumentKinds(policy, phase, entry.id, visit).length === 0 ? 'done' : 'waiting')
    }
  }
  return out
}

export async function changeOrchestration(input: {
  readonly root: string
  readonly changeDir: string
  readonly changeName: string
  readonly state: PipelineState
  readonly plan: EffectiveWorkflowPlan
  readonly resolver: EffectiveSkillResolver | undefined
  readonly user: TenonUser | undefined
  readonly candidate: (() => Promise<string | undefined>) | undefined
}): Promise<ChangeOrchestrationResponse> {
  const { plan, state } = input
  const phaseValue = state.fields.phase
  const phase = Array.isArray(phaseValue) ? phaseValue.join(',') : phaseValue ?? ''
  const archivedValue = state.fields.archived
  const archived = (Array.isArray(archivedValue) ? archivedValue.join(',') : archivedValue ?? '') === 'true'
  const io = planEffectiveIo(plan)
  const orchestration = buildOrchestration(plan, input.resolver, io)
  const [skills, agents, tests] = await Promise.all([
    currentSkillStatuses({ plan, orchestration, phase, changeDir: input.changeDir, resolver: input.resolver }),
    projectAgentRuns({
      changeDir: input.changeDir,
      plan,
      state,
      phase,
      ...(input.candidate === undefined ? {} : { candidate: input.candidate }),
    }),
    projectTestEvidence({
      root: input.root,
      changeDir: input.changeDir,
      changeName: input.changeName,
      plan,
      user: input.user,
      ...(input.candidate === undefined ? {} : { candidate: input.candidate }),
    }),
  ])
  const trackValue = state.fields.track
  const track = Array.isArray(trackValue) ? trackValue.join(',') : trackValue ?? ''
  return {
    change: input.changeName,
    workflow: plan.id,
    track: track === '' ? null : track,
    current: phase,
    stages: withRunStatus(orchestration, { phase, archived, skills, agents, tests: tests.tests ?? [] }),
    returns: orchestration.returns,
    flows: orchestration.flows,
    io,
  }
}
