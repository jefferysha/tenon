import type { EffectiveWorkflowPlan } from './effective-plan-types.js'
import type { ActionConfig, CompiledGuardConfig, StepIR, StepTransitionIR } from './ir.js'
import { NON_PM } from './predicates.js'

export interface GovernedLifecyclePolicy {
  readonly guards: readonly CompiledGuardConfig[]
  readonly actions: readonly ActionConfig[]
}

const PRE_VERIFY_PASSED: CompiledGuardConfig = { type: 'field-equals', field: 'pre_verify_review_result', value: 'pass' }
const RESET_PRE_VERIFY: ActionConfig = { type: 'reset-pre-verify-review' }

/**
 * 受治理工作流的固定生命周期（按相邻阶段 id 套用）：只剩安全不变量——实现前评审、build 冻结与验证不被绕过、
 * 主规格迁移。设计 §1b 已退役的检查（build_mode / isolation / direct_override / branch_status）不在其中；
 * 内建 `default` 的这些规则全部写在 default.yaml 里，这里只是给阶段 id 恰好对得上的自定义工作流兜底，
 * 与 YAML 里同样的声明按结构去重（mergeLifecycleGuards / mergeLifecycleActions）。
 * 旧执行模型的转换表（flow/default-event-policy.ts）另有一份，只服务快照里记着旧模型的任务。
 */
const GOVERNED_LIFECYCLE: Readonly<Record<string, GovernedLifecyclePolicy>> = {
  'spec>build': { guards: [], actions: [RESET_PRE_VERIFY] },
  'build>spec': { guards: [], actions: [RESET_PRE_VERIFY] },
  'build>verify': { guards: [PRE_VERIFY_PASSED], actions: [{ type: 'freeze-build-sha' }] },
  'verify>ship': {
    guards: [{ type: 'build-head-unchanged', field: 'build_sha' }],
    actions: [{ type: 'mark-verification-passed' }],
  },
  'verify>build': { guards: [], actions: [{ type: 'mark-verification-failed' }, RESET_PRE_VERIFY] },
  'ship>archive': { guards: [{ type: 'spec-migration-applied' }], actions: [] },
}

/**
 * 只在带旧文档契约（`mode: 'contract'`）的计划里注入的离开条件：它们引用的 `plan` / `verification_report` 字段
 * 由旧的 `tenon artifact register` / 文档登记写入，新任务没有人登记，必须产出改由 YAML 里的 `required-output` 声明。
 * 守卫按边的先后保持改前顺序（文档检查在前）。
 */
const CONTRACT_LIFECYCLE_GUARDS: Readonly<Record<string, readonly CompiledGuardConfig[]>> = {
  'spec>build': [{ type: 'file-exists', path: { kind: 'field', field: 'plan' }, when: NON_PM }],
  'verify>ship': [{ type: 'file-exists', path: { kind: 'field', field: 'verification_report' } }],
}

/**
 * 固定生命周期的适用范围：`governed` = 走 OpenSpec 生命周期（实现前评审、冻结与校验 build 修订、验证标记、主规格迁移），
 * `contract` = 冻结计划另带旧文档契约（再加上面引用文档字段的两条）。
 */
export interface LifecycleScope {
  readonly governed: boolean
  readonly contract: boolean
}

/** 计划的固定生命周期适用范围：调用方不必各自拼 `governed` / `mode`。 */
export function lifecycleScopeOf(plan: { readonly capabilities: Pick<EffectiveWorkflowPlan['capabilities'], 'documents'> }): LifecycleScope {
  const { governed, mode } = plan.capabilities.documents
  return { governed, contract: mode === 'contract' }
}

/**
 * The lifecycle policy that applies to one compiled edge.
 *
 * A custom workflow can express the same lifecycle in four places: the source step,
 * the selected edge, the document-governed fixed policy and the field-semantic policy.
 * Consumers must use this fully merged view rather than rebuilding a partial list of
 * guards themselves.  In particular, a rollback edge is identified from its effective
 * actions and removes only the revision guard that would otherwise make recovery
 * impossible.
 */
export interface EffectiveLifecyclePolicy extends GovernedLifecyclePolicy {
  readonly rollback: boolean
}

