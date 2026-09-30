import type {
  ArchivedChangeSnapshot,
  ChangeSnapshot,
  ProjectRepositoryIdentity,
  ProjectSnapshot,
  ReviewHandshakeSnapshot,
  Snapshot,
} from '../types'
import { isRecord, optionalString, recordOfBooleans, stringArray } from './transport'
import { decodePlanBrief, decodePolicyReports } from './testPolicyDecoders'
import {
  decodeAgentRuns, decodeDocuments, decodeSkillRuns, decodeTerminalActivity, decodeTests,
  decodeTodo,
} from './snapshotEvidenceDecoders'
import {
  decodeWorkflowExecution, decodeWorkflowRules, exactKeys, workflowRulesSemanticKey,
} from './snapshotWorkflowDecoders'
import { expandWireProject } from './snapshotWire'

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

/** `owner` / `creator` are required keys: null for legacy values, otherwise an exact `{id,name,slug}`. */
function decodeUserRefKey(value: Record<string, unknown>, key: 'owner' | 'creator'): import('../types').UserRefView | null | undefined {
  if (!(key in value)) return undefined
  const ref = value[key]
  if (ref === null) return null
  if (!isRecord(ref) || Object.keys(ref).length !== 3 || typeof ref.id !== 'string' || typeof ref.name !== 'string' || typeof ref.slug !== 'string') return undefined
  return { id: ref.id, name: ref.name, slug: ref.slug }
}

export function decodeChange(value: unknown): ChangeSnapshot | null {
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
    || creator === undefined
    || (value.rev !== undefined && (typeof value.rev !== 'string' || value.rev === ''))) return null
  const reviewHandshake = value.reviewHandshake === undefined
    ? undefined
    : decodeReviewHandshake(value.reviewHandshake, workflowRules, value.phase)
  const todo = value.todo === undefined ? undefined : decodeTodo(value.todo)
  const documents = value.documents === undefined ? undefined : decodeDocuments(value.documents)
  const terminalActivity = value.terminalActivity === undefined ? undefined : decodeTerminalActivity(value.terminalActivity)
  const skillRuns = value.skillRuns === undefined ? undefined : decodeSkillRuns(value.skillRuns)
  const agentRuns = value.agentRuns === undefined ? undefined : decodeAgentRuns(value.agentRuns)
  const tests = value.tests === undefined ? undefined : decodeTests(value.tests)
  const testPolicy = value.testPolicy === undefined ? undefined : decodePolicyReports(value.testPolicy)
  const testPlan = value.testPlan === undefined ? undefined : decodePlanBrief(value.testPlan)
  const testDiagnostics = value.testDiagnostics === undefined
    ? undefined
    : stringArray(value.testDiagnostics) ? value.testDiagnostics : undefined
  if ((value.tests !== undefined && !tests)
    || (value.testPolicy !== undefined && !testPolicy)
    || (value.testPlan !== undefined && !testPlan)
    || (value.testUser !== undefined && typeof value.testUser !== 'string')
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
    ...(typeof value.rev === 'string' ? { rev: value.rev } : {}),
    ...(reviewHandshake ? { reviewHandshake } : {}),
    ...(todo ? { todo } : {}),
    ...(documents ? { documents } : {}),
    ...(terminalActivity ? { terminalActivity } : {}),
    ...(skillRuns ? { skillRuns } : {}),
    ...(agentRuns ? { agentRuns } : {}),
    ...(tests ? { tests } : {}),
    ...(testPolicy ? { testPolicy } : {}),
    ...(testPlan ? { testPlan } : {}),
    ...(typeof value.testUser === 'string' ? { testUser: value.testUser } : {}),
    ...(testDiagnostics ? { testDiagnostics } : {}),
  }
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

export function decodeProject(wire: unknown): ProjectSnapshot | null {
  // The list wire writes shared sub-trees once per project; put them back before validating anything.
  const value = expandWireProject(wire)
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
    ...(value.view === 'list' ? { view: 'list' as const } : {}),
    version: value.version,
    generated_at: value.generated_at,
    capabilities: value.capabilities,
    project_count: value.project_count,
    change_count: value.change_count,
    projects,
  }
}

/** A `snapshot-delta` frame: the envelope, the registry order, and only the projects whose bytes moved. */
export interface SnapshotDelta {
  readonly envelope: Omit<Snapshot, 'projects'>
  readonly roots: readonly string[]
  readonly projects: readonly ProjectSnapshot[]
}

export function decodeSnapshotDelta(value: unknown): SnapshotDelta | null {
  if (!isRecord(value)
    || typeof value.version !== 'string'
    || typeof value.generated_at !== 'string'
    || !recordOfBooleans(value.capabilities)
    || typeof value.project_count !== 'number'
    || typeof value.change_count !== 'number'
    || !stringArray(value.roots)
    || !Array.isArray(value.projects)) return null
  const projects: ProjectSnapshot[] = []
  for (const project of value.projects) {
    const decoded = decodeProject(project)
    if (!decoded) return null
    projects.push(decoded)
  }
  return {
    envelope: {
      ...(value.snapshot_protocol === 'tenon-snapshot/v2' ? { snapshot_protocol: value.snapshot_protocol } : {}),
      ...(value.view === 'list' ? { view: 'list' as const } : {}),
      version: value.version,
      generated_at: value.generated_at,
      capabilities: value.capabilities,
      project_count: value.project_count,
      change_count: value.change_count,
    },
    roots: value.roots,
    projects,
  }
}

/**
 * The snapshot a delta produces from the one the stream last delivered. Projects the delta does not resend keep their
 * object identity, so views memoized on a project do not recompute. `null` when the delta names a project neither
 * side knows: the stream is out of step and the caller reconnects.
 */
export function applySnapshotDelta(base: Snapshot, delta: SnapshotDelta): Snapshot | null {
  const known = new Map(base.projects.map((project) => [project.root, project]))
  for (const project of delta.projects) known.set(project.root, project)
  const projects: ProjectSnapshot[] = []
  for (const root of delta.roots) {
    const project = known.get(root)
    if (project === undefined) return null
    projects.push(project)
  }
  return { ...delta.envelope, projects }
}
