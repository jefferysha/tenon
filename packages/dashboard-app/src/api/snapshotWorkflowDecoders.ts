/** Snapshot decoders for a change's frozen workflow rules and transition readiness. */
import type { ChangeSnapshot, StepExitBlockerSource, TransitionReadinessBlockerSnapshot } from '../types'
import { isRecord, optionalString } from './transport'
import { decodeWorkflowPolicyRules } from './workflowPolicySnapshotDecoder'

export function uniqueNonemptyStrings(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length === new Set(value).size
    && value.every((item) => typeof item === 'string' && item !== '')
}

export function exactKeys(value: Record<string, unknown>, steps: readonly string[]): boolean {
  const keys = Object.keys(value).sort()
  return keys.length === steps.length && keys.every((key, index) => key === [...steps].sort()[index])
}

export function decodeWorkflowRules(value: unknown): ChangeSnapshot['workflowRules'] | null {
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

export function decodeWorkflowExecution(
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

export const GUARD_TYPES = new Set([
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
export const GUARD_CAPABILITIES = new Set([
  'readText', 'fileExists', 'gitHeadSha', 'workspaceFingerprint', 'specMigrationStatus',
])
export const STEP_EXIT_SOURCES = new Set(['guard', 'document', 'skill', 'test', 'reviewer', 'revision', 'spec', 'tasks'])
export const AGENT_BLOCKER_REASONS = new Set([
  'executor-missing', 'executor-running', 'executor-failed',
  'reviewer-missing', 'reviewer-running', 'reviewer-stale', 'reviewer-failed', 'reviewer-wrong-host',
  'agent-records-invalid',
])

export function decodeTransitionReadinessBlocker(value: unknown): TransitionReadinessBlockerSnapshot | null {
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
  if (value.kind === 'step-exit') {
    if (typeof value.source !== 'string' || !STEP_EXIT_SOURCES.has(value.source)
      || typeof value.code !== 'string' || value.code === ''
      || typeof value.message !== 'string' || value.message === ''
      || (value.items !== undefined && !(Array.isArray(value.items) && value.items.every((item) => typeof item === 'string')))
      || (value.subject !== undefined && typeof value.subject !== 'string')
      || (value.state !== undefined && typeof value.state !== 'string')
      || (value.count !== undefined && !(typeof value.count === 'number' && Number.isInteger(value.count) && value.count >= 0))
      || !Object.keys(value).every((key) =>
        key === 'kind' || key === 'source' || key === 'code' || key === 'message' || key === 'items'
        || key === 'subject' || key === 'state' || key === 'count')) return null
    return {
      kind: 'step-exit',
      source: value.source as StepExitBlockerSource,
      code: value.code,
      message: value.message,
      ...(value.items === undefined ? {} : { items: [...(value.items as string[])] }),
      ...(typeof value.subject === 'string' ? { subject: value.subject } : {}),
      ...(typeof value.state === 'string' ? { state: value.state } : {}),
      ...(typeof value.count === 'number' ? { count: value.count } : {}),
    }
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

export function workflowRulesSemanticKey(rules: ChangeSnapshot['workflowRules']): string {
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
