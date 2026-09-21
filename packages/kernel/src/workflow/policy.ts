import type {
  SkillInvocationDecisionPayloadV1,
  SkillInvocationPolicyRefV1,
  SkillInvocationQuestionPayloadV1,
} from '../skill-invocation/types.js'
import type {
  WorkflowDecompositionAskCondition,
  WorkflowDecompositionAutoCondition,
  WorkflowDecompositionMode,
  WorkflowDecompositionPolicyV1,
  WorkflowDecompositionStrategy,
  WorkflowDecompositionTarget,
  WorkflowInteractionMode,
  WorkflowInteractionPolicyV1,
} from './types.js'

export const WORKFLOW_DECOMPOSITION_MODES = Object.freeze([
  'off', 'suggest', 'auto-safe', 'require-review',
] as const) satisfies readonly WorkflowDecompositionMode[]
export const WORKFLOW_DECOMPOSITION_TARGETS = Object.freeze(['work-items', 'child-pipelines'] as const) satisfies readonly WorkflowDecompositionTarget[]
export const WORKFLOW_DECOMPOSITION_STRATEGIES = Object.freeze(['balanced', 'breadth-first', 'depth-first'] as const) satisfies readonly WorkflowDecompositionStrategy[]
export const WORKFLOW_DECOMPOSITION_AUTO_CONDITIONS = Object.freeze([
  'independent-work-items', 'cross-component-boundary', 'context-budget-risk',
] as const) satisfies readonly WorkflowDecompositionAutoCondition[]
export const WORKFLOW_DECOMPOSITION_ASK_CONDITIONS = Object.freeze([
  'ambiguous-requirements', 'hard-boundary', 'missing-authorization', 'limit-exceeded',
] as const) satisfies readonly WorkflowDecompositionAskCondition[]
export const WORKFLOW_INTERACTION_MODES = Object.freeze(['interactive', 'recommended-defaults', 'afk'] as const) satisfies readonly WorkflowInteractionMode[]

export const DEFAULT_WORKFLOW_DECOMPOSITION_POLICY: WorkflowDecompositionPolicyV1 = Object.freeze({
  version: 'v1',
  mode: 'off',
  target: 'work-items',
  strategy: 'balanced',
  max_items: 16,
  max_depth: 2,
  auto_when: Object.freeze([]),
  ask_when: Object.freeze([]),
})

export const DEFAULT_WORKFLOW_INTERACTION_POLICY: WorkflowInteractionPolicyV1 = Object.freeze({
  version: 'v1', mode: 'interactive',
})

function policyError(path: string, message: string): never {
  throw new Error(`compileWorkflow: ${path}: ${message}`)
}
function ownRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    policyError(path, `必须是对象（实际 ${JSON.stringify(value)}）`)
  }
  return value as Record<string, unknown>
}
function rejectUnknownKeys(record: Record<string, unknown>, keys: readonly string[], path: string): void {
  const allowed = new Set(keys)
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) policyError(path, `未知字段 '${key}'`)
  }
}
function closedValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  fallback: T,
): T {
  const resolved = value === undefined ? fallback : value
  if (typeof resolved !== 'string' || !allowed.includes(resolved as T)) {
    policyError(path, `必须属于 ${allowed.join('|')}（实际 ${JSON.stringify(resolved)}）`)
  }
  return resolved as T
}
function boundedInteger(value: unknown, fallback: number, min: number, max: number, path: string): number {
  const resolved = value === undefined ? fallback : value
  if (!Number.isInteger(resolved) || typeof resolved !== 'number' || resolved < min || resolved > max) {
    policyError(path, `必须是 ${min}..${max} 的整数（实际 ${JSON.stringify(resolved)}）`)
  }
  return resolved
}
function closedList<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) policyError(path, `必须是数组（实际 ${JSON.stringify(value)}）`)
  const result: T[] = []
  const seen = new Set<string>()
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index) || value[index] === undefined) {
      policyError(`${path}[${index}]`, '条件不得为空或稀疏')
    }
    const resolved = closedValue(value[index], allowed, `${path}[${index}]`, allowed[0] as T)
    if (seen.has(resolved)) policyError(`${path}[${index}]`, `条件 '${resolved}' 重复`)
    seen.add(resolved)
    result.push(resolved)
  }
  return result
}

