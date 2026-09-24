import type { TrackDefinition } from '@tenon/kernel'
import {
  assessBuildRevisionTrust,
  builtinWorkflow,
  compileWorkflow,
  evaluateWorkflowAction,
  evaluateSpecMigrationEvidence,
  loadWorkflow,
  readinessByTransition,
  stepExitTransitions,
  resolveBoundEffectiveWorkflowPlan,
  resolveEffectiveWorkflowPlan,
  WORKFLOW_ACTIONS,
  workflowPolicyPermissionLayer,
  probeBuildRevisionIdentity,
  readValidatedTransitionHead,
  safeRevisionHash,
  type EffectiveWorkflowPlan,
  type PipelineState,
  type PipelineTodoStageDefinition,
  type WorkflowDef,
  type WorkflowAction,
  type WorkflowAuthorityBinding,
  type WorkflowHardConfirmation,
  type WorkflowPermissionLayers,
  type WorkflowPlanSnapshot,
} from '@tenon/kernel'
import type {
  LegacyWorkflowRulesSnapshot,
  WorkflowConfiguredPolicySnapshot,
  WorkflowExecutionSnapshot,
  WorkflowRulesSnapshot,
} from './types.js'
import { projectFileExists } from './projectCapabilities.js'
import { withStepExitReadiness, type StepExitSnapshotDeps } from './stepExitReadiness.js'

export interface WorkflowSnapshotCapabilityDeps {
  readonly fileExists?: (root: string, repoRelativePath: string) => boolean
  readonly gitHeadSha?: (cwd: string) => Promise<string>
  /**
   * Root for the capabilities that spawn a child process (the build-revision identity probe). Defaults to
   * `root`, which is correct for callers that already pass a real path; the project scan passes the
   * anchor's real path because its `root` is the process-local fd handle no child can resolve.
   */
  readonly childProcessRoot?: string
  readonly workspaceFingerprint?: (cwd: string, changeName: string) => Promise<string>
  readonly assessBuildRevision?: import('@tenon/kernel').TransitionContext['assessBuildRevision']
  /** 本步 agent 的阻断；缺省 = 未接线，readiness 不含 agent 项。 */
  readonly stepAgents?: () => Promise<readonly import('@tenon/kernel').AgentBlocker[]>
  /**
   * `tenon status` exits 的其余判定面（相位出口规则、技能、文档、测试）；缺省 = 只判出边 guard 与 agent。
   * 生产装配恒有：readiness 与 CLI 同一份 evaluateStepExitReport。
   */
  readonly stepExits?: StepExitSnapshotDeps
}

export interface WorkflowSnapshotAuthorityInput {
  readonly layers: Omit<WorkflowPermissionLayers, 'workflow'>
  readonly authority?: WorkflowAuthorityBinding
  readonly hardConfirmations?: Partial<Record<WorkflowAction, WorkflowHardConfirmation>>
}

const ACTION_CLASSIFICATION: Readonly<Record<WorkflowAction, Parameters<typeof evaluateWorkflowAction>[0]['classification']>> = {
  'suggest-decomposition': 'routine-reversible',
  'materialize-work-items': 'routine-reversible',
  'create-child-pipeline': 'routine-reversible',
  'apply-recommended-default': 'routine-reversible',
  'enter-afk': 'routine-reversible',
  'write-filesystem': 'routine-reversible',
  'create-branch': 'routine-reversible',
  'create-pull-request': 'external-side-effect',
  'merge-pull-request': 'irreversible',
  'call-external-api': 'external-side-effect',
  'publish-external': 'publication',
  'operate-production': 'production',
  'incur-cost': 'cost',
  'access-credentials': 'credentials',
  'perform-irreversible-action': 'irreversible',
}

function samePolicy(
  configured: Extract<WorkflowConfiguredPolicySnapshot, { status: 'available' }>,
  plan: EffectiveWorkflowPlan,
): boolean {
  const left = configured.decomposition
  const right = plan.decomposition
  return left.version === right.version && left.mode === right.mode && left.target === right.target
    && left.strategy === right.strategy && left.max_items === right.max_items
    && left.max_depth === right.max_depth
    && left.auto_when.length === right.auto_when.length
    && left.auto_when.every((condition, index) => right.auto_when[index] === condition)
    && left.ask_when.length === right.ask_when.length
    && left.ask_when.every((condition, index) => right.ask_when[index] === condition)
    && configured.interaction.version === plan.interaction.version
    && configured.interaction.mode === plan.interaction.mode
}