/** Canonical lifecycle invariants inherited by document-governed custom workflows. */
export function governedLifecyclePolicy(
  scope: LifecycleScope,
  from: string,
  to: string,
): GovernedLifecyclePolicy | undefined {
  if (!scope.governed) return undefined
  const key = `${from}>${to}`
  const fixed = Object.hasOwn(GOVERNED_LIFECYCLE, key) ? GOVERNED_LIFECYCLE[key] : undefined
  if (fixed === undefined || !scope.contract || !Object.hasOwn(CONTRACT_LIFECYCLE_GUARDS, key)) return fixed
  return { ...fixed, guards: [...(CONTRACT_LIFECYCLE_GUARDS[key] ?? []), ...fixed.guards] }
}

export function mergeLifecycleGuards(
  declared: readonly CompiledGuardConfig[],
  required: readonly CompiledGuardConfig[] | undefined,
): readonly CompiledGuardConfig[] {
  if (!required || required.length === 0) return declared
  const merged = [...declared]
  for (const candidate of required) {
    if (!merged.some((guard) => JSON.stringify(guard) === JSON.stringify(candidate))) {
      merged.push(candidate)
    }
  }
  return merged
}

export function mergeLifecycleActions(
  declared: readonly ActionConfig[],
  required: readonly ActionConfig[] | undefined,
): readonly ActionConfig[] {
  const merged: ActionConfig[] = []
  for (const action of [...declared, ...(required ?? [])]) {
    if (!merged.some((candidate) => JSON.stringify(candidate) === JSON.stringify(action))) {
      merged.push(action)
    }
  }
  return merged
}

function isRevisionGuard(guard: CompiledGuardConfig): boolean {
  return guard.type === 'build-head-unchanged' && guard.field === 'build_sha'
}

/**
 * Merge all lifecycle declarations for a single compiled edge.
 *
 * The returned guard order is declaration order (source step, edge, fixed policy,
 * semantic policy) and structurally equivalent entries are evaluated once.  A rollback
 * is determined exclusively by the resulting action list; no step or event id is
 * special-cased.  Only the revision guard is removed on rollback.  Other guards remain
 * in their original order so custom permissions, evidence and policy checks retain
 * their historical behaviour.
 */
export function effectiveLifecyclePolicy(
  scope: LifecycleScope,
  from: StepIR,
  edge: StepTransitionIR,
  to: StepIR | undefined,
): EffectiveLifecyclePolicy {
  const fixed = governedLifecyclePolicy(scope, from.id, edge.to)
  const semantic = semanticRevisionLifecyclePolicy(from, edge, to, fixed?.actions)
  const actions = mergeLifecycleActions(
    mergeLifecycleActions(edge.actions, fixed?.actions),
    semantic?.actions,
  )
  const rollback = actions.some((action) => action.type === 'mark-verification-failed')
  const declared = mergeLifecycleGuards(from.guards, edge.guards)
  const withFixed = mergeLifecycleGuards(declared, fixed?.guards)
  const merged = mergeLifecycleGuards(withFixed, semantic?.guards)
  const guards = rollback ? merged.filter((guard) => !isRevisionGuard(guard)) : merged
  return { guards, actions, rollback }
}

export { isRevisionGuard }

/**
 * Infer the revision lifecycle for an arbitrary custom graph from field semantics.  Fixed
 * phase names remain supported by governedLifecyclePolicy above, while this function covers
 * historical/frozen plans whose step ids are intentionally different.
 */
export function semanticRevisionLifecyclePolicy(
  from: StepIR,
  edge: StepTransitionIR,
  to: StepIR | undefined,
  inheritedActions: readonly ActionConfig[] = [],
): GovernedLifecyclePolicy | undefined {
  const outputsBuildSha = from.outputs.some((output) => output.field === 'build_sha')
  const currentStepInputsBuildSha = from.inputs.some((input) => input.field === 'build_sha')
  const targetStepInputsBuildSha = to?.inputs.some((input) => input.field === 'build_sha') ?? false
  const rollback = [...edge.actions, ...inheritedActions]
    .some((action) => action.type === 'mark-verification-failed')
  // Capture belongs to the Build -> Verify-like entry edge: the source step must declare the
  // output and the target must declare the input.  A trust guard belongs to the Verify-like
  // source step itself and therefore applies to every non-rollback exit from that step.  Keeping
  // these predicates separate prevents the first Verify edge from requiring a token before the
  // capture action has run.
  const actions: ActionConfig[] = outputsBuildSha && targetStepInputsBuildSha
    ? [{ type: 'freeze-build-sha' }]
    : []
  const guards: CompiledGuardConfig[] = currentStepInputsBuildSha && !rollback
    ? [{ type: 'build-head-unchanged', field: 'build_sha' }]
    : []
  if (actions.length === 0 && guards.length === 0) return undefined
  return { actions, guards }
}
