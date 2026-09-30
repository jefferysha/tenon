/** Snapshot decoders for per-change run evidence: terminal activity, Todo, skill/agent runs, tests, documents. */
import type {
  AgentRunView, AgentRunsSnapshot, DocumentEvidenceSnapshot, PipelineTodoProjection,
  PipelineTodoStage, SkillRunsSnapshot, TerminalActivitySnapshot, TestItemSnapshot, TestItemStatus,
  TestRunSummary, TestStepSnapshot,
} from '../types'
import { isRecord, optionalString, stringArray } from './transport'

export function decodeActorName(value: unknown): { id: string; name: string } | null {
  return isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string' ? { id: value.id, name: value.name } : null
}

export function decodeTerminalActivity(value: unknown): TerminalActivitySnapshot | undefined {
  if (!isRecord(value)
    || typeof value.sessionId !== 'string'
    || typeof value.heartbeatAt !== 'string'
    || typeof value.expiresAt !== 'string'
    || !optionalString(value.turnId)) return undefined
  return {
    sessionId: value.sessionId,
    heartbeatAt: value.heartbeatAt,
    expiresAt: value.expiresAt,
    ...(value.turnId === undefined ? {} : { turnId: value.turnId }),
  }
}

export function decodeTodoStage(value: unknown): PipelineTodoStage | null {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.label !== 'string'
    || (value.status !== 'done' && value.status !== 'current' && value.status !== 'pending')
    || !Array.isArray(value.tasks)) return null
  const tasks = []
  for (const task of value.tasks) {
    if (!isRecord(task) || typeof task.text !== 'string' || typeof task.completed !== 'boolean') return null
    tasks.push({ text: task.text, completed: task.completed })
  }
  return { id: value.id, label: value.label, status: value.status, tasks }
}

export function decodeTodo(value: unknown): PipelineTodoProjection | undefined {
  if (!isRecord(value) || typeof value.hasTaskSource !== 'boolean' || !Array.isArray(value.stages)) return undefined
  const stages: PipelineTodoStage[] = []
  for (const stage of value.stages) {
    const decoded = decodeTodoStage(stage)
    if (!decoded) return undefined
    stages.push(decoded)
  }
  return { hasTaskSource: value.hasTaskSource, stages }
}

/** 服务端 skillRuns 投影：形状不合即整条 change 视为不可信（与其它可选字段同策略）。 */
export function decodeSkillRuns(value: unknown): SkillRunsSnapshot | undefined {
  if (!Array.isArray(value)) return undefined
  const steps: Array<SkillRunsSnapshot[number]> = []
  for (const step of value) {
    if (!isRecord(step) || typeof step.stepId !== 'string' || !Array.isArray(step.skills)) return undefined
    const skills: Array<SkillRunsSnapshot[number]['skills'][number]> = []
    for (const skill of step.skills) {
      if (!isRecord(skill) || typeof skill.id !== 'string' || skill.id === ''
        || (skill.status !== 'idle' && skill.status !== 'running' && skill.status !== 'done')
        || typeof skill.wave !== 'number' || !Number.isInteger(skill.wave) || skill.wave < 0) return undefined
      skills.push({ id: skill.id, status: skill.status, wave: skill.wave })
    }
    steps.push({ stepId: step.stepId, skills })
  }
  return steps
}

export const AGENT_STATES: readonly string[] = ['idle', 'running', 'done', 'stale']
export const AGENT_RESULTS: readonly string[] = ['pass', 'fail', 'done', 'failed']
export const AGENT_SEVERITIES: readonly string[] = ['critical', 'high', 'medium', 'low']

export function decodeAgentView(value: unknown): AgentRunView | null {
  if (!isRecord(value) || typeof value.agent !== 'string' || value.agent === ''
    || (value.role !== 'executor' && value.role !== 'reviewer')
    || typeof value.required !== 'boolean'
    || (value.blockAt !== undefined && (typeof value.blockAt !== 'string' || !AGENT_SEVERITIES.includes(value.blockAt)))
    || !stringArray(value.dependsOn) || !stringArray(value.readsTests)
    || typeof value.state !== 'string' || !AGENT_STATES.includes(value.state)
    || (value.result !== null && (typeof value.result !== 'string' || !AGENT_RESULTS.includes(value.result)))
    || typeof value.findings !== 'number' || !Number.isInteger(value.findings) || value.findings < 0
    || typeof value.blocking !== 'number' || !Number.isInteger(value.blocking) || value.blocking < 0
    || (value.runId !== null && typeof value.runId !== 'string')
    || (value.reportPath !== null && typeof value.reportPath !== 'string')
    || (value.finishedAt !== null && typeof value.finishedAt !== 'string')
    || (value.reruns !== undefined && (typeof value.reruns !== 'number' || !Number.isInteger(value.reruns) || value.reruns < 0))
    || (value.flipped !== undefined && typeof value.flipped !== 'boolean')
    || (value.rerunReason !== undefined && value.rerunReason !== null && typeof value.rerunReason !== 'string')) return null
  const actor = value.actor
  let actorView: AgentRunView['actor'] = null
  if (actor !== null) {
    if (!isRecord(actor) || typeof actor.id !== 'string' || typeof actor.name !== 'string') return null
    actorView = { id: actor.id, name: actor.name }
  }
  return {
    agent: value.agent,
    role: value.role,
    required: value.required,
    ...(value.blockAt === undefined ? {} : { blockAt: value.blockAt as AgentRunView['blockAt'] }),
    dependsOn: value.dependsOn,
    readsTests: value.readsTests,
    state: value.state as AgentRunView['state'],
    result: value.result as AgentRunView['result'],
    findings: value.findings,
    blocking: value.blocking,
    runId: value.runId,
    reportPath: value.reportPath,
    actor: actorView,
    finishedAt: value.finishedAt,
    ...(value.reruns === undefined ? {} : { reruns: value.reruns as number }),
    ...(value.flipped === undefined ? {} : { flipped: value.flipped as boolean }),
    ...(value.rerunReason === undefined ? {} : { rerunReason: value.rerunReason as string | null }),
  }
}