function effectivePolicy(
  plan: EffectiveWorkflowPlan,
  input: WorkflowSnapshotAuthorityInput | undefined,
): WorkflowRulesSnapshot['policy']['effective'] {
  if (input === undefined) return { status: 'unavailable', reason: 'authority-input-unavailable' }
  const workflow = workflowPolicyPermissionLayer(plan)
  const evaluations = WORKFLOW_ACTIONS.map((action) => evaluateWorkflowAction({
    action,
    classification: ACTION_CLASSIFICATION[action],
    interactionMode: plan.interaction.mode,
    layers: { ...input.layers, workflow },
    authority: input.authority,
    hardConfirmation: input.hardConfirmations?.[action],
  }))
  return {
    status: 'available',
    grants: evaluations.filter((evaluation) => evaluation.allowed).map((evaluation) => evaluation.action),
    denials: evaluations.flatMap((evaluation) => evaluation.denials.map((denial) => ({
      ...denial, action: evaluation.action,
    }))),
  }
}

export function resolveConfiguredWorkflowPolicy(
  workflowName: string,
  loadDefinition: (name: string) => WorkflowDef | null,
): WorkflowConfiguredPolicySnapshot {
  const plan = resolveEffectiveWorkflowPlan(workflowName, (name) => {
    const definition = builtinWorkflow(name) ?? loadDefinition(name)
    return definition === null ? null : compileWorkflow(definition)
  }, undefined, () => loadDefinition('default'))
  if (plan === null) return { status: 'missing' }
  return {
    status: 'available',
    workflowFingerprint: plan.workflowFingerprint,
    decomposition: structuredClone(plan.decomposition),
    interaction: structuredClone(plan.interaction),
  }
}

export function resolveConfiguredWorkflowPolicySafely(
  workflowName: string,
  loadDefinition: (name: string) => WorkflowDef | null,
  rethrow?: (error: unknown) => boolean,
): WorkflowConfiguredPolicySnapshot {
  try {
    return resolveConfiguredWorkflowPolicy(workflowName, loadDefinition)
  } catch (error) {
    if (rethrow?.(error) === true) throw error
    return { status: 'invalid' }
  }
}

export function resolveSnapshotEffectivePlan(
  root: string,
  workflowName: string,
  binding: {
    readonly documentProfile?: 'legacy-full' | 'document-v1'
    readonly documentGovernanceFingerprint?: string
    readonly workflowPlanFingerprint?: string
    readonly workflowPlanSnapshot?: WorkflowPlanSnapshot
  },
  loadDefinition: (name: string) => WorkflowDef | null = (name) => loadWorkflow(root, name),
  track?: TrackDefinition,
): EffectiveWorkflowPlan {
  const plan = resolveBoundEffectiveWorkflowPlan(workflowName, binding, (name) => {
    const definition = builtinWorkflow(name) ?? loadDefinition(name)
    return definition === null ? null : compileWorkflow(definition)
  }, track, binding.workflowPlanSnapshot)
  if (plan === null) throw new Error(`workflow '${workflowName}' 未找到`)
  return plan
}

export function snapshotTodoStages(
  plan: EffectiveWorkflowPlan | undefined,
  phase: string,
): readonly PipelineTodoStageDefinition[] {
  if (plan) {
    return plan.workflow.steps.map((step) => ({
      id: step.id,
      label: step.label || step.id,
      transitions: step.transitions.map((transition) => transition.to),
    }))
  }
  return phase === '' ? [] : [{ id: phase, label: phase }]
}

export function snapshotWorkflowRules(
  plan: EffectiveWorkflowPlan,
  configured: WorkflowConfiguredPolicySnapshot = { status: 'unavailable' },
  authority?: WorkflowSnapshotAuthorityInput,
): WorkflowRulesSnapshot {
  const configuredAvailable = configured.status === 'available'
  const fingerprintChanged = configuredAvailable
    ? configured.workflowFingerprint !== plan.workflowFingerprint
    : null
  const policyChanged = configuredAvailable ? !samePolicy(configured, plan) : null
  return {
    executionModel: plan.capabilities.execution.model,
    steps: plan.workflow.steps.map((step) => step.id),
    // Structural exits: a step without a forward edge also lists its implicit `archived` edge, so
    // readiness and a pending `archived` review handshake decode against the same rules.
    transitions: Object.fromEntries(plan.workflow.steps.map((step) => [
      step.id,
      stepExitTransitions(plan, step.id).map((transition) => ({ event: transition.event, to: transition.to })),
    ])),
    gateByStep: Object.fromEntries(plan.workflow.steps.map((step) => [step.id, step.gate])),
    labelByStep: Object.fromEntries(
      plan.workflow.steps.map((step) => [step.id, step.label || step.id]),
    ),
    outputsByStep: Object.fromEntries(plan.workflow.steps.map((step) => [
      step.id,
      step.outputs.map((output) => output.field),
    ])),
    policy: {
      schema: 'workflow-policy/v1',
      configured,
      frozen: {
        workflowFingerprint: plan.workflowFingerprint,
        decomposition: structuredClone(plan.decomposition),
        interaction: structuredClone(plan.interaction),
        workflowCeiling: workflowPolicyPermissionLayer(plan),
      },
      effective: effectivePolicy(plan, authority),
      drift: {
        status: configuredAvailable
          ? fingerprintChanged || policyChanged ? 'changed' : 'current'
          : configured.status,
        fingerprintChanged,
        policyChanged,
      },
    },
  }
}

