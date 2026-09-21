import type {
  ArchivedChangeSnapshot,
  ChangeSnapshot,
  DocumentEvidenceSnapshot,
  PipelineTodoProjection,
  PipelineTodoStage,
  ProjectRepositoryIdentity,
  ProjectSnapshot,
  ReviewHandshakeSnapshot,
  Snapshot,
  TerminalActivitySnapshot,
  TransitionReadinessBlockerSnapshot,
  SkillRunsSnapshot,
  AgentRunsSnapshot,
  AgentRunView,
  TestItemSnapshot,
  TestItemStatus,
  TestRunSummary,
  TestStepSnapshot,
} from '../types'
import { isRecord, optionalString, recordOfBooleans, stringArray } from './transport'
import { decodeWorkflowPolicyRules } from './workflowPolicySnapshotDecoder'

function decodeTerminalActivity(value: unknown): TerminalActivitySnapshot | undefined {
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

function decodeTodoStage(value: unknown): PipelineTodoStage | null {
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

function decodeTodo(value: unknown): PipelineTodoProjection | undefined {
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
function decodeSkillRuns(value: unknown): SkillRunsSnapshot | undefined {
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

const AGENT_STATES: readonly string[] = ['idle', 'running', 'done', 'stale']
const AGENT_RESULTS: readonly string[] = ['pass', 'fail', 'done', 'failed']
const AGENT_SEVERITIES: readonly string[] = ['critical', 'high', 'medium', 'low']

function decodeAgentView(value: unknown): AgentRunView | null {
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
    || (value.finishedAt !== null && typeof value.finishedAt !== 'string')) return null
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
  }
}

/** 服务端 agentRuns 投影：形状不合即整条 change 视为不可信（同 skillRuns 策略）。 */
function decodeAgentRuns(value: unknown): AgentRunsSnapshot | undefined {
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

const TEST_STATUSES: readonly string[] = ['passed', 'failed', 'stale', 'missing', 'running']

/** 服务端 tests 投影：状态不在闭集或形状不合即整条 change 视为不可信（同 skillRuns 策略）。 */
function decodeTests(value: unknown): TestStepSnapshot[] | undefined {
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

function decodeTestRun(value: unknown): TestRunSummary | undefined {
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

function decodeDocuments(value: unknown): DocumentEvidenceSnapshot | undefined {
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

function decodeFields(value: unknown): Record<string, string | string[]> | null {
  if (!isRecord(value)) return null
  const fields: Record<string, string | string[]> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') fields[key] = item
    else if (stringArray(item)) fields[key] = item
    else return null
  }
  return fields
}

function decodeReviewHandshake(
  value: unknown,
  rules: ChangeSnapshot['workflowRules'],
  currentStep: string,
): ReviewHandshakeSnapshot | null {
  if (!isRecord(value)) return null
  if (value.status === 'not-requested') {
    return exactKeys(value, ['status']) ? { status: 'not-requested' } : null
  }
  if (
    rules.gateByStep[currentStep] !== 'review'
    || (value.status !== 'pending' && value.status !== 'approved')
    || typeof value.event !== 'string'
    || value.event === ''
    || !(rules.transitions[currentStep] ?? []).some((edge) => edge.event === value.event)
    || typeof value.requestedAt !== 'string'
    || value.requestedAt === ''
  ) return null
  if (value.status === 'pending') {
    return exactKeys(value, ['status', 'event', 'requestedAt'])
      ? { status: 'pending', event: value.event, requestedAt: value.requestedAt }
      : null
  }
  if (
    typeof value.acknowledgedAt !== 'string'
    || value.acknowledgedAt === ''
    || !exactKeys(value, ['status', 'event', 'requestedAt', 'acknowledgedAt'])
  ) return null
  return {
    status: 'approved',
    event: value.event,
    requestedAt: value.requestedAt,
    acknowledgedAt: value.acknowledgedAt,
  }
}

function decodeActorName(value: unknown): { id: string; name: string } | null {
  return isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string' ? { id: value.id, name: value.name } : null
}

/** `owner` / `creator` are required keys: null for legacy values, otherwise an exact `{id,name,slug}`. */
function decodeUserRefKey(value: Record<string, unknown>, key: 'owner' | 'creator'): import('../types').UserRefView | null | undefined {
  if (!(key in value)) return undefined
  const ref = value[key]
  if (ref === null) return null
  if (!isRecord(ref) || Object.keys(ref).length !== 3 || typeof ref.id !== 'string' || typeof ref.name !== 'string' || typeof ref.slug !== 'string') return undefined
  return { id: ref.id, name: ref.name, slug: ref.slug }
}

function decodeChange(value: unknown): ChangeSnapshot | null {
  if (!isRecord(value)) return null
  const fields = decodeFields(value.fields)
  const workflowRules = decodeWorkflowRules(value.workflowRules)
  const workflowExecution = decodeWorkflowExecution(value.workflowExecution, workflowRules, value.phase)
  const owner = decodeUserRefKey(value, 'owner')
  const creator = decodeUserRefKey(value, 'creator')
  if (typeof value.name !== 'string'
    || typeof value.path !== 'string'
    || typeof value.phase !== 'string'
    || typeof value.phase_status !== 'string'
    || typeof value.track !== 'string'
    || typeof value.preset !== 'string'
    || typeof value.archived !== 'string'
    || typeof value.updated_at !== 'string'
    || typeof value.workflowPlanFingerprint !== 'string'
    || !/^[0-9a-f]{64}$/.test(value.workflowPlanFingerprint)
    || workflowRules === null
    || workflowExecution === null
    || !workflowRules.steps.includes(value.phase)
    || !fields
    || owner === undefined
    || creator === undefined) return null
  const reviewHandshake = value.reviewHandshake === undefined
    ? undefined
    : decodeReviewHandshake(value.reviewHandshake, workflowRules, value.phase)
  const todo = value.todo === undefined ? undefined : decodeTodo(value.todo)
  const documents = value.documents === undefined ? undefined : decodeDocuments(value.documents)
  const terminalActivity = value.terminalActivity === undefined ? undefined : decodeTerminalActivity(value.terminalActivity)
  const skillRuns = value.skillRuns === undefined ? undefined : decodeSkillRuns(value.skillRuns)
  const agentRuns = value.agentRuns === undefined ? undefined : decodeAgentRuns(value.agentRuns)
  const tests = value.tests === undefined ? undefined : decodeTests(value.tests)
  const testDiagnostics = value.testDiagnostics === undefined
    ? undefined
    : stringArray(value.testDiagnostics) ? value.testDiagnostics : undefined
  if ((value.tests !== undefined && !tests)
    || (value.testDiagnostics !== undefined && !testDiagnostics)
    || (value.reviewHandshake !== undefined && !reviewHandshake)
    || (value.todo !== undefined && !todo)
    || (value.documents !== undefined && !documents)
    || (value.terminalActivity !== undefined && !terminalActivity)
    || (value.skillRuns !== undefined && !skillRuns)
    || (value.agentRuns !== undefined && !agentRuns)) return null
  return {
    name: value.name,
    path: value.path,
    phase: value.phase,
    phase_status: value.phase_status,
    track: value.track,
    preset: value.preset,
    archived: value.archived,
    updated_at: value.updated_at,
    fields,
    owner,
    creator,
    workflowPlanFingerprint: value.workflowPlanFingerprint,
    workflowRules,
    workflowExecution,
    ...(reviewHandshake ? { reviewHandshake } : {}),
    ...(todo ? { todo } : {}),
    ...(documents ? { documents } : {}),
    ...(terminalActivity ? { terminalActivity } : {}),
    ...(skillRuns ? { skillRuns } : {}),
    ...(agentRuns ? { agentRuns } : {}),
    ...(tests ? { tests } : {}),
    ...(testDiagnostics ? { testDiagnostics } : {}),
  }
}

function uniqueNonemptyStrings(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length === new Set(value).size
    && value.every((item) => typeof item === 'string' && item !== '')
}

function exactKeys(value: Record<string, unknown>, steps: readonly string[]): boolean {
  const keys = Object.keys(value).sort()
  return keys.length === steps.length && keys.every((key, index) => key === [...steps].sort()[index])
}

function decodeWorkflowRules(value: unknown): ChangeSnapshot['workflowRules'] | null {
  if (!isRecord(value)
    || (value.executionModel !== 'phase-manifest' && value.executionModel !== 'step-graph')
    || !uniqueNonemptyStrings(value.steps)
    || !isRecord(value.transitions)
    || !isRecord(value.gateByStep)
    || !isRecord(value.labelByStep)
    || !isRecord(value.outputsByStep)) return null
  const steps = [...value.steps]
  const stepSet = new Set(steps)
  if (!exactKeys(value.transitions, steps)
    || !exactKeys(value.gateByStep, steps)
    || !exactKeys(value.labelByStep, steps)
    || !exactKeys(value.outputsByStep, steps)
  ) return null
  const transitions: Record<string, Array<{ event: string; to: string }>> = {}
  for (const step of steps) {
    const edges = value.transitions[step]
    if (!Array.isArray(edges)) return null
    const events = new Set<string>()
    const decodedEdges: Array<{ event: string; to: string }> = []
    for (const edge of edges) {
      if (!isRecord(edge)
        || typeof edge.event !== 'string'
        || edge.event === ''
        || events.has(edge.event)
        || typeof edge.to !== 'string'
        || !stepSet.has(edge.to)) return null
      events.add(edge.event)
      decodedEdges.push({ event: edge.event, to: edge.to })
    }
    transitions[step] = decodedEdges
  }
  if (!Object.values(value.gateByStep).every(
    (gate) => gate === null || gate === 'review' || gate === 'auto',
  ) || !Object.values(value.labelByStep).every((label) => typeof label === 'string' && label !== '')) return null
  const outputsByStep: Record<string, string[]> = {}
  for (const step of steps) {
    const outputs = value.outputsByStep[step]
    if (!Array.isArray(outputs) || outputs.length !== new Set(outputs).size
      || !outputs.every((output) => typeof output === 'string' && output !== '')) return null
    outputsByStep[step] = [...outputs] as string[]
  }
  const policy = value.policy === undefined ? undefined : decodeWorkflowPolicyRules(value.policy)
  if (policy === null) return null
  return {
    executionModel: value.executionModel,
    steps,
    transitions,
    gateByStep: value.gateByStep as Record<string, 'review' | 'auto' | null>,
    labelByStep: value.labelByStep as Record<string, string>,
    outputsByStep,
    ...(policy === undefined ? {} : { policy }),
  }
}

function decodeWorkflowExecution(
  value: unknown,
  rules: ChangeSnapshot['workflowRules'] | null,
  currentStep: unknown,
): ChangeSnapshot['workflowExecution'] | null {
  if (rules === null
    || typeof currentStep !== 'string'
    || !rules.steps.includes(currentStep)
    || !isRecord(value)
    || !isRecord(value.readinessByTransition)) return null
  const readinessSteps = Object.keys(value.readinessByTransition)
  if (!(exactKeys(value.readinessByTransition, rules.steps)
    || (readinessSteps.length === 1 && readinessSteps[0] === currentStep))) return null
  const readinessByTransition: ChangeSnapshot['workflowExecution']['readinessByTransition'] = {}
  for (const step of readinessSteps) {
    const byEvent = value.readinessByTransition[step]
    if (!isRecord(byEvent)) return null
    const events = (rules.transitions[step] ?? []).map((transition) => transition.event)
    if (!exactKeys(byEvent, events)) return null
    readinessByTransition[step] = {}
    for (const event of events) {
      const readiness = byEvent[event]
      if (!isRecord(readiness)
        || typeof readiness.ready !== 'boolean'
        || !Array.isArray(readiness.blockers)
        || !Object.keys(readiness).every((key) => key === 'ready' || key === 'blockers')) return null
      const blockers: TransitionReadinessBlockerSnapshot[] = []
      for (const candidate of readiness.blockers) {
        const blocker = decodeTransitionReadinessBlocker(candidate)
        if (blocker === null) return null
        blockers.push(blocker)
      }
      if (readiness.ready !== (blockers.length === 0)
        || new Set(blockers.map((blocker) => JSON.stringify(blocker))).size !== blockers.length) return null
      readinessByTransition[step][event] = { ready: readiness.ready, blockers }
    }
  }
  return { readinessByTransition }
}

const GUARD_TYPES = new Set([
  'tasks-at-least',
  'field-nonempty',
  'output-present',
  'file-exists',
  'field-equals',
  'field-in',
  'full-direct-override',
  'build-head-unchanged',
  'spec-migration-applied',
])
const GUARD_CAPABILITIES = new Set([
  'readText', 'fileExists', 'gitHeadSha', 'workspaceFingerprint', 'specMigrationStatus',
])
const AGENT_BLOCKER_REASONS = new Set([
  'executor-missing', 'executor-running', 'executor-failed',
  'reviewer-missing', 'reviewer-running', 'reviewer-stale', 'reviewer-failed',
  'agent-records-invalid',
])

function decodeTransitionReadinessBlocker(value: unknown): TransitionReadinessBlockerSnapshot | null {
  if (!isRecord(value)) return null
  if (value.kind === 'verify-build-revision-untrusted') {
    const reasons = new Set([
      'missing', 'null', 'ambiguous', 'malformed', 'isolation-mismatch',
      'capability-unavailable', 'provenance-missing', 'provenance-mismatch',
      'state-stale', 'revision-stale', 'project-mismatch', 'worktree-mismatch',
      'evaluation-error',
    ])
    if (value.code !== 'verify-build-revision-untrusted'
      || typeof value.reason !== 'string' || !reasons.has(value.reason)
      || value.remediation !== 'return-to-build-and-capture-current-revision'
      || (value.stateHash !== undefined && (typeof value.stateHash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.stateHash)))
      || (value.revisionHash !== undefined && (typeof value.revisionHash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.revisionHash)))
      || !Object.keys(value).every((key) =>
        key === 'kind' || key === 'code' || key === 'reason' || key === 'remediation'
        || key === 'stateHash' || key === 'revisionHash')) return null
    return {
      kind: 'verify-build-revision-untrusted',
      code: 'verify-build-revision-untrusted',
      reason: value.reason as 'missing' | 'null' | 'ambiguous' | 'malformed' | 'isolation-mismatch'
        | 'capability-unavailable' | 'provenance-missing' | 'provenance-mismatch'
        | 'state-stale' | 'revision-stale' | 'project-mismatch' | 'worktree-mismatch'
        | 'evaluation-error',
      remediation: 'return-to-build-and-capture-current-revision',
      ...(value.stateHash === undefined ? {} : { stateHash: value.stateHash }),
      ...(value.revisionHash === undefined ? {} : { revisionHash: value.revisionHash }),
    }
  }
  // agent 阻断不挂在某个 guard 上（它不是 guard），所以在 guardType 校验之前判。
  if (value.kind === 'agents-incomplete') {
    if (!Array.isArray(value.agents)
      || !Object.keys(value).every((key) => key === 'kind' || key === 'agents')) return null
    const agents: { agent: string; reason: string }[] = []
    for (const item of value.agents) {
      if (!isRecord(item) || typeof item.agent !== 'string' || typeof item.reason !== 'string'
        || !AGENT_BLOCKER_REASONS.has(item.reason)
        || !Object.keys(item).every((key) => key === 'agent' || key === 'reason')) return null
      agents.push({ agent: item.agent, reason: item.reason })
    }
    return { kind: 'agents-incomplete', agents }
  }
  if (typeof value.guardType !== 'string' || !GUARD_TYPES.has(value.guardType)) return null
  if (value.kind === 'evaluation-error') {
    if ((value.capability !== undefined
        && (typeof value.capability !== 'string' || !GUARD_CAPABILITIES.has(value.capability)))
      || !Object.keys(value).every((key) =>
        key === 'kind' || key === 'guardType' || key === 'capability')) return null
    return {
      kind: 'evaluation-error',
      guardType: value.guardType,
      ...(value.capability === undefined ? {} : { capability: value.capability as string }),
    }
  }
  if (value.kind === 'capability-unavailable') {
    if (typeof value.capability !== 'string'
      || !GUARD_CAPABILITIES.has(value.capability)
      || !Object.keys(value).every((key) =>
        key === 'kind' || key === 'guardType' || key === 'capability')) return null
    return {
      kind: 'capability-unavailable',
      guardType: value.guardType,
      capability: value.capability,
    }
  }
  if (value.kind !== 'guard-failed'
    || !optionalString(value.field)
    || !optionalString(value.actual)
    || (value.expected !== undefined && !uniqueNonemptyStrings(value.expected))
    || !Object.keys(value).every((key) =>
      key === 'kind' || key === 'guardType' || key === 'field' || key === 'actual' || key === 'expected')) return null
  return {
    kind: 'guard-failed',
    guardType: value.guardType,
    ...(value.field === undefined ? {} : { field: value.field }),
    ...(value.actual === undefined ? {} : { actual: value.actual }),
    ...(value.expected === undefined ? {} : { expected: [...value.expected] as string[] }),
  }
}

function workflowRulesSemanticKey(rules: ChangeSnapshot['workflowRules']): string {
  return JSON.stringify({
    executionModel: rules.executionModel,
    steps: rules.steps,
    stepRules: rules.steps.map((step) => ({
      step,
      transitions: rules.transitions[step] ?? [],
      gate: rules.gateByStep[step],
      outputs: rules.outputsByStep[step] ?? [],
    })),
    labels: Object.entries(rules.labelByStep ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    policy: rules.policy,
  })
}

function decodeRepositoryIdentity(value: unknown): ProjectRepositoryIdentity | null {
  if (!isRecord(value)
    || !exactKeys(value, ['id', 'label', 'workspace_kind'])
    || typeof value.id !== 'string'
    || !/^[0-9a-f]{64}$/.test(value.id)
    || typeof value.label !== 'string'
    || value.label.length === 0
    || value.label.length > 255
    || value.label.includes('/')
    || (value.workspace_kind !== 'primary' && value.workspace_kind !== 'worktree')) return null
  return {
    id: value.id,
    label: value.label,
    workspace_kind: value.workspace_kind,
  }
}

function decodeProject(value: unknown): ProjectSnapshot | null {
  if (!isRecord(value)
    || typeof value.root !== 'string'
    || typeof value.ok !== 'boolean'
    || !optionalString(value.error)
    || !Array.isArray(value.changes)) return null
  const repository = value.repository === undefined ? undefined : decodeRepositoryIdentity(value.repository)
  if (repository === null) return null
  const compatibilityIssues = value.compatibilityIssues === undefined
    ? undefined
    : decodeCompatibilityIssues(value.compatibilityIssues)
  if (compatibilityIssues === null) return null
  const compatibilityIssuesTruncated = value.compatibilityIssuesTruncated === undefined
    ? undefined
    : value.compatibilityIssuesTruncated === true
      ? true
      : null
  if (compatibilityIssuesTruncated === null
    || (compatibilityIssuesTruncated && compatibilityIssues?.length !== 100)) return null
  if (value.ok && (
    value.error !== undefined
    || compatibilityIssuesTruncated
    || (compatibilityIssues?.some((issue) => issue.severity !== 'warning'))
  )) return null
  const changes: ChangeSnapshot[] = []
  const rulesByFingerprint = new Map<string, string>()
  for (const change of value.changes) {
    const decoded = decodeChange(change)
    if (!decoded) return null
    const semanticKey = workflowRulesSemanticKey(decoded.workflowRules)
    const existing = rulesByFingerprint.get(decoded.workflowPlanFingerprint)
    if (existing !== undefined && existing !== semanticKey) return null
    rulesByFingerprint.set(decoded.workflowPlanFingerprint, semanticKey)
    changes.push(decoded)
  }
  const archived = value.archived === undefined ? undefined : decodeArchivedChanges(value.archived)
  if (archived === null) return null
  const uncommittedDeletions = decodeDeletionCount(value.uncommittedDeletions)
  if (uncommittedDeletions === null) return null
  return {
    root: value.root,
    ok: value.ok,
    changes,
    ...(archived === undefined ? {} : { archived }),
    ...(uncommittedDeletions === undefined ? {} : { uncommittedDeletions }),
    ...(repository === undefined ? {} : { repository }),
    ...(compatibilityIssues === undefined ? {} : { compatibilityIssues }),
    ...(compatibilityIssuesTruncated === undefined ? {} : { compatibilityIssuesTruncated }),
    ...(value.error === undefined ? {} : { error: value.error }),
  }
}

/** 归档行是普通 change 加一个 archive 段；任何形状不符都让整个项目解码失败（闭形状）。 */
function decodeArchivedChanges(value: unknown): ArchivedChangeSnapshot[] | null {
  if (!Array.isArray(value)) return null
  const rows: ArchivedChangeSnapshot[] = []
  for (const entry of value) {
    const change = decodeChange(entry)
    if (!change || !isRecord(entry) || !isRecord(entry.archive)) return null
    const { archivedAt, phase, actor } = entry.archive
    if (typeof archivedAt !== 'string' || typeof phase !== 'string' || !isRecord(actor)) return null
    if (typeof actor.id !== 'string' || typeof actor.name !== 'string' || actor.trust !== 'declared') return null
    rows.push({ ...change, archive: { archivedAt, phase, actor: { id: actor.id, name: actor.name, trust: 'declared' } } })
  }
  return rows
}

/** `undefined` when absent, `null` when present but not a non-negative integer. */
function decodeDeletionCount(value: unknown): number | undefined | null {
  if (value === undefined) return undefined
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function decodeCompatibilityIssues(
  value: unknown,
): ProjectSnapshot['compatibilityIssues'] | null {
  if (!Array.isArray(value) || value.length > 100) return null
  const seenChanges = new Set<string>()
  const issues: NonNullable<ProjectSnapshot['compatibilityIssues']> = []
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.change !== 'string' || raw.change === '' || seenChanges.has(raw.change)) return null
    const severity = raw.severity === 'warning' ? 'warning' : 'blocking'
    const canonicalKeys = exactKeys(raw, ['kind', 'change', 'foundVersion', 'supportedVersion', 'action'])
      || exactKeys(raw, ['severity', 'kind', 'change', 'foundVersion', 'supportedVersion', 'action'])
    const legacyKeys = exactKeys(raw, ['kind', 'change', 'legacyScopePath', 'action'])
      || exactKeys(raw, ['severity', 'kind', 'change', 'legacyScopePath', 'action'])
    if (canonicalKeys && raw.kind === 'unsupported-canonical-version'
      && severity === 'blocking'
      && typeof raw.foundVersion === 'number' && Number.isSafeInteger(raw.foundVersion)
      && typeof raw.supportedVersion === 'number' && Number.isSafeInteger(raw.supportedVersion)
      && raw.supportedVersion >= 1 && raw.foundVersion > raw.supportedVersion
      && raw.action === 'upgrade-runtime') {
      // Older servers omitted severity. Normalize that shape to an explicit
      // blocking issue so callers cannot accidentally treat it as a warning.
      issues.push({ severity: 'blocking', kind: raw.kind, change: raw.change, foundVersion: raw.foundVersion, supportedVersion: raw.supportedVersion, action: raw.action })
    } else if (legacyKeys && raw.kind === 'legacy-scope-unmerged'
      && typeof raw.legacyScopePath === 'string' && raw.legacyScopePath !== ''
      && raw.action === 'merge-or-remove-legacy-scope') {
      issues.push({ severity, kind: raw.kind, change: raw.change, legacyScopePath: raw.legacyScopePath, action: raw.action })
    } else return null
    seenChanges.add(raw.change)
  }
  return issues
}

export function decodeSnapshot(value: unknown): Snapshot | null {
  if (!isRecord(value)
    || typeof value.version !== 'string'
    || typeof value.generated_at !== 'string'
    || !recordOfBooleans(value.capabilities)
    || typeof value.project_count !== 'number'
    || typeof value.change_count !== 'number'
    || !Array.isArray(value.projects)) return null
  const projects: ProjectSnapshot[] = []
  for (const project of value.projects) {
    const decoded = decodeProject(project)
    if (!decoded) return null
    projects.push(decoded)
  }
  return {
    ...(value.snapshot_protocol === 'tenon-snapshot/v2'
      ? { snapshot_protocol: value.snapshot_protocol }
      : {}),
    version: value.version,
    generated_at: value.generated_at,
    capabilities: value.capabilities,
    project_count: value.project_count,
    change_count: value.change_count,
    projects,
  }
}
