import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import {
  effectiveWorkflowPlanBinding,
  ensureAgentFreeze,
  OBSERVE_ACTION_KINDS,
  prepareAgentFreeze,
  workflowPlanSnapshot,
  type AgentLibrary,
  type EffectiveWorkflowPlan,
  type InitOptions,
  type PipelineState,
  type StateStore,
  type WorkflowRun,
  type WorkflowRunRepository,
} from '@tenon/kernel'
import type {
  WorkflowRunCreateIfAbsentRepository,
  WorkflowRunCreateIfAbsentResult,
  WorkflowRunCreateRequest,
} from './workflow-run-materializer.js'

const TOP_LEVEL_KEYS = new Set([
  'schemaVersion',
  'kind',
  'idempotencyKey',
  'source',
  'actionIdentity',
  'candidateId',
  'changeName',
  'routeId',
  'workflowId',
  'initialStep',
])
const SOURCE_KEYS = new Set(['sourceId', 'actionKind', 'observationId'])
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const CHANGE_NAME_RE = /^[A-Za-z0-9_-]+$/

export type WorkflowRunCreateTrustedInit = Omit<
  InitOptions,
  'repoRoot' | 'name' | 'runId' | 'initialWorkflow'
>

export interface WorkflowRunCreateRepositoryDeps {
  readonly repoRoot: string
  readonly store: StateStore
  readonly runRepository: Pick<WorkflowRunRepository, 'initChange'>
  /** Host resolves the trusted route to the exact immutable plan frozen into the new run. */
  readonly resolveWorkflowPlan: (
    request: WorkflowRunCreateRequest,
  ) => EffectiveWorkflowPlan | Promise<EffectiveWorkflowPlan>
  /** Host-owned policy. Request identity, location, and workflow coordinates are not delegable. */
  readonly resolveInit: (
    request: WorkflowRunCreateRequest,
  ) => WorkflowRunCreateTrustedInit | Promise<WorkflowRunCreateTrustedInit>
  /** Host 的 agent 库读取面；缺省 = 空库，工作流引用了 agent 就拒绝创建。 */
  readonly loadAgentLibrary?: () => Promise<AgentLibrary>
}

export class WorkflowRunCreateRequestError extends Error {
  readonly _tag = 'WorkflowRunCreateRequestError' as const

  constructor(readonly issues: readonly string[]) {
    super(`WorkflowRun create request rejected: ${issues.join('; ')}`)
    this.name = 'WorkflowRunCreateRequestError'
  }
}

export interface WorkflowRunCreateConflictDetails {
  readonly changeDir: string
  readonly expectedRunId: string
  readonly observedRunId?: string
  readonly expectedWorkflowId: string
  readonly observedWorkflowId?: string
  readonly expectedInitialStep: string
  readonly observedInitialStep?: string
}

export class WorkflowRunCreateConflictError extends Error {
  readonly _tag = 'WorkflowRunCreateConflictError' as const
  readonly changeDir: string
  readonly expectedRunId: string
  readonly observedRunId?: string
  readonly expectedWorkflowId: string
  readonly observedWorkflowId?: string
  readonly expectedInitialStep: string
  readonly observedInitialStep?: string

  constructor(details: WorkflowRunCreateConflictDetails) {
    super(
      `WorkflowRun create conflict at '${details.changeDir}': expected `
      + `run=${details.expectedRunId}, workflow=${details.expectedWorkflowId}, step=${details.expectedInitialStep}; `
      + `observed run=${details.observedRunId ?? '<missing>'}, `
      + `workflow=${details.observedWorkflowId ?? '<invalid>'}, `
      + `step=${details.observedInitialStep ?? '<invalid>'}`,
    )
    this.name = 'WorkflowRunCreateConflictError'
    this.changeDir = details.changeDir
    this.expectedRunId = details.expectedRunId
    this.observedRunId = details.observedRunId
    this.expectedWorkflowId = details.expectedWorkflowId
    this.observedWorkflowId = details.observedWorkflowId
    this.expectedInitialStep = details.expectedInitialStep
    this.observedInitialStep = details.observedInitialStep
  }
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unexpectedKeys(value: object, allowed: ReadonlySet<string>): string[] {
  return Reflect.ownKeys(value)
    .filter((key) => typeof key !== 'string' || !allowed.has(key))
    .map((key) => typeof key === 'symbol' ? key.toString() : key)
}

function validateString(
  value: unknown,
  path: string,
  issues: string[],
  kind: 'safe-id' | 'change-name' = 'safe-id',
): value is string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    issues.push(`${path}: expected a non-empty string`)
    return false
  }
  if (kind === 'safe-id' && !SAFE_ID_RE.test(value)) {
    issues.push(`${path}: expected a safe opaque id`)
    return false
  }
  if (kind === 'change-name' && (!CHANGE_NAME_RE.test(value) || value.includes('..'))) {
    issues.push(`${path}: expected a safe change name`)
    return false
  }
  return true
}