export function compileWorkflowDecompositionPolicy(value: unknown): WorkflowDecompositionPolicyV1 {
  if (value === undefined) return structuredClone(DEFAULT_WORKFLOW_DECOMPOSITION_POLICY)
  const record = ownRecord(value, 'decomposition')
  rejectUnknownKeys(record, [
    'version', 'mode', 'target', 'strategy', 'max_items', 'max_depth', 'auto_when', 'ask_when',
  ], 'decomposition')
  if (record.version !== 'v1') {
    policyError('decomposition.version', `必须是 'v1'（实际 ${JSON.stringify(record.version)}）`)
  }
  return {
    version: 'v1',
    mode: closedValue(record.mode, WORKFLOW_DECOMPOSITION_MODES, 'decomposition.mode', 'off'),
    target: closedValue(record.target, WORKFLOW_DECOMPOSITION_TARGETS, 'decomposition.target', 'work-items'),
    strategy: closedValue(record.strategy, WORKFLOW_DECOMPOSITION_STRATEGIES, 'decomposition.strategy', 'balanced'),
    max_items: boundedInteger(record.max_items, 16, 1, 32, 'decomposition.max_items'),
    max_depth: boundedInteger(record.max_depth, 2, 0, 4, 'decomposition.max_depth'),
    auto_when: closedList(record.auto_when, WORKFLOW_DECOMPOSITION_AUTO_CONDITIONS, 'decomposition.auto_when'),
    ask_when: closedList(record.ask_when, WORKFLOW_DECOMPOSITION_ASK_CONDITIONS, 'decomposition.ask_when'),
  }
}

export function compileWorkflowInteractionPolicy(value: unknown): WorkflowInteractionPolicyV1 {
  if (value === undefined) return structuredClone(DEFAULT_WORKFLOW_INTERACTION_POLICY)
  const record = ownRecord(value, 'interaction')
  rejectUnknownKeys(record, ['version', 'mode'], 'interaction')
  if (record.version !== 'v1') {
    policyError('interaction.version', `必须是 'v1'（实际 ${JSON.stringify(record.version)}）`)
  }
  return {
    version: 'v1',
    mode: closedValue(record.mode, WORKFLOW_INTERACTION_MODES, 'interaction.mode', 'interactive'),
  }
}

export const WORKFLOW_ACTIONS = Object.freeze([
  'suggest-decomposition',
  'materialize-work-items',
  'create-child-pipeline',
  'apply-recommended-default',
  'enter-afk',
  'write-filesystem',
  'create-branch',
  'create-pull-request',
  'merge-pull-request',
  'call-external-api',
  'publish-external',
  'operate-production',
  'incur-cost',
  'access-credentials',
  'perform-irreversible-action',
] as const)
export type WorkflowAction = typeof WORKFLOW_ACTIONS[number]
export type WorkflowActionClassification =
  | 'routine-reversible'
  | 'safety-sensitive'
  | 'cost'
  | 'production'
  | 'external-side-effect'
  | 'publication'
  | 'credentials'
  | 'irreversible'
  | 'missing-authorization'

export type WorkflowPermissionLayer = 'platform' | 'skill' | 'project' | 'workflow' | 'run'
export type WorkflowPermissionLayerStatus =
  | 'valid'
  | 'missing'
  | 'stale'
  | 'malformed'
  | 'identity-mismatch'
  | 'fingerprint-mismatch'

export interface WorkflowPermissionLayerInput {
  readonly status: WorkflowPermissionLayerStatus
  readonly grants: readonly WorkflowAction[]
}

export type WorkflowPermissionLayers = Readonly<Record<WorkflowPermissionLayer, WorkflowPermissionLayerInput>>

export interface WorkflowAuthorityBinding {
  readonly authority_id: string
  readonly workflow_run_id: string
  readonly workflow_fingerprint: string
}

export type WorkflowHardConfirmation =
  | ({ readonly status: 'confirmed'; readonly action: WorkflowAction } & WorkflowAuthorityBinding)
  | { readonly status: 'missing' | 'stale' | 'identity-mismatch' }

export interface EvaluateWorkflowActionInput {
  readonly action: WorkflowAction
  readonly classification: WorkflowActionClassification
  readonly interactionMode: WorkflowInteractionMode
  readonly layers: WorkflowPermissionLayers
  readonly authority?: WorkflowAuthorityBinding
  readonly hardConfirmation?: WorkflowHardConfirmation
  readonly frozenRecommendedDefaultPolicy?: SkillInvocationPolicyRefV1
  readonly recommendedDefaultEvidence?: {
    readonly question: RecommendedDefaultQuestion
    readonly decision: RecommendedDefaultDecision
  }
}

export interface WorkflowPermissionContribution {
  readonly layer: WorkflowPermissionLayer
  readonly status: WorkflowPermissionLayerStatus
  readonly granted: boolean
}