export function snapshotWorkflowRulesAtRoot(
  plan: EffectiveWorkflowPlan,
  root: string,
  workflowName: string,
  authority?: WorkflowSnapshotAuthorityInput,
): WorkflowRulesSnapshot {
  return snapshotWorkflowRules(
    plan,
    resolveConfiguredWorkflowPolicySafely(workflowName, (name) => loadWorkflow(root, name)),
    authority,
  )
}

export function legacySnapshotWorkflowRules(plan: EffectiveWorkflowPlan): LegacyWorkflowRulesSnapshot {
  const current = snapshotWorkflowRules(plan)
  return {
    steps: current.steps,
    transitions: current.transitions,
    gateByStep: current.gateByStep,
    labelByStep: current.labelByStep,
    outputsByStep: current.outputsByStep,
    nonemptyOutputByStep: Object.fromEntries(plan.workflow.steps.map((step) => [
      step.id,
      step.guards.some((guard) => guard.type === 'output-present'),
    ])),
  }
}

export async function snapshotWorkflowExecution(
  plan: EffectiveWorkflowPlan,
  state: PipelineState,
  root: string,
  changeDir: string,
  changeName: string,
  deps: WorkflowSnapshotCapabilityDeps,
): Promise<WorkflowExecutionSnapshot> {
  const fileExists = deps.fileExists ?? projectFileExists
  const gitHeadSha = deps.gitHeadSha
  const workspaceFingerprint = deps.workspaceFingerprint
  const assessBuildRevision = deps.assessBuildRevision ?? (async (request) => {
    const identity = await probeBuildRevisionIdentity(deps.childProcessRoot ?? root)
    const observe = async () => {
      const kind = request.isolation === 'in-place' ? 'workspace' as const : 'git' as const
      const revision = kind === 'workspace'
        ? await workspaceFingerprint?.(root, changeName) ?? ''
        : await gitHeadSha?.(root) ?? ''
      if (!identity) throw new Error('build revision identity unavailable')
      return { kind, revision, identity }
    }
    const provenance = async () => {
      const validated = await readValidatedTransitionHead(changeDir)
      if (!validated) return undefined
      const { current, record } = validated
      const stateBuildSha = current.state.fields.build_sha
      return {
        currentStep: String(current.state.fields.phase ?? ''),
        stateHash: safeRevisionHash(current.state.fields),
        stateBuildSha: Array.isArray(stateBuildSha) ? stateBuildSha.join(',') : stateBuildSha,
        recordTo: record.to,
        buildShaEffects: record.effects
          .filter((effect) => effect.field === 'build_sha')
          .map((effect) => typeof effect.to === 'string' ? effect.to : ''),
      }
    }
    return assessBuildRevisionTrust({ ...request, observe, provenance })
  })
  const guardContext = {
    fileExists: (path: string) => fileExists(root, path),
    gitHeadSha: gitHeadSha === undefined ? undefined : () => gitHeadSha(root),
    workspaceFingerprint: workspaceFingerprint === undefined
      ? undefined
      : () => workspaceFingerprint(root, changeName),
    assessBuildRevision,
  }
  const readiness = await readinessByTransition(plan, state, {
    changeDirAbs: changeDir,
    ...guardContext,
    specMigrationStatus: () => evaluateSpecMigrationEvidence(root, changeDir, changeName),
    ...(deps.stepAgents === undefined ? {} : { stepAgents: deps.stepAgents }),
  })
  const stepExits = deps.stepExits
  if (stepExits === undefined) return { readinessByTransition: readiness }
  return {
    readinessByTransition: await withStepExitReadiness(readiness, {
      plan, state, root, changeDir, changeName, guardContext,
      agentBlockers: deps.stepAgents ?? (async () => []),
      deps: stepExits,
    }),
  }
}