/**
 * Read every known field exactly once into a plain frozen value. Besides rejecting direct misuse,
 * this prevents getters/proxies from presenting one request to hashing and another to init policy.
 */
function snapshotRequest(input: WorkflowRunCreateRequest): WorkflowRunCreateRequest {
  try {
    if (!isRecord(input)) throw new WorkflowRunCreateRequestError(['request: expected an object'])
    const topExtras = unexpectedKeys(input, TOP_LEVEL_KEYS)
    const sourceInput = input.source
    const sourceIsRecord = isRecord(sourceInput)
    const sourceExtras = sourceIsRecord ? unexpectedKeys(sourceInput, SOURCE_KEYS) : []

    const schemaVersion = input.schemaVersion
    const kind = input.kind
    const idempotencyKey = input.idempotencyKey
    const sourceId = sourceIsRecord ? sourceInput.sourceId : undefined
    const actionKind = sourceIsRecord ? sourceInput.actionKind : undefined
    const observationId = sourceIsRecord ? sourceInput.observationId : undefined
    const actionIdentity = input.actionIdentity
    const candidateId = input.candidateId
    const changeName = input.changeName
    const routeId = input.routeId
    const workflowId = input.workflowId
    const initialStep = input.initialStep

    const issues: string[] = []
    if (topExtras.length > 0) issues.push(`request: unknown fields ${topExtras.join(', ')}`)
    if (!sourceIsRecord) {
      issues.push('request.source: expected an object')
    } else if (sourceExtras.length > 0) {
      issues.push(`request.source: unknown fields ${sourceExtras.join(', ')}`)
    }
    if (schemaVersion !== 1) issues.push('request.schemaVersion: expected literal 1')
    if (kind !== 'create-workflow-run') issues.push("request.kind: expected 'create-workflow-run'")
    validateString(idempotencyKey, 'request.idempotencyKey', issues)
    validateString(sourceId, 'request.source.sourceId', issues)
    if (!OBSERVE_ACTION_KINDS.includes(actionKind as (typeof OBSERVE_ACTION_KINDS)[number])) {
      issues.push('request.source.actionKind: expected a supported observe action kind')
    }
    validateString(observationId, 'request.source.observationId', issues)
    validateString(actionIdentity, 'request.actionIdentity', issues)
    validateString(candidateId, 'request.candidateId', issues)
    validateString(changeName, 'request.changeName', issues, 'change-name')
    validateString(routeId, 'request.routeId', issues)
    validateString(workflowId, 'request.workflowId', issues)
    validateString(initialStep, 'request.initialStep', issues)
    if (issues.length > 0) throw new WorkflowRunCreateRequestError(issues)

    const source = Object.freeze({
      sourceId: sourceId as string,
      actionKind: actionKind as WorkflowRunCreateRequest['source']['actionKind'],
      observationId: observationId as string,
    })
    return Object.freeze({
      schemaVersion: 1,
      kind: 'create-workflow-run',
      idempotencyKey: idempotencyKey as string,
      source,
      actionIdentity: actionIdentity as string,
      candidateId: candidateId as string,
      changeName: changeName as string,
      routeId: routeId as string,
      workflowId: workflowId as string,
      initialStep: initialStep as string,
    })
  } catch (error) {
    if (error instanceof WorkflowRunCreateRequestError) throw error
    throw new WorkflowRunCreateRequestError([
      `request: could not extract canonical fields (${error instanceof Error ? error.message : String(error)})`,
    ])
  }
}