export type WorkflowPermissionRemediationCode =
  | 'platform-policy-required'
  | 'skill-contract-required'
  | 'project-policy-required'
  | 'workflow-ceiling-required'
  | 'run-grant-required'
  | 'refresh-stale-authority'
  | 'repair-authority-binding'
  | 'request-hard-confirmation'
  | 'request-decomposition-review'
  | 'revise-decomposition-candidate'
  | 'select-decomposition-mode'
  | 'select-compatible-interaction-mode'

export interface WorkflowPermissionDenial {
  readonly layer?: WorkflowPermissionLayer
  readonly code: string
  readonly remediation: WorkflowPermissionRemediationCode
}

export interface WorkflowActionEvaluation {
  readonly action: WorkflowAction
  readonly allowed: boolean
  readonly status: 'allowed' | 'denied' | 'hard-blocked' | 'stale'
  readonly contributions: readonly WorkflowPermissionContribution[]
  readonly denials: readonly WorkflowPermissionDenial[]
}

const LAYERS = ['platform', 'skill', 'project', 'workflow', 'run'] as const
const LAYER_REMEDIATION: Readonly<Record<WorkflowPermissionLayer, WorkflowPermissionRemediationCode>> = {
  platform: 'platform-policy-required',
  skill: 'skill-contract-required',
  project: 'project-policy-required',
  workflow: 'workflow-ceiling-required',
  run: 'run-grant-required',
}
const HARD_CLASSIFICATIONS: ReadonlySet<WorkflowActionClassification> = new Set([
  'safety-sensitive', 'cost', 'production', 'external-side-effect', 'publication',
  'credentials', 'irreversible', 'missing-authorization',
])

export function evaluateWorkflowAction(input: EvaluateWorkflowActionInput): WorkflowActionEvaluation {
  const contributions: WorkflowPermissionContribution[] = []
  const denials: WorkflowPermissionDenial[] = []
  let hasStale = false
  let hasMissing = false
  const classificationValid = input.classification === 'routine-reversible'
    || HARD_CLASSIFICATIONS.has(input.classification)
  if (!classificationValid) {
    hasMissing = true
    denials.push({
      code: 'action-classification-malformed',
      remediation: 'repair-authority-binding',
    })
  }
  if (classificationValid && input.classification === 'missing-authorization') {
    // Missing authority is itself an unresolvable hard boundary. A matching confirmation
    // cannot manufacture the authorization that the classification says is absent.
    hasMissing = true
    denials.push({
      code: 'missing-authorization-hard-blocked',
      remediation: 'repair-authority-binding',
    })
  }
  const runtimeLayers: unknown = input.layers
  const layerRecord = typeof runtimeLayers === 'object' && runtimeLayers !== null && !Array.isArray(runtimeLayers)
    ? runtimeLayers as Record<string, unknown>
    : undefined
  for (const layer of LAYERS) {
    const rawFact = layerRecord?.[layer]
    const fact = typeof rawFact === 'object' && rawFact !== null && !Array.isArray(rawFact)
      ? rawFact as Record<string, unknown>
      : undefined
    const rawStatus = fact?.status
    const rawGrants = fact?.grants
    const grants = Array.isArray(rawGrants)
      && rawGrants.every((grant) =>
        typeof grant === 'string' && WORKFLOW_ACTIONS.includes(grant as WorkflowAction))
      && new Set(rawGrants).size === rawGrants.length
      ? rawGrants as WorkflowAction[]
      : undefined
    const status: WorkflowPermissionLayerStatus = grants !== undefined && (rawStatus === 'valid'
      || rawStatus === 'missing'
      || rawStatus === 'stale'
      || rawStatus === 'malformed'
      || rawStatus === 'identity-mismatch'
      || rawStatus === 'fingerprint-mismatch')
      ? rawStatus
      : 'malformed'
    const granted = status === 'valid' && grants?.includes(input.action) === true
    contributions.push({ layer, status, granted })
    if (status !== 'valid') {
      hasStale ||= status === 'stale' || status === 'identity-mismatch' || status === 'fingerprint-mismatch'
      hasMissing ||= status === 'missing' || status === 'malformed'
      denials.push({
        layer,
        code: `${layer}-${status}`,
        remediation: status === 'stale' ? 'refresh-stale-authority' : 'repair-authority-binding',
      })
    } else if (!granted) {
      denials.push({ layer, code: `${layer}-denied`, remediation: LAYER_REMEDIATION[layer] })
    }
  }

  if ((input.action === 'enter-afk' && input.interactionMode !== 'afk')
    || (input.action === 'apply-recommended-default' && input.interactionMode !== 'recommended-defaults')) {
    denials.push({
      code: 'interaction-mode-denied',
      remediation: 'select-compatible-interaction-mode',
    })
  }

  if (input.action === 'apply-recommended-default' && !canUseWorkflowRecommendedDefault(
    { version: 'v1', mode: input.interactionMode },
    input.recommendedDefaultEvidence?.question ?? {
      question_id: '', option_ids: [], requiredness: 'routine', shown: true,
    },
    input.recommendedDefaultEvidence?.decision,
    input.frozenRecommendedDefaultPolicy,
  )) {
    denials.push({
      code: 'recommended-default-evidence-required',
      remediation: 'select-compatible-interaction-mode',
    })
  }

  if (classificationValid && HARD_CLASSIFICATIONS.has(input.classification)) {
    const authority = input.authority
    const confirmation = input.hardConfirmation
    const bindingValid = confirmation?.status === 'confirmed'
      && nonEmptyString(authority?.authority_id)
      && nonEmptyString(authority.workflow_run_id)
      && /^[0-9a-f]{64}$/.test(authority.workflow_fingerprint)
      && confirmation.authority_id === authority.authority_id
      && confirmation.action === input.action
      && confirmation.workflow_run_id === authority.workflow_run_id
      && confirmation.workflow_fingerprint === authority.workflow_fingerprint
    if (!bindingValid) {
      denials.push({
        code: confirmation?.status === 'confirmed'
          ? 'hard-confirmation-binding-mismatch'
          : 'hard-confirmation-required',
        remediation: 'request-hard-confirmation',
      })
    }
  }

  if (denials.length === 0) {
    return { action: input.action, allowed: true, status: 'allowed', contributions, denials }
  }
  const hardBlocked = hasMissing
    || denials.some((denial) => denial.code.startsWith('hard-confirmation-'))
  return {
    action: input.action,
    allowed: false,
    status: hardBlocked ? 'hard-blocked' : hasStale ? 'stale' : 'denied',
    contributions,
    denials,
  }
}