/** 服务端 agentRuns 投影：形状不合即整条 change 视为不可信（同 skillRuns 策略）。 */
export function decodeAgentRuns(value: unknown): AgentRunsSnapshot | undefined {
  if (!Array.isArray(value)) return undefined
  const steps: Array<AgentRunsSnapshot[number]> = []
  for (const step of value) {
    if (!isRecord(step) || typeof step.stepId !== 'string' || step.stepId === '' || !Array.isArray(step.agents)) return undefined
    const agents: AgentRunView[] = []
    for (const agent of step.agents) {
      const decoded = decodeAgentView(agent)
      if (decoded === null) return undefined
      agents.push(decoded)
    }
    steps.push({ stepId: step.stepId, agents })
  }
  return steps
}

export const TEST_STATUSES: readonly string[] = ['passed', 'failed', 'stale', 'missing', 'running']

/** 服务端 tests 投影：状态不在闭集或形状不合即整条 change 视为不可信（同 skillRuns 策略）。 */
export function decodeTests(value: unknown): TestStepSnapshot[] | undefined {
  if (!Array.isArray(value)) return undefined
  const steps: TestStepSnapshot[] = []
  for (const step of value) {
    if (!isRecord(step) || typeof step.stepId !== 'string' || step.stepId === '' || !Array.isArray(step.items)) return undefined
    const items: TestItemSnapshot[] = []
    for (const item of step.items) {
      if (!isRecord(item) || typeof item.id !== 'string' || item.id === ''
        || typeof item.direction !== 'string' || item.direction === ''
        || typeof item.required !== 'boolean'
        || typeof item.status !== 'string' || !TEST_STATUSES.includes(item.status)
        || (item.label !== undefined && (typeof item.label !== 'string' || item.label === ''))) return undefined
      const run = item.run === undefined ? undefined : decodeTestRun(item.run)
      if (item.run !== undefined && run === undefined) return undefined
      items.push({
        id: item.id,
        ...(item.label === undefined ? {} : { label: item.label }),
        direction: item.direction,
        required: item.required,
        status: item.status as TestItemStatus,
        ...(run === undefined ? {} : { run }),
      })
    }
    steps.push({ stepId: step.stepId, items })
  }
  return steps
}

export function decodeTestRun(value: unknown): TestRunSummary | undefined {
  if (!isRecord(value) || typeof value.runId !== 'string' || value.runId === ''
    || typeof value.user !== 'string' || !isRecord(value.actor)
    || typeof value.actor.id !== 'string' || typeof value.actor.name !== 'string'
    || (value.result !== 'pass' && value.result !== 'fail')
    || (value.exitCode !== null && typeof value.exitCode !== 'number')
    || typeof value.durationMs !== 'number' || typeof value.finishedAt !== 'string'
    || !stringArray(value.reasons)) return undefined
  return {
    runId: value.runId,
    user: value.user,
    actor: { id: value.actor.id, name: value.actor.name },
    result: value.result,
    exitCode: value.exitCode === null ? null : value.exitCode,
    durationMs: value.durationMs,
    finishedAt: value.finishedAt,
    reasons: value.reasons,
  }
}

export function decodeDocuments(value: unknown): DocumentEvidenceSnapshot | undefined {
  if (!isRecord(value) || typeof value.governed !== 'boolean' || !stringArray(value.blockers) || !Array.isArray(value.items)) {
    return undefined
  }
  const items: DocumentEvidenceSnapshot['items'] = []
  for (const item of value.items) {
    if (!isRecord(item)
      || typeof item.kind !== 'string'
      || !['recorded', 'missing', 'stale', 'unread'].includes(String(item.status))
      || typeof item.requiredRead !== 'boolean'
      || !stringArray(item.paths)
      || !stringArray(item.producers)) return undefined
    const timeline = item.timeline === undefined ? undefined : Array.isArray(item.timeline) && item.timeline.every((entry) => isRecord(entry) && typeof entry.producer === 'string' && typeof entry.recordedAt === 'string' && optionalString(entry.readAt) && (entry.actor === undefined || decodeActorName(entry.actor) !== null))
      ? item.timeline.map((entry) => {
        const actor = decodeActorName(entry.actor)
        return { producer: entry.producer as string, recordedAt: entry.recordedAt as string, ...(typeof entry.readAt === 'string' ? { readAt: entry.readAt } : {}), ...(actor === null ? {} : { actor }) }
      })
      : undefined
    if (item.timeline !== undefined && timeline === undefined) return undefined
    const status = item.status
    if (status !== 'recorded' && status !== 'missing' && status !== 'stale' && status !== 'unread') return undefined
    const reason = item.reason
    if (reason !== undefined && reason !== 'changed' && reason !== 'producer' && reason !== 'invocation' && reason !== 'legacy-path') return undefined
    items.push({
      kind: item.kind,
      status,
      ...(reason === undefined ? {} : { reason }),
      requiredRead: item.requiredRead,
      paths: item.paths,
      producers: item.producers,
      ...(timeline === undefined ? {} : { timeline }),
    })
  }
  return {
    governed: value.governed,
    ...(typeof value.phase === 'string' ? { phase: value.phase } : {}),
    ...(typeof value.ledgerPresent === 'boolean' ? { ledgerPresent: value.ledgerPresent } : {}),
    ...(typeof value.pass === 'boolean' ? { pass: value.pass } : {}),
    blockers: value.blockers,
    items,
  }
}