function runIdFor(request: WorkflowRunCreateRequest): string {
  const canonical = JSON.stringify([
    request.schemaVersion,
    request.kind,
    request.idempotencyKey,
    request.source.sourceId,
    request.source.actionKind,
    request.source.observationId,
    request.actionIdentity,
    request.candidateId,
    request.changeName,
    request.routeId,
    request.workflowId,
    request.initialStep,
  ])
  return `triage-run-v1-${createHash('sha256').update(canonical, 'utf8').digest('hex')}`
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

function stateString(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function assertExistingIdentity(
  changeDir: string,
  expectedRunId: string,
  request: WorkflowRunCreateRequest,
  observed: {
    readonly runId?: string
    readonly workflowId?: string
    readonly initialStep?: string
  },
): void {
  if (
    observed.runId === expectedRunId
    && observed.workflowId === request.workflowId
    && observed.initialStep === request.initialStep
  ) return
  throw new WorkflowRunCreateConflictError({
    changeDir,
    expectedRunId,
    observedRunId: observed.runId,
    expectedWorkflowId: request.workflowId,
    observedWorkflowId: observed.workflowId,
    expectedInitialStep: request.initialStep,
    observedInitialStep: observed.initialStep,
  })
}

function assertEstablishedRun(
  changeDir: string,
  expectedRunId: string,
  request: WorkflowRunCreateRequest,
  run: WorkflowRun,
): void {
  assertExistingIdentity(changeDir, expectedRunId, request, {
    runId: run.id,
    workflowId: run.workflowId,
    initialStep: run.currentStep,
  })
}

function runFromValidatedState(state: PipelineState): WorkflowRun {
  const metadata = state.runMetadata!
  const stringField = (key: keyof PipelineState['fields']): string => {
    const value = state.fields[key]
    return Array.isArray(value) ? value.join(',') : (value ?? '')
  }
  return {
    id: metadata.runId,
    workflowId: stringField('workflow'),
    currentStep: stringField('phase'),
    lifecycle: stringField('archived') === 'true' ? 'archived' : 'active',
    transitionSequence: metadata.transitionSequence,
    transitionHead: metadata.transitionHead,
    documentProfile: metadata.documentProfile,
    documentGovernanceFingerprint: metadata.documentGovernanceFingerprint,
    workflowPlanFingerprint: metadata.workflowPlanFingerprint,
    workflowPlanSnapshot: metadata.workflowPlanSnapshot,
    createdAt: stringField('created_at'),
    updatedAt: stringField('updated_at'),
    automationPolicy: metadata.automationPolicy,
    policyId: metadata.automationPolicy?.policy_id,
    policyVersion: metadata.automationPolicy?.policy_version,
    loopId: metadata.loopId,
    iterationId: metadata.iterationId,
  }
}

export function createWorkflowRunCreateIfAbsentRepository(
  deps: WorkflowRunCreateRepositoryDeps,
): WorkflowRunCreateIfAbsentRepository {
  return {
    async createIfAbsent(input): Promise<WorkflowRunCreateIfAbsentResult> {
      const request = snapshotRequest(input)
      const expectedRunId = runIdFor(request)
      const changeDir = join(
        resolve(deps.repoRoot),
        'openspec',
        'changes',
        request.changeName,
      )
      const readExisting = async (): Promise<WorkflowRun | undefined> => {
        try {
          // Read-only probe avoids creating `.pipeline.lock` inside a competing initializer's
          // not-yet-committed directory. Once canonical state exists, lock and validate one snapshot.
          await deps.store.read(changeDir)
          return await deps.store.withLock(changeDir, async () => {
            const state = await deps.store.read(changeDir)
            assertExistingIdentity(changeDir, expectedRunId, request, {
              runId: state.runMetadata?.runId,
              workflowId: stateString(state.fields.workflow),
              initialStep: stateString(state.fields.phase),
            })
            return runFromValidatedState(state)
          })
        } catch (error) {
          if (errnoCode(error) === 'ENOENT') return undefined
          throw error
        }
      }
      const existing = await readExisting()
      if (existing !== undefined) return { status: 'existing', run: existing }

      const trusted = await deps.resolveInit(request)
      const plan = await deps.resolveWorkflowPlan(request)
      if (plan.id !== request.workflowId
        || !plan.workflow.steps.some((step) => step.id === request.initialStep)) {
        throw new WorkflowRunCreateRequestError([
          'request workflow/initialStep does not match the host-resolved workflow plan',
        ])
      }
      const planBinding = effectiveWorkflowPlanBinding(plan)
      // agent 内容随 Change 创建冻结；缺任何被引用的 agent 都在发布之前抛出。
      const freezeAgent = await prepareAgentFreeze(
        plan.workflow,
        deps.loadAgentLibrary ?? (async () => ({ entries: [], sync: { id: 'agents', state: 'unchanged' as const } })),
      )
      // Explicit projection is intentional: even an unsound host implementation cannot smuggle
      // repoRoot/name/runId/initialWorkflow through object spread and override request identity.
      const init: InitOptions = {
        repoRoot: deps.repoRoot,
        name: request.changeName,
        track: trusted.track,
        reviewSeed: trusted.reviewSeed,
        preset: trusted.preset,
        creator: trusted.creator,
        clock: trusted.clock,
        runId: expectedRunId,
        initialWorkflow: {
          workflow: request.workflowId,
          phase: request.initialStep,
          ...planBinding,
          workflowPlanSnapshot: workflowPlanSnapshot(plan),
          openspecContract: plan.capabilities.documents.profile === 'legacy-full',
          documentContract: plan.capabilities.documents.governed,
        },
      }
      let created: { changeDir: string; run: WorkflowRun } | undefined
      try {
        created = await deps.runRepository.initChange(init)
      } catch (error) {
        if (errnoCode(error) !== 'EEXIST') throw error
      }
      if (created !== undefined) {
        assertEstablishedRun(created.changeDir, expectedRunId, request, created.run)
        if (freezeAgent !== undefined) {
          await ensureAgentFreeze({
            changeDir: created.changeDir,
            runId: created.run.id,
            workflowFingerprint: plan.workflowFingerprint,
            workflow: plan.workflow,
            resolve: freezeAgent,
          })
        }
        return { status: 'created', run: created.run }
      }

      // The name-level init lock releases only after current is committed, so an EEXIST loser can
      // now converge through the same immutable existing-state path without observing half init.
      const run = await readExisting()
      if (run === undefined) {
        throw new Error(`WorkflowRun init reported EEXIST but no committed Change exists: ${changeDir}`)
      }
      return { status: 'existing', run }
    },
  }
}