export function workflowPolicyPermissionLayer(policy: {
  readonly decomposition: WorkflowDecompositionPolicyV1
  readonly interaction: WorkflowInteractionPolicyV1
}): WorkflowPermissionLayerInput & { readonly status: 'valid' } {
  const grants: WorkflowAction[] = []
  if (policy.decomposition.mode !== 'off') grants.push('suggest-decomposition')
  if (policy.interaction.mode === 'recommended-defaults') grants.push('apply-recommended-default')
  if (policy.interaction.mode === 'afk') grants.push('enter-afk')
  return { status: 'valid', grants }
}

export type RecommendedDefaultQuestion = Pick<
  SkillInvocationQuestionPayloadV1,
  'question_id' | 'option_ids' | 'requiredness' | 'shown'
>
export type RecommendedDefaultDecision = Pick<
  SkillInvocationDecisionPayloadV1,
  'question_id' | 'mode' | 'policy' | 'rationale_code' | 'selected_option_ids'
>

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function uniqueNonEmptyStrings(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every(nonEmptyString)
    && new Set(value).size === value.length
}

export function canUseWorkflowRecommendedDefault(
  interaction: WorkflowInteractionPolicyV1,
  question: RecommendedDefaultQuestion,
  decision: RecommendedDefaultDecision | undefined,
  frozenPolicy: SkillInvocationPolicyRefV1 | undefined,
): boolean {
  const questionOptions = uniqueNonEmptyStrings(question.option_ids)
    ? new Set(question.option_ids)
    : undefined
  const selectedOptions = uniqueNonEmptyStrings(decision?.selected_option_ids)
    ? decision.selected_option_ids
    : undefined
  return interaction.mode === 'recommended-defaults'
    && nonEmptyString(question.question_id)
    && question.requiredness === 'routine'
    && question.shown === false
    && decision?.question_id === question.question_id
    && decision?.mode === 'recommended-default'
    && nonEmptyString(frozenPolicy?.id)
    && nonEmptyString(frozenPolicy.version)
    && nonEmptyString(frozenPolicy.rule_id)
    && decision.policy?.id === frozenPolicy.id
    && decision.policy.version === frozenPolicy.version
    && decision.policy.rule_id === frozenPolicy.rule_id
    && nonEmptyString(decision.rationale_code)
    && selectedOptions !== undefined
    && questionOptions !== undefined
    && selectedOptions.every((option) => questionOptions.has(option))
}
